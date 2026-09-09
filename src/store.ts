/**
 * M1 autonomous memory store (replaces the old candidate/approval architecture).
 *
 * Direct autonomous writes, no candidates, no approvals, no TTY path:
 * - event.append: immutable raw append (single txn: raw_events + FTS + bigrams + operations + audit)
 * - record.remember: direct active write with sourceRefs validation (single txn)
 * - record.get / record.list: same-scope reads (get returns any status; list defaults active)
 * - record.recall: bounded hybrid lexical (FTS5 BM25 + char-bigram) + raw descent
 *   + exact tag/link seeds + depth-2 graph expansion, deterministic fusion
 * - record.feedback: exposure-verified usage + heat in a single txn (mere recall adds no heat)
 * - record.correct: new revision + conditional active->superseded in one txn (one winner)
 * - record.archive: conditional active->archived (terminal, row kept)
 *
 * Vector search is NOT implemented in M1: recall degrades to lexical+graph
 * by construction (§8). maintain.distill is NOT implemented (M3).
 * Links are opaque refs (max 8); graph follows only active same-scope
 * resolved refs; dangling refs are kept and skipped during expansion.
 * Raw bodies never leave through recall items (snippets only), audit, or errors.
 */
import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  bodyHashFor,
  canonicalStringify,
  canonicalTime,
  containsLoneSurrogateDeep,
  countCp,
  hasControl,
  normalizeBody,
  normalizeField,
  normalizeLink,
  normalizeTag,
  nowIso,
  requestHashFor,
  sha256HexUtf8,
} from "./normalize.js";
import { enqueueProjection } from "./projection.js";
import {
  applyResponseBudget,
  fail,
  ok,
  type ResponseEnvelope,
} from "./protocol.js";

export const RECORD_KINDS = [
  "user_fact",
  "model_inference",
  "summary",
  "correction",
] as const;

export const ARCHIVE_REASONS = [
  "USER_ARCHIVED",
  "OBSOLETE",
  "DUPLICATE",
] as const;

/** Recall/graph bounds (plan §8 defaults; fixed, documented, deterministic). */
export const GRAPH_DEPTH_MAX = 2;
export const GRAPH_EXPAND_MAX = 40;
export const RAW_DESCENT_MAX = 3;
export const FUSION_CANDIDATE_MAX = 60;
/** Exposures ledger cap: oldest rows pruned beyond this (feedback stays verifiable while fresh). */
export const EXPOSURES_CAP = 1000;

const ID_RE = /^[A-Za-z0-9_-]+$/;

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export function ensureM1Schema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS raw_events(
    eventId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
    body TEXT NOT NULL, bodyNorm TEXT NOT NULL,
    source TEXT NOT NULL, observedAt TEXT NOT NULL,
    scope TEXT NOT NULL, runId TEXT NULL, createdAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS records(
    id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
    source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','superseded','archived')),
    supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS record_tags(recordId TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(recordId, tag))`);
  db.exec(`CREATE TABLE IF NOT EXISTS record_links(fromId TEXT NOT NULL, toRef TEXT NOT NULL, PRIMARY KEY(fromId, toRef))`);
  db.exec(`CREATE TABLE IF NOT EXISTS record_source_refs(recordId TEXT NOT NULL, eventId TEXT NOT NULL, PRIMARY KEY(recordId, eventId))`);
  db.exec(`CREATE TABLE IF NOT EXISTS operations(
    idempotencyKey TEXT PRIMARY KEY, op TEXT NOT NULL, requestHash TEXT NOT NULL,
    responseJson TEXT NOT NULL, createdAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS audit(
    ts TEXT NOT NULL, op TEXT NOT NULL, targetId TEXT NULL, code TEXT NOT NULL,
    scope TEXT NULL, bytes INTEGER NULL, limitN INTEGER NULL, runId TEXT NULL,
    recallId TEXT NULL, reasonCode TEXT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS exposures(
    ts TEXT NOT NULL, recallId TEXT NOT NULL, runId TEXT NULL, scope TEXT NULL,
    recordId TEXT NOT NULL, snippetBytes INTEGER NULL, truncated INTEGER NULL, limitN INTEGER NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS usage(
    ts TEXT NOT NULL, recallId TEXT NOT NULL, recordId TEXT NOT NULL, scope TEXT NOT NULL, runId TEXT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS note_heat(recordId TEXT PRIMARY KEY, usedCount INTEGER NOT NULL, lastUsedAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS projection_queue(recordId TEXT PRIMARY KEY, attempts INTEGER NOT NULL, nextAt TEXT NOT NULL)`);
  // Derived lexical indexes (rebuildable; never canonical).
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(recordId UNINDEXED, body)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_raw USING fts5(eventId UNINDEXED, body)`);
  db.exec(`CREATE TABLE IF NOT EXISTS char_bigrams(kind TEXT NOT NULL, id TEXT NOT NULL, bigram TEXT NOT NULL, PRIMARY KEY(kind, id, bigram))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_records_scope_status_created_id ON records(scope, status, createdAt, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_record_tags_tag_record ON record_tags(tag, recordId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_record_links_toref_from ON record_links(toRef, fromId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_source_refs_event ON record_source_refs(eventId, recordId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bigrams_lookup ON char_bigrams(kind, bigram, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_exposures_recall ON exposures(recallId, recordId)`);
  try {
    db.exec(`DELETE FROM usage WHERE rowid NOT IN (SELECT MIN(rowid) FROM usage GROUP BY recallId, recordId)`);
  } catch {
    /* best-effort dedupe before enforcing uniqueness */
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_usage_recall_record ON usage(recallId, recordId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_scope_created ON raw_events(scope, createdAt, eventId)`);
  // Self-heal derived indexes when they are obviously out of sync with
  // canonical tables (empty or smaller than canonical). Best-effort only:
  // never throws, never touches canonical rows; recall's bodyNorm fallback
  // covers reads even when repair fails.
  maybeRebuildDerivedIndexes(db);
}

/**
 * Legacy approval-schema detector. True when ANY trace of the old
 * candidate/approval architecture exists: candidates tables, a records table
 * carrying candidateId, approval tokens, TTL columns. Fresh/empty DBs (no
 * tables, or scopes-only) are NOT legacy. Read-only: never mutates.
 */
export function hasLegacyApprovalSchema(db: DatabaseSync): boolean {
  let names: Array<{ name: string; sql: string | null }>;
  try {
    names = db
      .prepare(`SELECT name, sql FROM sqlite_master WHERE type IN ('table','view')`)
      .all() as Array<{ name: string; sql: string | null }>;
  } catch {
    return true; // Unreadable catalog: refuse rather than guess.
  }
  const set = new Set(names.map((r) => r.name));
  if (set.has("candidates") || set.has("candidate_tags") || set.has("candidate_links")) {
    return true;
  }
  for (const r of names) {
    const sql = r.sql ?? "";
    if (/candidateId/i.test(sql) || /approvalToken/i.test(sql) || /expiresAt/i.test(sql)) {
      return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function genId(prefix: string): string {
  return `${prefix}_${randomBytes(8).toString("hex")}`;
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

interface StoredOp {
  op: string;
  requestHash: string;
  responseJson: string;
}

function readOperation(db: DatabaseSync, key: string): StoredOp | null {
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
  return budgeted({ ...parsed, deduplicated: true }, config);
}

export function isScopeAuthorized(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
): boolean {
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

function scopeGate(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
): ResponseEnvelope | null {
  try {
    if (!isScopeAuthorized(db, config, scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    return null;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

function bad(): ResponseEnvelope {
  return fail("BAD_REQUEST");
}
function limitExceeded(): ResponseEnvelope {
  return fail("LIMIT_EXCEEDED");
}

function checkLenCp(s: string, min: number, max: number): "ok" | "short" | "long" {
  const n = countCp(s);
  if (n < min) return "short";
  if (n > max) return "long";
  return "ok";
}

function changedRows(result: unknown): number {
  const c = (result as { changes?: unknown } | null)?.changes;
  if (typeof c === "number" && Number.isSafeInteger(c)) return c;
  if (typeof c === "bigint") return Number(c);
  return 0;
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

/** DB cap gate (best-effort max of logical vs physical WAL-inclusive size). */
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

function assertDbUnderCap(db: DatabaseSync, config: AppConfig): void {
  if (isDbOverCap(db, config)) throw new Error("db over cap");
}

/* ---------------- char bigrams (CJK-safe lexical path) --------------- */

/** Adjacent code-point pairs of the normalized text (pure, deterministic). */
export function bigramsOf(normalized: string): string[] {
  const cps = [...normalized].filter((c) => c !== " ");
  const out = new Set<string>();
  for (let i = 0; i + 1 < cps.length; i++) {
    out.add((cps[i] as string) + (cps[i + 1] as string));
  }
  return [...out].sort();
}

function indexBigrams(
  db: DatabaseSync,
  kind: "note" | "raw",
  id: string,
  normalized: string,
): void {
  const ins = db.prepare(`INSERT OR IGNORE INTO char_bigrams(kind, id, bigram) VALUES (?, ?, ?)`);
  for (const b of bigramsOf(normalized)) ins.run(kind, id, b);
}

/**
 * Bounded best-effort post-commit index maintenance (never throws).
 * Derived FTS/bigram rows are rebuildable; a failure here must never roll
 * back the already-committed canonical raw/record write. Recall always
 * keeps a canonical bodyNorm instr fallback, so memory stays findable
 * when these derived rows are absent.
 */
function bestEffortIndexNote(db: DatabaseSync, recordId: string, bodyNorm: string): void {
  try {
    db.prepare(`INSERT INTO fts_notes(recordId, body) VALUES (?, ?)`).run(recordId, bodyNorm);
  } catch {
    /* derived only; canonical commit already succeeded */
  }
  try {
    indexBigrams(db, "note", recordId, bodyNorm);
  } catch {
    /* ignore */
  }
}

function bestEffortIndexRaw(db: DatabaseSync, eventId: string, bodyNorm: string): void {
  try {
    db.prepare(`INSERT INTO fts_raw(eventId, body) VALUES (?, ?)`).run(eventId, bodyNorm);
  } catch {
    /* derived only; canonical commit already succeeded */
  }
  try {
    indexBigrams(db, "raw", eventId, bodyNorm);
  } catch {
    /* ignore */
  }
}

/**
 * Post-commit projection enqueue (best-effort, never throws, never affects
 * the already-committed envelope). Must run OUTSIDE canonical transactions:
 * canonical commits must not depend on queue/index success.
 */
function outboundRefsOf(db: DatabaseSync, fromId: string): string[] {
  try {
    const rows = db.prepare(`SELECT toRef FROM record_links WHERE fromId = ?`).all(fromId) as Array<{
      toRef: string;
    }>;
    return rows.map((r) => r.toRef);
  } catch {
    return [];
  }
}

/** Resolve outbound refs to existing same-scope record IDs (best-effort). */
function resolvedSameScopeIds(db: DatabaseSync, scope: string, refs: string[]): string[] {
  const out: string[] = [];
  try {
    const stmt = db.prepare(`SELECT id FROM records WHERE id = ? AND scope = ?`);
    for (const r of refs) {
      try {
        const row = stmt.get(r, scope) as { id: string } | undefined;
        if (row) out.push(row.id);
      } catch {
        /* per-ref best effort */
      }
    }
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Enqueue changed records plus resolved same-scope outbound targets whose
 * rendered Backlinks section may have changed. Unresolved/dangling refs stay
 * canonical links but are never enqueued as files. Best-effort: never throws.
 */
function postCommitEnqueueProjections(
  db: DatabaseSync,
  scope: string,
  changedIds: string[],
  outboundRefs: string[],
): void {
  try {
    const seen = new Set<string>();
    const targets = resolvedSameScopeIds(db, scope, outboundRefs);
    for (const id of [...changedIds, ...targets]) {
      if (seen.has(id)) continue;
      seen.add(id);
      enqueueProjection(db, id);
    }
  } catch {
    /* projection is best-effort; the commit already succeeded */
  }
}

/**
 * Exported rebuild of derived lexical indexes from canonical tables.
 * Reads raw_events.bodyNorm / records.bodyNorm (canonical), clears only
 * the derived tables (fts_notes, fts_raw, char_bigrams), and re-inserts.
 * Bounded by the existing canonical row count; never deletes or mutates
 * canonical rows. On failure the canonical tables are untouched (derived
 * tables may be partially rebuilt; recall's bodyNorm fallback still works).
 */
export function rebuildDerivedIndexes(db: DatabaseSync): { notes: number; raw: number; bigrams: number } {
  const noteRows = db
    .prepare(`SELECT id, bodyNorm FROM records ORDER BY createdAt ASC, id ASC`)
    .all() as Array<{ id: string; bodyNorm: string }>;
  const rawRows = db
    .prepare(`SELECT eventId, bodyNorm FROM raw_events ORDER BY createdAt ASC, eventId ASC`)
    .all() as Array<{ eventId: string; bodyNorm: string }>;
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(`DELETE FROM fts_notes`);
    db.exec(`DELETE FROM fts_raw`);
    db.exec(`DELETE FROM char_bigrams`);
    const ftsNote = db.prepare(`INSERT INTO fts_notes(recordId, body) VALUES (?, ?)`);
    for (const r of noteRows) {
      try {
        ftsNote.run(r.id, r.bodyNorm);
      } catch {
        /* per-row best effort; continue */
      }
    }
    const ftsRaw = db.prepare(`INSERT INTO fts_raw(eventId, body) VALUES (?, ?)`);
    for (const r of rawRows) {
      try {
        ftsRaw.run(r.eventId, r.bodyNorm);
      } catch {
        /* per-row best effort; continue */
      }
    }
    const bi = db.prepare(`INSERT OR IGNORE INTO char_bigrams(kind, id, bigram) VALUES (?, ?, ?)`);
    let bigrams = 0;
    for (const r of noteRows) {
      for (const b of bigramsOf(r.bodyNorm)) {
        try {
          bi.run("note", r.id, b);
          bigrams++;
        } catch {
          break;
        }
      }
    }
    for (const r of rawRows) {
      for (const b of bigramsOf(r.bodyNorm)) {
        try {
          bi.run("raw", r.eventId, b);
          bigrams++;
        } catch {
          break;
        }
      }
    }
    db.exec("COMMIT");
    return { notes: noteRows.length, raw: rawRows.length, bigrams };
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function countTable(db: DatabaseSync, sql: string): number | null {
  try {
    const row = db.prepare(sql).get() as { n: number } | undefined;
    return typeof row?.n === "number" ? row.n : null;
  } catch {
    return null;
  }
}

/** Best-effort repair hook for schema init: rebuild on obvious mismatch only. Never throws. */
function maybeRebuildDerivedIndexes(db: DatabaseSync): void {
  try {
    const notes = countTable(db, `SELECT COUNT(*) AS n FROM records`);
    const ftsNotes = countTable(db, `SELECT COUNT(*) AS n FROM fts_notes`);
    const raws = countTable(db, `SELECT COUNT(*) AS n FROM raw_events`);
    const ftsRaws = countTable(db, `SELECT COUNT(*) AS n FROM fts_raw`);
    const bigrams = countTable(db, `SELECT COUNT(*) AS n FROM char_bigrams`);
    if (notes === null || ftsNotes === null || raws === null || ftsRaws === null || bigrams === null) return;
    const missing =
      (notes > 0 && ftsNotes === 0) ||
      (raws > 0 && ftsRaws === 0) ||
      (notes + raws > 0 && bigrams === 0) ||
      ftsNotes < notes ||
      ftsRaws < raws;
    if (!missing) return;
    try {
      rebuildDerivedIndexes(db);
    } catch {
      /* recall bodyNorm fallback covers; never fail init */
    }
  } catch {
    /* never fail schema init on index repair */
  }
}

function ftsEscapeTerm(t: string): string {
  return t.replace(/"/g, '""');
}

/** FTS5 BM25 candidates over notes; empty array when FTS errors (bigram path covers). */
function ftsNoteHits(
  db: DatabaseSync,
  scope: string,
  normalizedQuery: string,
  since: string | null,
  until: string | null,
  cap: number,
): Array<{ id: string; rank: number }> {
  const terms = normalizedQuery.split(" ").map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 8);
  if (terms.length === 0) return [];
  const match = terms.map((t) => `"${ftsEscapeTerm(t)}"*`).join(" OR ");
  try {
    let sql = `SELECT f.recordId AS id, bm25(fts_notes) AS r FROM fts_notes f
      JOIN records ON records.id = f.recordId
      WHERE f.body MATCH ? AND records.scope = ? AND records.status = 'active'`;
    const args: Array<string | number> = [match, scope];
    if (since !== null) {
      sql += ` AND records.createdAt >= ?`;
      args.push(since);
    }
    if (until !== null) {
      sql += ` AND records.createdAt < ?`;
      args.push(until);
    }
    sql += ` ORDER BY r ASC LIMIT ?`;
    args.push(cap);
    return db.prepare(sql).all(...args) as Array<{ id: string; rank: number }>;
  } catch {
    return [];
  }
}

/** Bigram-overlap candidates over notes (deterministic, CJK-safe). */
function bigramNoteHits(
  db: DatabaseSync,
  scope: string,
  normalizedQuery: string,
  since: string | null,
  until: string | null,
  cap: number,
): Array<{ id: string; overlap: number }> {
  const bigrams = bigramsOf(normalizedQuery);
  if (bigrams.length === 0) {
    // Single-char query: exact substring scan fallback (bounded by scope window).
    try {
      let sql = `SELECT id FROM records WHERE scope = ? AND status = 'active' AND instr(bodyNorm, ?) > 0`;
      const args: Array<string | number> = [scope, normalizedQuery];
      if (since !== null) {
        sql += ` AND createdAt >= ?`;
        args.push(since);
      }
      if (until !== null) {
        sql += ` AND createdAt < ?`;
        args.push(until);
      }
      sql += ` ORDER BY createdAt DESC, id ASC LIMIT ?`;
      args.push(cap);
      return (db.prepare(sql).all(...args) as Array<{ id: string }>).map((r) => ({ id: r.id, overlap: 1 }));
    } catch {
      return [];
    }
  }
  try {
    const placeholders = bigrams.map(() => "?").join(",");
    let sql = `SELECT b.id AS id, COUNT(*) AS overlap FROM char_bigrams b
      JOIN records ON records.id = b.id
      WHERE b.kind = 'note' AND b.bigram IN (${placeholders}) AND records.scope = ? AND records.status = 'active'`;
    const args: Array<string | number> = [...bigrams, scope];
    if (since !== null) {
      sql += ` AND records.createdAt >= ?`;
      args.push(since);
    }
    if (until !== null) {
      sql += ` AND records.createdAt < ?`;
      args.push(until);
    }
    sql += ` GROUP BY b.id ORDER BY overlap DESC, records.createdAt DESC, b.id ASC LIMIT ?`;
    args.push(cap);
    return db.prepare(sql).all(...args) as Array<{ id: string; overlap: number }>;
  } catch {
    return [];
  }
}

/** Raw lexical hits mapped to records via source refs (active, same scope, time-windowed). */
function rawDescentHits(
  db: DatabaseSync,
  scope: string,
  normalizedQuery: string,
  since: string | null,
  until: string | null,
): Array<{ id: string }> {
  const terms = normalizedQuery.split(" ").map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 8);
  let eventIds: string[] = [];
  if (terms.length > 0) {
    const match = terms.map((t) => `"${ftsEscapeTerm(t)}"*`).join(" OR ");
    try {
      const rows = db
        .prepare(
          `SELECT f.eventId AS eventId FROM fts_raw f
           JOIN raw_events ON raw_events.eventId = f.eventId
           WHERE f.body MATCH ? AND raw_events.scope = ?
           ORDER BY bm25(fts_raw) ASC LIMIT ?`,
        )
        .all(match, scope, RAW_DESCENT_MAX) as Array<{ eventId: string }>;
      eventIds = rows.map((r) => r.eventId);
    } catch {
      eventIds = [];
    }
  }
  if (eventIds.length === 0) {
    // Bigram fallback over raw bodies for CJK/short queries.
    const bigrams = bigramsOf(normalizedQuery);
    try {
      if (bigrams.length > 0) {
        const placeholders = bigrams.map(() => "?").join(",");
        const rows = db
          .prepare(
            `SELECT b.id AS eventId, COUNT(*) AS overlap FROM char_bigrams b
             JOIN raw_events ON raw_events.eventId = b.id
             WHERE b.kind = 'raw' AND b.bigram IN (${placeholders}) AND raw_events.scope = ?
             GROUP BY b.id ORDER BY overlap DESC, raw_events.createdAt DESC, b.id ASC LIMIT ?`,
          )
          .all(...[...bigrams, scope, RAW_DESCENT_MAX]) as Array<{ eventId: string }>;
        eventIds = rows.map((r) => r.eventId);
      } else {
        const rows = db
          .prepare(
            `SELECT eventId FROM raw_events WHERE scope = ? AND instr(bodyNorm, ?) > 0
             ORDER BY createdAt DESC, eventId ASC LIMIT ?`,
          )
          .all(scope, normalizedQuery, RAW_DESCENT_MAX) as Array<{ eventId: string }>;
        eventIds = rows.map((r) => r.eventId);
      }
    } catch {
      eventIds = [];
    }
  }
  if (eventIds.length === 0) return [];
  try {
    const placeholders = eventIds.map(() => "?").join(",");
    let sql = `SELECT DISTINCT s.recordId AS id FROM record_source_refs s
         JOIN records ON records.id = s.recordId
         WHERE s.eventId IN (${placeholders}) AND records.scope = ? AND records.status = 'active'`;
    const args: Array<string | number> = [...eventIds, scope];
    if (since !== null) {
      sql += ` AND records.createdAt >= ?`;
      args.push(since);
    }
    if (until !== null) {
      sql += ` AND records.createdAt < ?`;
      args.push(until);
    }
    const rows = db.prepare(sql).all(...args) as Array<{ id: string }>;
    return rows;
  } catch {
    return [];
  }
}

/**
 * Bounded canonical fallback over records.bodyNorm (never FTS/bigrams).
 * Guarantees committed memory stays findable when derived indexes are
 * absent or stale. Whole-query instr first, then per-term OR when the
 * query has multiple tokens. Deterministic, scope/status/window bounded.
 */
function canonicalBodyNormHits(
  db: DatabaseSync,
  scope: string,
  normalizedQuery: string,
  since: string | null,
  until: string | null,
  cap: number,
): Array<{ id: string }> {
  const terms = normalizedQuery.split(" ").map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 8);
  if (terms.length === 0) return [];
  try {
    const window = (alias: string): { frag: string; args: Array<string | number> } => {
      let frag = "";
      const args: Array<string | number> = [];
      if (since !== null) {
        frag += ` AND ${alias}.createdAt >= ?`;
        args.push(since);
      }
      if (until !== null) {
        frag += ` AND ${alias}.createdAt < ?`;
        args.push(until);
      }
      return { frag, args };
    };
    const w = window("records");
    const whole = db
      .prepare(
        `SELECT id FROM records WHERE scope = ? AND status = 'active' AND instr(bodyNorm, ?) > 0${w.frag}
         ORDER BY createdAt DESC, id ASC LIMIT ?`,
      )
      .all(scope, normalizedQuery, ...w.args, cap) as Array<{ id: string }>;
    if (whole.length > 0 || terms.length === 1) return whole;
    const conds = terms.map(() => `instr(bodyNorm, ?) > 0`).join(" OR ");
    const w2 = window("records");
    const perTerm = db
      .prepare(
        `SELECT id FROM records WHERE scope = ? AND status = 'active' AND (${conds})${w2.frag}
         ORDER BY createdAt DESC, id ASC LIMIT ?`,
      )
      .all(scope, ...terms, ...w2.args, cap) as Array<{ id: string }>;
    return perTerm;
  } catch {
    return [];
  }
}

/* ---------------- shared param validation ---------------- */

function parseProvenance(
  provenance: unknown,
): { source: string; observedAt: string } | null {
  if (!isPlainObject(provenance)) return null;
  const keys = Object.keys(provenance);
  if (keys.length !== 2 || !keys.includes("source") || !keys.includes("observedAt")) return null;
  const source = provenance["source"];
  const observedAt = provenance["observedAt"];
  if (typeof source !== "string") return null;
  const srcLen = checkLenCp(source, 1, 256);
  if (srcLen !== "ok" || hasControl(source)) return null;
  const canonObs = canonicalTime(observedAt);
  if (canonObs === null) return null;
  return { source: source as string, observedAt: canonObs };
}

function parseScope(scope: unknown): string | null {
  if (typeof scope !== "string") return null;
  if (checkLenCp(scope, 1, 256) !== "ok" || hasControl(scope)) return null;
  return scope;
}

function parseRunId(runId: unknown): string | null | "invalid" {
  if (runId === undefined || runId === null) return null;
  if (typeof runId !== "string") return "invalid";
  if (checkLenCp(runId, 1, 256) !== "ok" || hasControl(runId)) return "invalid";
  return runId;
}

function parseTags(tags: unknown, max: number): string[] | "bad" | "over" {
  if (tags === undefined) return [];
  if (!Array.isArray(tags)) return "bad";
  if (tags.length > max) return "over";
  const seen = new Set<string>();
  for (const t of tags) {
    if (typeof t !== "string") return "bad";
    const tl = checkLenCp(t, 1, 256);
    if (tl === "long") return "over";
    if (tl === "short" || hasControl(t)) return "bad";
    const nt = normalizeTag(t);
    if (countCp(nt) < 1 || countCp(nt) > 256) return "bad";
    seen.add(nt);
  }
  return [...seen].sort();
}

/** Opaque outbound link refs: non-empty, bounded, control-free, case preserved. */
function parseLinks(links: unknown, max: number): string[] | "bad" | "over" {
  if (links === undefined) return [];
  if (!Array.isArray(links)) return "bad";
  if (links.length > max) return "over";
  const seen = new Set<string>();
  for (const l of links) {
    if (typeof l !== "string") return "bad";
    const ll = checkLenCp(l, 1, 256);
    if (ll === "long") return "over";
    if (ll === "short" || hasControl(l)) return "bad";
    const nl = normalizeLink(l);
    if (countCp(nl) < 1 || countCp(nl) > 256) return "bad";
    seen.add(nl);
  }
  return [...seen].sort();
}

function parseSourceRefs(refs: unknown, max: number): string[] | "bad" | "over" {
  if (refs === undefined) return [];
  if (!Array.isArray(refs)) return "bad";
  if (refs.length > max) return "over";
  const seen = new Set<string>();
  for (const r of refs) {
    if (typeof r !== "string") return "bad";
    if (countCp(r) < 1 || countCp(r) > 256 || hasControl(r)) return "bad";
    seen.add(r);
  }
  return [...seen].sort();
}

/* ------------------------------------------------------------------ */
/* event.append                                                        */
/* ------------------------------------------------------------------ */

export function eventAppend(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["eventId", "sessionId", "turnId", "body", "provenance", "scope", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { eventId, sessionId, turnId, body, provenance, scope, runId } = params;
  for (const f of [eventId, sessionId, turnId]) {
    if (typeof f !== "string" || checkLenCp(f, 1, 128) !== "ok" || hasControl(f as string)) {
      return budgeted(bad(), config);
    }
  }
  if (typeof body !== "string") return budgeted(bad(), config);
  if (countCp(body) > config.limits.bodyMaxCp) return budgeted(limitExceeded(), config);
  const nBody = normalizeBody(body);
  if (countCp(nBody) < 1) return budgeted(bad(), config);
  if (countCp(nBody) > config.limits.bodyMaxCp) return budgeted(limitExceeded(), config);
  const prov = parseProvenance(provenance);
  if (!prov) return budgeted(bad(), config);
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  const nRunId = parseRunId(runId);
  if (nRunId === "invalid") return budgeted(bad(), config);

  const reqHash = requestHashFor("event.append", {
    body: body as string,
    eventId,
    observedAt: prov.observedAt,
    runId: nRunId,
    scope: nScope,
    sessionId,
    source: prov.source,
    turnId,
  });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "event.append") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);
  const rawBody = body as string;
  let committed: ResponseEnvelope;
  try {
    committed = withTransaction(db, (): ResponseEnvelope => {
      const probe: ResponseEnvelope = ok({ event: { eventId } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      db.prepare(
        `INSERT INTO raw_events(eventId, sessionId, turnId, body, bodyNorm, source, observedAt, scope, runId, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(eventId as string, sessionId as string, turnId as string, rawBody, nBody, prov.source, prov.observedAt, nScope, nRunId, now);
      const stored = budgeted(probe, config);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, "event.append", reqHash, JSON.stringify(stored), now);
      auditInsert(db, {
        ts: now,
        op: "event.append",
        targetId: eventId as string,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: null,
        runId: nRunId,
        recallId: null,
        reasonCode: null,
      });
      assertDbUnderCap(db, config);
      return stored;
    });
    // Derived indexes post-commit, best-effort: failure never rolls back canonical.
    bestEffortIndexRaw(db, eventId as string, nBody);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "event.append" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    if (/UNIQUE constraint failed: raw_events/.test(msg)) {
      // Same eventId re-appended under a fresh key: immutable raw, no update.
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  return committed;
}

/* ------------------------------------------------------------------ */
/* record.remember                                                     */
/* ------------------------------------------------------------------ */

interface NormalizedRemember {
  body: string;
  bodyNorm: string;
  kind: string;
  source: string;
  observedAt: string;
  scope: string;
  tags: string[];
  links: string[];
  sourceRefs: string[];
  runId: string | null;
}

/**
 * Empty sourceRefs are allowed ONLY for kind=model_inference/summary whose
 * provenance source carries an explicit derivation marker ("derived",
 * case-insensitive). Everything else with empty sourceRefs is BAD_REQUEST.
 */
function emptyRefsAllowed(kind: string, source: string): boolean {
  if (kind !== "model_inference" && kind !== "summary") return false;
  return /derived/i.test(source);
}

function parseRememberParams(
  config: AppConfig,
  params: Record<string, unknown>,
): { ok: true; value: NormalizedRemember } | { ok: false; res: ResponseEnvelope } {
  if (containsLoneSurrogateDeep(params)) return { ok: false, res: bad() };
  const allowed = new Set(["body", "kind", "provenance", "scope", "tags", "links", "sourceRefs", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: bad() };
  }
  const { body, kind, provenance, scope, tags, links, sourceRefs, runId } = params;
  if (typeof body !== "string") return { ok: false, res: bad() };
  if (countCp(body) > config.limits.bodyMaxCp) return { ok: false, res: limitExceeded() };
  const nBody = normalizeBody(body);
  if (countCp(nBody) < 1) return { ok: false, res: bad() };
  if (countCp(nBody) > config.limits.bodyMaxCp) return { ok: false, res: limitExceeded() };
  if (typeof kind !== "string" || !(RECORD_KINDS as readonly string[]).includes(kind)) {
    return { ok: false, res: bad() };
  }
  const prov = parseProvenance(provenance);
  if (!prov) return { ok: false, res: bad() };
  const nScope = parseScope(scope);
  if (!nScope) return { ok: false, res: bad() };
  const nTags = parseTags(tags, config.limits.tagsMax);
  if (nTags === "bad") return { ok: false, res: bad() };
  if (nTags === "over") return { ok: false, res: limitExceeded() };
  const nLinks = parseLinks(links, config.limits.linksMax);
  if (nLinks === "bad") return { ok: false, res: bad() };
  if (nLinks === "over") return { ok: false, res: limitExceeded() };
  const nRefs = parseSourceRefs(sourceRefs, config.limits.sourceRefsMax);
  if (nRefs === "bad") return { ok: false, res: bad() };
  if (nRefs === "over") return { ok: false, res: limitExceeded() };
  if (nRefs.length === 0 && !emptyRefsAllowed(kind as string, prov.source)) {
    return { ok: false, res: bad() };
  }
  const nRunId = parseRunId(runId);
  if (nRunId === "invalid") return { ok: false, res: bad() };
  return {
    ok: true,
    value: {
      body: body as string,
      bodyNorm: nBody,
      kind: kind as string,
      source: prov.source,
      observedAt: prov.observedAt,
      scope: nScope,
      tags: nTags,
      links: nLinks,
      sourceRefs: nRefs,
      runId: nRunId,
    },
  };
}

/** Verify every sourceRef exists as same-scope raw; returns error envelope or null. */
function checkSourceRefs(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  refs: string[],
): ResponseEnvelope | null {
  for (const r of refs) {
    let row: { scope: string } | undefined;
    try {
      row = db.prepare(`SELECT scope FROM raw_events WHERE eventId = ?`).get(r) as
        | { scope: string }
        | undefined;
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    if (!row) return budgeted(fail("NOT_FOUND"), config);
    if (row.scope !== scope) return budgeted(fail("FORBIDDEN_SCOPE"), config);
  }
  return null;
}

export function rememberRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  const parsed = parseRememberParams(config, params);
  if (!parsed.ok) return budgeted(parsed.res, config);
  const n = parsed.value;
  const reqHash = requestHashFor("record.remember", {
    body: n.body,
    kind: n.kind,
    links: n.links,
    observedAt: n.observedAt,
    runId: n.runId,
    scope: n.scope,
    source: n.source,
    sourceRefs: n.sourceRefs,
    tags: n.tags,
  });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "record.remember") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, n.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, n.scope);
    if (denied) return denied;
  }
  {
    const refErr = checkSourceRefs(db, config, n.scope, n.sourceRefs);
    if (refErr) return refErr;
  }

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);
  const id = genId("rec");
  let committed: ResponseEnvelope;
  try {
    committed = withTransaction(db, (): ResponseEnvelope => {
      // Re-verify refs inside the txn (fail closed on concurrent change).
      for (const r of n.sourceRefs) {
        const row = db.prepare(`SELECT scope FROM raw_events WHERE eventId = ?`).get(r) as
          | { scope: string }
          | undefined;
        if (!row) throw new Error("source lost");
        if (row.scope !== n.scope) throw new Error("source scope");
      }
      const probe: ResponseEnvelope = ok({ record: { id } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      db.prepare(
        `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?)`,
      ).run(id, n.body, n.bodyNorm, bodyHashFor(n.body), n.kind, n.source, n.observedAt, n.scope, now);
      for (const t of n.tags) {
        db.prepare(`INSERT INTO record_tags(recordId, tag) VALUES (?, ?)`).run(id, t);
      }
      for (const l of n.links) {
        db.prepare(`INSERT INTO record_links(fromId, toRef) VALUES (?, ?)`).run(id, l);
      }
      for (const r of n.sourceRefs) {
        db.prepare(`INSERT INTO record_source_refs(recordId, eventId) VALUES (?, ?)`).run(id, r);
      }
      db.prepare(`INSERT OR IGNORE INTO note_heat(recordId, usedCount, lastUsedAt) VALUES (?, 0, ?)`).run(id, now);
      const stored = budgeted(probe, config);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, "record.remember", reqHash, JSON.stringify(stored), now);
      auditInsert(db, {
        ts: now,
        op: "record.remember",
        targetId: id,
        code: stored.code,
        scope: n.scope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: null,
        runId: n.runId,
        recallId: null,
        reasonCode: null,
      });
      // Canonical txn ends here: projection queue is post-commit only so the
      // commit never depends on queue/index success.
      assertDbUnderCap(db, config);
      return stored;
    });
    // Post-commit, best-effort: the new record plus resolved same-scope
    // outbound targets whose Backlinks section now includes the new record.
    // Never changes the committed response.
    postCommitEnqueueProjections(db, n.scope, [id], n.links);
    // Derived indexes post-commit, best-effort: failure never rolls back canonical.
    bestEffortIndexNote(db, id, n.bodyNorm);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "source lost") return budgeted(fail("NOT_FOUND"), config);
    if (msg === "source scope") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "record.remember" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  return committed;
}

/* ------------------------------------------------------------------ */
/* record.get / record.list                                            */
/* ------------------------------------------------------------------ */

export interface RecordView {
  id: string;
  body: string;
  bodyHash: string;
  kind: string;
  source: string;
  observedAt: string;
  scope: string;
  status: string;
  supersedes: string | null;
  revision: number;
  createdAt: string;
  tags: string[];
  links: string[];
  sourceRefs: string[];
}

function readRecordView(db: DatabaseSync, id: string): RecordView | null {
  const row = db
    .prepare(
      `SELECT id, body, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt
       FROM records WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        body: string;
        bodyHash: string;
        kind: string;
        source: string;
        observedAt: string;
        scope: string;
        status: string;
        supersedes: string | null;
        revision: number;
        createdAt: string;
      }
    | undefined;
  if (!row) return null;
  const tags = (
    db.prepare(`SELECT tag FROM record_tags WHERE recordId = ? ORDER BY tag ASC`).all(id) as Array<{ tag: string }>
  ).map((r) => r.tag);
  const links = (
    db.prepare(`SELECT toRef FROM record_links WHERE fromId = ? ORDER BY toRef ASC`).all(id) as Array<{ toRef: string }>
  ).map((r) => r.toRef);
  const sourceRefs = (
    db.prepare(`SELECT eventId FROM record_source_refs WHERE recordId = ? ORDER BY eventId ASC`).all(id) as Array<{ eventId: string }>
  ).map((r) => r.eventId);
  return { ...row, tags, links, sourceRefs };
}

export function getRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const keys = Object.keys(params);
  for (const k of keys) {
    if (k !== "id" && k !== "scope") return budgeted(bad(), config);
  }
  const { id, scope } = params;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return budgeted(bad(), config);
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const now = nowOverride ?? nowIso();
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      let view: RecordView | null;
      try {
        view = readRecordView(db, id as string);
      } catch {
        throw new Error("read failed");
      }
      if (!view) throw new Error("missing");
      if (view.scope !== nScope) throw new Error("scope mismatch");
      const stored = budgeted(ok({ record: view }), config);
      if (!stored.ok) throw new Error("response over budget");
      auditInsert(db, {
        ts: now,
        op: "record.get",
        targetId: id as string,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: null,
        runId: null,
        recallId: null,
        reasonCode: null,
      });
      // Reads stay available over configured cap; audit still commits.
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "missing") return budgeted(fail("NOT_FOUND"), config);
    if (msg === "scope mismatch") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

export function listRecords(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope", "limit", "since", "until", "status"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { scope, limit, since, until, status } = params;
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  let nLimit = config.limits.limitDefault;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return budgeted(bad(), config);
    if (limit < 1) return budgeted(bad(), config);
    if (limit > config.limits.limitMax) return budgeted(limitExceeded(), config);
    nLimit = limit;
  }
  let nSince: string | null = null;
  if (since !== undefined && since !== null) {
    const c = canonicalTime(since);
    if (c === null) return budgeted(bad(), config);
    nSince = c;
  }
  let nUntil: string | null = null;
  if (until !== undefined && until !== null) {
    const c = canonicalTime(until);
    if (c === null) return budgeted(bad(), config);
    nUntil = c;
  }
  let nStatus = "active";
  if (status !== undefined && status !== null) {
    if (status !== "active" && status !== "superseded" && status !== "archived") {
      return budgeted(bad(), config);
    }
    nStatus = status as string;
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const now = nowOverride ?? nowIso();
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      let rows: Array<{ id: string; kind: string; status: string; body: string; createdAt: string }>;
      try {
        let sql = `SELECT id, kind, status, body, createdAt FROM records WHERE scope = ? AND status = ?`;
        const args: Array<string | number> = [nScope, nStatus];
        if (nSince !== null) {
          sql += ` AND createdAt >= ?`;
          args.push(nSince);
        }
        if (nUntil !== null) {
          sql += ` AND createdAt < ?`;
          args.push(nUntil);
        }
        sql += ` ORDER BY createdAt DESC, id ASC LIMIT ?`;
        args.push(nLimit);
        rows = db.prepare(sql).all(...args) as Array<{ id: string; kind: string; status: string; body: string; createdAt: string }>;
      } catch {
        throw new Error("read failed");
      }
      const items = rows.map((r) => {
        const cps = [...r.body];
        const max = config.limits.snippetMaxCp;
        return {
          id: r.id,
          kind: r.kind,
          status: r.status,
          snippet: cps.length <= max ? r.body : cps.slice(0, max).join(""),
          truncated: cps.length > max,
          createdAt: r.createdAt,
        };
      });
      const stored = budgeted(ok({ items }), config);
      if (!stored.ok) throw new Error("response over budget");
      auditInsert(db, {
        ts: now,
        op: "record.list",
        targetId: null,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: nLimit,
        runId: null,
        recallId: null,
        reasonCode: null,
      });
      // Reads stay available over configured cap; audit still commits.
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* record.recall (bounded hybrid: lexical + raw descent + graph)        */
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

function parseRecallParams(
  config: AppConfig,
  params: Record<string, unknown>,
): { ok: true; value: ParsedRecall } | { ok: false; res: ResponseEnvelope } {
  if (containsLoneSurrogateDeep(params)) return { ok: false, res: bad() };
  const allowed = new Set(["query", "tags", "link", "since", "until", "limit", "scope", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: bad() };
  }
  const { query, tags, link, since, until, limit, scope, runId } = params;
  if (typeof query !== "string") return { ok: false, res: bad() };
  if (countCp(query) > config.limits.queryMaxCp) return { ok: false, res: limitExceeded() };
  const nq = normalizeBody(query);
  if (countCp(nq) < 1) return { ok: false, res: bad() };
  if (countCp(nq) > config.limits.queryMaxCp) return { ok: false, res: limitExceeded() };
  const nTags = parseTags(tags, config.limits.tagsMax);
  if (nTags === "bad") return { ok: false, res: bad() };
  if (nTags === "over") return { ok: false, res: limitExceeded() };
  let nLink: string | null = null;
  if (link !== undefined && link !== null) {
    if (typeof link !== "string") return { ok: false, res: bad() };
    const ll = checkLenCp(link, 1, 256);
    if (ll === "long") return { ok: false, res: limitExceeded() };
    if (ll === "short" || hasControl(link)) return { ok: false, res: bad() };
    const nl = normalizeField(link, false);
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
  const nScope = parseScope(scope);
  if (!nScope) return { ok: false, res: bad() };
  const nRunId = parseRunId(runId);
  if (nRunId === "invalid") return { ok: false, res: bad() };
  return { ok: true, value: { query: nq, tags: nTags, link: nLink, since: nSince, until: nUntil, limit: nLimit, scope: nScope, runId: nRunId } };
}

function snippetFor(body: string, maxCp: number): { snippet: string; truncated: boolean } {
  const cps = [...body];
  if (cps.length <= maxCp) return { snippet: body, truncated: false };
  return { snippet: cps.slice(0, maxCp).join(""), truncated: true };
}

/** Records matching ALL given tags (active, same scope, ordered deterministically). */
function tagSeedIds(
  db: DatabaseSync,
  scope: string,
  tags: string[],
  since: string | null,
  until: string | null,
): string[] {
  if (tags.length === 0) return [];
  let sql = `SELECT records.id AS id FROM records WHERE scope = ? AND status = 'active'`;
  const args: Array<string | number> = [scope];
  if (since !== null) {
    sql += ` AND createdAt >= ?`;
    args.push(since);
  }
  if (until !== null) {
    sql += ` AND createdAt < ?`;
    args.push(until);
  }
  for (const t of tags) {
    sql += ` AND EXISTS (SELECT 1 FROM record_tags WHERE recordId = records.id AND tag = ?)`;
    args.push(t);
  }
  sql += ` ORDER BY createdAt DESC, id ASC LIMIT ?`;
  args.push(FUSION_CANDIDATE_MAX);
  try {
    return (db.prepare(sql).all(...args) as Array<{ id: string }>).map((r) => r.id);
  } catch {
    return [];
  }
}

/** Bounded depth-2 expansion over resolved active same-scope refs + backlinks. */
function expandGraph(
  db: DatabaseSync,
  scope: string,
  frontier0: string[],
): Map<string, number> {
  const dist = new Map<string, number>();
  for (const id of frontier0) {
    if (!dist.has(id)) dist.set(id, 0);
  }
  let frontier = [...frontier0];
  for (let d = 0; d < GRAPH_DEPTH_MAX && frontier.length > 0; d++) {
    const next: string[] = [];
    for (const id of frontier) {
      if (dist.size >= GRAPH_EXPAND_MAX) break;
      let outs: Array<{ toRef: string }>;
      let backs: Array<{ fromId: string }>;
      try {
        outs = db.prepare(`SELECT toRef FROM record_links WHERE fromId = ?`).all(id) as Array<{ toRef: string }>;
        backs = db
          .prepare(
            `SELECT l.fromId AS fromId FROM record_links l
             JOIN records r ON r.id = l.fromId
             WHERE l.toRef = ? AND r.scope = ? AND r.status = 'active'`,
          )
          .all(id, scope) as Array<{ fromId: string }>;
      } catch {
        continue;
      }
      const neighbors = [...outs.map((o) => o.toRef), ...backs.map((b) => b.fromId)];
      for (const nb of neighbors) {
        if (dist.has(nb) || dist.size >= GRAPH_EXPAND_MAX) continue;
        // Resolve: only active same-scope records are followed (dangling skipped).
        let okRow: { id: string } | undefined;
        try {
          okRow = db
            .prepare(`SELECT id FROM records WHERE id = ? AND scope = ? AND status = 'active'`)
            .get(nb, scope) as { id: string } | undefined;
        } catch {
          continue;
        }
        if (!okRow) continue;
        dist.set(nb, d + 1);
        next.push(nb);
      }
    }
    // Deterministic order within a distance level.
    next.sort();
    frontier = next;
  }
  return dist;
}

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
    return withTransaction(db, (): ResponseEnvelope => {
      // Reads/recall stay available over configured cap; audit + exposures
      // still commit. Real SQLite failures still throw -> STORE_UNAVAILABLE.

      // 1) Lexical candidates: FTS5/BM25 + char-bigram overlap.
      const ftsHits = ftsNoteHits(db, p.scope, p.query, p.since, p.until, FUSION_CANDIDATE_MAX);
      const biHits = bigramNoteHits(db, p.scope, p.query, p.since, p.until, FUSION_CANDIDATE_MAX);
      // 2) Raw descent: raw lexical hits mapped to records via source refs.
      const rawHits = rawDescentHits(db, p.scope, p.query, p.since, p.until);
      const rawSet = new Set(rawHits.map((r) => r.id));
      // 2b) Bounded canonical fallback over bodyNorm: committed memory stays
      // findable when derived FTS/bigram indexes are absent or stale.
      const canonHits = canonicalBodyNormHits(db, p.scope, p.query, p.since, p.until, FUSION_CANDIDATE_MAX);
      const canonSet = new Set(canonHits.map((r) => r.id));
      // 3) Exact tag/link seeds.
      const seedIds = new Set<string>(tagSeedIds(db, p.scope, p.tags, p.since, p.until));
      if (p.link !== null) {
        try {
          const target = db
            .prepare(`SELECT id, createdAt FROM records WHERE id = ? AND scope = ? AND status = 'active'`)
            .get(p.link, p.scope) as { id: string; createdAt: string } | undefined;
          if (target) {
            if (p.since !== null && target.createdAt < p.since) {
              /* window excludes the seed */
            } else if (p.until !== null && target.createdAt >= p.until) {
              /* window excludes the seed */
            } else {
              seedIds.add(target.id);
            }
          }
        } catch {
          /* seed lookup failure: continue with other signals */
        }
      }

      // Score accumulation (fixed weights; deterministic).
      const lexRank = new Map<string, number>();
      ftsHits.forEach((h, i) => {
        if (!lexRank.has(h.id)) lexRank.set(h.id, i);
      });
      const biRank = new Map<string, number>();
      biHits.forEach((h, i) => {
        if (!biRank.has(h.id)) biRank.set(h.id, i);
      });
      const pool = new Set<string>([...lexRank.keys(), ...biRank.keys(), ...rawSet, ...canonSet, ...seedIds]);
      // Pool cap: keep top 60 by lexical pre-order (lex rank, then id).
      let poolIds = [...pool];
      if (poolIds.length > FUSION_CANDIDATE_MAX) {
        const preScore = (id: string): number => {
          const lr = lexRank.has(id) ? 1 / (1 + (lexRank.get(id) as number)) : 0;
          const br = biRank.has(id) ? 0.5 / (1 + (biRank.get(id) as number)) : 0;
          return lr + br + (seedIds.has(id) ? 0.25 : 0);
        };
        poolIds.sort((a, b) => preScore(b) - preScore(a) || (a < b ? -1 : a > b ? 1 : 0));
        poolIds = poolIds.slice(0, FUSION_CANDIDATE_MAX);
      }
      // 4) Bounded graph expansion from seeds + top lexical ids.
      const frontier0 = [...new Set<string>([...seedIds, ...poolIds.slice(0, 10)])].slice(0, 20);
      const graphDist = expandGraph(db, p.scope, frontier0);

      // Heat lookup for the bounded pool only.
      const heat = new Map<string, number>();
      if (poolIds.length > 0 || graphDist.size > 0) {
        const allIds = [...new Set<string>([...poolIds, ...graphDist.keys()])];
        try {
          const placeholders = allIds.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT recordId, usedCount FROM note_heat WHERE recordId IN (${placeholders})`)
            .all(...allIds) as Array<{ recordId: string; usedCount: number }>;
          for (const r of rows) heat.set(r.recordId, r.usedCount);
        } catch {
          /* heat unavailable: score without it */
        }
      }

      const score = (id: string): number => {
        let s = 0;
        if (lexRank.has(id)) s += 3 / (1 + (lexRank.get(id) as number));
        if (biRank.has(id)) s += 1.5 / (1 + (biRank.get(id) as number));
        if (rawSet.has(id)) s += 2;
        if (canonSet.has(id)) s += 1;
        if (seedIds.has(id)) s += 1;
        const d = graphDist.get(id);
        if (d !== undefined && d > 0) s += (GRAPH_DEPTH_MAX + 1 - d) * 0.5;
        s += Math.min(heat.get(id) ?? 0, 20) * 0.02;
        return s;
      };

      // Candidate metadata for final ordering (createdAt for tie-break).
      const meta = new Map<string, { createdAt: string }>();
      const orderIds = [...new Set<string>([...poolIds, ...graphDist.keys()])];
      if (orderIds.length > 0) {
        try {
          const placeholders = orderIds.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT id, createdAt FROM records WHERE id IN (${placeholders})`)
            .all(...orderIds) as Array<{ id: string; createdAt: string }>;
          for (const r of rows) meta.set(r.id, { createdAt: r.createdAt });
        } catch {
          throw new Error("read failed");
        }
      }
      const ranked = orderIds
        .filter((id) => meta.has(id))
        .sort((a, b) => {
          const sa = score(a);
          const sb = score(b);
          if (sa !== sb) return sb - sa;
          const ca = (meta.get(a) as { createdAt: string }).createdAt;
          const cb = (meta.get(b) as { createdAt: string }).createdAt;
          if (ca !== cb) return ca < cb ? 1 : -1; // createdAt DESC
          return a < b ? -1 : a > b ? 1 : 0; // id ASC
        })
        .slice(0, p.limit);

      // Bounded projection: snippets only, never raw bodies.
      let items: Array<{ id: string; snippet: string; truncated: boolean; tags: string[]; createdAt: string }>;
      try {
        items = ranked.map((id) => {
          const row = db
            .prepare(`SELECT body, createdAt FROM records WHERE id = ?`)
            .get(id) as { body: string; createdAt: string };
          const { snippet, truncated } = snippetFor(row.body, config.limits.snippetMaxCp);
          const tags = (
            db.prepare(`SELECT tag FROM record_tags WHERE recordId = ? ORDER BY tag ASC`).all(id) as Array<{ tag: string }>
          ).map((r) => r.tag);
          return { id, snippet, truncated, tags, createdAt: row.createdAt };
        });
      } catch {
        throw new Error("read failed");
      }

      const probe: ResponseEnvelope = ok({ recallId, items });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      const stored = budgeted(probe, config);
      if (!stored.ok) throw new Error("response over budget");
      const responseBytes = Buffer.byteLength(JSON.stringify(stored), "utf8");

      // Fail-closed ledger: audit + exposures commit with the response.
      auditInsert(db, {
        ts: now,
        op: "record.recall",
        targetId: recallId,
        code: stored.code,
        scope: p.scope,
        bytes: responseBytes,
        limitN: p.limit,
        runId: p.runId,
        recallId,
        reasonCode: null,
      });
      const exp = db.prepare(
        `INSERT INTO exposures(ts, recallId, runId, scope, recordId, snippetBytes, truncated, limitN)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const it of items) {
        exp.run(now, recallId, p.runId, p.scope, it.id, Buffer.byteLength(it.snippet, "utf8"), it.truncated ? 1 : 0, p.limit);
      }
      // Bounded exposures ledger (prune oldest beyond cap).
      try {
        db.prepare(
          `DELETE FROM exposures WHERE rowid NOT IN (SELECT rowid FROM exposures ORDER BY ts DESC, rowid DESC LIMIT ?)`,
        ).run(EXPOSURES_CAP);
      } catch {
        /* prune failure must not fail the recall */
      }
      // Recall metadata (audit + exposures) may exceed configured cap;
      // only real SQLite failures fail closed via the catch below.
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* record.feedback (cited-only heat)                                   */
/* ------------------------------------------------------------------ */

export function feedbackRecords(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["recallId", "recordIds", "scope", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { recallId, recordIds, scope, runId } = params;
  if (typeof recallId !== "string" || recallId.length === 0 || recallId.length > 256) {
    return budgeted(bad(), config);
  }
  if (!Array.isArray(recordIds) || recordIds.length === 0) return budgeted(bad(), config);
  if (recordIds.length > config.limits.limitMax) return budgeted(limitExceeded(), config);
  const seen = new Set<string>();
  for (const r of recordIds) {
    if (typeof r !== "string" || r.length === 0 || r.length > 256 || hasControl(r)) {
      return budgeted(bad(), config);
    }
    seen.add(r);
  }
  const ids = [...seen].sort();
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  const nRunId = parseRunId(runId);
  if (nRunId === "invalid") return budgeted(bad(), config);

  const reqHash = requestHashFor("record.feedback", {
    recallId,
    recordIds: ids,
    runId: nRunId,
    scope: nScope,
  });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "record.feedback") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      // Exposure verification: the recall must exist in this scope, and every
      // reported id must be a member of its exposure set. Any deviation
      // rejects the WHOLE report with no usage/heat change.
      let exposed: Array<{ recordId: string; scope: string | null }>;
      try {
        exposed = db
          .prepare(`SELECT recordId, scope FROM exposures WHERE recallId = ?`)
          .all(recallId) as Array<{ recordId: string; scope: string | null }>;
      } catch {
        throw new Error("read failed");
      }
      if (exposed.length === 0) throw new Error("unknown recall");
      if (exposed.some((e) => e.scope !== nScope)) throw new Error("recall scope");
      const exposedSet = new Set(exposed.map((e) => e.recordId));
      for (const id of ids) {
        if (!exposedSet.has(id)) throw new Error("outside exposure");
      }
      // Same-scope guard on the reported records themselves.
      for (const id of ids) {
        let row: { scope: string } | undefined;
        try {
          row = db.prepare(`SELECT scope FROM records WHERE id = ?`).get(id) as
            | { scope: string }
            | undefined;
        } catch {
          throw new Error("read failed");
        }
        if (!row) throw new Error("outside exposure");
        if (row.scope !== nScope) throw new Error("record scope");
      }
      const probe: ResponseEnvelope = ok({ feedback: { recallId, counted: ids.length } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      const use = db.prepare(
        `INSERT OR IGNORE INTO usage(ts, recallId, recordId, scope, runId) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const id of ids) {
        const inserted = use.run(now, recallId, id, nScope, nRunId);
        // Heat only on the first usage of a (recallId, recordId) exposure:
        // a repeat under another idempotency key reuses the ledger row and
        // must not double-heat the same recall exposure.
        if (changedRows(inserted) === 1) {
          db.prepare(`INSERT OR IGNORE INTO note_heat(recordId, usedCount, lastUsedAt) VALUES (?, 0, ?)`).run(id, now);
          db.prepare(`UPDATE note_heat SET usedCount = usedCount + 1, lastUsedAt = ? WHERE recordId = ?`).run(now, id);
        }
      }
      const stored = budgeted(probe, config);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, "record.feedback", reqHash, JSON.stringify(stored), now);
      auditInsert(db, {
        ts: now,
        op: "record.feedback",
        targetId: recallId,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: ids.length,
        runId: nRunId,
        recallId,
        reasonCode: null,
      });
      assertDbUnderCap(db, config);
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "recall scope" || msg === "record scope") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "unknown recall" || msg === "outside exposure") return budgeted(fail("NOT_FOUND"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "record.feedback" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* record.correct (atomic revision + supersede)                        */
/* ------------------------------------------------------------------ */

export function correctRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["recordId", "body", "kind", "provenance", "scope", "links", "sourceRefs", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { recordId, body, kind, provenance, scope, links, sourceRefs, runId } = params;
  if (typeof recordId !== "string" || recordId.length === 0 || recordId.length > 256 || hasControl(recordId)) {
    return budgeted(bad(), config);
  }
  if (kind !== "correction") return budgeted(bad(), config);
  if (typeof body !== "string") return budgeted(bad(), config);
  if (countCp(body) > config.limits.bodyMaxCp) return budgeted(limitExceeded(), config);
  const nBody = normalizeBody(body);
  if (countCp(nBody) < 1) return budgeted(bad(), config);
  if (countCp(nBody) > config.limits.bodyMaxCp) return budgeted(limitExceeded(), config);
  const prov = parseProvenance(provenance);
  if (!prov) return budgeted(bad(), config);
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  const nLinks = parseLinks(links, config.limits.linksMax);
  if (nLinks === "bad") return budgeted(bad(), config);
  if (nLinks === "over") return budgeted(limitExceeded(), config);
  const nRefs = parseSourceRefs(sourceRefs, config.limits.sourceRefsMax);
  if (nRefs === "bad") return budgeted(bad(), config);
  if (nRefs === "over") return budgeted(limitExceeded(), config);
  const nRunId = parseRunId(runId);
  if (nRunId === "invalid") return budgeted(bad(), config);

  const reqHash = requestHashFor("record.correct", {
    body: body as string,
    kind: "correction",
    links: nLinks,
    observedAt: prov.observedAt,
    recordId,
    runId: nRunId,
    scope: nScope,
    source: prov.source,
    sourceRefs: nRefs,
  });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "record.correct") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);
  const newId = genId("rec");
  const rawBody = body as string;
  let committed: ResponseEnvelope;
  try {
    committed = withTransaction(db, (): ResponseEnvelope => {
      let target: { scope: string; status: string; revision: number } | undefined;
      try {
        target = db
          .prepare(`SELECT scope, status, revision FROM records WHERE id = ?`)
          .get(recordId) as { scope: string; status: string; revision: number } | undefined;
      } catch {
        throw new Error("read failed");
      }
      if (!target) throw new Error("missing");
      if (target.scope !== nScope) throw new Error("scope mismatch");
      if (target.status !== "active") throw new Error("not active");
      for (const r of nRefs) {
        const row = db.prepare(`SELECT scope FROM raw_events WHERE eventId = ?`).get(r) as
          | { scope: string }
          | undefined;
        if (!row) throw new Error("source lost");
        if (row.scope !== nScope) throw new Error("source scope");
      }
      const probe: ResponseEnvelope = ok({ record: { id: newId, supersedes: recordId } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      // Conditional flip is the arbiter: exactly one concurrent correction wins.
      let moved: unknown;
      try {
        moved = db
          .prepare(`UPDATE records SET status='superseded' WHERE id=? AND status='active' AND scope=?`)
          .run(recordId, nScope);
      } catch {
        throw new Error("db over cap");
      }
      if (changedRows(moved) !== 1) throw new Error("not active");
      db.prepare(
        `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
         VALUES (?, ?, ?, ?, 'correction', ?, ?, ?, 'active', ?, ?, ?)`,
      ).run(newId, rawBody, nBody, bodyHashFor(rawBody), prov.source, prov.observedAt, nScope, recordId, target.revision + 1, now);
      for (const l of nLinks) {
        db.prepare(`INSERT INTO record_links(fromId, toRef) VALUES (?, ?)`).run(newId, l);
      }
      for (const r of nRefs) {
        db.prepare(`INSERT INTO record_source_refs(recordId, eventId) VALUES (?, ?)`).run(newId, r);
      }
      db.prepare(`INSERT OR IGNORE INTO note_heat(recordId, usedCount, lastUsedAt) VALUES (?, 0, ?)`).run(newId, now);
      const stored = budgeted(probe, config);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, "record.correct", reqHash, JSON.stringify(stored), now);
      auditInsert(db, {
        ts: now,
        op: "record.correct",
        targetId: newId,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: null,
        runId: nRunId,
        recallId: null,
        reasonCode: null,
      });
      // Canonical txn ends here: projection queue is post-commit only so the
      // commit never depends on queue/index success.
      assertDbUnderCap(db, config);
      return stored;
    });
    // Post-commit, best-effort: the new + superseded records plus resolved
    // same-scope old/new outbound targets whose Backlinks may have changed
    // (old targets lose the superseded linker, new targets gain the new one).
    // Never changes the committed response.
    postCommitEnqueueProjections(
      db,
      nScope,
      [newId, recordId as string],
      [...outboundRefsOf(db, recordId as string), ...nLinks],
    );
    // Derived indexes post-commit, best-effort: failure never rolls back canonical.
    bestEffortIndexNote(db, newId, nBody);
    return committed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "missing" || msg === "source lost") {
      // Distinguish missing target (NOT_FOUND) from missing source ref.
      if (msg === "source lost") return budgeted(fail("NOT_FOUND"), config);
      return budgeted(fail("NOT_FOUND"), config);
    }
    if (msg === "scope mismatch" || msg === "source scope") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "not active") return budgeted(fail("CONFLICT"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "record.correct" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* record.archive (terminal exclusion, row kept)                       */
/* ------------------------------------------------------------------ */

export function archiveRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["id", "scope", "reasonCode"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { id, scope, reasonCode } = params;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) return budgeted(bad(), config);
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  if (typeof reasonCode !== "string" || !(ARCHIVE_REASONS as readonly string[]).includes(reasonCode)) {
    return budgeted(bad(), config);
  }

  const reqHash = sha256HexUtf8(
    canonicalStringify({ op: "record.archive", id, scope: nScope, reasonCode }),
  );

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "record.archive") return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);
  let committed: ResponseEnvelope;
  try {
    committed = withTransaction(db, (): ResponseEnvelope => {
      let target: { scope: string; status: string } | undefined;
      try {
        target = db.prepare(`SELECT scope, status FROM records WHERE id = ?`).get(id) as
          | { scope: string; status: string }
          | undefined;
      } catch {
        throw new Error("read failed");
      }
      if (!target) throw new Error("missing");
      if (target.scope !== nScope) throw new Error("scope mismatch");
      if (target.status !== "active") throw new Error("not active");
      const probe: ResponseEnvelope = ok({ record: { id, status: "archived" } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      let moved: unknown;
      try {
        moved = db
          .prepare(`UPDATE records SET status='archived' WHERE id=? AND status='active' AND scope=?`)
          .run(id, nScope);
      } catch {
        throw new Error("db over cap");
      }
      if (changedRows(moved) !== 1) throw new Error("not active");
      const stored = budgeted(probe, config);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, "record.archive", reqHash, JSON.stringify(stored), now);
      auditInsert(db, {
        ts: now,
        op: "record.archive",
        targetId: id as string,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: null,
        runId: null,
        recallId: null,
        reasonCode: reasonCode as string,
      });
      // Canonical txn ends here: projection queue is post-commit only so the
      // commit never depends on queue/index success.
      assertDbUnderCap(db, config);
      return stored;
    });
    // Post-commit, best-effort: the archived record plus resolved same-scope
    // outbound targets whose Backlinks lose the archived linker. Never changes
    // the committed response.
    postCommitEnqueueProjections(
      db,
      nScope,
      [id as string],
      outboundRefsOf(db, id as string),
    );
    return committed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "missing") return budgeted(fail("NOT_FOUND"), config);
    if (msg === "scope mismatch") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "not active") return budgeted(fail("CONFLICT"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "record.archive" && again.requestHash === reqHash) {
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* Re-exported for tests/smoke: id format check. */
export function qAll<T>(db: DatabaseSync, sql: string, args: Array<string | number>): T[] {
  return db.prepare(sql).all(...(args as [])) as T[];
}
