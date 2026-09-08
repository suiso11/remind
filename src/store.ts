/**
 * T2 domain: candidates + human review/approve/reject atop T1.
 * Plan ref: plan.md 14.2-14.5 (proposal adopted for T2 only).
 *
 * Notes / smallest explicit corrections to the plan text:
 * - candidate.get requires {id, scope}: plan 14.2 lists params {id} but 14.5
 *   requires every id lookup (review + candidate.get) to check request scope
 *   vs stored scope. Without a request scope the check is impossible, so T2
 *   requires scope and answers BAD_REQUEST when absent, FORBIDDEN_SCOPE on
 *   mismatch. No body is ever returned on this path.
 * - Human review/approve/reject require --scope for the same reason: the id
 *   lookup must bind to a request scope. Missing scope is BAD_REQUEST.
 * - candidate.create with kind=correction or a supersedes pointer is answered
 *   NOT_IMPLEMENTED (honest T4 deferral): the supersedes column exists in the
 *   schema, but the T4 conditional-supersede transaction is not implemented.
 * - record.correct-request / record.recall / archive stay NOT_IMPLEMENTED /
 *   FORBIDDEN-over-JSON exactly as before (T3-T4 own them).
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
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
}

/** Scope is authorized when it is in startup config AND in the scopes table. */
export function isScopeAuthorized(db: DatabaseSync, config: AppConfig, scope: string): boolean {
  if (!config.allowedScopes.includes(scope)) return false;
  try {
    const row = db.prepare(`SELECT scope FROM scopes WHERE scope = ?`).get(scope) as
      | { scope: string }
      | undefined;
    return !!row;
  } catch {
    return false;
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
  const allowed = new Set(["body", "kind", "provenance", "scope", "tags", "link", "ttlSec", "runId", "supersedes"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: bad() };
  }
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
  try {
    const row = db
      .prepare(`SELECT op, requestHash, responseJson FROM operations WHERE idempotencyKey = ?`)
      .get(key) as StoredOp | undefined;
    return row ?? null;
  } catch {
    return null;
  }
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

  // Honest T4 deferral: schema carries supersedes, behavior does not (yet).
  if (n.kind === "correction" || n.supersedes !== null) {
    return budgeted(fail("NOT_IMPLEMENTED"), config);
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
    if (!isScopeAuthorized(db, config, n.scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  if (!isScopeAuthorized(db, config, n.scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);

  const now = nowOverride ?? nowIso();
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return budgeted(fail("STORE_UNAVAILABLE"), config);
  const createdAt = new Date(nowMs).toISOString();
  const expiresAt = new Date(nowMs + n.ttlSec * 1000).toISOString();
  const id = genId("cand");

  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      // Entry gate (cheap reject when already over cap; fail closed when
      // the footprint cannot be measured).
      if (isDbOverCap(db, config)) throw new Error("db over cap");
      // Budget gate BEFORE any insert: an over-budget success must not
      // leave an orphan candidate row or a cached failure with mutation.
      const probe: ResponseEnvelope = ok({
        candidate: { id, bodyHash: n.bodyHash, status: "candidate", expiresAt },
      });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      db.prepare(
        `INSERT INTO candidates(id, body, bodyHash, kind, source, observedAt, scope, supersedes, status, idempotencyKey, requestHash, createdAt, expiresAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, NULL, 'candidate', ?, ?, ?, ?)`,
      ).run(id, n.body, n.bodyHash, n.kind, n.source, n.observedAt, n.scope, idempotencyKey, reqHash, createdAt, expiresAt);
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
      // Pre-commit cap: conservative WAL-reserve bound re-measured after
      // the writes (page_count already reflects allocations). Crossing
      // rolls back here (STORE_UNAVAILABLE) instead of leaving an
      // oversized database.
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    // Unique-key collision on the idempotency key means a concurrent commit
    // won the race: re-read and replay deterministically.
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      const again = readOperation(db, idempotencyKey);
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
  if (!isScopeAuthorized(db, config, scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
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
  if (!isScopeAuthorized(db, config, scope)) return { ok: false, code: "FORBIDDEN_SCOPE" };
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

/**
 * DB cap gate (dbMaxBytes). Committed size = max(logical, physical):
 * - Logical: PRAGMA page_count * page_size of the main image (includes
 *   freelist pages, so conservative; also the only signal for :memory:
 *   databases, which have no file path).
 * - Physical: filesystem bytes of the main file + WAL (-wal) + SHM (-shm)
 *   sidecars. In WAL mode uncheckpointed COMMITTED writes live in -wal, so
 *   the file sum is what actually grows; the logical view alone would miss
 *   it. Summing logical + physical would double-count the main image,
 *   hence max(), not the sum.
 * - Pre-commit bound (proven conservative, no value-byte heuristic).
 *   Small writes fitting a free page move neither page_count nor -wal
 *   pre-commit, yet COMMIT appends at least one WAL frame (page image +
 *   24-byte frame header + 32-byte WAL header). The gate hence reserves
 *   commit-time WAL growth explicitly. SQLite WAL format constants
 *   (documented file format): frame header 24 bytes, WAL header 32 bytes,
 *   wal-index (SHM) grows in 32KiB blocks (NOT a 32768-byte global
 *   maximum). Each 32KiB wal-index block covers at most 4096 frames (the
 *   first block holds slightly fewer usable entries, ~4062, because of its
 *   header). Dividing the projected frame count by 4000 (< 4062) therefore
 *   overestimates the block count, and one extra block covers the header
 *   shortfall plus the empty-WAL case; the result is a conservative upper
 *   bound on post-commit SHM size, not an exact size. After the writes,
 *   inside the transaction, re-read pc = page_count, the current WAL size,
 *   and the physical files, then require
 *   max(pc * ps, phys) + pc * (ps + 24) + 32 + shmGrowth <= cap, where
 *   shmGrowth = max(0, neededShm - currentShmBytes) and neededShm =
 *   (ceil(projectedFrames / 4000) + 1) * 32768 with projectedFrames =
 *   existingFrames + pc and existingFrames =
 *   ceil(max(0, walSize - 32) / (ps + 24)). COMMIT can append at most one
 *   WAL frame per database page (dirty + newly allocated pages are all
 *   within the observed pc), each frame at most ps + 24 bytes, plus at most
 *   one 32-byte WAL header, plus SHM growth to the multi-block bound above.
 *   This over-reserves (up to ~one full extra database image plus SHM
 *   blocks) by design: a committed database can never exceed the cap under
 *   the supported WAL assumptions, at the cost of requiring roughly one
 *   image of headroom for any write.
 * - Fail-closed measurement: any unreadable PRAGMA / malformed database_list
 *   / non-ENOENT stat throws, the entry gate treats it as over cap, and the
 *   pre-commit gate throws "db over cap"; callers answer STORE_UNAVAILABLE.
 *   Only ENOENT on a -wal/-shm sidecar is tolerated (missing sidecar = 0).
 *   Nothing is admitted on a failed measurement.
 */
export const WAL_FRAME_HEADER_BYTES = 24;
export const WAL_HEADER_BYTES = 32;
export const WAL_INDEX_BLOCK_BYTES = 32768;
/** Conservative divisor: real blocks cover <=4096 frames (first ~4062). */
export const WAL_INDEX_FRAMES_PER_BLOCK_CONSERVATIVE = 4000;

/** True only for ENOENT stat failures (missing sidecar). All else is fatal. */
export function isEnoentStatError(e: unknown): boolean {
  return typeof e === "object" && e !== null && (e as { code?: unknown }).code === "ENOENT";
}

function statSizeOrThrow(p: string): number {
  const s = fs.statSync(p).size;
  if (!Number.isSafeInteger(s) || s < 0) throw new Error("db measure failed");
  return s;
}

function sidecarSizeOrThrow(p: string): number {
  try {
    return statSizeOrThrow(p);
  } catch (e) {
    if (isEnoentStatError(e)) return 0;
    throw e;
  }
}

/**
 * Conservative post-commit SHM size minus already-counted SHM (growth only).
 * Multi-block wal-index bound: see the gate comment above.
 */
export function shmGrowthBound(args: {
  walSize: number;
  shmSize: number;
  pageCount: number;
  pageSize: number;
}): number {
  const { walSize, shmSize, pageCount, pageSize } = args;
  if (
    !Number.isSafeInteger(walSize) || walSize < 0 ||
    !Number.isSafeInteger(shmSize) || shmSize < 0 ||
    !Number.isSafeInteger(pageCount) || pageCount < 0 ||
    !Number.isSafeInteger(pageSize) || pageSize <= 0
  ) {
    throw new Error("db measure failed");
  }
  const frameSize = pageSize + WAL_FRAME_HEADER_BYTES;
  if (!Number.isSafeInteger(frameSize) || frameSize <= 0) throw new Error("db measure failed");
  const existingFrames =
    walSize <= WAL_HEADER_BYTES ? 0 : Math.ceil((walSize - WAL_HEADER_BYTES) / frameSize);
  if (!Number.isSafeInteger(existingFrames) || existingFrames < 0) throw new Error("db measure failed");
  const projected = existingFrames + pageCount;
  if (!Number.isSafeInteger(projected) || projected < 0) throw new Error("db measure failed");
  const neededBlocks =
    Math.ceil(projected / WAL_INDEX_FRAMES_PER_BLOCK_CONSERVATIVE) + 1;
  if (!Number.isSafeInteger(neededBlocks) || neededBlocks < 0) throw new Error("db measure failed");
  const neededShm = neededBlocks * WAL_INDEX_BLOCK_BYTES;
  if (!Number.isSafeInteger(neededShm) || neededShm < 0) throw new Error("db measure failed");
  return Math.max(0, neededShm - shmSize);
}

export function measureFootprintOrThrow(db: DatabaseSync): {
  footprint: number;
  pageCount: number;
  pageSize: number;
  shmGrowth: number;
} {
  const pcRow = db.prepare(`PRAGMA page_count`).get() as { page_count: unknown } | undefined;
  const psRow = db.prepare(`PRAGMA page_size`).get() as { page_size: unknown } | undefined;
  const pc = pcRow?.page_count;
  const ps = psRow?.page_size;
  if (typeof pc !== "number" || typeof ps !== "number" || !Number.isSafeInteger(pc) || !Number.isSafeInteger(ps) || pc < 0 || ps <= 0) {
    throw new Error("db measure failed");
  }
  const logical = pc * ps;
  if (!Number.isSafeInteger(logical)) throw new Error("db measure failed");
  const rows = db.prepare(`PRAGMA database_list`).all() as Array<{ name: string; file: unknown }>;
  if (!Array.isArray(rows)) throw new Error("db measure failed");
  const main = rows.find((r) => typeof r === "object" && r !== null && (r as { name: unknown }).name === "main") as
    | { name: string; file: unknown }
    | undefined;
  if (!main) throw new Error("db measure failed");
  const mainFile: unknown = main.file;
  let physical = 0;
  let walSize = 0;
  let shmSize = 0;
  if (mainFile === "") {
    // :memory: database: no files; WAL/SHM sizes stay 0 (SHM growth bound
    // below still reserves conservatively from pc).
  } else if (typeof mainFile === "string" && mainFile.length > 0) {
    // Main-file stat failure is fatal (fail closed); only ENOENT on a
    // -wal/-shm sidecar means "missing sidecar = 0". Any other sidecar
    // stat error (EACCES, ENOTDIR, EIO, ...) is rethrown fail-closed.
    const mainSize = statSizeOrThrow(mainFile);
    walSize = sidecarSizeOrThrow(mainFile + "-wal");
    shmSize = sidecarSizeOrThrow(mainFile + "-shm");
    physical = mainSize + walSize + shmSize;
    if (!Number.isSafeInteger(physical) || physical < 0) throw new Error("db measure failed");
  } else {
    // Malformed/missing main entry (null, non-string, absent): fail closed
    // rather than misclassifying a file DB as :memory:.
    throw new Error("db measure failed");
  }
  const shmGrowth = shmGrowthBound({ walSize, shmSize, pageCount: pc, pageSize: ps });
  return { footprint: Math.max(logical, physical), pageCount: pc, pageSize: ps, shmGrowth };
}

function isDbOverCap(db: DatabaseSync, config: AppConfig): boolean {
  try {
    return measureFootprintOrThrow(db).footprint > config.dbMaxBytes;
  } catch {
    return true;
  }
}

/**
 * Pre-commit gate: call inside the transaction after all writes. Re-reads
 * page_count / files (so allocations are observed) and enforces the
 * conservative WAL-reserve bound. Throws "db over cap" on crossing AND on
 * measurement failure (fail closed); withTransaction rolls everything back.
 */
function assertDbUnderCap(db: DatabaseSync, config: AppConfig): void {
  let m: { footprint: number; pageCount: number; pageSize: number; shmGrowth: number };
  try {
    m = measureFootprintOrThrow(db);
  } catch {
    throw new Error("db over cap");
  }
  const reserve = m.pageCount * (m.pageSize + WAL_FRAME_HEADER_BYTES) + WAL_HEADER_BYTES + m.shmGrowth;
  if (!Number.isSafeInteger(reserve) || !Number.isSafeInteger(m.footprint + reserve)) {
    throw new Error("db over cap");
  }
  if (m.footprint + reserve > config.dbMaxBytes) throw new Error("db over cap");
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
    if (!isScopeAuthorized(db, config, args.scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  if (!isScopeAuthorized(db, config, args.scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);

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
  // Correction approvals need the T4 conditional-supersede transaction.
  if (row.kind === "correction" || row.supersedes !== null) {
    return budgeted(fail("NOT_IMPLEMENTED"), config);
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

  const approvedAt = nowOverride ?? nowIso();
  const recId = genId("rec");
  try {
    const response = withTransaction(db, (): ResponseEnvelope => {
      // Entry gate (cheap reject when already over cap; fail closed when
      // the footprint cannot be measured).
      if (isDbOverCap(db, config)) throw new Error("db over cap");
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
      db.prepare(
        `INSERT INTO records(id, candidateId, body, bodyHash, kind, source, observedAt, scope, status, supersedes, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, ?)`,
      ).run(recId, fresh.id, fresh.body, fresh.bodyHash, fresh.kind, fresh.source, fresh.observedAt, fresh.scope, approvedAt);
      for (const t of readTags(db, args.id)) {
        db.prepare(`INSERT OR IGNORE INTO record_tags(recordId, tag) VALUES (?, ?)`).run(recId, t);
      }
      const lk = readLink(db, args.id);
      if (lk !== null) {
        db.prepare(`INSERT OR IGNORE INTO record_links(fromId, toName) VALUES (?, ?)`).run(recId, lk);
      }
      db.prepare(`UPDATE candidates SET status='approved' WHERE id=? AND status='candidate'`).run(args.id);
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
      // Pre-commit cap: conservative WAL-reserve bound re-measured after
      // the writes. Crossing rolls back record + status flip
      // (STORE_UNAVAILABLE).
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      const again = readOperation(db, args.idempotencyKey);
      if (again && again.op === "approve" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    if (msg === "expired now") return budgeted(fail("EXPIRED"), config);
    if (msg === "state moved" || msg === "token moved") return budgeted(fail("CONFLICT"), config);
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
    if (!isScopeAuthorized(db, config, args.scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  if (!isScopeAuthorized(db, config, args.scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);

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
      // Entry gate (cheap reject when already over cap; fail closed when
      // the footprint cannot be measured).
      if (isDbOverCap(db, config)) throw new Error("db over cap");
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
      // Pre-commit cap: conservative WAL-reserve bound re-measured after
      // the writes. Crossing rolls back the flip.
      assertDbUnderCap(db, config);
      return stored;
    });
    return response;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      const again = readOperation(db, args.idempotencyKey);
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
