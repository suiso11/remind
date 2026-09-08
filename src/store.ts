/**
 * T2 domain: candidates + human review/approve/reject atop T1.
 * T4 adds: record.correct-request (correction candidate creation),
 * correction approval (atomic conditional supersede), and human archive.
 * Plan ref: plan.md 14.2/14.4-14.5/14.7 (proposal adopted for T2-T4).
 *
 * Notes / smallest explicit corrections to the plan text:
 * - candidate.get requires {id, scope}: plan 14.2 lists params {id} but 14.5
 *   requires every id lookup (review + candidate.get) to check request scope
 *   vs stored scope. Without a request scope the check is impossible, so T2
 *   requires scope and answers BAD_REQUEST when absent, FORBIDDEN_SCOPE on
 *   mismatch. No body is ever returned on this path.
 * - Human review/approve/reject/archive require --scope for the same reason:
 *   the id lookup must bind to a request scope. Missing scope is BAD_REQUEST.
 * - candidate.create with kind=correction requires a supersedes pointer to an
 *   existing active same-scope record (same rule as record.correct-request);
 *   missing target is NOT_FOUND, scope mismatch FORBIDDEN_SCOPE, inactive
 *   target CONFLICT. Committed idempotent replays bypass the target check so
 *   a stored envelope replays stably after later target moves.
 * - record.recall is implemented here (T3): only status='active' rows match.
 * - Local single-user error semantics (adopted plan, unchanged): id lookups
 *   answer NOT_FOUND when the row is absent, FORBIDDEN_SCOPE on scope
 *   mismatch, CONFLICT when present-but-inactive. This oracle can disclose
 *   id existence to a same-scope caller; accepted as a residual limitation
 *   for the local single-user CLI (no new semantics without agreement).
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  approvalTokenFor,
  bodyHashFor,
  canonicalStringify,
  canonicalTime,
  containsLoneSurrogateDeep,
  countCp,
  hasControl,
  normalizeBody,
  normalizeLink,
  normalizeTag,
  nowIso,
  requestHashFor,
  safeEqual,
  sha256HexUtf8,
} from "./normalize.js";
import { applyResponseBudget, fail, ok, type ResponseEnvelope } from "./protocol.js";

export const CANDIDATE_KINDS = ["user_fact", "model_inference", "correction"] as const;
export const CANDIDATE_STATUSES = ["candidate", "approved", "rejected", "expired"] as const;

export function ensureT2Schema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS candidates(
    id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyHash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','correction')),
    source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
    supersedes TEXT NULL, status TEXT NOT NULL CHECK(status IN ('candidate','approved','rejected','expired')),
    idempotencyKey TEXT NULL, requestHash TEXT NULL,
    createdAt TEXT NOT NULL, expiresAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS candidate_tags(candidateId TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(candidateId, tag))`);
  db.exec(`CREATE TABLE IF NOT EXISTS candidate_links(fromId TEXT PRIMARY KEY, toName TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS records(
    id TEXT PRIMARY KEY, candidateId TEXT UNIQUE NOT NULL, body TEXT NOT NULL, bodyHash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','correction')),
    source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','superseded','archived')),
    supersedes TEXT NULL, createdAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS record_tags(recordId TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(recordId, tag))`);
  db.exec(`CREATE TABLE IF NOT EXISTS record_links(fromId TEXT PRIMARY KEY, toName TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS operations(
    idempotencyKey TEXT PRIMARY KEY, op TEXT NOT NULL, requestHash TEXT NOT NULL,
    responseJson TEXT NOT NULL, createdAt TEXT NOT NULL)`);
  // Metadata-only audit (no body / query / snippet text). Token/approver kept.
  db.exec(`CREATE TABLE IF NOT EXISTS audit(
    ts TEXT NOT NULL, op TEXT NOT NULL, targetId TEXT NULL, code TEXT NOT NULL,
    scope TEXT NULL, bytes INTEGER NULL, limitN INTEGER NULL, runId TEXT NULL,
    recallId TEXT NULL, approver TEXT NULL, approvedAt TEXT NULL, token TEXT NULL,
    reasonCode TEXT NULL)`);
  // T3-owned exposure ledger: created now so T2 commits never need a later migration.
  db.exec(`CREATE TABLE IF NOT EXISTS exposures(
    ts TEXT NOT NULL, recallId TEXT NOT NULL, runId TEXT NULL, scope TEXT NULL,
    recordId TEXT NOT NULL, snippetBytes INTEGER NULL, truncated INTEGER NULL, limitN INTEGER NULL)`);
  // T3 bounded-retrieval indexes (additive migration; existing rows untouched).
  // records(scope,status,createdAt,id) covers the recall pre-filter + fixed
  // order; tag/link PKs already bind (recordId,tag)/(fromId), the extra
  // indexes cover the reverse exact-match direction.
  // Honest note: this bounds host variables and result materialization, but
  // the SQL scan may still examine every row in the scope window (instr
  // predicate); it is not hard constant latency.
  db.exec(`CREATE INDEX IF NOT EXISTS idx_records_scope_status_created_id ON records(scope, status, createdAt, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_record_tags_tag_record ON record_tags(tag, recordId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_record_links_toname_from ON record_links(toName, fromId)`);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Scope authorization tri-state (P2 fix).
 *
 * - Scope absent from startup config => genuine denial (returns false).
 * - Scope present in config but missing from the scopes table => genuine
 *   denial (returns false; the row may have been revoked).
 * - Any scopes-table I/O failure (closed DB, missing/corrupt table, I/O
 *   error) THROWS Error("scope check unavailable"): callers must answer
 *   STORE_UNAVAILABLE, never FORBIDDEN_SCOPE. Returning false here used to
 *   misclassify STORE_UNAVAILABLE as FORBIDDEN_SCOPE.
 */
export function isScopeAuthorized(db: DatabaseSync, config: AppConfig, scope: string): boolean {
  if (!config.allowedScopes.includes(scope)) return false;
  let row: { scope: string } | undefined;
  try {
    row = db.prepare(`SELECT scope FROM scopes WHERE scope = ?`).get(scope) as
      | { scope: string }
      | undefined;
  } catch {
    throw new Error("scope check unavailable");
  }
  return !!row;
}

/** Scope gate for envelope-returning ops: false => FORBIDDEN_SCOPE, throw => STORE_UNAVAILABLE. */
function scopeGate(db: DatabaseSync, config: AppConfig, scope: string): ResponseEnvelope | null {
  try {
    if (!isScopeAuthorized(db, config, scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    return null;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

interface NormalizedCreate {
  body: string;
  bodyHash: string;
  kind: string;
  source: string;
  observedAt: string;
  scope: string;
  tags: string[];
  link: string | null;
  ttlSec: number;
  runId: string | null;
  supersedes: string | null;
}

type ParseResult =
  | { ok: true; value: NormalizedCreate }
  | { ok: false; res: ResponseEnvelope };

function limitExceeded(): ResponseEnvelope {
  return fail("LIMIT_EXCEEDED");
}
function bad(): ResponseEnvelope {
  return fail("BAD_REQUEST");
}

function checkLenCp(s: string, min: number, max: number): "ok" | "short" | "long" {
  const n = countCp(s);
  if (n < min) return "short";
  if (n > max) return "long";
  return "ok";
}

/** Validate + normalize candidate.create params (no DB writes). */
export function parseCreateParams(
  config: AppConfig,
  params: Record<string, unknown>,
): ParseResult {
  // Direct-call hardening (mirrors the protocol envelope): any unpaired
  // surrogate in any param string is BAD_REQUEST with no mutation.
  if (containsLoneSurrogateDeep(params)) return { ok: false, res: bad() };
  const allowed = new Set(["body", "kind", "provenance", "scope", "tags", "link", "ttlSec", "runId", "supersedes"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: bad() };
  }
  if (containsLoneSurrogateDeep(Object.keys(params))) return { ok: false, res: bad() };
  const { body, kind, provenance, scope, tags, link, ttlSec, runId, supersedes } = params;

  if (typeof body !== "string") return { ok: false, res: bad() };
  if (checkLenCp(body, 1, config.limits.bodyMaxCp) === "long") return { ok: false, res: limitExceeded() };
  const nBody = normalizeBody(body);
  const bodyLen = checkLenCp(nBody, 1, Math.min(2000, config.limits.bodyMaxCp));
  if (bodyLen === "short") return { ok: false, res: bad() };
  if (bodyLen === "long") return { ok: false, res: limitExceeded() };

  if (typeof kind !== "string" || !(CANDIDATE_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, res: bad() };
  }
  if (!isPlainObject(provenance)) return { ok: false, res: bad() };
  const pKeys = Object.keys(provenance);
  if (pKeys.length !== 2 || !pKeys.includes("source") || !pKeys.includes("observedAt")) {
    return { ok: false, res: bad() };
  }
  const source = provenance["source"];
  const observedAt = provenance["observedAt"];
  if (typeof source !== "string") return { ok: false, res: bad() };
  const srcLen = checkLenCp(source, 1, 256);
  if (srcLen === "long") return { ok: false, res: limitExceeded() };
  if (srcLen === "short" || hasControl(source)) return { ok: false, res: bad() };
  const canonObs = canonicalTime(observedAt);
  if (canonObs === null) return { ok: false, res: bad() };

  if (typeof scope !== "string") return { ok: false, res: bad() };
  const scopeLen = checkLenCp(scope, 1, 256);
  if (scopeLen === "long") return { ok: false, res: limitExceeded() };
  if (scopeLen === "short" || hasControl(scope)) return { ok: false, res: bad() };

  let nTags: string[] = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return { ok: false, res: bad() };
    if (tags.length > config.limits.tagsMax) return { ok: false, res: limitExceeded() };
    const seen = new Set<string>();
    for (const t of tags) {
      if (typeof t !== "string") return { ok: false, res: bad() };
      const tl = checkLenCp(t, 1, 256);
      if (tl === "long") return { ok: false, res: limitExceeded() };
      if (tl === "short" || hasControl(t)) return { ok: false, res: bad() };
      const nt = normalizeTag(t);
      if (countCp(nt) < 1 || countCp(nt) > 256) return { ok: false, res: bad() };
      seen.add(nt);
    }
    nTags = [...seen].sort();
  }

  let nLink: string | null = null;
  if (link !== undefined && link !== null) {
    if (typeof link !== "string") return { ok: false, res: bad() };
    const ll = checkLenCp(link, 1, 256);
    if (ll === "long") return { ok: false, res: limitExceeded() };
    if (ll === "short" || hasControl(link)) return { ok: false, res: bad() };
    const nl = normalizeLink(link);
    if (countCp(nl) < 1 || countCp(nl) > 256) return { ok: false, res: bad() };
    nLink = nl;
  }

  let ttl = config.candidateTtlSec;
  if (ttlSec !== undefined) {
    if (typeof ttlSec !== "number" || !Number.isInteger(ttlSec)) return { ok: false, res: bad() };
    if (ttlSec < 1) return { ok: false, res: bad() };
    if (ttlSec > config.candidateTtlSec) return { ok: false, res: limitExceeded() };
    ttl = ttlSec;
  }

  let nRunId: string | null = null;
  if (runId !== undefined && runId !== null) {
    if (typeof runId !== "string") return { ok: false, res: bad() };
    const rl = checkLenCp(runId, 1, 256);
    if (rl === "long") return { ok: false, res: limitExceeded() };
    if (rl === "short" || hasControl(runId)) return { ok: false, res: bad() };
    nRunId = runId;
  }

  let nSup: string | null = null;
  if (supersedes !== undefined && supersedes !== null) {
    if (typeof supersedes !== "string" || supersedes.length === 0 || supersedes.length > 256) {
      return { ok: false, res: bad() };
    }
    if (hasControl(supersedes)) return { ok: false, res: bad() };
    nSup = supersedes;
  }

  return {
    ok: true,
    value: {
      body: nBody,
      bodyHash: bodyHashFor(nBody),
      kind: kind as string,
      source: source as string,
      observedAt: canonObs,
      scope: scope as string,
      tags: nTags,
      link: nLink,
      ttlSec: ttl,
      runId: nRunId,
      supersedes: nSup,
    },
  };
}

export function normalizedParamsForHash(n: NormalizedCreate): Record<string, unknown> {
  return {
    body: n.body,
    kind: n.kind,
    observedAt: n.observedAt,
    scope: n.scope,
    source: n.source,
    link: n.link,
    runId: n.runId,
    supersedes: n.supersedes,
    tags: n.tags,
    ttlSec: n.ttlSec,
  };
}

function budgeted(res: ResponseEnvelope, config: AppConfig): ResponseEnvelope {
  return applyResponseBudget(res, config.limits.responseMaxBytes);
}

/** Pre-commit budget gate: success envelopes must fit before any mutation commits. */
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

interface StoredOp {
  op: string;
  requestHash: string;
  responseJson: string;
}

function readOperation(db: DatabaseSync, key: string): StoredOp | null {
  // Fail closed: DB I/O failures THROW so callers answer STORE_UNAVAILABLE.
  // Never swallow to null (null means "no prior key", i.e. safe to insert).
  const row = db
    .prepare(`SELECT op, requestHash, responseJson FROM operations WHERE idempotencyKey = ?`)
    .get(key) as StoredOp | undefined;
  return row ?? null;
}

function replaySaved(savedJson: string, config: AppConfig): ResponseEnvelope {
  let parsed: ResponseEnvelope;
  try {
    parsed = JSON.parse(savedJson) as ResponseEnvelope;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  const out: ResponseEnvelope = { ...parsed, deduplicated: true };
  return budgeted(out, config);
}

export interface CandidateRow {
  id: string;
  body: string;
  bodyHash: string;
  kind: string;
  source: string;
  observedAt: string;
  scope: string;
  supersedes: string | null;
  status: string;
  createdAt: string;
  expiresAt: string;
}

export function readCandidate(db: DatabaseSync, id: string): CandidateRow | null {
  try {
    const row = db
      .prepare(`SELECT id, body, bodyHash, kind, source, observedAt, scope, supersedes, status, createdAt, expiresAt FROM candidates WHERE id = ?`)
      .get(id) as CandidateRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

export interface RecordRow {
  id: string;
  candidateId: string;
  body: string;
  bodyHash: string;
  kind: string;
  source: string;
  observedAt: string;
  scope: string;
  status: string;
  supersedes: string | null;
  createdAt: string;
}

/**
 * Record read. THROWS on query failure (fail closed → STORE_UNAVAILABLE);
 * returns null only when the row is genuinely absent. Never fabricate a row:
 * a fabricated "active" target would let a correction approval supersede
 * nothing while minting a new record.
 */
function readRecordOrThrow(db: DatabaseSync, id: string): RecordRow | null {
  const row = db
    .prepare(`SELECT id, candidateId, body, bodyHash, kind, source, observedAt, scope, status, supersedes, createdAt FROM records WHERE id = ?`)
    .get(id) as RecordRow | undefined;
  return row ?? null;
}

/**
 * Correction target gate (creation-time fast path). The approval transaction
 * re-checks atomically with a conditional UPDATE, so this is advisory only.
 * Returns the target row, or an envelope for NOT_FOUND / FORBIDDEN_SCOPE /
 * CONFLICT / STORE_UNAVAILABLE.
 */
function checkCorrectionTarget(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  supersedes: string,
): { ok: true; target: RecordRow } | { ok: false; res: ResponseEnvelope } {
  let target: RecordRow | null;
  try {
    target = readRecordOrThrow(db, supersedes);
  } catch {
    return { ok: false, res: budgeted(fail("STORE_UNAVAILABLE"), config) };
  }
  if (!target) return { ok: false, res: budgeted(fail("NOT_FOUND"), config) };
  if (target.scope !== scope) return { ok: false, res: budgeted(fail("FORBIDDEN_SCOPE"), config) };
  if (target.status !== "active") return { ok: false, res: budgeted(fail("CONFLICT"), config) };
  return { ok: true, target };
}

/** Run-result changes count for conditional UPDATEs (node:sqlite run payload). */
function changedRows(result: unknown): number {
  const c = (result as { changes?: unknown } | null)?.changes;
  if (typeof c === "number" && Number.isSafeInteger(c)) return c;
  if (typeof c === "bigint") return Number(c);
  return 0;
}

/**
 * Candidate metadata reads. These THROW on query failure (corruption,
 * incompatible pre-existing table, I/O error) so every public boundary
 * answers STORE_UNAVAILABLE. They must never substitute an empty tag list
 * / null link: that would report incomplete metadata as success and, worse,
 * bind the approval token to the wrong tag/link set and commit tag-less
 * records. Callers catch the throw and fail closed.
 */
function readTags(db: DatabaseSync, candidateId: string): string[] {
  const rows = db.prepare(`SELECT tag FROM candidate_tags WHERE candidateId = ? ORDER BY tag ASC`).all(candidateId) as Array<{ tag: string }>;
  return rows.map((r) => r.tag);
}

function readLink(db: DatabaseSync, fromId: string): string | null {
  const row = db.prepare(`SELECT toName FROM candidate_links WHERE fromId = ?`).get(fromId) as { toName: string } | undefined;
  return row ? row.toName : null;
}

export function tokenForStored(
  row: CandidateRow,
  tags: string[],
  link: string | null,
): string {
  return approvalTokenFor({
    id: row.id,
    bodyHash: row.bodyHash,
    kind: row.kind,
    source: row.source,
    observedAt: row.observedAt,
    scope: row.scope,
    supersedes: row.supersedes,
    tags: [...tags].sort(),
    link,
    createdAt: row.createdAt,
    expiresAt: row.expiresAt,
  });
}

function auditInsert(
  db: DatabaseSync,
  entry: {
    ts: string;
    op: string;
    targetId: string | null;
    code: string;
    scope: string | null;
    runId: string | null;
    approver: string | null;
    approvedAt: string | null;
    token: string | null;
    reasonCode: string | null;
  },
): void {
  db.prepare(
    `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, approver, approvedAt, token, reasonCode)
     VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?, ?, ?, ?)`,
  ).run(
    entry.ts,
    entry.op,
    entry.targetId,
    entry.code,
    entry.scope,
    entry.runId,
    entry.approver,
    entry.approvedAt,
    entry.token,
    entry.reasonCode,
  );
}

/** candidate.create over JSON (write op, idempotencyKey mandatory). */
export function createCandidate(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  const parsed = parseCreateParams(config, params);
  if (!parsed.ok) return budgeted(parsed.res, config);
  const n = parsed.value;

  // T4: correction candidates must name their target. kind=correction without
  // supersedes (or vice versa) is BAD_REQUEST; the target must exist, be in
  // the same scope, and be active. Committed replays below bypass this check.
  if (n.kind === "correction" || n.supersedes !== null) {
    if (n.kind !== "correction" || n.supersedes === null) {
      return budgeted(fail("BAD_REQUEST"), config);
    }
  }

  const reqHash = requestHashFor("candidate.create", normalizedParamsForHash(n));

  // Idempotent replay gate: authorization recheck + hash match first, then
  // committed replay even if the candidate has since expired.
  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "candidate.create") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, n.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, n.scope);
    if (denied) return denied;
  }
  // Creation-time target gate (advisory; approval re-checks atomically).
  if (n.supersedes !== null) {
    const gate = checkCorrectionTarget(db, config, n.scope, n.supersedes);
    if (!gate.ok) return gate.res;
  }

  const now = nowOverride ?? nowIso();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return budgeted(fail("STORE_UNAVAILABLE"), config);
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + n.ttlSec * 1000).toISOString();
  const id = genId("cand");

  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      // Transaction-time target recheck (mirrors record.correct-request):
      // the advisory gate above ran before BEGIN IMMEDIATE, so a record
      // archived/superseded in between must not gain a correction candidate.
      if (n.supersedes !== null) {
        const gateIn = checkCorrectionTarget(db, config, n.scope, n.supersedes);
        if (!gateIn.ok) throw new Error("target moved");
      }
      // Budget gate BEFORE any insert: an over-budget success must not
      // leave an orphan candidate row or a cached failure with mutation.
      const probe: ResponseEnvelope = ok({
        candidate: { id, bodyHash: n.bodyHash, status: "candidate", expiresAt },
      });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      db.prepare(
        `INSERT INTO candidates(id, body, bodyHash, kind, source, observedAt, scope, supersedes, status, idempotencyKey, requestHash, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)`,
      ).run(id, n.body, n.bodyHash, n.kind, n.source, n.observedAt, n.scope, n.supersedes, idempotencyKey, reqHash, createdAt, expiresAt);
      for (const t of n.tags) {
        db.prepare(`INSERT INTO candidate_tags(candidateId, tag) VALUES (?, ?)`).run(id, t);
      }
      if (n.link !== null) {
        db.prepare(`INSERT INTO candidate_links(fromId, toName) VALUES (?, ?)`).run(id, n.link);
      }
      const res: ResponseEnvelope = ok({
        candidate: { id, bodyHash: n.bodyHash, status: "candidate", expiresAt },
      });
      const stored = budgeted(res, config);
      // Fail closed: if the budgeted envelope collapsed to LIMIT_EXCEEDED the
      // candidate row must not survive alone; persist the exact envelope sent.
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, "candidate.create", reqHash, JSON.stringify(stored), createdAt);
      auditInsert(db, {
        ts: createdAt,
        op: "candidate.create",
        targetId: id,
        code: stored.code,
        scope: n.scope,
        runId: n.runId,
        approver: null,
        approvedAt: null,
        token: null,
        reasonCode: null,
      });
      // Pre-commit cap: the write that crosses dbMaxBytes rolls back here
      // (STORE_UNAVAILABLE) instead of leaving an oversized database.
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "target moved") {
      // Re-read outside the rolled-back transaction for the precise code
      // (NOT_FOUND / FORBIDDEN_SCOPE / CONFLICT), mirroring correct-request.
      const gate = checkCorrectionTarget(db, config, n.scope, n.supersedes as string);
      if (!gate.ok) return gate.res;
      return budgeted(fail("CONFLICT"), config);
    }
    // Unique-key collision on the idempotency key means a concurrent commit
    // won the race: re-read and replay deterministically.
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "candidate.create" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    if (/UNIQUE constraint failed: candidates/.test(msg)) {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/** candidate.get over JSON: metadata only, never the body. Requires {id, scope}. */
export function getCandidateMeta(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
): ResponseEnvelope {
  const keys = Object.keys(params);
  for (const k of keys) {
    if (k !== "id" && k !== "scope") return budgeted(fail("BAD_REQUEST"), config);
  }
  const { id, scope } = params;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return budgeted(fail("BAD_REQUEST"), config);
  if (typeof scope !== "string" || countCp(scope) < 1 || countCp(scope) > 256 || hasControl(scope)) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  {
    const denied = scopeGate(db, config, scope);
    if (denied) return denied;
  }
  let row: CandidateRow | null;
  try {
    row = readCandidate(db, id);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (!row) return budgeted(fail("NOT_FOUND"), config);
  if (row.scope !== scope) return budgeted(fail("FORBIDDEN_SCOPE"), config);
  // Terminal states stay readable as metadata; expiry is lazy-marked here.
  const nowMs = Date.now();
  if (row.status === "candidate" && Date.parse(row.expiresAt) <= nowMs) {
    try {
      db.prepare(`UPDATE candidates SET status='expired' WHERE id=? AND status='candidate'`).run(id);
      row = { ...row, status: "expired" };
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
  }
  // Metadata query failure is STORE_UNAVAILABLE, never a fabricated
  // empty tag list / null link (readTags/readLink throw on failure).
  let tags: string[];
  let link: string | null;
  try {
    tags = readTags(db, id);
    link = readLink(db, id);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  return budgeted(
    ok({
      candidate: {
        id: row.id,
        bodyHash: row.bodyHash,
        kind: row.kind,
        scope: row.scope,
        status: row.status,
        expiresAt: row.expiresAt,
        createdAt: row.createdAt,
        supersedes: row.supersedes,
        tags,
        link,
      },
    }),
    config,
  );
}

/** Human review read model (TTY path + direct-call tests). No body leak outside TTY. */
export function getCandidateForReview(
  db: DatabaseSync,
  config: AppConfig,
  id: string,
  scope: string,
): { ok: true; row: CandidateRow; tags: string[]; link: string | null; token: string } | { ok: false; code: "BAD_REQUEST" | "FORBIDDEN_SCOPE" | "NOT_FOUND" | "STORE_UNAVAILABLE" } {
  if (!id || typeof id !== "string" || id.length > 256) return { ok: false, code: "BAD_REQUEST" };
  if (typeof scope !== "string" || countCp(scope) < 1 || countCp(scope) > 256 || hasControl(scope)) {
    return { ok: false, code: "BAD_REQUEST" };
  }
  // Authorize BEFORE disclosing the full body/token: a revoked scope
  // (removed from startup config or the scopes table) must not review.
  // A scopes-table I/O failure is STORE_UNAVAILABLE, never FORBIDDEN_SCOPE.
  try {
    if (!isScopeAuthorized(db, config, scope)) return { ok: false, code: "FORBIDDEN_SCOPE" };
  } catch {
    return { ok: false, code: "STORE_UNAVAILABLE" };
  }
  let row: CandidateRow | null;
  try {
    row = readCandidate(db, id);
  } catch {
    return { ok: false, code: "STORE_UNAVAILABLE" };
  }
  if (!row) return { ok: false, code: "NOT_FOUND" };
  if (row.scope !== scope) return { ok: false, code: "FORBIDDEN_SCOPE" };
  // Metadata query failure must not disclose a row with fabricated
  // empty tags / null link (and a token bound to that wrong set).
  try {
    const tags = readTags(db, id);
    const link = readLink(db, id);
    return { ok: true, row, tags, link, token: tokenForStored(row, tags, link) };
  } catch {
    return { ok: false, code: "STORE_UNAVAILABLE" };
  }
}

function lazyExpire(db: DatabaseSync, id: string): void {
  try {
    db.prepare(`UPDATE candidates SET status='expired' WHERE id=? AND status='candidate' AND expiresAt <= ?`).run(id, nowIso());
  } catch {
    /* ignore: caller re-reads */
  }
}

function currentApprover(): string {
  try {
    const u = (process.env["USER"] || process.env["USERNAME"] || "terminal-user").slice(0, 64);
    return u.length > 0 ? u : "terminal-user";
  } catch {
    return "terminal-user";
  }
}

/** Human approve (domain core; CLI adds TTY + yes-confirmation on top). */
export function approveCandidate(
  db: DatabaseSync,
  config: AppConfig,
  args: { id: string; scope: string; token: string; idempotencyKey: string },
  nowOverride?: string,
): ResponseEnvelope {
  if (!args.id || typeof args.id !== "string" || args.id.length > 256) return budgeted(fail("BAD_REQUEST"), config);
  if (typeof args.scope !== "string" || countCp(args.scope) < 1 || countCp(args.scope) > 256 || hasControl(args.scope)) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  if (typeof args.token !== "string" || args.token.length === 0 || args.token.length > 512) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  if (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(args.idempotencyKey)) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  const reqHash = sha256HexUtf8(canonicalStringify({ op: "approve", id: args.id, scope: args.scope, token: args.token }));

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, args.idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "approve") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, args.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, args.scope);
    if (denied) return denied;
  }

  lazyExpire(db, args.id);
  let row: CandidateRow | null;
  try {
    row = readCandidate(db, args.id);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (!row) return budgeted(fail("NOT_FOUND"), config);
  if (row.scope !== args.scope) return budgeted(fail("FORBIDDEN_SCOPE"), config);
  if (row.status !== "candidate") {
    // Approved/rejected are terminal; an expired row reports EXPIRED.
    if (row.status === "expired" || Date.parse(row.expiresAt) <= Date.now()) {
      return budgeted(fail("EXPIRED"), config);
    }
    return budgeted(fail("CONFLICT"), config);
  }
  if (Date.parse(row.expiresAt) <= Date.now()) {
    lazyExpire(db, args.id);
    return budgeted(fail("EXPIRED"), config);
  }
  // T4: correction approvals run the conditional-supersede transaction.
  // A correction candidate without a supersedes pointer is malformed and can
  // never approve (fail closed); creation always sets one.
  const isCorrection = row.kind === "correction" || row.supersedes !== null;
  if (isCorrection && (typeof row.supersedes !== "string" || row.supersedes.length === 0)) {
    return budgeted(fail("CONFLICT"), config);
  }
  // A metadata read failure here is STORE_UNAVAILABLE: binding the token
  // against fabricated empty tags / null link could approve the wrong set.
  let expected: string;
  try {
    expected = tokenForStored(row, readTags(db, args.id), readLink(db, args.id));
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (!safeEqual(args.token, expected)) return budgeted(fail("CONFLICT"), config);
  // Creation-time advisory target gate for corrections: missing / foreign /
  // inactive targets fail fast here; the transaction below is authoritative
  // (conditional UPDATE picks exactly one winner on races).
  if (isCorrection) {
    const gate = checkCorrectionTarget(db, config, args.scope, row.supersedes as string);
    if (!gate.ok) return gate.res;
  }

  const approvedAt = nowOverride ?? nowIso();
  const recId = genId("rec");
  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      // Re-verify inside the transaction (fail closed on concurrent terminal move).
      const fresh = readCandidate(db, args.id);
      if (!fresh || fresh.status !== "candidate") throw new Error("state moved");
      if (Date.parse(fresh.expiresAt) <= Date.now()) throw new Error("expired now");
      if (!safeEqual(args.token, tokenForStored(fresh, readTags(db, args.id), readLink(db, args.id)))) {
        throw new Error("token moved");
      }
      // Budget gate BEFORE any insert: no orphan record / candidate mutation
      // on an over-budget success.
      const probe: ResponseEnvelope = ok({ record: { id: recId } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      const freshIsCorrection = fresh.kind === "correction" || fresh.supersedes !== null;
      if (freshIsCorrection) {
        // Atomic correction commit: exactly one approval may move the old
        // row active → superseded. The conditional UPDATE is the arbiter:
        // 0 changed rows means a competing approval (or archive) won, or the
        // scope moved — everything rolls back as CONFLICT / FORBIDDEN_SCOPE.
        if (typeof fresh.supersedes !== "string" || fresh.supersedes.length === 0) {
          throw new Error("supersede lost");
        }
        let target: RecordRow | null;
        try {
          target = readRecordOrThrow(db, fresh.supersedes);
        } catch {
          throw new Error("db over cap");
        }
        if (!target) throw new Error("supersede lost");
        if (target.scope !== fresh.scope || target.scope !== args.scope) throw new Error("supersede scope");
        let moved: unknown;
        try {
          moved = db
            .prepare(`UPDATE records SET status='superseded' WHERE id=? AND status='active' AND scope=?`)
            .run(target.id, fresh.scope);
        } catch {
          throw new Error("db over cap");
        }
        if (changedRows(moved) !== 1) throw new Error("supersede lost");
        db.prepare(
          `INSERT INTO records(id, candidateId, body, bodyHash, kind, source, observedAt, scope, status, supersedes, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`,
        ).run(recId, fresh.id, fresh.body, fresh.bodyHash, fresh.kind, fresh.source, fresh.observedAt, fresh.scope, target.id, approvedAt);
      } else {
        db.prepare(
          `INSERT INTO records(id, candidateId, body, bodyHash, kind, source, observedAt, scope, status, supersedes, createdAt)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
        ).run(recId, fresh.id, fresh.body, fresh.bodyHash, fresh.kind, fresh.source, fresh.observedAt, fresh.scope, approvedAt);
      }
      for (const t of readTags(db, args.id)) {
        db.prepare(`INSERT OR IGNORE INTO record_tags(recordId, tag) VALUES (?, ?)`).run(recId, t);
      }
      const lk = readLink(db, args.id);
      if (lk !== null) {
        db.prepare(`INSERT OR IGNORE INTO record_links(fromId, toName) VALUES (?, ?)`).run(recId, lk);
      }
      const flipped = db.prepare(`UPDATE candidates SET status='approved' WHERE id=? AND status='candidate'`).run(args.id);
      if (changedRows(flipped) !== 1) throw new Error("state moved");
      const res: ResponseEnvelope = ok({ record: { id: recId } });
      const stored = budgeted(res, config);
      db.prepare(`INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`).run(
        args.idempotencyKey,
        "approve",
        reqHash,
        JSON.stringify(stored),
        approvedAt,
      );
      auditInsert(db, {
        ts: approvedAt,
        op: "approve",
        targetId: args.id,
        code: stored.code,
        scope: fresh.scope,
        runId: null,
        approver: currentApprover(),
        approvedAt,
        token: args.token,
        reasonCode: null,
      });
      // Pre-commit cap: crossing dbMaxBytes rolls back record + status flip.
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, args.idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "approve" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    if (msg === "expired now") return budgeted(fail("EXPIRED"), config);
    if (msg === "supersede scope") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "state moved" || msg === "token moved" || msg === "supersede lost") {
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/** Human reject (domain core; CLI adds TTY + yes-confirmation on top). */
export function rejectCandidate(
  db: DatabaseSync,
  config: AppConfig,
  args: { id: string; scope: string; token: string; idempotencyKey: string; reasonCode: string },
  nowOverride?: string,
): ResponseEnvelope {
  if (!args.id || typeof args.id !== "string" || args.id.length > 256) return budgeted(fail("BAD_REQUEST"), config);
  if (typeof args.scope !== "string" || countCp(args.scope) < 1 || countCp(args.scope) > 256 || hasControl(args.scope)) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  if (typeof args.token !== "string" || args.token.length === 0 || args.token.length > 512) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  if (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(args.idempotencyKey)) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  if (args.reasonCode !== "USER_REJECTED") return budgeted(fail("BAD_REQUEST"), config);
  const reqHash = sha256HexUtf8(
    canonicalStringify({ op: "reject", id: args.id, scope: args.scope, token: args.token, reasonCode: args.reasonCode }),
  );

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, args.idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "reject") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, args.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, args.scope);
    if (denied) return denied;
  }

  lazyExpire(db, args.id);
  let row: CandidateRow | null;
  try {
    row = readCandidate(db, args.id);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (!row) return budgeted(fail("NOT_FOUND"), config);
  if (row.scope !== args.scope) return budgeted(fail("FORBIDDEN_SCOPE"), config);
  if (row.status !== "candidate") {
    if (row.status === "expired" || Date.parse(row.expiresAt) <= Date.now()) {
      return budgeted(fail("EXPIRED"), config);
    }
    return budgeted(fail("CONFLICT"), config);
  }
  if (Date.parse(row.expiresAt) <= Date.now()) {
    lazyExpire(db, args.id);
    return budgeted(fail("EXPIRED"), config);
  }
  // Same fail-closed metadata rule as approve: never bind against
  // fabricated empty tags / null link.
  try {
    if (!safeEqual(args.token, tokenForStored(row, readTags(db, args.id), readLink(db, args.id)))) {
      return budgeted(fail("CONFLICT"), config);
    }
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }

  const now = nowOverride ?? nowIso();
  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      const fresh = readCandidate(db, args.id);
      if (!fresh || fresh.status !== "candidate") throw new Error("state moved");
      if (Date.parse(fresh.expiresAt) <= Date.now()) throw new Error("expired now");
      if (!safeEqual(args.token, tokenForStored(fresh, readTags(db, args.id), readLink(db, args.id)))) {
        throw new Error("token moved");
      }
      const probe: ResponseEnvelope = ok({ candidate: { id: args.id, status: "rejected" } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      db.prepare(`UPDATE candidates SET status='rejected' WHERE id=? AND status='candidate'`).run(args.id);
      const res: ResponseEnvelope = ok({ candidate: { id: args.id, status: "rejected" } });
      const stored = budgeted(res, config);
      db.prepare(`INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`).run(
        args.idempotencyKey,
        "reject",
        reqHash,
        JSON.stringify(stored),
        now,
      );
      auditInsert(db, {
        ts: now,
        op: "reject",
        targetId: args.id,
        code: stored.code,
        scope: fresh.scope,
        runId: null,
        approver: currentApprover(),
        approvedAt: now,
        token: args.token,
        reasonCode: "USER_REJECTED",
      });
      // Pre-commit cap: crossing dbMaxBytes rolls back the status flip.
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, args.idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "reject" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    if (msg === "expired now") return budgeted(fail("EXPIRED"), config);
    if (msg === "state moved" || msg === "token moved") return budgeted(fail("CONFLICT"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* T4 correction-request + archive (plan 14.7 adopted subset)            */
/* ------------------------------------------------------------------ */

interface NormalizedCorrection {
  recordId: string;
  body: string;
  bodyHash: string;
  source: string;
  observedAt: string;
  scope: string;
  tags: string[];
  link: string | null;
  runId: string | null;
}

type CorrectionParse =
  | { ok: true; value: NormalizedCorrection }
  | { ok: false; res: ResponseEnvelope };

/**
 * Validate + normalize record.correct-request params (no DB writes).
 * Short form of candidate.create(kind=correction, supersedes=recordId):
 * kind, when present, must be exactly "correction"; ttlSec is not accepted
 * (corrections share the standard candidate TTL).
 */
export function parseCorrectRequestParams(
  config: AppConfig,
  params: Record<string, unknown>,
): CorrectionParse {
  if (containsLoneSurrogateDeep(params)) return { ok: false, res: bad() };
  const allowed = new Set(["recordId", "body", "kind", "provenance", "scope", "tags", "link", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: bad() };
  }
  if (containsLoneSurrogateDeep(Object.keys(params))) return { ok: false, res: bad() };
  const { recordId, body, kind, provenance, scope, tags, link, runId } = params;

  if (typeof recordId !== "string" || recordId.length === 0 || recordId.length > 256) {
    return { ok: false, res: bad() };
  }
  if (hasControl(recordId)) return { ok: false, res: bad() };
  if (kind !== undefined && kind !== "correction") return { ok: false, res: bad() };

  if (typeof body !== "string") return { ok: false, res: bad() };
  if (checkLenCp(body, 1, config.limits.bodyMaxCp) === "long") return { ok: false, res: limitExceeded() };
  const nBody = normalizeBody(body);
  const bodyLen = checkLenCp(nBody, 1, Math.min(2000, config.limits.bodyMaxCp));
  if (bodyLen === "short") return { ok: false, res: bad() };
  if (bodyLen === "long") return { ok: false, res: limitExceeded() };

  if (!isPlainObject(provenance)) return { ok: false, res: bad() };
  const pKeys = Object.keys(provenance);
  if (pKeys.length !== 2 || !pKeys.includes("source") || !pKeys.includes("observedAt")) {
    return { ok: false, res: bad() };
  }
  const source = provenance["source"];
  const observedAt = provenance["observedAt"];
  if (typeof source !== "string") return { ok: false, res: bad() };
  const srcLen = checkLenCp(source, 1, 256);
  if (srcLen === "long") return { ok: false, res: limitExceeded() };
  if (srcLen === "short" || hasControl(source)) return { ok: false, res: bad() };
  const canonObs = canonicalTime(observedAt);
  if (canonObs === null) return { ok: false, res: bad() };

  if (typeof scope !== "string") return { ok: false, res: bad() };
  const scopeLen = checkLenCp(scope, 1, 256);
  if (scopeLen === "long") return { ok: false, res: limitExceeded() };
  if (scopeLen === "short" || hasControl(scope)) return { ok: false, res: bad() };

  let nTags: string[] = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return { ok: false, res: bad() };
    if (tags.length > config.limits.tagsMax) return { ok: false, res: limitExceeded() };
    const seen = new Set<string>();
    for (const t of tags) {
      if (typeof t !== "string") return { ok: false, res: bad() };
      const tl = checkLenCp(t, 1, 256);
      if (tl === "long") return { ok: false, res: limitExceeded() };
      if (tl === "short" || hasControl(t)) return { ok: false, res: bad() };
      const nt = normalizeTag(t);
      if (countCp(nt) < 1 || countCp(nt) > 256) return { ok: false, res: bad() };
      seen.add(nt);
    }
    nTags = [...seen].sort();
  }

  let nLink: string | null = null;
  if (link !== undefined && link !== null) {
    if (typeof link !== "string") return { ok: false, res: bad() };
    const ll = checkLenCp(link, 1, 256);
    if (ll === "long") return { ok: false, res: limitExceeded() };
    if (ll === "short" || hasControl(link)) return { ok: false, res: bad() };
    const nl = normalizeLink(link);
    if (countCp(nl) < 1 || countCp(nl) > 256) return { ok: false, res: bad() };
    nLink = nl;
  }

  let nRunId: string | null = null;
  if (runId !== undefined && runId !== null) {
    if (typeof runId !== "string") return { ok: false, res: bad() };
    const rl = checkLenCp(runId, 1, 256);
    if (rl === "long") return { ok: false, res: limitExceeded() };
    if (rl === "short" || hasControl(runId)) return { ok: false, res: bad() };
    nRunId = runId;
  }

  return {
    ok: true,
    value: {
      recordId,
      body: nBody,
      bodyHash: bodyHashFor(nBody),
      source: source as string,
      observedAt: canonObs,
      scope: scope as string,
      tags: nTags,
      link: nLink,
      runId: nRunId,
    },
  };
}

/**
 * record.correct-request over JSON (write op, idempotencyKey mandatory).
 * Creates a kind=correction candidate superseding an active same-scope
 * record. The old record stays active (and recallable) until a human
 * approves the correction; nothing here mutates records.
 */
export function correctRequest(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  const parsed = parseCorrectRequestParams(config, params);
  if (!parsed.ok) return budgeted(parsed.res, config);
  const n = parsed.value;

  const reqHash = requestHashFor("record.correct-request", {
    body: n.body,
    kind: "correction",
    observedAt: n.observedAt,
    scope: n.scope,
    source: n.source,
    link: n.link,
    recordId: n.recordId,
    runId: n.runId,
    tags: n.tags,
  });

  // Idempotent replay gate first: authorization recheck + hash match, then
  // the committed envelope even if the target has since moved. EXPIRED is
  // for fresh executions only, never for committed replay.
  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "record.correct-request") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, n.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, n.scope);
    if (denied) return denied;
  }
  // Creation-time advisory target gate (approval re-checks atomically).
  {
    const gate = checkCorrectionTarget(db, config, n.scope, n.recordId);
    if (!gate.ok) return gate.res;
  }

  const now = nowOverride ?? nowIso();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return budgeted(fail("STORE_UNAVAILABLE"), config);
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + config.candidateTtlSec * 1000).toISOString();
  const id = genId("cand");

  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      // Re-check the target inside the transaction: a record archived or
      // superseded between the advisory gate and COMMIT must not gain a
      // correction candidate.
      const gate = checkCorrectionTarget(db, config, n.scope, n.recordId);
      if (!gate.ok) throw new Error("target moved");
      // Budget gate BEFORE any insert: no orphan candidate on overflow.
      const probe: ResponseEnvelope = ok({
        candidate: { id, bodyHash: n.bodyHash, status: "candidate", expiresAt },
      });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      db.prepare(
        `INSERT INTO candidates(id, body, bodyHash, kind, source, observedAt, scope, supersedes, status, idempotencyKey, requestHash, createdAt, expiresAt)
         VALUES (?, ?, ?, 'correction', ?, ?, ?, ?, 'candidate', ?, ?, ?, ?)`,
      ).run(id, n.body, n.bodyHash, n.source, n.observedAt, n.scope, n.recordId, idempotencyKey, reqHash, createdAt, expiresAt);
      for (const t of n.tags) {
        db.prepare(`INSERT INTO candidate_tags(candidateId, tag) VALUES (?, ?)`).run(id, t);
      }
      if (n.link !== null) {
        db.prepare(`INSERT INTO candidate_links(fromId, toName) VALUES (?, ?)`).run(id, n.link);
      }
      const res: ResponseEnvelope = ok({
        candidate: { id, bodyHash: n.bodyHash, status: "candidate", expiresAt },
      });
      const stored = budgeted(res, config);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, "record.correct-request", reqHash, JSON.stringify(stored), createdAt);
      auditInsert(db, {
        ts: createdAt,
        op: "record.correct-request",
        targetId: id,
        code: stored.code,
        scope: n.scope,
        runId: n.runId,
        approver: null,
        approvedAt: null,
        token: null,
        reasonCode: null,
      });
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "target moved") {
      // Re-read outside the rolled-back transaction for the precise code.
      const gate = checkCorrectionTarget(db, config, n.scope, n.recordId);
      if (!gate.ok) return gate.res;
      return budgeted(fail("CONFLICT"), config);
    }
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "record.correct-request" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    if (/UNIQUE constraint failed: candidates/.test(msg)) {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/**
 * Human archive (domain core; CLI adds TTY + yes-confirmation on top).
 * Terminal transition active → archived: no restore, no physical deletion.
 * Metadata-only audit + idempotency row commit atomically with the flip;
 * audit/insert failure rolls everything back (fail closed).
 */
export function archiveRecord(
  db: DatabaseSync,
  config: AppConfig,
  args: { id: string; scope: string; idempotencyKey: string; reasonCode: string },
  nowOverride?: string,
): ResponseEnvelope {
  if (!args.id || typeof args.id !== "string" || args.id.length > 256) return budgeted(fail("BAD_REQUEST"), config);
  if (typeof args.scope !== "string" || countCp(args.scope) < 1 || countCp(args.scope) > 256 || hasControl(args.scope)) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  if (typeof args.idempotencyKey !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(args.idempotencyKey)) {
    return budgeted(fail("BAD_REQUEST"), config);
  }
  if (args.reasonCode !== "USER_ARCHIVED") return budgeted(fail("BAD_REQUEST"), config);
  const reqHash = sha256HexUtf8(
    canonicalStringify({ op: "archive", id: args.id, scope: args.scope, reasonCode: args.reasonCode }),
  );

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, args.idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "archive") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, args.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, args.scope);
    if (denied) return denied;
  }

  let target: RecordRow | null;
  try {
    target = readRecordOrThrow(db, args.id);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (!target) return budgeted(fail("NOT_FOUND"), config);
  if (target.scope !== args.scope) return budgeted(fail("FORBIDDEN_SCOPE"), config);
  if (target.status !== "active") return budgeted(fail("CONFLICT"), config);

  const now = nowOverride ?? nowIso();
  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      // Conditional flip is the arbiter: 0 rows means a competing approval
      // (supersede) or archive won first — roll everything back as CONFLICT.
      let moved: unknown;
      try {
        moved = db
          .prepare(`UPDATE records SET status='archived' WHERE id=? AND status='active' AND scope=?`)
          .run(args.id, args.scope);
      } catch {
        throw new Error("db over cap");
      }
      if (changedRows(moved) !== 1) throw new Error("archive lost");
      const probe: ResponseEnvelope = ok({ record: { id: args.id, status: "archived" } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      const res: ResponseEnvelope = ok({ record: { id: args.id, status: "archived" } });
      const stored = budgeted(res, config);
      db.prepare(`INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`).run(
        args.idempotencyKey,
        "archive",
        reqHash,
        JSON.stringify(stored),
        now,
      );
      auditInsert(db, {
        ts: now,
        op: "archive",
        targetId: args.id,
        code: stored.code,
        scope: args.scope,
        runId: null,
        approver: currentApprover(),
        approvedAt: null,
        token: null,
        reasonCode: "USER_ARCHIVED",
      });
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, args.idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "archive" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    if (msg === "archive lost") return budgeted(fail("CONFLICT"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* T3 deterministic recall (plan 14.6 + 14.4/14.8/14.10 adopted subset) */
/* ------------------------------------------------------------------ */

interface ParsedRecall {
  query: string;
  tags: string[];
  link: string | null;
  since: string | null;
  until: string | null;
  limit: number;
  scope: string;
  runId: string | null;
}

type RecallParse =
  | { ok: true; value: ParsedRecall }
  | { ok: false; res: ResponseEnvelope };

function parseRecallParams(config: AppConfig, params: Record<string, unknown>): RecallParse {
  // Direct-call hardening: unpaired surrogates (incl. escaped lone halves
  // that bypass UTF-8 checks) are BAD_REQUEST with no audit/exposure write.
  if (containsLoneSurrogateDeep(params)) return { ok: false, res: bad() };
  const allowed = new Set(["query", "tags", "link", "since", "until", "limit", "scope", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: bad() };
  }
  if (containsLoneSurrogateDeep(Object.keys(params))) return { ok: false, res: bad() };
  const { query, tags, link, since, until, limit, scope, runId } = params;

  if (typeof query !== "string") return { ok: false, res: bad() };
  if (countCp(query) > config.limits.queryMaxCp) return { ok: false, res: limitExceeded() };
  const nq = normalizeBody(query);
  const nqLen = countCp(nq);
  if (nqLen < 1) return { ok: false, res: bad() };
  if (nqLen > config.limits.queryMaxCp) return { ok: false, res: limitExceeded() };

  let nTags: string[] = [];
  if (tags !== undefined) {
    if (!Array.isArray(tags)) return { ok: false, res: bad() };
    if (tags.length > config.limits.tagsMax) return { ok: false, res: limitExceeded() };
    const seen = new Set<string>();
    for (const t of tags) {
      if (typeof t !== "string") return { ok: false, res: bad() };
      if (countCp(t) > 256) return { ok: false, res: limitExceeded() };
      if (countCp(t) < 1 || hasControl(t)) return { ok: false, res: bad() };
      const nt = normalizeTag(t);
      if (countCp(nt) < 1 || countCp(nt) > 256) return { ok: false, res: bad() };
      seen.add(nt);
    }
    nTags = [...seen].sort();
  }

  let nLink: string | null = null;
  if (link !== undefined && link !== null) {
    if (typeof link !== "string") return { ok: false, res: bad() };
    if (countCp(link) > 256) return { ok: false, res: limitExceeded() };
    if (countCp(link) < 1 || hasControl(link)) return { ok: false, res: bad() };
    const nl = normalizeLink(link);
    if (countCp(nl) < 1 || countCp(nl) > 256) return { ok: false, res: bad() };
    nLink = nl;
  }

  let nSince: string | null = null;
  if (since !== undefined && since !== null) {
    const c = canonicalTime(since);
    if (c === null) return { ok: false, res: bad() };
    nSince = c;
  }
  let nUntil: string | null = null;
  if (until !== undefined && until !== null) {
    const c = canonicalTime(until);
    if (c === null) return { ok: false, res: bad() };
    nUntil = c;
  }

  let nLimit = config.limits.limitDefault;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return { ok: false, res: bad() };
    if (limit < 1) return { ok: false, res: bad() };
    if (limit > config.limits.limitMax) return { ok: false, res: limitExceeded() };
    nLimit = limit;
  }

  if (typeof scope !== "string") return { ok: false, res: bad() };
  if (countCp(scope) > 256) return { ok: false, res: limitExceeded() };
  if (countCp(scope) < 1 || hasControl(scope)) return { ok: false, res: bad() };

  let nRunId: string | null = null;
  if (runId !== undefined && runId !== null) {
    if (typeof runId !== "string") return { ok: false, res: bad() };
    if (countCp(runId) > 256) return { ok: false, res: limitExceeded() };
    if (countCp(runId) < 1 || hasControl(runId)) return { ok: false, res: bad() };
    nRunId = runId;
  }

  return { ok: true, value: { query: nq, tags: nTags, link: nLink, since: nSince, until: nUntil, limit: nLimit, scope: scope as string, runId: nRunId } };
}

function snippetFor(body: string, maxCp: number): { snippet: string; truncated: boolean } {
  const cps = [...body];
  if (cps.length <= maxCp) return { snippet: body, truncated: false };
  return { snippet: cps.slice(0, maxCp).join(""), truncated: true };
}

/**
 * DB cap gate (dbMaxBytes). Effective size = max(logical, physical):
 * - Logical: PRAGMA page_count * page_size of the main image (includes
 *   freelist pages, so conservative; also the only signal for :memory:
 *   databases, which have no file path).
 * - Physical: filesystem bytes of the main file + WAL (-wal) + SHM (-shm)
 *   sidecars. In WAL mode uncheckpointed writes live in -wal, so the file
 *   sum is what actually grows before COMMIT; the logical view alone would
 *   miss it. Summing logical + physical would double-count the main image,
 *   hence max(), not the sum.
 * Oversize -> true (fail closed, STORE_UNAVAILABLE). Unknown/unreadable
 * sizes never block (fail-open on measurement only). Checked at transaction
 * entry (cheap reject) AND after mutations before COMMIT: the write that
 * crosses the cap throws inside withTransaction, rolls back, and leaves no
 * oversized database behind.
 */
function isDbOverCap(db: DatabaseSync, config: AppConfig): boolean {
  try {
    let logical = 0;
    try {
      const pc = db.prepare(`PRAGMA page_count`).get() as { page_count: number } | undefined;
      const ps = db.prepare(`PRAGMA page_size`).get() as { page_size: number } | undefined;
      logical = (pc?.page_count ?? 0) * (ps?.page_size ?? 0);
    } catch {
      /* logical unknown; physical may still decide */
    }
    let physical = 0;
    let seen = false;
    try {
      const rows = db.prepare(`PRAGMA database_list`).all() as Array<{ name: string; file: string }>;
      const main = rows.find((r) => r.name === "main")?.file ?? "";
      if (main) {
        for (const suffix of ["", "-wal", "-shm"]) {
          try {
            physical += fs.statSync(main + suffix).size;
            seen = true;
          } catch {
            /* missing sidecar is fine */
          }
        }
      }
    } catch {
      /* ignore sidecar errors */
    }
    if (!seen) return logical > 0 && logical > config.dbMaxBytes;
    return Math.max(logical, physical) > config.dbMaxBytes;
  } catch {
    return false;
  }
}

/** Post-mutation gate: call inside the transaction after all writes, before COMMIT. */
function assertDbUnderCap(db: DatabaseSync, config: AppConfig): void {
  if (isDbOverCap(db, config)) throw new Error("db over cap");
}

interface RecallCandidate {
  id: string;
  body: string;
  createdAt: string;
}

/** record.recall over JSON (read-only selection + metadata-only audit in one txn). */
export function recallRecords(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  const parsed = parseRecallParams(config, params);
  if (!parsed.ok) return budgeted(parsed.res, config);
  const p = parsed.value;
  {
    const denied = scopeGate(db, config, p.scope);
    if (denied) return denied;
  }

  const now = nowOverride ?? nowIso();
  const recallId = genId("recall");

  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      if (isDbOverCap(db, config)) throw new Error("db over cap");
      // Bounded SQL retrieval (T3 fix): every predicate is parameterized,
      // the literal substring uses instr(body, ?)>0 (no LIKE/wildcards), tag
      // ALL uses one EXISTS per tag, the optional link uses one EXISTS, and
      // SQL LIMIT enforces the bound (<= limitMax <= 100, recall <= 25 here).
      // Host variables are therefore O(tags)+O(1) (<= ~20), never O(matches),
      // so a 32k+ match window cannot hit the SQLite variable cap. Tags for
      // the response are fetched only for the <= limit selected ids, so the
      // second IN list is bounded by LIMIT too.
      // Honest note: this bounds variables + materialization, but the instr
      // scan may still examine every row in the scope/time window; it is not
      // hard constant latency.
      // Canonical millis strings sort lexicographically, so >= / < match
      // since-inclusive / until-exclusive numerically.
      let sql = `SELECT id, body, createdAt FROM records WHERE scope = ? AND status = 'active'`;
      const args: Array<string | number> = [p.scope];
      if (p.since !== null) {
        sql += ` AND createdAt >= ?`;
        args.push(p.since);
      }
      if (p.until !== null) {
        sql += ` AND createdAt < ?`;
        args.push(p.until);
      }
      sql += ` AND instr(body, ?) > 0`;
      args.push(p.query);
      for (const t of p.tags) {
        sql += ` AND EXISTS (SELECT 1 FROM record_tags WHERE recordId = records.id AND tag = ?)`;
        args.push(t);
      }
      if (p.link !== null) {
        sql += ` AND EXISTS (SELECT 1 FROM record_links WHERE fromId = records.id AND toName = ?)`;
        args.push(p.link);
      }
      sql += ` ORDER BY createdAt DESC, id ASC LIMIT ?`;
      args.push(p.limit);
      let rows: RecallCandidate[];
      try {
        rows = db.prepare(sql).all(...args) as unknown as RecallCandidate[];
      } catch {
        throw new Error("recall select failed");
      }

      // Tags for the bounded selected ids only (<= limit placeholders).
      const tagMap = new Map<string, Set<string>>();
      if (rows.length > 0) {
        try {
          const ids = rows.map((r) => r.id);
          const placeholders = ids.map(() => "?").join(",");
          const trows = db
            .prepare(`SELECT recordId, tag FROM record_tags WHERE recordId IN (${placeholders})`)
            .all(...(ids as [])) as Array<{ recordId: string; tag: string }>;
          for (const t of trows) {
            let s = tagMap.get(t.recordId);
            if (!s) {
              s = new Set<string>();
              tagMap.set(t.recordId, s);
            }
            s.add(t.tag);
          }
        } catch {
          throw new Error("tag read failed");
        }
      }

      const top = rows;
      const items = top.map((r) => {
        const { snippet, truncated } = snippetFor(r.body, config.limits.snippetMaxCp);
        const tags = [...(tagMap.get(r.id) ?? new Set<string>())].sort();
        return { id: r.id, snippet, truncated, tags, createdAt: r.createdAt };
      });

      // Full-response budget BEFORE any audit/exposure write: no partial
      // shaving, no orphan exposure rows on overflow.
      const probe: ResponseEnvelope = ok({ recallId, items });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      const stored = budgeted(probe, config);
      if (!stored.ok) throw new Error("response over budget");
      const responseBytes = Buffer.byteLength(JSON.stringify(stored), "utf8");

      // Metadata-only audit + per-item exposures (no query/body/snippet text).
      db.prepare(
        `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, approver, approvedAt, token, reasonCode)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(now, "record.recall", recallId, stored.code, p.scope, responseBytes, p.limit, p.runId, recallId);
      const exp = db.prepare(
        `INSERT INTO exposures(ts, recallId, runId, scope, recordId, snippetBytes, truncated, limitN)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const it of items) {
        exp.run(
          now,
          recallId,
          p.runId,
          p.scope,
          it.id,
          Buffer.byteLength(it.snippet, "utf8"),
          it.truncated ? 1 : 0,
          p.limit,
        );
      }
      // Pre-commit cap: audit/exposure growth that crosses dbMaxBytes rolls
      // back the whole recall (no partial ledger rows survive).
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}
