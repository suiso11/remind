/**
 * M3 state-core: durable cultivation queue, single-flight maintenance lease,
 * and bounded transactional cultivation apply.
 *
 * Dependency slice (no model): this module performs NO inference and makes no
 * network calls. It only stores bounded review requests, guards single-flight
 * maintenance with a SQLite lease, and applies already-decided model actions
 * transactionally. The next (LLM) worker supplies real offline decisions via
 * applyCultivationBatch and drains the queue under the lease.
 *
 * U5 implementation choices (fixed here, bounds configurable at startup via
 * `cultivation{queueMax,batchMax,leaseTtlMs,reviewMaxAttempts}`):
 * - Queue dedup: at most one OPEN (pending/leased) review per record
 *   (partial unique index). Re-triggers while open are duplicates, not new rows.
 * - Queue full: enqueue drops (returns 'dropped_full'); the canonical
 *   remember/correct/feedback commit is NEVER affected.
 * - Lease: single global row (leaseId='m3'). Expired leases are stealable
 *   (crash support); orphaned 'leased' rows are reclaimed to pending with
 *   backoff, or failed after reviewMaxAttempts (retry support); pending/leased
 *   rows can be explicitly cancelled (cancel support).
 * - Batches are single-scope (scoped bounded context): dequeue and apply both
 *   take one scope; cross-scope actions are rejected per-action (FORBIDDEN_SCOPE).
 * - Apply is conservative: unknown/invalid/stale actions are per-action
 *   no-change (reported, audited), never a batch failure; no raw/record
 *   DELETEs anywhere; consolidation inserts real summary rows (source unions,
 *   history kept) and never auto-retires sources (retirement is explicit).
 */

import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { cultivationBounds } from "./config.js";
import {
  bodyHashFor,
  canonicalTime,
  containsLoneSurrogateDeep,
  countCp,
  hasControl,
  normalizeBody,
  normalizeField,
  normalizeTag,
  nowIso,
  requestHashFor,
} from "./normalize.js";
import { enqueueProjection } from "./projection.js";
import { deriveConsolidationPrivacy } from "./privacy.js";
import {
  parseSourceRefsParam,
  storedSourceRefs,
  type SourceRef,
} from "./sourceref.js";
import {
  applyResponseBudget,
  fail,
  ok,
  type ResponseEnvelope,
} from "./protocol.js";

/** Fixed retire reason codes (metadata-only audit). */
export const RETIRE_REASONS = [
  "NO_LONGER_USEFUL",
  "OUTDATED",
  "LOW_SIGNAL",
  "LOW_ACTIVATION",
  "CONSOLIDATED",
] as const;

/** Fixed reactivate reason codes (metadata-only audit). */
export const REACTIVATE_REASONS = [
  "STILL_USEFUL",
  "CORRECTION_NEEDED",
  "USER_REQUESTED",
] as const;

export type CultivationTrigger = "remember" | "correct" | "feedback";
export type CultivationReviewStatus =
  | "pending"
  | "leased"
  | "done"
  | "cancelled"
  | "failed";

export interface CultivationReview {
  queueId: string;
  recordId: string;
  scope: string;
  trigger: CultivationTrigger;
  status: CultivationReviewStatus;
  attempts: number;
  nextAt: string;
  createdAt: string;
  runId: string | null;
  batchId: string | null;
}

/** Retry backoff bounds (deterministic, no jitter; same shape as projection). */
export const CULTIVATION_RETRY_BASE_MS = 1000;
export const CULTIVATION_RETRY_CAP_MS = 300_000;

export function cultivationBackoffMs(attempts: number): number {
  const n = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  const shift = Math.min(n - 1, 8);
  return Math.min(CULTIVATION_RETRY_BASE_MS * Math.pow(2, shift), CULTIVATION_RETRY_CAP_MS);
}

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export function ensureCultivationSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS cultivation_queue(
    queueId TEXT PRIMARY KEY, recordId TEXT NOT NULL, scope TEXT NOT NULL,
    trigger TEXT NOT NULL CHECK(trigger IN ('remember','correct','feedback')),
    status TEXT NOT NULL CHECK(status IN ('pending','leased','done','cancelled','failed')),
    attempts INTEGER NOT NULL, nextAt TEXT NOT NULL, createdAt TEXT NOT NULL,
    runId TEXT NULL, batchId TEXT NULL)`);
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_cultivation_queue_open_record
    ON cultivation_queue(recordId) WHERE status IN ('pending','leased')`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_cultivation_queue_due
    ON cultivation_queue(status, nextAt, scope)`);
  db.exec(`CREATE TABLE IF NOT EXISTS cultivation_lease(
    leaseId TEXT PRIMARY KEY CHECK(leaseId='m3'), owner TEXT NOT NULL,
    expiresAt TEXT NOT NULL, scope TEXT NULL, batchId TEXT NULL, updatedAt TEXT NOT NULL)`);
}

/* ------------------------------------------------------------------ */
/* Small local helpers (duplicated from store to avoid a store cycle)   */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function budgeted(res: ResponseEnvelope, config: AppConfig): ResponseEnvelope {
  return applyResponseBudget(res, config.limits.responseMaxBytes);
}

function successFits(res: ResponseEnvelope, maxBytes: number): boolean {
  return Buffer.byteLength(JSON.stringify(res), "utf8") <= maxBytes;
}

function withTransaction<T>(db: DatabaseSync, fn: () => T): T {
  db.exec("BEGIN IMMEDIATE");
  try {
    const out = fn();
    db.exec("COMMIT");
    return out;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function bad(): ResponseEnvelope {
  return fail("BAD_REQUEST");
}
function limitExceeded(): ResponseEnvelope {
  return fail("LIMIT_EXCEEDED");
}

function parseScope(scope: unknown): string | null {
  if (typeof scope !== "string") return null;
  if (countCp(scope) < 1 || countCp(scope) > 256 || hasControl(scope)) return null;
  return scope;
}

function parseRunId(runId: unknown): string | null | "invalid" {
  if (runId === undefined || runId === null) return null;
  if (typeof runId !== "string") return "invalid";
  if (countCp(runId) < 1 || countCp(runId) > 256 || hasControl(runId)) return "invalid";
  return runId;
}

function parseProvenance(
  provenance: unknown,
): { source: string; observedAt: string } | null {
  if (!isPlainObject(provenance)) return null;
  const keys = Object.keys(provenance);
  if (keys.length !== 2 || !keys.includes("source") || !keys.includes("observedAt")) return null;
  const source = provenance["source"];
  const observedAt = provenance["observedAt"];
  if (typeof source !== "string") return null;
  if (countCp(source) < 1 || countCp(source) > 256 || hasControl(source)) return null;
  const canonObs = canonicalTime(observedAt);
  if (canonObs === null) return null;
  return { source: source as string, observedAt: canonObs };
}

function auditInsert(
  db: DatabaseSync,
  entry: {
    ts: string;
    op: string;
    targetId: string | null;
    code: string;
    scope: string | null;
    bytes: number | null;
    limitN: number | null;
    runId: string | null;
    recallId: string | null;
    reasonCode: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    entry.ts,
    entry.op,
    entry.targetId,
    entry.code,
    entry.scope,
    entry.bytes,
    entry.limitN,
    entry.runId,
    entry.recallId,
    entry.reasonCode,
  );
}

function isScopeAuthorized(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
): boolean {
  if (!config.allowedScopes.includes(scope)) return false;
  try {
    const row = db.prepare(`SELECT scope FROM scopes WHERE scope = ?`).get(scope) as
      | { scope: string }
      | undefined;
    return !!row;
  } catch {
    throw new Error("scope check unavailable");
  }
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/* ------------------------------------------------------------------ */
/* Queue: bounded post-commit review enqueue (never fails the write)    */
/* ------------------------------------------------------------------ */

export type EnqueueOutcome = "enqueued" | "duplicate" | "dropped_full";

/**
 * Best-effort review enqueue for the next LLM worker. Triggered ONLY by
 * remember/correct/validated-feedback commits (callers), including zero-link
 * notes. Never throws; a full queue drops (bounded) and the canonical write
 * that already committed is unaffected.
 */
export function enqueueCultivationReview(
  db: DatabaseSync,
  config: AppConfig,
  input: {
    recordId: string;
    scope: string;
    trigger: CultivationTrigger;
    runId?: string | null;
    now?: string;
  },
): EnqueueOutcome {
  try {
    const bounds = cultivationBounds(config);
    const now = input.now ?? nowIso();
    if (!Number.isFinite(Date.parse(now))) return "dropped_full";
    ensureCultivationSchema(db);
    // Atomic capacity check + insert as ONE statement: the COUNT subquery is
    // evaluated while the statement holds the write lock, so concurrent
    // remember/correct/feedback workers serialize and cannot jointly exceed
    // queueMax. A single statement issues no explicit BEGIN/COMMIT (it stays
    // invisible to transaction observers and is safe when the caller already
    // holds an outer write transaction); contention or any failure drops
    // (the canonical write already committed is unaffected).
    try {
      const res = db.prepare(
        `INSERT OR IGNORE INTO cultivation_queue(queueId, recordId, scope, trigger, status, attempts, nextAt, createdAt, runId, batchId)
         SELECT ?, ?, ?, ?, 'pending', 0, ?, ?, ?, NULL
         WHERE (SELECT COUNT(*) FROM cultivation_queue WHERE status IN ('pending','leased')) < ?`,
      ).run(
        genId("cq"),
        input.recordId,
        input.scope,
        input.trigger,
        now,
        now,
        input.runId ?? null,
        bounds.queueMax,
      ) as unknown as { changes?: unknown };
      const changes = typeof res?.changes === "number" ? res.changes : Number(res?.changes ?? 0);
      if (changes === 1) return "enqueued";
      // changes=0 is either the cap (WHERE false) or the partial-unique
      // open-per-record hit (IGNORE): disambiguate by re-reading the row.
      try {
        const open = db
          .prepare(
            `SELECT 1 AS one FROM cultivation_queue WHERE recordId = ? AND status IN ('pending','leased') LIMIT 1`,
          )
          .get(input.recordId) as { one: number } | undefined;
        return open ? "duplicate" : "dropped_full";
      } catch {
        return "dropped_full";
      }
    } catch {
      return "dropped_full";
    }
  } catch {
    return "dropped_full";
  }
}

/** Due pending reviews for one scope (diagnostics/drain input; never throws). */
export function peekCultivationQueue(
  db: DatabaseSync,
  scope: string,
  limit: number,
  now?: string,
): CultivationReview[] {
  try {
    ensureCultivationSchema(db);
    const ts = now ?? nowIso();
    const cap = Number.isInteger(limit) && limit >= 1 ? Math.min(limit, 50) : 20;
    return db
      .prepare(
        `SELECT queueId, recordId, scope, trigger, status, attempts, nextAt, createdAt, runId, batchId
         FROM cultivation_queue WHERE status = 'pending' AND scope = ? AND nextAt <= ?
         ORDER BY nextAt ASC, queueId ASC LIMIT ?`,
      )
      .all(scope, ts, cap) as unknown as CultivationReview[];
  } catch {
    return [];
  }
}

/** Count open (pending+leased) reviews (diagnostics; never throws). */
export function countOpenCultivationReviews(db: DatabaseSync): number {
  try {
    ensureCultivationSchema(db);
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n FROM cultivation_queue WHERE status IN ('pending','leased')`,
      )
      .get() as { n: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  } catch {
    return 0;
  }
}

/* ------------------------------------------------------------------ */
/* Single-flight lease with crash/retry/cancel support                  */
/* ------------------------------------------------------------------ */

export interface CultivationLease {
  owner: string;
  expiresAt: string;
  scope: string | null;
  batchId: string | null;
}

/**
 * Acquire the single global maintenance lease. Free or expired => acquired
 * (stealable: crash support). Held and unexpired by another owner => refused.
 * Orphan reclaim runs BEFORE the upsert so a steal actually returns crashed
 * 'leased' rows to pending (reclaim checks lease liveness and would no-op
 * after a fresh upsert). Never throws.
 */
export function acquireCultivationLease(
  db: DatabaseSync,
  config: AppConfig,
  input: { owner: string; scope?: string | null; ttlMs?: number; now?: string },
): { acquired: boolean; lease: CultivationLease | null } {
  try {
    ensureCultivationSchema(db);
    const bounds = cultivationBounds(config);
    const now = input.now ?? nowIso();
    if (!Number.isFinite(Date.parse(now))) return { acquired: false, lease: null };
    if (typeof input.owner !== "string" || input.owner.length === 0) {
      return { acquired: false, lease: null };
    }
    const ttl =
      typeof input.ttlMs === "number" && Number.isFinite(input.ttlMs)
        ? Math.max(1000, Math.min(Math.floor(input.ttlMs), 600000))
        : bounds.leaseTtlMs;
    const expiresAt = new Date(Date.parse(now) + ttl).toISOString();
    // Atomic availability check + insert/steal: one IMMEDIATE write
    // transaction so two concurrent acquirers cannot both observe an empty or
    // expired lease and both return acquired:true (single-flight). A lock
    // contender that cannot begin fails closed as refused (caller retries).
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = db
        .prepare(`SELECT owner, expiresAt, scope, batchId FROM cultivation_lease WHERE leaseId = 'm3'`)
        .get() as
        | { owner: string; expiresAt: string; scope: string | null; batchId: string | null }
        | undefined;
      if (row && row.expiresAt > now) {
        if (row.owner === input.owner) {
          // Same-execution re-acquire refreshes the TTL (heartbeat/renewal).
          // Owners are unique per distill execution (caller key + nonce), so a
          // concurrent retry under the same caller key holds a different owner
          // and is correctly refused below instead of hijacking the lease.
          db.prepare(
            `UPDATE cultivation_lease SET expiresAt = ?, scope = ?, updatedAt = ? WHERE leaseId = 'm3' AND owner = ?`,
          ).run(expiresAt, input.scope ?? row.scope, now, input.owner);
          db.exec("COMMIT");
          return {
            acquired: true,
            lease: { owner: row.owner, expiresAt, scope: input.scope ?? row.scope, batchId: row.batchId },
          };
        }
        db.exec("ROLLBACK");
        return {
          acquired: false,
          lease: { owner: row.owner, expiresAt: row.expiresAt, scope: row.scope, batchId: row.batchId },
        };
      }
      // No live lease (missing or expired): reclaim crashed orphans first,
      // while the lease still reads expired, then take the lease. Reclaim
      // runs inside this same transaction (no nested txn) and is best-effort.
      try {
        reclaimExpiredCultivationLeases(db, config, now);
      } catch {
        /* reclaim is best-effort */
      }
      db.prepare(
        `INSERT INTO cultivation_lease(leaseId, owner, expiresAt, scope, batchId, updatedAt)
         VALUES ('m3', ?, ?, ?, NULL, ?)
         ON CONFLICT(leaseId) DO UPDATE SET owner=excluded.owner, expiresAt=excluded.expiresAt,
           scope=excluded.scope, batchId=NULL, updatedAt=excluded.updatedAt`,
      ).run(input.owner, expiresAt, input.scope ?? null, now);
      db.exec("COMMIT");
      return {
        acquired: true,
        lease: { owner: input.owner, expiresAt, scope: input.scope ?? null, batchId: null },
      };
    } catch {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      return { acquired: false, lease: null };
    }
  } catch {
    return { acquired: false, lease: null };
  }
}

/**
 * Fence check: true only while the lease row is live and owned by `owner`.
 * Used before apply commits so a stolen/expired lease cannot silently commit
 * decisions made under a dead generation. Never throws.
 */
export function isCultivationLeaseHeldBy(db: DatabaseSync, owner: string, now?: string): boolean {
  try {
    ensureCultivationSchema(db);
    const ts = now ?? nowIso();
    if (!Number.isFinite(Date.parse(ts))) return false;
    const row = db
      .prepare(`SELECT owner, expiresAt FROM cultivation_lease WHERE leaseId = 'm3'`)
      .get() as { owner: string; expiresAt: string } | undefined;
    return !!row && row.owner === owner && row.expiresAt > ts;
  } catch {
    return false;
  }
}

/** Release the lease; only the owning holder can release. Never throws. */
export function releaseCultivationLease(
  db: DatabaseSync,
  owner: string,
): boolean {
  try {
    ensureCultivationSchema(db);
    const row = db
      .prepare(`SELECT owner FROM cultivation_lease WHERE leaseId = 'm3'`)
      .get() as { owner: string } | undefined;
    if (!row || row.owner !== owner) return false;
    db.prepare(`DELETE FROM cultivation_lease WHERE leaseId = 'm3' AND owner = ?`).run(owner);
    return true;
  } catch {
    return false;
  }
}

/**
 * Reclaim orphaned 'leased' rows (crash support): when the lease row is
 * missing or expired, leased reviews return to pending with attempts+1 and a
 * capped backoff; rows past reviewMaxAttempts are marked failed. Returns the
 * number reclaimed. Never throws.
 */
export function reclaimExpiredCultivationLeases(
  db: DatabaseSync,
  config: AppConfig,
  now?: string,
): number {
  try {
    ensureCultivationSchema(db);
    const bounds = cultivationBounds(config);
    const ts = now ?? nowIso();
    if (!Number.isFinite(Date.parse(ts))) return 0;
    const lease = db
      .prepare(`SELECT expiresAt FROM cultivation_lease WHERE leaseId = 'm3'`)
      .get() as { expiresAt: string } | undefined;
    if (lease && lease.expiresAt > ts) return 0; // live lease: leased rows still belong to it
    const orphaned = db
      .prepare(`SELECT queueId, attempts FROM cultivation_queue WHERE status = 'leased'`)
      .all() as Array<{ queueId: string; attempts: number }>;
    let n = 0;
    for (const r of orphaned) {
      const attempts = r.attempts + 1;
      if (attempts >= bounds.reviewMaxAttempts) {
        db.prepare(`UPDATE cultivation_queue SET status='failed', attempts=?, batchId=NULL WHERE queueId=?`).run(
          attempts,
          r.queueId,
        );
      } else {
        const nextAt = new Date(Date.parse(ts) + cultivationBackoffMs(attempts)).toISOString();
        db.prepare(
          `UPDATE cultivation_queue SET status='pending', attempts=?, nextAt=?, batchId=NULL WHERE queueId=?`,
        ).run(attempts, nextAt, r.queueId);
      }
      n++;
    }
    return n;
  } catch {
    return 0;
  }
}

/** Explicitly cancel one queued review (pending/leased only). Never throws. */
export function cancelCultivationReview(
  db: DatabaseSync,
  queueId: string,
): boolean {
  try {
    ensureCultivationSchema(db);
    const res = db
      .prepare(
        `UPDATE cultivation_queue SET status='cancelled', batchId=NULL WHERE queueId=? AND status IN ('pending','leased')`,
      )
      .run(queueId) as unknown as { changes?: unknown };
    const c = (res as { changes?: unknown })?.changes;
    return (typeof c === "number" ? c : 0) === 1;
  } catch {
    return false;
  }
}

/**
 * Opaque resume cursor for dequeue paging. Format "<nextAt>|<queueId>" so the
 * keyset filter matches the dequeue ORDER BY (nextAt ASC, queueId ASC): a
 * plain max-queueId marker would skip rows whose nextAt is newer but whose id
 * sorts smaller. Cursors issued before this format (bare queueId, no "|")
 * are treated as legacy queueId markers.
 */
export function encodeCultivationCursor(nextAt: string, queueId: string): string {
  return `${nextAt}|${queueId}`;
}

export function parseCultivationCursor(
  cursor: string | null | undefined,
): { nextAt: string; queueId: string } | { legacyQueueId: string } | null {
  if (typeof cursor !== "string" || cursor.length < 1 || cursor.length > 256) return null;
  if (/[\u0000-\u001F\u007F-\u009F]/.test(cursor)) return null;
  const sep = cursor.indexOf("|");
  if (sep < 0) return { legacyQueueId: cursor };
  const nextAt = cursor.slice(0, sep);
  const queueId = cursor.slice(sep + 1);
  if (!Number.isFinite(Date.parse(nextAt))) return { legacyQueueId: cursor };
  if (queueId.length < 1 || queueId.length > 256) return { legacyQueueId: cursor };
  return { nextAt, queueId };
}

/**
 * Dequeue a bounded due batch for the lease holder (single scope). Marks rows
 * leased with the new batchId. Requires a live lease owned by `owner`.
 * Paging uses the (nextAt, queueId) keyset so no due row is skipped:
 * composite cursors filter (nextAt, queueId) past the marker in dequeue
 * order; legacy bare-queueId cursors keep the old queueId>marker filter.
 * Never throws (returns empty batch when unauthorized/empty).
 */
export function dequeueCultivationBatch(
  db: DatabaseSync,
  config: AppConfig,
  input: { owner: string; scope: string; limit?: number; now?: string; cursor?: string | null },
): { batchId: string | null; items: CultivationReview[] } {
  try {
    ensureCultivationSchema(db);
    const bounds = cultivationBounds(config);
    const ts = input.now ?? nowIso();
    if (!Number.isFinite(Date.parse(ts))) return { batchId: null, items: [] };
    const lease = db
      .prepare(`SELECT owner, expiresAt FROM cultivation_lease WHERE leaseId = 'm3'`)
      .get() as { owner: string; expiresAt: string } | undefined;
    if (!lease || lease.owner !== input.owner || lease.expiresAt <= ts) {
      return { batchId: null, items: [] };
    }
    const cap =
      typeof input.limit === "number" && Number.isInteger(input.limit) && input.limit >= 1
        ? Math.min(input.limit, bounds.batchMax)
        : bounds.batchMax;
    const parsed = parseCultivationCursor(input.cursor ?? null);
    let filter = "";
    let args: Array<string | number> = [input.scope, ts];
    if (parsed && "nextAt" in parsed) {
      filter = "AND (nextAt > ? OR (nextAt = ? AND queueId > ?))";
      args = [input.scope, ts, parsed.nextAt, parsed.nextAt, parsed.queueId];
    } else if (parsed && "legacyQueueId" in parsed) {
      // Legacy bare-queueId marker (pre-composite cursors): resolve its nextAt
      // so the same (nextAt, queueId) keyset applies and no due row is
      // skipped. Unknown markers (row gone) restart from the head.
      let markerNextAt: string | null = null;
      try {
        const mrow = db
          .prepare(`SELECT nextAt FROM cultivation_queue WHERE queueId = ?`)
          .get(parsed.legacyQueueId) as { nextAt: string } | undefined;
        if (mrow && Number.isFinite(Date.parse(mrow.nextAt))) markerNextAt = mrow.nextAt;
      } catch {
        markerNextAt = null;
      }
      if (markerNextAt !== null) {
        filter = "AND (nextAt > ? OR (nextAt = ? AND queueId > ?))";
        args = [input.scope, ts, markerNextAt, markerNextAt, parsed.legacyQueueId];
      }
    }
    const rows = db
      .prepare(
        `SELECT queueId, recordId, scope, trigger, status, attempts, nextAt, createdAt, runId, batchId
         FROM cultivation_queue WHERE status='pending' AND scope=? AND nextAt <= ?
         ${filter}
         ORDER BY nextAt ASC, queueId ASC LIMIT ?`,
      )
      .all(...([...args, cap] as unknown as [])) as unknown as CultivationReview[];
    if (rows.length === 0) return { batchId: null, items: [] };
    const batchId = genId("cult");
    for (const r of rows) {
      db.prepare(`UPDATE cultivation_queue SET status='leased', batchId=? WHERE queueId=? AND status='pending'`).run(
        batchId,
        r.queueId,
      );
    }
    db.prepare(`UPDATE cultivation_lease SET batchId=?, updatedAt=? WHERE leaseId='m3'`).run(batchId, ts);
    const items = db
      .prepare(
        `SELECT queueId, recordId, scope, trigger, status, attempts, nextAt, createdAt, runId, batchId
         FROM cultivation_queue WHERE batchId=? ORDER BY nextAt ASC, queueId ASC`,
      )
      .all(batchId) as unknown as CultivationReview[];
    return { batchId, items };
  } catch {
    return { batchId: null, items: [] };
  }
}

/**
 * Settle one queued review: done/cancelled are terminal; failed retries with
 * capped backoff until reviewMaxAttempts, then terminal failed. Never throws.
 *
 * Optional `guard.batchId` restricts the settle to rows still leased under
 * that batch: rows reclaimed or re-leased by a newer lease owner (different
 * batchId, or back to pending with batchId NULL) are left untouched for the
 * owner/reclaim path instead of being reset by a stale execution. Returns
 * false when the guard does not match (nothing settled).
 */
export function completeCultivationReview(
  db: DatabaseSync,
  config: AppConfig,
  queueId: string,
  outcome: "done" | "failed" | "cancelled",
  now?: string,
  guard?: { batchId: string },
): boolean {
  try {
    ensureCultivationSchema(db);
    const bounds = cultivationBounds(config);
    const ts = now ?? nowIso();
    if (!Number.isFinite(Date.parse(ts))) return false;
    if (outcome === "done" || outcome === "cancelled") {
      const res = guard
        ? db
            .prepare(
              `UPDATE cultivation_queue SET status=?, batchId=NULL WHERE queueId=? AND status='leased' AND batchId=?`,
            )
            .run(outcome, queueId, guard.batchId)
        : db
            .prepare(
              `UPDATE cultivation_queue SET status=?, batchId=NULL WHERE queueId=? AND status IN ('pending','leased')`,
            )
            .run(outcome, queueId) as unknown as { changes?: unknown };
      const c = (res as { changes?: unknown })?.changes;
      return (typeof c === "number" ? c : 0) === 1;
    }
    if (guard) {
      const row = db
        .prepare(`SELECT attempts FROM cultivation_queue WHERE queueId=? AND status='leased' AND batchId=?`)
        .get(queueId, guard.batchId) as { attempts: number } | undefined;
      if (!row) return false;
      const attempts = row.attempts + 1;
      if (attempts >= bounds.reviewMaxAttempts) {
        db.prepare(`UPDATE cultivation_queue SET status='failed', attempts=?, batchId=NULL WHERE queueId=? AND status='leased' AND batchId=?`).run(
          attempts,
          queueId,
          guard.batchId,
        );
      } else {
        const nextAt = new Date(Date.parse(ts) + cultivationBackoffMs(attempts)).toISOString();
        db.prepare(
          `UPDATE cultivation_queue SET status='pending', attempts=?, nextAt=?, batchId=NULL WHERE queueId=? AND status='leased' AND batchId=?`,
        ).run(attempts, nextAt, queueId, guard.batchId);
      }
      return true;
    }
    const row = db
      .prepare(`SELECT attempts FROM cultivation_queue WHERE queueId=? AND status IN ('pending','leased')`)
      .get(queueId) as { attempts: number } | undefined;
    if (!row) return false;
    const attempts = row.attempts + 1;
    if (attempts >= bounds.reviewMaxAttempts) {
      db.prepare(`UPDATE cultivation_queue SET status='failed', attempts=?, batchId=NULL WHERE queueId=?`).run(
        attempts,
        queueId,
      );
    } else {
      const nextAt = new Date(Date.parse(ts) + cultivationBackoffMs(attempts)).toISOString();
      db.prepare(
        `UPDATE cultivation_queue SET status='pending', attempts=?, nextAt=?, batchId=NULL WHERE queueId=?`,
      ).run(attempts, nextAt, queueId);
    }
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Bounded transactional cultivation apply (for the next LLM worker)    */
/* ------------------------------------------------------------------ */

export type CultivationDecision = "keep" | "retire" | "reactivate" | "consolidate";

export interface CultivationSummaryInput {
  body: string;
  provenance: { source: string; observedAt: string };
  tags?: string[];
  links?: string[];
  sourceRefs?: SourceRef[];
}

export interface CultivationAction {
  recordId: string;
  action: CultivationDecision;
  /** Optimistic guard: skip (stale) when the row revision differs. */
  expectedRevision?: number;
  /** Optimistic guard: skip (stale) when the row status differs. */
  expectedStatus?: "active" | "retired";
  /**
   * Consolidation peer guard: the second source of a merge, re-validated
   * atomically in the apply transaction. A peer corrected, retired, or
   * archived after inference (stale body) becomes a per-action CONFLICT
   * no-change instead of a summary derived from stale content.
   */
  peer?: {
    recordId: string;
    expectedRevision?: number;
    expectedStatus?: "active" | "retired";
  };
  /** Required for retire/reactivate (fixed codes, metadata-only audit). */
  reasonCode?: string;
  /** Required for consolidate (real summary insert). */
  summary?: CultivationSummaryInput;
}

export interface CultivationApplyInput {
  /** Single scope for the whole batch (scoped bounded context). */
  scope: string;
  runId?: string | null;
  /** Caller-supplied idempotency key (required; per-batch operation row). */
  idempotencyKey: string;
  actions: CultivationAction[];
  /**
   * Atomic cancellation/ownership fence (optional; used by maintain.distill).
   * When present, each mutating action is applied only while its queue row is
   * still leased under `batchId`; a row cancelled (or otherwise moved) before
   * the commit becomes a per-action CONFLICT no-change, so a cancelled review
   * can never mutate its record. When `owner` is present the whole batch also
   * requires the m3 lease to still be live and owned by it, else the batch
   * fails CONFLICT with nothing applied.
   */
  fence?: {
    owner?: string;
    batchId?: string;
    guards?: Array<{ queueId: string; recordId: string }>;
  };
}

export interface CultivationActionResult {
  recordId: string;
  action: CultivationDecision;
  applied: boolean;
  code: string;
  summaryId?: string;
}

function emptySummaryRefsAllowed(source: string): boolean {
  return /derived/i.test(source);
}

/**
 * Apply one bounded batch of already-decided cultivation actions in a SINGLE
 * transaction with ONE operations row (idempotencyKey) plus per-action audit
 * rows (metadata only: no bodies). Conservative: unknown/invalid/stale
 * actions are per-action no-change (reported + audited), never a batch
 * failure. No raw/record DELETEs: retire/reactivate only flip active<->retired
 * and consolidate only INSERTs summary rows (history kept; sources never
 * auto-retired — retirement stays explicit).
 */
export function applyCultivationBatch(
  db: DatabaseSync,
  config: AppConfig,
  input: CultivationApplyInput,
  nowOverride?: string,
): ResponseEnvelope {
  if (!isPlainObject(input as unknown as Record<string, unknown>)) {
    return budgeted(bad(), config);
  }
  if (containsLoneSurrogateDeep(input)) return budgeted(bad(), config);
  const nScope = parseScope(input.scope);
  if (!nScope) return budgeted(bad(), config);
  const nRunId = parseRunId(input.runId);
  if (nRunId === "invalid") return budgeted(bad(), config);
  if (!Array.isArray(input.actions) || input.actions.length === 0) return budgeted(bad(), config);
  const bounds = cultivationBounds(config);
  if (input.actions.length > bounds.batchMax) return budgeted(limitExceeded(), config);
  if (
    typeof input.idempotencyKey !== "string" ||
    !/^[A-Za-z0-9_-]{1,128}$/.test(input.idempotencyKey)
  ) {
    return budgeted(bad(), config);
  }

  const reqHash = requestHashFor("maintain.cultivate", {
    actions: input.actions,
    runId: nRunId,
    scope: nScope,
  });

  let saved: { op: string; requestHash: string; responseJson: string } | null = null;
  try {
    ensureCultivationSchema(db);
    saved = db
      .prepare(`SELECT op, requestHash, responseJson FROM operations WHERE idempotencyKey = ?`)
      .get(input.idempotencyKey) as
      | { op: string; requestHash: string; responseJson: string }
      | undefined ?? null;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "maintain.cultivate") return budgeted(fail("CONFLICT"), config);
    try {
      if (!isScopeAuthorized(db, config, nScope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    try {
      const parsed = JSON.parse(saved.responseJson) as ResponseEnvelope;
      return budgeted({ ...parsed, deduplicated: true }, config);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
  }
  try {
    if (!isScopeAuthorized(db, config, nScope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);

  try {
    return withTransaction(db, (): ResponseEnvelope => {
      // Generation fence: when the caller holds the single-flight lease, the
      // batch commits only while that lease is still live and owned by the
      // same execution. A stolen/expired lease fails the whole batch with no
      // mutation (caller retries under its new generation).
      if (input.fence?.owner) {
        let held = false;
        try {
          const lease = db
            .prepare(`SELECT owner, expiresAt FROM cultivation_lease WHERE leaseId = 'm3'`)
            .get() as { owner: string; expiresAt: string } | undefined;
          held = !!lease && lease.owner === input.fence.owner && lease.expiresAt > now;
        } catch {
          throw new Error("read failed");
        }
        if (!held) throw new Error("lease lost");
      }
      const guards = input.fence?.guards;
      const fenceBatch = input.fence?.batchId;
      const results: CultivationActionResult[] = [];
      const newIds: string[] = [];
      let applied = 0;

      for (const a of input.actions) {
        const skip = (code: string): void => {
          results.push({ recordId: typeof a?.recordId === "string" ? a.recordId : "", action: a?.action, applied: false, code });
          auditInsert(db, {
            ts: now,
            op: "maintain.cultivate",
            targetId: typeof a?.recordId === "string" ? a.recordId : null,
            code,
            scope: nScope,
            bytes: null,
            limitN: null,
            runId: nRunId,
            recallId: null,
            reasonCode: typeof a?.reasonCode === "string" ? a.reasonCode : null,
          });
        };
        if (!isPlainObject(a as unknown as Record<string, unknown>)) {
          skip("BAD_REQUEST");
          continue;
        }
        const { recordId, action, expectedRevision, expectedStatus, reasonCode, summary } = a;
        if (
          typeof recordId !== "string" ||
          recordId.length === 0 ||
          recordId.length > 256 ||
          hasControl(recordId) ||
          (action !== "keep" && action !== "retire" && action !== "reactivate" && action !== "consolidate")
        ) {
          skip("BAD_REQUEST");
          continue;
        }
        let target: { scope: string; status: string; revision: number; privacySensitivity: string | null } | undefined;
        try {
          target = db
            .prepare(`SELECT scope, status, revision, privacySensitivity FROM records WHERE id = ?`)
            .get(recordId) as { scope: string; status: string; revision: number; privacySensitivity: string | null } | undefined;
        } catch {
          throw new Error("read failed");
        }
        if (!target) {
          skip("NOT_FOUND");
          continue;
        }
        if (target.scope !== nScope) {
          skip("FORBIDDEN_SCOPE");
          continue;
        }
        if (
          (expectedRevision !== undefined &&
            (!Number.isInteger(expectedRevision) || expectedRevision !== target.revision)) ||
          (expectedStatus !== undefined && expectedStatus !== target.status)
        ) {
          skip("CONFLICT"); // stale decision: conservative no-change
          continue;
        }

        if (action === "keep") {
          results.push({ recordId, action, applied: false, code: "OK" });
          auditInsert(db, {
            ts: now, op: "maintain.cultivate", targetId: recordId, code: "OK",
            scope: nScope, bytes: null, limitN: null, runId: nRunId, recallId: null, reasonCode: null,
          });
          continue;
        }

        // Atomic cancellation fence: a mutating action commits only while its
        // queue row is still leased under the same batch. Cancelled (or
        // settled/retried) rows become audited CONFLICT no-change.
        if (guards && fenceBatch) {
          const g = guards.find((x) => x.recordId === recordId);
          if (g) {
            let live = false;
            try {
              const q = db
                .prepare(`SELECT status, batchId FROM cultivation_queue WHERE queueId = ?`)
                .get(g.queueId) as { status: string; batchId: string | null } | undefined;
              live = !!q && q.status === "leased" && q.batchId === fenceBatch;
            } catch {
              throw new Error("read failed");
            }
            if (!live) {
              skip("CONFLICT");
              continue;
            }
          }
        }

        if (action === "retire" || action === "reactivate") {
          const allowed = action === "retire" ? RETIRE_REASONS : REACTIVATE_REASONS;
          if (typeof reasonCode !== "string" || !(allowed as readonly string[]).includes(reasonCode)) {
            skip("BAD_REQUEST");
            continue;
          }
          if (action === "retire") {
            if (target.status === "retired") {
              results.push({ recordId, action, applied: false, code: "OK" }); // idempotent no-op
            } else if (target.status !== "active") {
              skip("CONFLICT"); // superseded/archived are not reversible here
              continue;
            } else {
              db.prepare(`UPDATE records SET status='retired' WHERE id=? AND status='active' AND scope=?`).run(
                recordId,
                nScope,
              );
              applied++;
              results.push({ recordId, action, applied: true, code: "OK" });
              newIds.push(recordId);
            }
          } else {
            if (target.status === "active") {
              results.push({ recordId, action, applied: false, code: "OK" }); // idempotent no-op
            } else if (target.status !== "retired") {
              skip("CONFLICT");
              continue;
            } else {
              db.prepare(`UPDATE records SET status='active' WHERE id=? AND status='retired' AND scope=?`).run(
                recordId,
                nScope,
              );
              applied++;
              results.push({ recordId, action, applied: true, code: "OK" });
              newIds.push(recordId);
            }
          }
          auditInsert(db, {
            ts: now, op: "maintain.cultivate", targetId: recordId, code: "OK",
            scope: nScope, bytes: null, limitN: null, runId: nRunId, recallId: null, reasonCode,
          });
          continue;
        }

        // consolidate: real summary insert, history kept, no auto-retire.
        // Peer guard: when the caller names the second merge source, its
        // revision/status are re-validated atomically here (same txn). A peer
        // corrected/retired/archived after inference is stale: conservative
        // CONFLICT no-change, never a summary from the stale body. Links are
        // additionally required to resolve to existing same-scope rows below.
        // F-I01-05: the peer's privacy sensitivity is captured here too and
        // propagated to the summary via the single deriveConsolidationPrivacy
        // helper (sensitive wins, all-known => normal, unknown => null).
        let peerPrivacySensitivity: string | null = null;
        if (isPlainObject(a.peer as unknown as Record<string, unknown>)) {
          const peer = a.peer as NonNullable<CultivationAction["peer"]>;
          if (
            typeof peer.recordId !== "string" ||
            peer.recordId.length === 0 ||
            peer.recordId.length > 256 ||
            hasControl(peer.recordId) ||
            peer.recordId === recordId
          ) {
            skip("BAD_REQUEST");
            continue;
          }
          let peerRow: { scope: string; status: string; revision: number; privacySensitivity: string | null } | undefined;
          try {
            peerRow = db
              .prepare(`SELECT scope, status, revision, privacySensitivity FROM records WHERE id = ?`)
              .get(peer.recordId) as { scope: string; status: string; revision: number; privacySensitivity: string | null } | undefined;
          } catch {
            throw new Error("read failed");
          }
          if (!peerRow || peerRow.scope !== nScope || peerRow.status !== "active") {
            skip(!peerRow ? "NOT_FOUND" : peerRow.scope !== nScope ? "FORBIDDEN_SCOPE" : "CONFLICT");
            continue;
          }
          if (
            (peer.expectedRevision !== undefined &&
              (!Number.isInteger(peer.expectedRevision) || peer.expectedRevision !== peerRow.revision)) ||
            (peer.expectedStatus !== undefined && peer.expectedStatus !== peerRow.status)
          ) {
            skip("CONFLICT"); // peer went stale after inference: no summary
            continue;
          }
          peerPrivacySensitivity = peerRow.privacySensitivity;
        }
        if (!isPlainObject(summary as unknown as Record<string, unknown>)) {
          skip("BAD_REQUEST");
          continue;
        }
        const s = summary as CultivationSummaryInput;
        if (typeof s.body !== "string") {
          skip("BAD_REQUEST");
          continue;
        }
        if (countCp(s.body) > config.limits.bodyMaxCp) {
          skip("LIMIT_EXCEEDED");
          continue;
        }
        const nBody = normalizeBody(s.body);
        if (countCp(nBody) < 1 || countCp(nBody) > config.limits.bodyMaxCp) {
          skip("BAD_REQUEST");
          continue;
        }
        const prov = parseProvenance(s.provenance);
        if (!prov) {
          skip("BAD_REQUEST");
          continue;
        }
        // tags: normalized, bounded (reuse remember limits).
        let nTags: string[] | null = null;
        if (s.tags !== undefined) {
          if (!Array.isArray(s.tags) || s.tags.length > config.limits.tagsMax) {
            skip(Array.isArray(s.tags) ? "LIMIT_EXCEEDED" : "BAD_REQUEST");
            continue;
          }
          const seen = new Set<string>();
          let badTag = false;
          for (const t of s.tags) {
            if (typeof t !== "string" || hasControl(t)) {
              badTag = true;
              break;
            }
            const nt = normalizeTag(t);
            if (countCp(nt) < 1 || countCp(nt) > 256) {
              badTag = true;
              break;
            }
            seen.add(nt);
          }
          if (badTag) {
            skip("BAD_REQUEST");
            continue;
          }
          nTags = [...seen].sort();
        } else {
          nTags = [];
        }
        // links: same-context (must resolve to existing SAME-scope records).
        let nLinks: string[] | null = null;
        if (s.links !== undefined) {
          if (!Array.isArray(s.links) || s.links.length > config.limits.linksMax) {
            skip(Array.isArray(s.links) ? "LIMIT_EXCEEDED" : "BAD_REQUEST");
            continue;
          }
          const seen = new Set<string>();
          let badLink = false;
          for (const l of s.links) {
            if (typeof l !== "string") {
              badLink = true;
              break;
            }
            const ll = countCp(l);
            if (ll < 1 || ll > 256 || hasControl(l)) {
              badLink = true;
              break;
            }
            const nl = normalizeField(l, false);
            if (countCp(nl) < 1 || countCp(nl) > 256) {
              badLink = true;
              break;
            }
            let ref: { scope: string } | undefined;
            try {
              ref = db.prepare(`SELECT scope FROM records WHERE id = ?`).get(nl) as
                | { scope: string }
                | undefined;
            } catch {
              throw new Error("read failed");
            }
            if (!ref || ref.scope !== nScope) {
              badLink = true; // dangling or cross-scope: conservative no-change
              break;
            }
            seen.add(nl);
          }
          if (badLink) {
            skip("CONFLICT");
            continue;
          }
          nLinks = [...seen].sort();
        } else {
          nLinks = [];
        }
        // sourceRefs: union the caller supplies; each must exist same-scope.
        // Entries are either legacy eventId strings or code-point spans; the
        // union preserves (eventId,start,end) so consolidation never drops
        // span provenance. SPAN bounds are checked against the raw body.
        let nRefs: SourceRef[] | null = null;
        if (s.sourceRefs !== undefined) {
          const parsedRefs = parseSourceRefsParam(s.sourceRefs, config.limits.sourceRefsMax);
          if (parsedRefs === "bad") {
            skip("BAD_REQUEST");
            continue;
          }
          if (parsedRefs === "over") {
            skip("LIMIT_EXCEEDED");
            continue;
          }
          let missing: string | null = null;
          let forbidden = false;
          for (const r of parsedRefs) {
            const eventId = typeof r === "string" ? r : r.eventId;
            let row: { scope: string; body: string } | undefined;
            try {
              row = db.prepare(`SELECT scope, body FROM raw_events WHERE eventId = ?`).get(eventId) as
                | { scope: string; body: string }
                | undefined;
            } catch {
              throw new Error("read failed");
            }
            if (!row) {
              missing = "NOT_FOUND";
              break;
            }
            if (row.scope !== nScope) {
              forbidden = true;
              break;
            }
            if (typeof r !== "string" && r.end > countCp(row.body)) {
              missing = "BAD_REQUEST";
              break;
            }
          }
          if (missing) {
            skip(missing);
            continue;
          }
          if (forbidden) {
            skip("FORBIDDEN_SCOPE");
            continue;
          }
          nRefs = parsedRefs;
        } else {
          nRefs = [];
        }
        if (nRefs.length === 0 && !emptySummaryRefsAllowed(prov.source)) {
          skip("BAD_REQUEST");
          continue;
        }
        const summaryId = genId("rec");
        const probe: ResponseEnvelope = ok({ cultivation: { summaryId } });
        if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
        // F-I01-05: derived summaries always carry origin "self_activity";
        // sensitivity follows the propagation helper over the merge sources.
        const summaryPrivacy = deriveConsolidationPrivacy([target.privacySensitivity, peerPrivacySensitivity]);
        db.prepare(
          `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt, privacySensitivity, privacyOrigin)
           VALUES (?, ?, ?, ?, 'summary', ?, ?, ?, 'active', NULL, 1, ?, ?, ?)`,
        ).run(summaryId, s.body, nBody, bodyHashFor(nBody), prov.source, prov.observedAt, nScope, now,
          summaryPrivacy === null ? null : summaryPrivacy.sensitivity, summaryPrivacy === null ? null : summaryPrivacy.origin);
        for (const t of nTags) db.prepare(`INSERT INTO record_tags(recordId, tag) VALUES (?, ?)`).run(summaryId, t);
        for (const l of nLinks) db.prepare(`INSERT INTO record_links(fromId, toRef) VALUES (?, ?)`).run(summaryId, l);
        {
          const refStmt = db.prepare(
            `INSERT INTO record_source_refs(recordId, eventId, spanStart, spanEnd) VALUES (?, ?, ?, ?)`,
          );
          for (const r of storedSourceRefs(nRefs)) {
            refStmt.run(summaryId, r.eventId, r.start, r.end);
          }
        }
        db.prepare(`INSERT OR IGNORE INTO note_heat(recordId, usedCount, lastUsedAt) VALUES (?, 0, ?)`).run(summaryId, now);
        applied++;
        results.push({ recordId, action, applied: true, code: "OK", summaryId });
        newIds.push(summaryId);
        auditInsert(db, {
          ts: now, op: "maintain.cultivate", targetId: summaryId, code: "OK",
          scope: nScope, bytes: null, limitN: null, runId: nRunId, recallId: null, reasonCode: null,
        });
      }

      const stored = budgeted(
        ok({ cultivation: { applied, skipped: results.length - applied, results } }),
        config,
      );
      if (!stored.ok) throw new Error("response over budget");
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(input.idempotencyKey, "maintain.cultivate", reqHash, JSON.stringify(stored), now);
      auditInsert(db, {
        ts: now, op: "maintain.cultivate", targetId: null, code: stored.code,
        scope: nScope, bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: results.length, runId: nRunId, recallId: null, reasonCode: null,
      });
      // Capacity gate (logical size; physical WAL sidecars are covered by the
      // write-path checks in store.ts): over-cap batches roll back, never
      // delete or truncate.
      try {
        const pc = db.prepare(`PRAGMA page_count`).get() as { page_count: number } | undefined;
        const ps = db.prepare(`PRAGMA page_size`).get() as { page_size: number } | undefined;
        if ((pc?.page_count ?? 0) * (ps?.page_size ?? 0) > config.dbMaxBytes) {
          throw new Error("db over cap");
        }
      } catch (e) {
        if (e instanceof Error && e.message === "db over cap") throw e;
        /* PRAGMA failure is best-effort; real I/O failures surface below */
      }
      // Projection is post-commit only; enqueue inside txn is safe because the
      // queue table rolls back with the batch (unlike vault files).
      for (const id of newIds) {
        try {
          enqueueProjection(db, id);
        } catch {
          /* best-effort */
        }
      }
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "lease lost") return budgeted(fail("CONFLICT"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: { op: string; requestHash: string; responseJson: string } | null = null;
      try {
        again = db
          .prepare(`SELECT op, requestHash, responseJson FROM operations WHERE idempotencyKey = ?`)
          .get(input.idempotencyKey) as
          | { op: string; requestHash: string; responseJson: string }
          | undefined ?? null;
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "maintain.cultivate" && again.requestHash === reqHash) {
        try {
          const parsed = JSON.parse(again.responseJson) as ResponseEnvelope;
          return budgeted({ ...parsed, deduplicated: true }, config);
        } catch {
          return budgeted(fail("STORE_UNAVAILABLE"), config);
        }
      }
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}
