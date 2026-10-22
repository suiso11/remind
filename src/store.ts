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
 * - record.retire / record.reactivate: reversible active<->retired (M3 state
 *   core; idempotent, fixed reason codes, metadata-only audit)
 * - record.search: explicit active+retired lexical search (M3; excludes
 *   archived/superseded; no heat, no reactivation, no exposures)
 * - cultivation queue: bounded post-commit review enqueue on
 *   remember/correct/validated-feedback (M3; no inline inference, never fails
 *   the canonical write); lease/apply live in src/cultivation.ts
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
  episodesBounds,
  graphLimitMax,
  graphResponseMaxBytes,
  rangeLimitMax,
  rawBodyMaxCp,
  rawPageMaxCp,
  requirePrivacyEnabled,
} from "./config.js";
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
  parsePrivacyParam,
  privacyFromColumns,
  type PrivacyMetadata,
} from "./privacy.js";
import {
  parseSourceRefsParam,
  sourceRefFromColumns,
  storedSourceRefs,
  type SourceRef,
} from "./sourceref.js";
import {
  REACTIVATE_REASONS,
  RETIRE_REASONS,
  enqueueCultivationReview,
  ensureCultivationSchema,
  isCultivationLeaseHeldBy,
} from "./cultivation.js";
import {
  applyResponseBudget,
  fail,
  ok,
  type ResponseEnvelope,
} from "./protocol.js";
import {
  VECTOR_DIM,
  cosine,
  deserializeVec,
  isValidVector,
  serializeVec,
  vectorsEnabled,
} from "./vectors.js";
import {
  GraphLimitError,
  GraphLocalScopeError,
  buildGraphLocal,
  buildGraphPage,
  buildGraphVersion,
  decodeGraphPageCursor,
} from "./graph.js";

/**
 * Current additive schema generation, stamped into PRAGMA user_version only
 * after every migration and index in ensureM1Schema has succeeded. Version 2
 * was the original M1 stamp; 3 marks the serialized, span/episode-complete
 * schema; 4 adds record_topics.origin (tag/external/llm precedence); 5 adds
 * the derived association tables to the versioned migration (they are no
 * longer re-created on every open); 6 adds associate_scope_state, the
 * whole-scope edge fingerprint; 7 adds the derived record_importance ledger
 * (activation); 8 adds the maintain.consolidate cluster ledger. Older 2-
 * through 7-stamped files are migrated in place (never refused), including
 * v7 files that already hold activation importance data.
 */
export const SCHEMA_VERSION = 8;
/** Original M1 stamp; still accepted and upgraded on open. */
export const LEGACY_M1_USER_VERSION = 2;
/** Pre-topic-origin schema stamp; accepted and upgraded in place. */
export const LEGACY_SCHEMA_VERSION_3 = 3;
/** Pre-association-schema stamp; accepted and upgraded in place. */
export const LEGACY_SCHEMA_VERSION_4 = 4;
/** Per-record-edge-scan stamp; accepted and upgraded in place. */
export const LEGACY_SCHEMA_VERSION_5 = 5;
/** Pre-record-importance stamp; accepted and upgraded in place. */
export const LEGACY_SCHEMA_VERSION_6 = 6;
/** Pre-consolidation-cluster-ledger stamp (v7 carries record_importance); accepted and upgraded in place. */
export const LEGACY_SCHEMA_VERSION_7 = 7;

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

/** M3 fixed reason codes (defined in cultivation.ts; re-exported for callers). */
export { REACTIVATE_REASONS, RETIRE_REASONS };

/** Recall/graph bounds (plan §8 defaults; fixed, documented, deterministic). */
export const GRAPH_DEPTH_MAX = 2;
export const GRAPH_EXPAND_MAX = 40;
export const RAW_DESCENT_MAX = 3;
export const FUSION_CANDIDATE_MAX = 60;
/** Topics shorter than this (after NFKC/lowercase) never seed a recall. */
const TOPIC_SEED_MIN_CP = 2;
/**
 * Similar-edge contribution = SIMILAR_FUSION_WEIGHT * score / hop. At hop 1
 * with score 1 this is 0.5, below an explicit-link graph node (1.0 at depth 1).
 */
const SIMILAR_FUSION_WEIGHT = 0.5;
/** Vector candidates cap (bounded; M2 default topK=20, hard cap 60 like fusion). */
export const VECTOR_CANDIDATE_MAX = 20;
/** Fixed vector fusion weight: 4/(1+rank), above lexical 3/(1+rank) so true
 *  paraphrase similarity outranks weak lexical overlap, below raw+seed sums
 *  so exact citations still win. Deterministic; ties break createdAt DESC, id ASC. */
export const VECTOR_FUSION_WEIGHT = 4;
/** Exposures ledger cap: oldest rows pruned beyond this (feedback stays verifiable while fresh). */
export const EXPOSURES_CAP = 1000;

const ID_RE = /^[A-Za-z0-9_-]+$/;

/* ------------------------------------------------------------------ */
/* Schema                                                              */
/* ------------------------------------------------------------------ */

export const RECORD_STATUSES = [
  "active",
  "superseded",
  "archived",
  "retired",
] as const;

/**
 * M3 migration: add the reversible 'retired' status to pre-M3 databases whose
 * records CHECK only allows ('active','superseded','archived'). Additive table
 * rebuild preserving every canonical row (no deletes, no status rewrites);
 * fresh DBs skip it. Savepoint-based so it works both standalone and inside
 * initDb's outer transaction. Never throws for missing tables.
 */
function migrateRecordsStatusForRetired(db: DatabaseSync): void {
  let sql: string | null = null;
  try {
    const row = db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='records'`)
      .get() as { sql: string | null } | undefined;
    sql = row?.sql ?? null;
  } catch {
    return;
  }
  if (!sql) return; // fresh DB: CREATE below already carries the new CHECK
  if (sql.includes("retired")) return; // already migrated
  db.exec(`SAVEPOINT m3_retired_status`);
  try {
    db.exec(`CREATE TABLE records_new(
      id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
      kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
      source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
      status TEXT NOT NULL CHECK(status IN ('active','superseded','archived','retired')),
      supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL)`);
    db.exec(`INSERT INTO records_new(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
      SELECT id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt FROM records`);
    db.exec(`DROP TABLE records`);
    db.exec(`ALTER TABLE records_new RENAME TO records`);
    db.exec(`RELEASE SAVEPOINT m3_retired_status`);
  } catch (e) {
    try {
      db.exec(`ROLLBACK TO SAVEPOINT m3_retired_status`);
    } catch {
      /* preserve the migration error */
    }
    try {
      db.exec(`RELEASE SAVEPOINT m3_retired_status`);
    } catch {
      /* preserve the migration error */
    }
    throw e;
  }
}

/**
 * F-I01-05 additive migration: nullable privacy columns (privacySensitivity,
 * privacyOrigin) on raw_events and records for databases created before this
 * slice. ALTER TABLE ADD COLUMN only — no rebuild, no row rewrite; existing
 * rows read back as NULL (legacy/unknown privacy). Idempotent (PRAGMA
 * table_info guard), savepoint-based so it composes with initDb's outer
 * transaction and with standalone calls. Both columns of a table are added
 * together (one savepoint).
 */
function ensurePrivacyColumns(db: DatabaseSync): void {
  const tableHasColumn = (table: string, col: string): boolean => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === col);
    } catch {
      return false; // unreadable catalog: CREATE below / callers handle it
    }
  };
  const targets: Array<{ table: string; ddl: string[] }> = [
    {
      table: "raw_events",
      ddl: [
        `ALTER TABLE raw_events ADD COLUMN privacySensitivity TEXT NULL CHECK(privacySensitivity IN ('normal','sensitive'))`,
        `ALTER TABLE raw_events ADD COLUMN privacyOrigin TEXT NULL CHECK(privacyOrigin IN ('conversation','self_activity'))`,
      ],
    },
    {
      table: "records",
      ddl: [
        `ALTER TABLE records ADD COLUMN privacySensitivity TEXT NULL CHECK(privacySensitivity IN ('normal','sensitive'))`,
        `ALTER TABLE records ADD COLUMN privacyOrigin TEXT NULL CHECK(privacyOrigin IN ('conversation','self_activity'))`,
      ],
    },
  ];
  for (const t of targets) {
    if (tableHasColumn(t.table, "privacySensitivity")) continue; // already migrated (or fresh CREATE carried it)
    db.exec(`SAVEPOINT ensure_privacy_columns_${t.table}`);
    try {
      for (const ddl of t.ddl) db.exec(ddl);
      db.exec(`RELEASE SAVEPOINT ensure_privacy_columns_${t.table}`);
    } catch (e) {
      try {
        db.exec(`ROLLBACK TO SAVEPOINT ensure_privacy_columns_${t.table}`);
      } catch {
        /* preserve the migration error */
      }
      try {
        db.exec(`RELEASE SAVEPOINT ensure_privacy_columns_${t.table}`);
      } catch {
        /* preserve the migration error */
      }
      throw e;
    }
  }
}

/**
 * P1 additive migration: nullable raw event chunk columns (docId, chunkSeq)
 * plus a partial unique index ensuring (scope, docId, chunkSeq) is unique
 * only for chunked events. ALTER TABLE ADD COLUMN only; legacy rows stay
 * NULL and never collide. Idempotent/savepoint-based like the privacy
 * migration.
 */
function ensureRawChunkColumns(db: DatabaseSync): void {
  const tableHasColumn = (table: string, col: string): boolean => {
    try {
      const cols = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === col);
    } catch {
      return false;
    }
  };
  if (!tableHasColumn("raw_events", "docId")) {
    db.exec(`SAVEPOINT ensure_raw_chunk_columns`);
    try {
      db.exec(`ALTER TABLE raw_events ADD COLUMN docId TEXT NULL`);
      db.exec(`ALTER TABLE raw_events ADD COLUMN chunkSeq INTEGER NULL CHECK(chunkSeq BETWEEN 0 AND 100000)`);
      db.exec(`RELEASE SAVEPOINT ensure_raw_chunk_columns`);
    } catch (e) {
      try { db.exec(`ROLLBACK TO SAVEPOINT ensure_raw_chunk_columns`); } catch { /* preserve error */ }
      try { db.exec(`RELEASE SAVEPOINT ensure_raw_chunk_columns`); } catch { /* preserve error */ }
      throw e;
    }
  }
  db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_raw_events_doc_chunk
    ON raw_events(scope, docId, chunkSeq) WHERE docId IS NOT NULL`);
}

/**
 * P1 guarded migration for record_source_refs spans. Legacy tables used
 * PRIMARY KEY(recordId,eventId), which forbids the same eventId with a
 * different span. Rebuild once (every row copied; legacy spans stay NULL)
 * with a unique expression index so NULL spans remain unique like before
 * while distinct spans coexist. Fresh tables skip the rebuild.
 *
 * The schema inspection, copy+swap, and index creation all run inside one
 * write transaction (BEGIN IMMEDIATE, or a savepoint when the caller already
 * owns a transaction such as initDb's fresh-schema transaction). A second
 * process opening the same pre-span file therefore waits on the write lock
 * (busy_timeout) and re-inspects the already-migrated schema instead of
 * copying spans as NULL from a stale snapshot.
 */
function ensureSourceRefSpans(db: DatabaseSync): void {
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT ensure_source_ref_spans_txn`);
  const commitTxn = (): void => {
    if (ownTransaction) db.exec("COMMIT");
    else db.exec(`RELEASE SAVEPOINT ensure_source_ref_spans_txn`);
  };
  const rollbackTxn = (): void => {
    if (ownTransaction) {
      try { db.exec("ROLLBACK"); } catch { /* preserve error */ }
    } else {
      try { db.exec(`ROLLBACK TO SAVEPOINT ensure_source_ref_spans_txn`); } catch { /* preserve error */ }
      try { db.exec(`RELEASE SAVEPOINT ensure_source_ref_spans_txn`); } catch { /* preserve error */ }
    }
  };
  try {
    let cols: Array<{ name: string; pk: number }>;
    try {
      cols = db.prepare(`PRAGMA table_info(record_source_refs)`).all() as Array<{
        name: string;
        pk: number;
      }>;
    } catch {
      commitTxn();
      return;
    }
    if (cols.length === 0) {
      commitTxn();
      return;
    }
    const hasSpans = cols.some((c) => c.name === "spanStart") && cols.some((c) => c.name === "spanEnd");
    const hasLegacyPk = cols.some((c) => c.pk > 0);
    if (!hasSpans || hasLegacyPk) {
      db.exec(`SAVEPOINT ensure_source_ref_spans`);
      try {
        db.exec(`CREATE TABLE record_source_refs_new(
          recordId TEXT NOT NULL, eventId TEXT NOT NULL,
          spanStart INTEGER NULL, spanEnd INTEGER NULL,
          CHECK((spanStart IS NULL AND spanEnd IS NULL) OR
                (spanStart IS NOT NULL AND spanEnd IS NOT NULL AND spanStart >= 0 AND spanEnd > spanStart)))`);
        db.exec(`INSERT INTO record_source_refs_new(recordId, eventId, spanStart, spanEnd)
          SELECT recordId, eventId, ${hasSpans ? "spanStart, spanEnd" : "NULL, NULL"} FROM record_source_refs`);
        db.exec(`DROP TABLE record_source_refs`);
        db.exec(`ALTER TABLE record_source_refs_new RENAME TO record_source_refs`);
        db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_source_refs_unique
          ON record_source_refs(recordId, eventId, COALESCE(spanStart, -1), COALESCE(spanEnd, -1))`);
        db.exec(`RELEASE SAVEPOINT ensure_source_ref_spans`);
      } catch (e) {
        try { db.exec(`ROLLBACK TO SAVEPOINT ensure_source_ref_spans`); } catch { /* preserve error */ }
        try { db.exec(`RELEASE SAVEPOINT ensure_source_ref_spans`); } catch { /* preserve error */ }
        throw e;
      }
    } else {
      db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_source_refs_unique
        ON record_source_refs(recordId, eventId, COALESCE(spanStart, -1), COALESCE(spanEnd, -1))`);
    }
    commitTxn();
  } catch (e) {
    rollbackTxn();
    throw e;
  }
}

function readSchemaVersion(db: DatabaseSync): number {
  const row = db.prepare(`PRAGMA user_version`).get() as
    | { user_version: number }
    | undefined;
  return row?.user_version ?? 0;
}

/**
 * P3 derived association layer (rebuildable; never canonical).
 *
 * similar_edges stores the union, over every active embedded record, of that
 * record's top-K semantic neighbours. The unordered pair is canonicalized by
 * CHECK(a < b), so a bidirectional match is one row (with the max score).
 * associate_scope_state stores one fingerprint per scope: a hash of the edge
 * settings, the model id, and the sorted (recordId, embedding-input hash) of
 * every active embedded record. When the fingerprint differs, the next
 * maintain.associate recomputes the WHOLE scope edge set in one transaction.
 * associate_state is the legacy per-record scan marker; it is retained for
 * compatibility but no longer read or written. All of these tables are
 * derived and can be dropped at any time; canonical `record_links` remain
 * caller-authored and untouched.
 *
 * Runs once inside the versioned migration lock; it is NOT called on the
 * already-current fast path (every DDL/PRAGMA here would otherwise be paid on
 * every CLI/worker open even though the tables are unchanged).
 */
export function ensureAssociateSchema(db: DatabaseSync): void {
  db.exec(`CREATE TABLE IF NOT EXISTS similar_edges(
    scope TEXT NOT NULL,
    a TEXT NOT NULL,
    b TEXT NOT NULL,
    score REAL NOT NULL,
    computedAt TEXT NOT NULL,
    PRIMARY KEY(scope, a, b),
    CHECK(a < b))`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_similar_edges_b ON similar_edges(scope, b)`);
  // Legacy per-record scan marker (kept for compatibility; unused now that
  // edge validity is tracked by the whole-scope fingerprint below).
  db.exec(`CREATE TABLE IF NOT EXISTS associate_state(
    recordId TEXT PRIMARY KEY,
    bodyHash TEXT NOT NULL,
    scannedAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS associate_scope_state(
    scope TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    computedAt TEXT NOT NULL)`);
  // Topics for the current record body. Derived and rebuildable; a row's
  // bodyHash must match records.bodyHash to be considered current. Origin
  // records precedence metadata: canonical tags > external (topic.set) > llm.
  // PK(recordId, topic) keeps one row per topic.
  db.exec(`CREATE TABLE IF NOT EXISTS record_topics(
    recordId TEXT NOT NULL,
    topic TEXT NOT NULL,
    bodyHash TEXT NOT NULL,
    origin TEXT NOT NULL DEFAULT 'llm' CHECK(origin IN ('tag','external','llm')),
    PRIMARY KEY(recordId, topic))`);
  // Additive migration for pre-origin tables (version 3). Default 'llm'
  // preserves prior rows, which were all SLM-extracted. Runs under the
  // caller's schema-init transaction when a version upgrade is in progress.
  let hasOrigin = false;
  try {
    const cols = db.prepare(`PRAGMA table_info(record_topics)`).all() as Array<{ name: string }>;
    hasOrigin = cols.some((c) => c.name === "origin");
  } catch {
    hasOrigin = false;
  }
  if (!hasOrigin) {
    db.exec(`ALTER TABLE record_topics ADD COLUMN origin TEXT NOT NULL DEFAULT 'llm' CHECK(origin IN ('tag','external','llm'))`);
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_record_topics_topic ON record_topics(topic)`);
}

/**
 * Whole additive-migration sequence. Callers must already hold the single
 * write lock (ensureM1Schema acquires it, or an outer transaction owns it).
 * Nested helpers use savepoints so one failure rolls back only its own step.
 */
function runM1SchemaMigrations(db: DatabaseSync): void {
  // M3 additive migration first: pre-M3 files keep every canonical row.
  migrateRecordsStatusForRetired(db);
  db.exec(`CREATE TABLE IF NOT EXISTS raw_events(
    eventId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
    body TEXT NOT NULL, bodyNorm TEXT NOT NULL,
    source TEXT NOT NULL, observedAt TEXT NOT NULL,
    scope TEXT NOT NULL, runId TEXT NULL, createdAt TEXT NOT NULL,
    privacySensitivity TEXT NULL CHECK(privacySensitivity IN ('normal','sensitive')),
    privacyOrigin TEXT NULL CHECK(privacyOrigin IN ('conversation','self_activity')),
    docId TEXT NULL, chunkSeq INTEGER NULL CHECK(chunkSeq BETWEEN 0 AND 100000))`);
  db.exec(`CREATE TABLE IF NOT EXISTS records(
    id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
    source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('active','superseded','archived','retired')),
    supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL,
    privacySensitivity TEXT NULL CHECK(privacySensitivity IN ('normal','sensitive')),
    privacyOrigin TEXT NULL CHECK(privacyOrigin IN ('conversation','self_activity')))`);
  // F-I01-05 additive privacy columns for databases created before the
  // columns existed (nullable; old rows stay NULL = legacy/unknown privacy).
  ensurePrivacyColumns(db);
  // P1 additive chunk columns (legacy rows NULL) for old databases.
  ensureRawChunkColumns(db);
  db.exec(`CREATE TABLE IF NOT EXISTS record_tags(recordId TEXT NOT NULL, tag TEXT NOT NULL, PRIMARY KEY(recordId, tag))`);
  db.exec(`CREATE TABLE IF NOT EXISTS record_links(fromId TEXT NOT NULL, toRef TEXT NOT NULL, PRIMARY KEY(fromId, toRef))`);
  db.exec(`CREATE TABLE IF NOT EXISTS record_source_refs(
    recordId TEXT NOT NULL, eventId TEXT NOT NULL,
    spanStart INTEGER NULL, spanEnd INTEGER NULL,
    CHECK((spanStart IS NULL AND spanEnd IS NULL) OR
          (spanStart IS NOT NULL AND spanEnd IS NOT NULL AND spanStart >= 0 AND spanEnd > spanStart)))`);
  // P1 guarded rebuild for pre-span tables (PK recordId,eventId); legacy rows
  // keep NULL spans and every existing row is copied.
  ensureSourceRefSpans(db);
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
  // Derived importance ledger (rebuildable; never canonical). Added in v7 by
  // the activation slice; the v6->v8 and v7->v8 paths create it here, and an
  // existing v7 table (with rows) is left untouched. bodyHash pins the record
  // revision the score was computed from, so stale scores are ignored.
  db.exec(`CREATE TABLE IF NOT EXISTS record_importance(
    recordId TEXT PRIMARY KEY,
    importance REAL NOT NULL,
    bodyHash TEXT NOT NULL,
    source TEXT NOT NULL CHECK(source IN ('llm','external')),
    scoredAt TEXT NOT NULL)`);
  db.exec(`CREATE TABLE IF NOT EXISTS projection_queue(recordId TEXT PRIMARY KEY, attempts INTEGER NOT NULL, nextAt TEXT NOT NULL)`);
  // Derived lexical indexes (rebuildable; never canonical).
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_notes USING fts5(recordId UNINDEXED, body)`);
  db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS fts_raw USING fts5(eventId UNINDEXED, body)`);
  db.exec(`CREATE TABLE IF NOT EXISTS char_bigrams(kind TEXT NOT NULL, id TEXT NOT NULL, bigram TEXT NOT NULL, PRIMARY KEY(kind, id, bigram))`);
  // P2 derived episode ledger (rebuildable; never canonical). Episode windows
  // and episode-level summaries reference canonical records by id. Additive:
  // databases created before this slice gain the table on next init.
  db.exec(`CREATE TABLE IF NOT EXISTS episode_summaries(
    scope TEXT,
    kind TEXT CHECK(kind IN ('session','doc','day')),
    episodeKey TEXT,
    level TEXT CHECK(level IN ('window','episode')),
    recordId TEXT,
    eventId TEXT NULL,
    spanStart INTEGER NULL,
    spanEnd INTEGER NULL,
    coveredThrough TEXT NULL,
    foldedRecordIds TEXT NULL,
    verbatim INTEGER NOT NULL DEFAULT 0 CHECK(verbatim IN (0,1)),
    createdAt TEXT,
    PRIMARY KEY(scope, kind, episodeKey, recordId))`);
  // Additive column for databases created before the fold marker existed.
  // Rows written by earlier builds keep NULL (no folded set), which reads as
  // "nothing folded yet" and is repaired on the next maintenance pass.
  const episodeColumns = db.prepare(`PRAGMA table_info(episode_summaries)`).all() as Array<{
    name: string;
  }>;
  if (!episodeColumns.some((c) => c.name === "foldedRecordIds")) {
    db.exec(`ALTER TABLE episode_summaries ADD COLUMN foldedRecordIds TEXT NULL`);
  }
  // Explicit verbatim marker for window rows: tags are caller-bounded by
  // tagsMax (and may be dropped entirely), so readers must not infer
  // verbatim mode from tags alone.
  if (!episodeColumns.some((c) => c.name === "verbatim")) {
    // Add the explicit marker and backfill it from the legacy fallback tag in
    // the SAME savepoint: rows written before the column existed identify
    // verbatim windows only by EPISODE_WINDOW_VERBATIM_TAG. Literal matches
    // episodes.ts to avoid a store <-> episodes import cycle.
    db.exec(`SAVEPOINT ensure_episode_verbatim_column`);
    try {
      db.exec(`ALTER TABLE episode_summaries ADD COLUMN verbatim INTEGER NOT NULL DEFAULT 0 CHECK(verbatim IN (0,1))`);
      db.exec(`UPDATE episode_summaries SET verbatim = 1
        WHERE recordId IN (
          SELECT recordId FROM record_tags WHERE tag = 'episode-window-verbatim'
        )`);
      db.exec(`RELEASE SAVEPOINT ensure_episode_verbatim_column`);
    } catch (e) {
      try { db.exec(`ROLLBACK TO SAVEPOINT ensure_episode_verbatim_column`); } catch { /* preserve error */ }
      try { db.exec(`RELEASE SAVEPOINT ensure_episode_verbatim_column`); } catch { /* preserve error */ }
      throw e;
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_episode_summaries_episode
    ON episode_summaries(scope, kind, episodeKey, level)`);
  // P3 maintain.consolidate ledger (derived; rebuildable). One active
  // topic-cluster summary per (scope, topic); recordId points at the active
  // canonical summary (or its latest revision) and memberFingerprint is the
  // sorted member ids + bodyHashes the summary was generated from. When the
  // fingerprint changes, the next pass regenerates and supersedes the record.
  db.exec(`CREATE TABLE IF NOT EXISTS cluster_summaries(
    scope TEXT NOT NULL,
    topic TEXT NOT NULL,
    recordId TEXT NOT NULL,
    memberFingerprint TEXT NOT NULL,
    createdAt TEXT NOT NULL,
    PRIMARY KEY(scope, topic))`);
  // Explicit per-event completion marker. An event is pending until its last
  // verified/verbatim window transaction (or a no-op "all windows already
  // present" repair) inserts this row. Unlike a createdAt watermark this is
  // order-independent: observation order and tie timestamps cannot skip a
  // failed event forever. Additive table; old databases gain it on init.
  db.exec(`CREATE TABLE IF NOT EXISTS episode_event_done(
    scope TEXT NOT NULL,
    kind TEXT NOT NULL CHECK(kind IN ('session','doc','day')),
    episodeKey TEXT NOT NULL,
    eventId TEXT NOT NULL,
    doneAt TEXT NOT NULL,
    PRIMARY KEY(scope, kind, episodeKey, eventId))`);
  // Derived vector index (rebuildable; never canonical). One row per record:
  // L2-normalized float32 LE embedding of the normalized body (dim pinned).
  // Missing rows, dim mismatches, and non-finite/zero vectors are ignored by
  // recall (offline lexical+graph fallback, §8). Rebuilt by scripts/rebuild-vectors.
  db.exec(`CREATE TABLE IF NOT EXISTS vec_notes(recordId TEXT PRIMARY KEY, dim INTEGER NOT NULL, vec BLOB NOT NULL, bodyHash TEXT NOT NULL, updatedAt TEXT NOT NULL)`);
  ensureAssociateSchema(db);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_records_scope_status_created_id ON records(scope, status, createdAt, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_record_tags_tag_record ON record_tags(tag, recordId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_record_links_toref_from ON record_links(toRef, fromId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_source_refs_event ON record_source_refs(eventId, recordId)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_bigrams_lookup ON char_bigrams(kind, bigram, id)`);
  db.exec(`CREATE INDEX IF NOT EXISTS idx_exposures_recall ON exposures(recallId, recordId)`);
  const usageUniqueExists = db
    .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type='index' AND name='idx_usage_recall_record'`)
    .get() as { found: number } | undefined;
  if (!usageUniqueExists) {
    // One-time migration for pre-index databases; normal startup never scans
    // or rewrites the usage ledger. A savepoint works both standalone and
    // inside fresh init's outer transaction.
    db.exec(`SAVEPOINT ensure_m1_usage_unique`);
    try {
      db.exec(`DELETE FROM usage WHERE rowid NOT IN (SELECT MIN(rowid) FROM usage GROUP BY recallId, recordId)`);
      db.exec(`CREATE UNIQUE INDEX idx_usage_recall_record ON usage(recallId, recordId)`);
      db.exec(`RELEASE SAVEPOINT ensure_m1_usage_unique`);
    } catch (e) {
      try { db.exec(`ROLLBACK TO SAVEPOINT ensure_m1_usage_unique`); } catch { /* preserve the migration error */ }
      try { db.exec(`RELEASE SAVEPOINT ensure_m1_usage_unique`); } catch { /* preserve the migration error */ }
      throw e;
    }
  }
  db.exec(`CREATE INDEX IF NOT EXISTS idx_raw_scope_created ON raw_events(scope, createdAt, eventId)`);
  // M3 cultivation queue + single-flight lease (additive; never canonical).
  try {
    ensureCultivationSchema(db);
  } catch {
    /* queue/lease absence never fails schema init; writers enqueue best-effort */
  }
  // Self-heal derived indexes when they are obviously out of sync with
  // canonical tables (empty or smaller than canonical). Best-effort only:
  // never throws, never touches canonical rows; recall's bodyNorm fallback
  // covers reads even when repair fails.
  maybeRebuildDerivedIndexes(db);
}

/**
 * Serialized schema initialization. The ENTIRE additive sequence above runs
 * under one write lock: BEGIN IMMEDIATE is acquired before any PRAGMA
 * table_info inspection and held through every ALTER/TABLE rebuild and index
 * creation. A concurrent opener therefore waits (busy_timeout) and re-inspects
 * the committed schema instead of racing a stale snapshot into a "duplicate
 * column" failure. When an outer transaction already owns the lock (initDb),
 * the sequence composes as a savepoint.
 *
 * Fast path: a completed init stamps PRAGMA user_version=SCHEMA_VERSION, so an
 * already-current file takes no write lock at all.
 */
export function ensureM1Schema(db: DatabaseSync): void {
  if (readSchemaVersion(db) === SCHEMA_VERSION) {
    // Already current: no write lock, no DDL, no PRAGMA inspection. The
    // derived association tables are part of the versioned migration below.
    return;
  }
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT ensure_m1_schema_txn`);
  const commit = (): void => {
    if (ownTransaction) db.exec("COMMIT");
    else db.exec(`RELEASE SAVEPOINT ensure_m1_schema_txn`);
  };
  const rollback = (): void => {
    if (ownTransaction) {
      try { db.exec("ROLLBACK"); } catch { /* preserve error */ }
    } else {
      try { db.exec(`ROLLBACK TO SAVEPOINT ensure_m1_schema_txn`); } catch { /* preserve error */ }
      try { db.exec(`RELEASE SAVEPOINT ensure_m1_schema_txn`); } catch { /* preserve error */ }
    }
  };
  try {
    // Re-check after acquiring the lock: another opener may have completed
    // the sequence while this connection was waiting on busy_timeout.
    if (readSchemaVersion(db) !== SCHEMA_VERSION) {
      runM1SchemaMigrations(db);
      db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    commit();
  } catch (e) {
    rollback();
    throw e;
  }
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
    // M3 cultivation tables (cultivation_lease.expiresAt, cultivation_queue)
    // are current-schema, not approval-era traces: skip them so the widened
    // schema is never mistaken for a legacy approval database.
    if (r.name.startsWith("cultivation_")) continue;
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

function savedRecordId(savedJson: string): string | null {
  try {
    const parsed = JSON.parse(savedJson) as { data?: { record?: { id?: unknown } } };
    const id = parsed.data?.record?.id;
    return typeof id === "string" && ID_RE.test(id) ? id : null;
  } catch {
    return null;
  }
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
  // Compose with ensureM1Schema's outer write transaction (savepoint) as well
  // as standalone callers (own BEGIN IMMEDIATE).
  const ownTransaction = !db.isTransaction;
  if (ownTransaction) db.exec("BEGIN IMMEDIATE");
  else db.exec(`SAVEPOINT rebuild_derived_indexes`);
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
    if (ownTransaction) db.exec("COMMIT");
    else db.exec(`RELEASE SAVEPOINT rebuild_derived_indexes`);
    return { notes: noteRows.length, raw: rawRows.length, bigrams };
  } catch (e) {
    if (ownTransaction) {
      try { db.exec("ROLLBACK"); } catch { /* ignore */ }
    } else {
      try { db.exec(`ROLLBACK TO SAVEPOINT rebuild_derived_indexes`); } catch { /* ignore */ }
      try { db.exec(`RELEASE SAVEPOINT rebuild_derived_indexes`); } catch { /* ignore */ }
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

/* ---------------- derived vector index (M2, rebuildable) --------------- */

/**
 * Upsert one record embedding (derived only; never canonical). Validates dim
 * and finiteness; invalid input deletes any stale row and reports false.
 * Never throws.
 */
export function upsertRecordVector(
  db: DatabaseSync,
  recordId: string,
  vec: Float32Array,
  bodyHash: string,
  now: string,
  dim: number = VECTOR_DIM,
): boolean {
  try {
    if (!isValidVector(vec, dim)) {
      try {
        db.prepare(`DELETE FROM vec_notes WHERE recordId = ?`).run(recordId);
      } catch {
        /* ignore */
      }
      return false;
    }
    db.prepare(
      `INSERT INTO vec_notes(recordId, dim, vec, bodyHash, updatedAt) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(recordId) DO UPDATE SET dim=excluded.dim, vec=excluded.vec, bodyHash=excluded.bodyHash, updatedAt=excluded.updatedAt`,
    ).run(recordId, dim, serializeVec(vec), bodyHash, now);
    return true;
  } catch {
    return false;
  }
}

/** Count usable vector rows (diagnostics; never throws). */
export function countVectors(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM vec_notes`).get() as { n: number } | undefined;
    return typeof row?.n === "number" ? row.n : 0;
  } catch {
    return 0;
  }
}

export interface VectorHit { id: string; sim: number; createdAt: string }

/**
 * Brute-force cosine candidates over the derived vec_notes table.
 * Bounded (topK), deterministic (sim DESC, createdAt DESC, id ASC),
 * scope/status/time-window isolated. Invalid rows (dim mismatch, corrupt
 * blob, non-finite) are skipped. Empty array on ANY problem: the caller
 * falls back to lexical+graph (§8). Never throws.
 */
export function vectorHits(
  db: DatabaseSync,
  scope: string,
  queryVec: Float32Array | null | undefined,
  since: string | null,
  until: string | null,
  topK: number,
  dim: number = VECTOR_DIM,
): VectorHit[] {
  try {
    if (!isValidVector(queryVec, dim)) return [];
    const q = queryVec as Float32Array;
    const cap = Number.isInteger(topK) && topK >= 1 ? Math.min(topK, FUSION_CANDIDATE_MAX) : VECTOR_CANDIDATE_MAX;
    let sql = `SELECT v.recordId AS id, v.vec AS vec, r.createdAt AS createdAt
      FROM vec_notes v JOIN records r ON r.id = v.recordId
      WHERE r.scope = ? AND r.status = 'active' AND v.dim = ?`;
    const args: Array<string | number | Buffer> = [scope, dim];
    if (since !== null) {
      sql += ` AND r.createdAt >= ?`;
      args.push(since);
    }
    if (until !== null) {
      sql += ` AND r.createdAt < ?`;
      args.push(until);
    }
    const rows = db.prepare(sql).all(...(args as [])) as Array<{ id: string; vec: Buffer | Uint8Array; createdAt: string }>;
    const scored: VectorHit[] = [];
    for (const r of rows) {
      try {
        const v = deserializeVec(r.vec as Buffer, dim);
        if (!v) continue;
        const sim = cosine(q, v);
        if (!Number.isFinite(sim) || sim <= -1.5) continue;
        scored.push({ id: r.id, sim, createdAt: r.createdAt });
      } catch {
        /* per-row best effort */
      }
    }
    scored.sort((a, b) =>
      a.sim !== b.sim ? b.sim - a.sim
        : a.createdAt !== b.createdAt ? (a.createdAt < b.createdAt ? 1 : -1)
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    return scored.slice(0, cap);
  } catch {
    return [];
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
    sql += ` ORDER BY r ASC, records.createdAt DESC, f.recordId ASC LIMIT ?`;
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
           ORDER BY bm25(fts_raw) ASC, raw_events.createdAt DESC, f.eventId ASC LIMIT ?`,
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
    if (bigrams.length > 0) {
      try {
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
      } catch {
        eventIds = [];
      }
    }
  }
  if (eventIds.length === 0) {
    // Both derived event lookups missed: canonical raw text remains findable
    // even for multi-code-point queries with stale/missing bigrams.
    try {
      const rows = db
        .prepare(
          `SELECT eventId FROM raw_events WHERE scope = ? AND instr(bodyNorm, ?) > 0
           ORDER BY createdAt DESC, eventId ASC LIMIT ?`,
        )
        .all(scope, normalizedQuery, RAW_DESCENT_MAX) as Array<{ eventId: string }>;
      eventIds = rows.map((r) => r.eventId);
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
 * Returns the canonical bodyNorm alongside the id so recall can compute a
 * substitute lexical rank for damaged derived entries without extra reads.
 */
function canonicalBodyNormHits(
  db: DatabaseSync,
  scope: string,
  normalizedQuery: string,
  since: string | null,
  until: string | null,
  cap: number,
): Array<{ id: string; bodyNorm: string }> {
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
        `SELECT id, bodyNorm FROM records WHERE scope = ? AND status = 'active' AND instr(bodyNorm, ?) > 0${w.frag}
         ORDER BY createdAt DESC, id ASC LIMIT ?`,
      )
      .all(scope, normalizedQuery, ...w.args, cap) as Array<{ id: string; bodyNorm: string }>;
    if (whole.length > 0 || terms.length === 1) return whole;
    const conds = terms.map(() => `instr(bodyNorm, ?) > 0`).join(" OR ");
    const w2 = window("records");
    const perTerm = db
      .prepare(
        `SELECT id, bodyNorm FROM records WHERE scope = ? AND status = 'active' AND (${conds})${w2.frag}
         ORDER BY createdAt DESC, id ASC LIMIT ?`,
      )
      .all(scope, ...terms, ...w2.args, cap) as Array<{ id: string; bodyNorm: string }>;
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

function parseSourceRefs(refs: unknown, max: number): SourceRef[] | "bad" | "over" {
  return parseSourceRefsParam(refs, max);
}

/* ------------------------------------------------------------------ */
/* event.append                                                        */
/* ------------------------------------------------------------------ */

const CHUNK_DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

interface RawChunk {
  docId: string;
  seq: number;
}

/** Optional `chunk: {docId, seq}`; absent => null, any other shape => invalid. */
function parseChunkParam(v: unknown): RawChunk | null | "invalid" {
  if (v === undefined) return null;
  if (!isPlainObject(v)) return "invalid";
  const keys = Object.keys(v);
  if (keys.length !== 2 || !keys.includes("docId") || !keys.includes("seq")) {
    return "invalid";
  }
  const docId = v["docId"];
  const seq = v["seq"];
  if (typeof docId !== "string" || !CHUNK_DOC_ID_RE.test(docId)) return "invalid";
  if (typeof seq !== "number" || !Number.isInteger(seq) || seq < 0 || seq > 100000) {
    return "invalid";
  }
  return { docId, seq };
}

export function eventAppend(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["eventId", "sessionId", "turnId", "body", "provenance", "scope", "runId", "privacy", "chunk"]);
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
  const rawBodyMax = rawBodyMaxCp(config);
  if (countCp(body) > rawBodyMax) return budgeted(limitExceeded(), config);
  const nBody = normalizeBody(body);
  if (countCp(nBody) < 1) return budgeted(bad(), config);
  if (countCp(nBody) > rawBodyMax) return budgeted(limitExceeded(), config);
  const prov = parseProvenance(provenance);
  if (!prov) return budgeted(bad(), config);
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  const nRunId = parseRunId(runId);
  if (nRunId === "invalid") return budgeted(bad(), config);
  // F-I01-05 optional privacy: strict shape; requirePrivacy rejects absence.
  const nPrivacy = parsePrivacyParam(params["privacy"]);
  if (nPrivacy === "invalid") return budgeted(bad(), config);
  if (requirePrivacyEnabled(config) && nPrivacy === null) return budgeted(bad(), config);
  const nChunk = parseChunkParam(params["chunk"]);
  if (nChunk === "invalid") return budgeted(bad(), config);

  // Legacy hash compatibility: absent keys are omitted entirely, so requests
  // without privacy/chunk hash byte-identically to the pre-slice normal form.
  const hashedParams: Record<string, unknown> = {
    body: body as string,
    eventId,
    observedAt: prov.observedAt,
    runId: nRunId,
    scope: nScope,
    sessionId,
    source: prov.source,
    turnId,
  };
  if (nPrivacy !== null) hashedParams["privacy"] = nPrivacy;
  if (nChunk !== null) hashedParams["chunk"] = nChunk;
  const reqHash = requestHashFor("event.append", hashedParams);

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
        `INSERT INTO raw_events(eventId, sessionId, turnId, body, bodyNorm, source, observedAt, scope, runId, createdAt, privacySensitivity, privacyOrigin, docId, chunkSeq)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(eventId as string, sessionId as string, turnId as string, rawBody, nBody, prov.source, prov.observedAt, nScope, nRunId, now,
        nPrivacy === null ? null : nPrivacy.sensitivity, nPrivacy === null ? null : nPrivacy.origin,
        nChunk === null ? null : nChunk.docId, nChunk === null ? null : nChunk.seq);
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
  sourceRefs: SourceRef[];
  runId: string | null;
  /** F-I01-05: validated optional privacy (null = absent / legacy-compatible). */
  privacy: PrivacyMetadata | null;
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
  const allowed = new Set(["body", "kind", "provenance", "scope", "tags", "links", "sourceRefs", "runId", "privacy"]);
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
  // F-I01-05 optional privacy: strict shape; requirePrivacy rejects absence
  // (BAD_REQUEST, no side effects — validated before any DB access).
  const nPrivacy = parsePrivacyParam(params["privacy"]);
  if (nPrivacy === "invalid") return { ok: false, res: bad() };
  if (requirePrivacyEnabled(config) && nPrivacy === null) return { ok: false, res: bad() };
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
      privacy: nPrivacy,
    },
  };
}

/**
 * Verify every sourceRef exists as same-scope raw and (when spanned) stays
 * within that event's code-point length: 0 <= start < end <= totalCp.
 */
function checkSourceRefs(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  refs: SourceRef[],
): ResponseEnvelope | null {
  for (const r of refs) {
    const eventId = typeof r === "string" ? r : r.eventId;
    let row: { scope: string; body: string } | undefined;
    try {
      row = db.prepare(`SELECT scope, body FROM raw_events WHERE eventId = ?`).get(eventId) as
        | { scope: string; body: string }
        | undefined;
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    if (!row) return budgeted(fail("NOT_FOUND"), config);
    if (row.scope !== scope) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (typeof r !== "string" && r.end > countCp(row.body)) {
      return budgeted(bad(), config);
    }
  }
  return null;
}

/** In-transaction re-validation: same checks as checkSourceRefs, fail closed. */
function verifySourceRefsInTxn(
  db: DatabaseSync,
  scope: string,
  refs: SourceRef[],
): void {
  for (const r of refs) {
    const eventId = typeof r === "string" ? r : r.eventId;
    const row = db.prepare(`SELECT scope, body FROM raw_events WHERE eventId = ?`).get(eventId) as
      | { scope: string; body: string }
      | undefined;
    if (!row) throw new Error("source lost");
    if (row.scope !== scope) throw new Error("source scope");
    if (typeof r !== "string" && r.end > countCp(row.body)) throw new Error("source span");
  }
}

function insertSourceRefs(
  db: DatabaseSync,
  recordId: string,
  refs: SourceRef[],
): void {
  const stmt = db.prepare(
    `INSERT INTO record_source_refs(recordId, eventId, spanStart, spanEnd) VALUES (?, ?, ?, ?)`,
  );
  for (const s of storedSourceRefs(refs)) {
    stmt.run(recordId, s.eventId, s.start, s.end);
  }
}

/**
 * Optional ownership fence for a canonical write (used by maintain.episodes).
 * The whole write transaction is refused unless the caller still owns the live
 * m3 lease; `afterInsert` runs inside that same transaction so a caller can
 * commit its derived ledger rows atomically with the canonical record.
 */
export interface CanonicalWriteFence {
  owner: string;
  /** Timestamp used to evaluate lease liveness. */
  now: string;
  afterInsert?: (db: DatabaseSync, recordId: string) => void;
}

function assertCanonicalWriteFence(
  db: DatabaseSync,
  fence: CanonicalWriteFence | undefined,
): void {
  if (!fence) return;
  if (!isCultivationLeaseHeldBy(db, fence.owner, fence.now)) {
    throw new Error("lease lost");
  }
}

export function rememberRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
  fence?: CanonicalWriteFence,
): ResponseEnvelope {
  const parsed = parseRememberParams(config, params);
  if (!parsed.ok) return budgeted(parsed.res, config);
  const n = parsed.value;
  const reqHash = requestHashFor(
    "record.remember",
    n.privacy === null
      ? // Legacy compatibility: omit the key entirely when absent (pre-PR hash).
        {
          body: n.body,
          kind: n.kind,
          links: n.links,
          observedAt: n.observedAt,
          runId: n.runId,
          scope: n.scope,
          source: n.source,
          sourceRefs: n.sourceRefs,
          tags: n.tags,
        }
      : {
          body: n.body,
          kind: n.kind,
          links: n.links,
          observedAt: n.observedAt,
          privacy: n.privacy,
          runId: n.runId,
          scope: n.scope,
          source: n.source,
          sourceRefs: n.sourceRefs,
          tags: n.tags,
        },
  );

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
    const id = savedRecordId(saved.responseJson);
    if (id) postCommitEnqueueProjections(db, n.scope, [id], n.links);
    if (id) {
      // Recovery: a post-commit cultivation enqueue lost to a crash or a
      // transient failure leaves no open review; replay re-enqueues (open
      // dedupe makes the already-queued case a safe duplicate no-op).
      enqueueCultivationReview(db, config, { recordId: id, scope: n.scope, trigger: "remember", runId: n.runId, now: nowIso() });
    }
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
      // Ownership fence evaluated inside this canonical transaction: a lease
      // stolen during inference rolls the whole write back.
      assertCanonicalWriteFence(db, fence);
      // Re-verify refs inside the txn (fail closed on concurrent change).
      verifySourceRefsInTxn(db, n.scope, n.sourceRefs);
      const probe: ResponseEnvelope = ok({ record: { id } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      db.prepare(
        `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt, privacySensitivity, privacyOrigin)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL, 1, ?, ?, ?)`,
      ).run(id, n.body, n.bodyNorm, bodyHashFor(n.bodyNorm), n.kind, n.source, n.observedAt, n.scope, now,
        n.privacy === null ? null : n.privacy.sensitivity, n.privacy === null ? null : n.privacy.origin);
      for (const t of n.tags) {
        db.prepare(`INSERT INTO record_tags(recordId, tag) VALUES (?, ?)`).run(id, t);
      }
      for (const l of n.links) {
        db.prepare(`INSERT INTO record_links(fromId, toRef) VALUES (?, ?)`).run(id, l);
      }
      insertSourceRefs(db, id, n.sourceRefs);
      db.prepare(`INSERT OR IGNORE INTO note_heat(recordId, usedCount, lastUsedAt) VALUES (?, 0, ?)`).run(id, now);
      fence?.afterInsert?.(db, id);
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
    // M3 cultivation review (bounded, zero-link notes included, no inline
    // inference): best-effort, never affects the committed envelope.
    enqueueCultivationReview(db, config, { recordId: id, scope: n.scope, trigger: "remember", runId: n.runId, now });
    // Derived indexes post-commit, best-effort: failure never rolls back canonical.
    bestEffortIndexNote(db, id, n.bodyNorm);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "lease lost") return budgeted(fail("CONFLICT"), config);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "source lost") return budgeted(fail("NOT_FOUND"), config);
    if (msg === "source scope") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "source span") return budgeted(bad(), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "record.remember" && again.requestHash === reqHash) {
        const replayId = savedRecordId(again.responseJson);
        if (replayId) postCommitEnqueueProjections(db, n.scope, [replayId], n.links);
        if (replayId) {
          enqueueCultivationReview(db, config, { recordId: replayId, scope: n.scope, trigger: "remember", runId: n.runId, now: nowIso() });
        }
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
  /** F-I01-05: stored privacy metadata; null for legacy rows (absent privacy). */
  privacy: PrivacyMetadata | null;
}

function readRecordView(db: DatabaseSync, id: string): RecordView | null {
  const row = db
    .prepare(
      `SELECT id, body, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt, privacySensitivity, privacyOrigin
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
        privacySensitivity: string | null;
        privacyOrigin: string | null;
      }
    | undefined;
  if (!row) return null;
  const tags = (
    db.prepare(`SELECT tag FROM record_tags WHERE recordId = ? ORDER BY tag ASC`).all(id) as Array<{ tag: string }>
  ).map((r) => r.tag);
  const links = (
    db.prepare(`SELECT toRef FROM record_links WHERE fromId = ? ORDER BY toRef ASC`).all(id) as Array<{ toRef: string }>
  ).map((r) => r.toRef);
  // Distinct keeps the legacy record.get shape (one eventId per source) even
  // when the same event is cited through multiple spans.
  const sourceRefs = (
    db.prepare(`SELECT DISTINCT eventId FROM record_source_refs WHERE recordId = ? ORDER BY eventId ASC`).all(id) as Array<{ eventId: string }>
  ).map((r) => r.eventId);
  return {
    id: row.id,
    body: row.body,
    bodyHash: row.bodyHash,
    kind: row.kind,
    source: row.source,
    observedAt: row.observedAt,
    scope: row.scope,
    status: row.status,
    supersedes: row.supersedes,
    revision: row.revision,
    createdAt: row.createdAt,
    privacy: privacyFromColumns(row.privacySensitivity, row.privacyOrigin),
    tags,
    links,
    sourceRefs,
  };
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
    if (status !== "active" && status !== "superseded" && status !== "archived" && status !== "retired") {
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
/* graph.page: bounded linked-memory graph for Companion              */
/* ------------------------------------------------------------------ */

/**
 * Page the canonical linked-memory graph (active + optionally retired) by
 * `createdAt DESC, id ASC` with an opaque cursor. Each page is shrunk
 * deterministically when the configured response budget cannot hold the
 * requested number of nodes, so a consumer can always follow nextCursor.
 * Read-only: links/tags/episode ledger only; no heat/exposure/usage writes.
 */
export function graphPage(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope", "includeRetired", "cursor", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { scope, includeRetired, cursor, limit } = params;
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  let nIncludeRetired = false;
  if (includeRetired !== undefined) {
    if (typeof includeRetired !== "boolean") return budgeted(bad(), config);
    nIncludeRetired = includeRetired;
  }
  let nCursor: { createdAt: string; id: string } | null = null;
  if (cursor !== undefined && cursor !== null) {
    nCursor = decodeGraphPageCursor(cursor);
    if (nCursor === null) return budgeted(bad(), config);
  }
  const maxLimit = graphLimitMax(config);
  // An omitted limit must still respect graphLimitMax even when the general
  // limitDefault is larger; otherwise an omitted limit bypasses the graph cap.
  let nLimit = Math.min(config.limits.limitDefault, maxLimit);
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return budgeted(bad(), config);
    if (limit < 1) return budgeted(bad(), config);
    if (limit > maxLimit) return budgeted(limitExceeded(), config);
    nLimit = limit;
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const now = nowOverride ?? nowIso();
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      // Largest page size whose encoded envelope fits the byte budget.
      // Sizes grow monotonically with node count (extra node + possible
      // cursor), so a deterministic binary search finds the max that fits.
      const version = buildGraphVersion(db, nScope);
      let best: { nodes: ReturnType<typeof buildGraphPage>["nodes"]; nextCursor: string | null } | null = null;
      let lo = 1;
      let hi = nLimit;
      const maxBytes = graphResponseMaxBytes(config);
      while (lo <= hi) {
        const mid = Math.floor((lo + hi) / 2);
        const page = buildGraphPage(db, {
          scope: nScope,
          includeRetired: nIncludeRetired,
          cursor: nCursor,
          limit: mid,
          snippetMaxCp: config.limits.snippetMaxCp,
        });
        const probe = ok({ nodes: page.nodes, nextCursor: page.nextCursor, version });
        if (Buffer.byteLength(JSON.stringify(probe), "utf8") <= maxBytes) {
          best = page;
          lo = mid + 1;
        } else {
          hi = mid - 1;
        }
      }
      if (best === null) throw new Error("response over budget");
      const stored = ok({ nodes: best.nodes, nextCursor: best.nextCursor, version });
      auditInsert(db, {
        ts: now,
        op: "graph.page",
        targetId: null,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: nLimit,
        runId: null,
        recallId: null,
        reasonCode: null,
      });
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "response over budget") return budgeted(limitExceeded(), config);
    if (e instanceof GraphLimitError) return budgeted(limitExceeded(), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* graph.local / graph.version: local graph + freshness token          */
/* ------------------------------------------------------------------ */

/**
 * Obsidian-like LOCAL graph around one record. The centre may be in any
 * status; neighbours follow the includeRetired filter and must be in the
 * same scope. Traversal is undirected over record_links (outbound plus
 * backlinks); consolidation edges are the summary/correction outbound rows.
 * Nodes are ordered centre, hop, createdAt DESC, id ASC, then shrunk
 * deterministically to the graph byte budget. Read-only: no
 * heat/exposure/usage writes (audit row only).
 */
export function graphLocal(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope", "id", "depth", "includeRetired", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { scope, id, depth, includeRetired, limit } = params;
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  if (
    typeof id !== "string" ||
    checkLenCp(id, 1, 256) !== "ok" ||
    hasControl(id)
  ) {
    return budgeted(bad(), config);
  }
  let nDepth: 1 | 2 = 1;
  if (depth !== undefined) {
    if (typeof depth !== "number" || !Number.isInteger(depth)) return budgeted(bad(), config);
    if (depth !== 1 && depth !== 2) return budgeted(bad(), config);
    nDepth = depth;
  }
  let nIncludeRetired = false;
  if (includeRetired !== undefined) {
    if (typeof includeRetired !== "boolean") return budgeted(bad(), config);
    nIncludeRetired = includeRetired;
  }
  const maxLimit = graphLimitMax(config);
  // Same rule as graph.page: the effective default never exceeds the cap.
  let nLimit = Math.min(config.limits.limitDefault, maxLimit);
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return budgeted(bad(), config);
    if (limit < 1) return budgeted(bad(), config);
    if (limit > maxLimit) return budgeted(limitExceeded(), config);
    nLimit = limit;
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const now = nowOverride ?? nowIso();
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      const data = buildGraphLocal(db, {
        scope: nScope,
        id,
        depth: nDepth,
        includeRetired: nIncludeRetired,
        limit: nLimit,
        snippetMaxCp: config.limits.snippetMaxCp,
        maxBytes: graphResponseMaxBytes(config),
      });
      if (data === null) return budgeted(fail("NOT_FOUND"), config);
      const stored = ok({
        center: data.center,
        nodes: data.nodes,
        edges: data.edges,
        truncated: data.truncated,
        version: data.version,
      });
      auditInsert(db, {
        ts: now,
        op: "graph.local",
        targetId: data.center,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: nLimit,
        runId: null,
        recallId: null,
        reasonCode: null,
      });
      return stored;
    });
  } catch (e) {
    if (e instanceof GraphLocalScopeError) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (e instanceof GraphLimitError) return budgeted(limitExceeded(), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/**
 * Tiny freshness token for the GLOBAL graph (graph.page). Returns an opaque
 * string that changes on relevant writes and stays stable across pure reads;
 * it is derived from the same sources as graph.local's version field.
 */
export function graphVersion(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const nScope = parseScope(params["scope"]);
  if (!nScope) return budgeted(bad(), config);
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  try {
    return ok({ version: buildGraphVersion(db, nScope) });
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* P1 raw reads: event.get / event.range / record.sources              */
/* ------------------------------------------------------------------ */

function chunkFromColumns(
  docId: string | null | undefined,
  seq: number | null | undefined,
): { docId: string; seq: number } | null {
  if (typeof docId !== "string" || typeof seq !== "number") return null;
  return { docId, seq };
}

function encodeEventCursor(observedAt: string, eventId: string): string {
  return Buffer.from(JSON.stringify({ o: observedAt, e: eventId }), "utf8").toString("base64url");
}

function decodeEventCursor(v: unknown): { observedAt: string; eventId: string } | null {
  if (typeof v !== "string" || v.length === 0 || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("o") || !keys.includes("e")) return null;
  const observedAt = canonicalTime(parsed["o"]);
  const eventId = parsed["e"];
  if (observedAt === null) return null;
  if (typeof eventId !== "string" || countCp(eventId) < 1 || countCp(eventId) > 128 || hasControl(eventId)) {
    return null;
  }
  return { observedAt, eventId };
}

export function getEvent(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  for (const k of Object.keys(params)) {
    if (k !== "eventId" && k !== "scope" && k !== "offset" && k !== "maxCp") {
      return budgeted(bad(), config);
    }
  }
  const { eventId, scope, offset, maxCp } = params;
  if (
    typeof eventId !== "string" ||
    checkLenCp(eventId, 1, 128) !== "ok" ||
    hasControl(eventId)
  ) {
    return budgeted(bad(), config);
  }
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  const pageMax = rawPageMaxCp(config);
  let nOffset = 0;
  if (offset !== undefined) {
    if (typeof offset !== "number" || !Number.isInteger(offset) || offset < 0) {
      return budgeted(bad(), config);
    }
    nOffset = offset;
  }
  let nMaxCp = pageMax;
  if (maxCp !== undefined) {
    if (typeof maxCp !== "number" || !Number.isInteger(maxCp) || maxCp < 1) {
      return budgeted(bad(), config);
    }
    if (maxCp > pageMax) return budgeted(limitExceeded(), config);
    nMaxCp = maxCp;
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const now = nowOverride ?? nowIso();
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      let row:
        | {
            eventId: string;
            sessionId: string;
            turnId: string;
            source: string;
            observedAt: string;
            createdAt: string;
            body: string;
            scope: string;
            privacySensitivity: string | null;
            privacyOrigin: string | null;
            docId: string | null;
            chunkSeq: number | null;
          }
        | undefined;
      try {
        row = db
          .prepare(
            `SELECT eventId, sessionId, turnId, source, observedAt, createdAt, body, scope,
                    privacySensitivity, privacyOrigin, docId, chunkSeq
             FROM raw_events WHERE eventId = ?`,
          )
          .get(eventId) as typeof row;
      } catch {
        throw new Error("read failed");
      }
      if (!row) throw new Error("missing");
      if (row.scope !== nScope) throw new Error("scope mismatch");
      const cps = [...row.body];
      const totalCp = cps.length;
      if (nOffset > totalCp) throw new Error("bad offset");
      const end = Math.min(totalCp, nOffset + nMaxCp);
      const body = cps.slice(nOffset, end).join("");
      const stored = budgeted(
        ok({
          eventId: row.eventId,
          sessionId: row.sessionId,
          turnId: row.turnId,
          source: row.source,
          observedAt: row.observedAt,
          createdAt: row.createdAt,
          privacy: privacyFromColumns(row.privacySensitivity, row.privacyOrigin),
          chunk: chunkFromColumns(row.docId, row.chunkSeq),
          totalCp,
          offset: nOffset,
          body,
          nextOffset: end < totalCp ? end : null,
        }),
        config,
      );
      if (!stored.ok) throw new Error("response over budget");
      auditInsert(db, {
        ts: now,
        op: "event.get",
        targetId: row.eventId,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: nMaxCp,
        runId: null,
        recallId: null,
        reasonCode: null,
      });
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "missing") return budgeted(fail("NOT_FOUND"), config);
    if (msg === "scope mismatch") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "bad offset") return budgeted(bad(), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

export function rangeEvents(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope", "sessionId", "docId", "since", "until", "cursor", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { scope, sessionId, docId, since, until, cursor, limit } = params;
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  let nSessionId: string | null = null;
  if (sessionId !== undefined) {
    if (
      typeof sessionId !== "string" ||
      checkLenCp(sessionId, 1, 128) !== "ok" ||
      hasControl(sessionId)
    ) {
      return budgeted(bad(), config);
    }
    nSessionId = sessionId;
  }
  let nDocId: string | null = null;
  if (docId !== undefined) {
    if (typeof docId !== "string" || !CHUNK_DOC_ID_RE.test(docId)) {
      return budgeted(bad(), config);
    }
    nDocId = docId;
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
  let nCursor: { observedAt: string; eventId: string } | null = null;
  if (cursor !== undefined && cursor !== null) {
    nCursor = decodeEventCursor(cursor);
    if (nCursor === null) return budgeted(bad(), config);
  }
  const maxLimit = rangeLimitMax(config);
  let nLimit = config.limits.limitDefault;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return budgeted(bad(), config);
    if (limit < 1) return budgeted(bad(), config);
    if (limit > maxLimit) return budgeted(limitExceeded(), config);
    nLimit = limit;
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const now = nowOverride ?? nowIso();
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      let rows: Array<{
        eventId: string;
        sessionId: string;
        turnId: string;
        body: string;
        observedAt: string;
        docId: string | null;
        chunkSeq: number | null;
      }>;
      try {
        let sql = `SELECT eventId, sessionId, turnId, body, observedAt, docId, chunkSeq
                   FROM raw_events WHERE scope = ?`;
        const args: Array<string | number> = [nScope];
        if (nSessionId !== null) {
          sql += ` AND sessionId = ?`;
          args.push(nSessionId);
        }
        if (nDocId !== null) {
          sql += ` AND docId = ?`;
          args.push(nDocId);
        }
        if (nSince !== null) {
          sql += ` AND observedAt >= ?`;
          args.push(nSince);
        }
        if (nUntil !== null) {
          sql += ` AND observedAt < ?`;
          args.push(nUntil);
        }
        if (nCursor !== null) {
          sql += ` AND (observedAt > ? OR (observedAt = ? AND eventId > ?))`;
          args.push(nCursor.observedAt, nCursor.observedAt, nCursor.eventId);
        }
        sql += ` ORDER BY observedAt ASC, eventId ASC LIMIT ?`;
        args.push(nLimit + 1);
        rows = db.prepare(sql).all(...args) as typeof rows;
      } catch {
        throw new Error("read failed");
      }
      const shown = rows.slice(0, nLimit);
      const items = shown.map((r) => {
        const cps = [...r.body];
        const max = config.limits.snippetMaxCp;
        return {
          eventId: r.eventId,
          sessionId: r.sessionId,
          turnId: r.turnId,
          observedAt: r.observedAt,
          chunk: chunkFromColumns(r.docId, r.chunkSeq),
          totalCp: cps.length,
          snippet: cps.length <= max ? r.body : cps.slice(0, max).join(""),
          truncated: cps.length > max,
        };
      });
      const last = shown.length > 0 ? shown[shown.length - 1] : null;
      const nextCursor =
        rows.length > nLimit && last
          ? encodeEventCursor(last.observedAt, last.eventId)
          : null;
      const stored = budgeted(ok({ items, nextCursor }), config);
      if (!stored.ok) throw new Error("response over budget");
      auditInsert(db, {
        ts: now,
        op: "event.range",
        targetId: null,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: nLimit,
        runId: null,
        recallId: null,
        reasonCode: null,
      });
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

export function recordSources(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  for (const k of Object.keys(params)) {
    if (k !== "id" && k !== "scope") return budgeted(bad(), config);
  }
  const { id, scope } = params;
  if (typeof id !== "string" || id.length === 0 || id.length > 256) {
    return budgeted(bad(), config);
  }
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const now = nowOverride ?? nowIso();
  const excerptMax = rawPageMaxCp(config);
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      let record: { id: string; scope: string } | undefined;
      try {
        record = db.prepare(`SELECT id, scope FROM records WHERE id = ?`).get(id) as
          | { id: string; scope: string }
          | undefined;
      } catch {
        throw new Error("read failed");
      }
      if (!record) throw new Error("missing");
      if (record.scope !== nScope) throw new Error("scope mismatch");
      let refs: Array<{ eventId: string; spanStart: number | null; spanEnd: number | null }>;
      try {
        refs = db
          .prepare(
            `SELECT eventId, spanStart, spanEnd FROM record_source_refs
             WHERE recordId = ?
             ORDER BY eventId ASC, spanStart ASC NULLS FIRST, spanEnd ASC NULLS FIRST`,
          )
          .all(id) as typeof refs;
      } catch {
        throw new Error("read failed");
      }
      // Resolve each ref once; excerpt caps are applied later so the whole
      // response can be kept within responseMaxBytes deterministically.
      const base = refs.map((r) => {
        let raw:
          | {
              sessionId: string;
              observedAt: string;
              body: string;
              scope: string;
              docId: string | null;
              chunkSeq: number | null;
            }
          | undefined;
        try {
          raw = db
            .prepare(
              `SELECT sessionId, observedAt, body, scope, docId, chunkSeq
               FROM raw_events WHERE eventId = ?`,
            )
            .get(r.eventId) as typeof raw;
        } catch {
          throw new Error("read failed");
        }
        if (!raw || raw.scope !== nScope) {
          return { eventId: r.eventId, missing: true as const };
        }
        const cps = [...raw.body];
        const hasSpan =
          r.spanStart !== null && r.spanStart !== undefined &&
          r.spanEnd !== null && r.spanEnd !== undefined;
        const start = hasSpan ? Math.min(r.spanStart as number, cps.length) : 0;
        const end = hasSpan ? Math.min(r.spanEnd as number, cps.length) : cps.length;
        return {
          eventId: r.eventId,
          sessionId: raw.sessionId,
          observedAt: raw.observedAt,
          chunk: chunkFromColumns(raw.docId, raw.chunkSeq),
          totalCp: cps.length,
          span: hasSpan ? { start: r.spanStart as number, end: r.spanEnd as number } : null,
          segment: cps.slice(start, end),
        };
      });
      // Share the excerpt budget across every source instead of giving each
      // one rawPageMaxCp. If the encoded envelope still does not fit, halve
      // the (uniform) caps down to a floor. Full text stays available through
      // event.get with offset=span.start.
      const sourceCount = base.length;
      const initialCap =
        sourceCount === 0 ? excerptMax : Math.max(1, Math.floor(excerptMax / sourceCount));
      const floor = Math.min(16, initialCap);
      let caps = base.map(() => initialCap);
      for (;;) {
        const sources = base.map((s, i) => {
          if ("missing" in s) return s;
          const cap = caps[i] as number;
          return {
            eventId: s.eventId,
            sessionId: s.sessionId,
            observedAt: s.observedAt,
            chunk: s.chunk,
            totalCp: s.totalCp,
            span: s.span,
            excerpt: s.segment.slice(0, cap).join(""),
            truncated: s.segment.length > cap,
          };
        });
        const candidate = ok({ id, sources });
        if (successFits(candidate, config.limits.responseMaxBytes)) {
          const stored = budgeted(candidate, config);
          auditInsert(db, {
            ts: now,
            op: "record.sources",
            targetId: id as string,
            code: stored.code,
            scope: nScope,
            bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
            limitN: null,
            runId: null,
            recallId: null,
            reasonCode: null,
          });
          return stored;
        }
        const next = caps.map((cap) => Math.max(floor, Math.floor(cap / 2)));
        if (next.every((cap, i) => cap === caps[i])) {
          throw new Error("response over budget");
        }
        caps = next;
      }
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "missing") return budgeted(fail("NOT_FOUND"), config);
    if (msg === "scope mismatch") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* P2 episodes: derived episode summaries + episode.list               */
/* ------------------------------------------------------------------ */

export type EpisodeKind = "session" | "doc" | "day";
export type EpisodeLevel = "window" | "episode";

/** Row accepted by insertEpisodeSummary (caller owns the transaction). */
export interface EpisodeSummaryInput {
  scope: string;
  kind: EpisodeKind;
  episodeKey: string;
  level: EpisodeLevel;
  recordId: string;
  eventId?: string | null;
  spanStart?: number | null;
  spanEnd?: number | null;
  coveredThrough?: string | null;
  /**
   * Window recordIds folded into this episode-level row. Used as the explicit
   * "already reduced" marker for staleness; never a timestamp. Ignored for
   * level='window'.
   */
  foldedRecordIds?: string[] | null;
  /**
   * Window rows only: true when the body is the raw verbatim fallback rather
   * than a model summary. Explicit ledger field because tags are bounded by
   * tagsMax and the verbatim tag can be dropped.
   */
  verbatim?: boolean;
  createdAt: string;
}

/** Stored episode_summaries row as returned by listEpisodeSummaries. */
export interface EpisodeSummaryRow {
  scope: string;
  kind: EpisodeKind;
  episodeKey: string;
  level: EpisodeLevel;
  recordId: string;
  eventId: string | null;
  spanStart: number | null;
  spanEnd: number | null;
  coveredThrough: string | null;
  foldedRecordIds: string[];
  verbatim: boolean;
  createdAt: string;
}

/** Per-event completion row (explicit pending marker complement). */
export interface EpisodeEventDoneInput {
  scope: string;
  kind: EpisodeKind;
  episodeKey: string;
  eventId: string;
  doneAt: string;
}

/**
 * Mark one raw event fully processed. No transaction is opened here so the
 * caller can write it in the same transaction as the event's last window (or
 * its ledger repair). Re-marking is idempotent.
 */
export function insertEpisodeEventDone(db: DatabaseSync, row: EpisodeEventDoneInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO episode_event_done(scope, kind, episodeKey, eventId, doneAt)
     VALUES (?, ?, ?, ?, ?)`,
  ).run(row.scope, row.kind, row.episodeKey, row.eventId, row.doneAt);
}

/**
 * Insert one derived episode ledger row. No transaction is opened here so a
 * maintainer can write window + episode rows atomically with its own txn.
 * Re-inserting the same (scope, kind, episodeKey, recordId) replaces it.
 */
export function insertEpisodeSummary(db: DatabaseSync, row: EpisodeSummaryInput): void {
  db.prepare(
    `INSERT OR REPLACE INTO episode_summaries(
       scope, kind, episodeKey, level, recordId, eventId,
       spanStart, spanEnd, coveredThrough, foldedRecordIds, verbatim, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    row.scope,
    row.kind,
    row.episodeKey,
    row.level,
    row.recordId,
    row.eventId ?? null,
    row.spanStart ?? null,
    row.spanEnd ?? null,
    row.coveredThrough ?? null,
    row.foldedRecordIds === undefined || row.foldedRecordIds === null
      ? null
      : JSON.stringify(row.foldedRecordIds),
    row.verbatim === true ? 1 : 0,
    row.createdAt,
  );
}

function parseFoldedRecordIds(raw: unknown): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((v): v is string => typeof v === "string");
  } catch {
    return [];
  }
}

/** Read derived episode ledger rows (optionally filtered to one level). */
export function listEpisodeSummaries(
  db: DatabaseSync,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
  level?: EpisodeLevel,
): EpisodeSummaryRow[] {
  let sql = `SELECT scope, kind, episodeKey, level, recordId, eventId,
                    spanStart, spanEnd, coveredThrough, foldedRecordIds, verbatim, createdAt
             FROM episode_summaries
             WHERE scope = ? AND kind = ? AND episodeKey = ?`;
  const args: Array<string> = [scope, kind, episodeKey];
  if (level !== undefined) {
    sql += ` AND level = ?`;
    args.push(level);
  }
  sql += ` ORDER BY createdAt DESC, recordId ASC`;
  const rows = db.prepare(sql).all(...args) as unknown as Array<
    Omit<EpisodeSummaryRow, "foldedRecordIds" | "verbatim"> & {
      foldedRecordIds: string | null;
      verbatim: number | null;
    }
  >;
  return rows.map((row) => ({
    ...row,
    foldedRecordIds: parseFoldedRecordIds(row.foldedRecordIds),
    verbatim: row.verbatim === 1,
  }));
}

/** One derived topic-cluster ledger row (maintain.consolidate). */
export interface ClusterSummaryRow {
  scope: string;
  topic: string;
  recordId: string;
  memberFingerprint: string;
  createdAt: string;
}

/**
 * Upsert one cluster ledger row. No transaction is opened here so the
 * maintainer can commit it atomically with the canonical summary record
 * (afterInsert under the cultivation lease fence).
 */
export function upsertClusterSummary(db: DatabaseSync, row: ClusterSummaryRow): void {
  db.prepare(
    `INSERT INTO cluster_summaries(scope, topic, recordId, memberFingerprint, createdAt)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(scope, topic) DO UPDATE SET
       recordId = excluded.recordId,
       memberFingerprint = excluded.memberFingerprint,
       createdAt = excluded.createdAt`,
  ).run(row.scope, row.topic, row.recordId, row.memberFingerprint, row.createdAt);
}

/** Read one cluster ledger row (scope + topic), or null when absent. */
export function getClusterSummary(
  db: DatabaseSync,
  scope: string,
  topic: string,
): ClusterSummaryRow | null {
  const row = db
    .prepare(
      `SELECT scope, topic, recordId, memberFingerprint, createdAt
       FROM cluster_summaries WHERE scope = ? AND topic = ?`,
    )
    .get(scope, topic) as ClusterSummaryRow | undefined;
  return row ?? null;
}

function encodeEpisodeCursor(startAt: string, episodeKey: string): string {
  return Buffer.from(JSON.stringify({ s: startAt, k: episodeKey }), "utf8").toString("base64url");
}

function decodeEpisodeCursor(v: unknown): { startAt: string; episodeKey: string } | null {
  if (typeof v !== "string" || v.length === 0 || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const keys = Object.keys(parsed);
  if (keys.length !== 2 || !keys.includes("s") || !keys.includes("k")) return null;
  const startAt = canonicalTime(parsed["s"]);
  const episodeKey = parsed["k"];
  if (startAt === null) return null;
  if (
    typeof episodeKey !== "string" ||
    countCp(episodeKey) < 1 ||
    countCp(episodeKey) > 256 ||
    hasControl(episodeKey)
  ) {
    return null;
  }
  return { startAt, episodeKey };
}

const EPISODE_KINDS = new Set<string>(["session", "doc", "day"]);

export function listEpisodes(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope", "kind", "since", "until", "cursor", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { scope, kind, since, until, cursor, limit } = params;
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  if (typeof kind !== "string" || !EPISODE_KINDS.has(kind)) {
    return budgeted(bad(), config);
  }
  const nKind = kind as EpisodeKind;
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
  let nCursor: { startAt: string; episodeKey: string } | null = null;
  if (cursor !== undefined && cursor !== null) {
    nCursor = decodeEpisodeCursor(cursor);
    if (nCursor === null) return budgeted(bad(), config);
  }
  const maxLimit = rangeLimitMax(config);
  let nLimit = config.limits.limitDefault;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return budgeted(bad(), config);
    if (limit < 1) return budgeted(bad(), config);
    if (limit > maxLimit) return budgeted(limitExceeded(), config);
    nLimit = limit;
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }
  const offset = episodesBounds(config).utcOffsetMinutes;
  const offsetModifier = `${offset >= 0 ? "+" : ""}${offset} minutes`;
  const keyExpr =
    nKind === "session" ? "sessionId" : nKind === "doc" ? "docId" : `date(observedAt, ?)`;
  const now = nowOverride ?? nowIso();
  try {
    return withTransaction(db, (): ResponseEnvelope => {
      let rows: Array<{
        episodeKey: string;
        startAt: string;
        endAt: string;
        eventCount: number;
        totalCp: number;
        maxCreatedAt: string;
      }>;
      try {
        let sql = `SELECT episodeKey, startAt, endAt, eventCount, totalCp, maxCreatedAt
                   FROM (
                     SELECT ${keyExpr} AS episodeKey,
                            MIN(observedAt) AS startAt,
                            MAX(observedAt) AS endAt,
                            COUNT(*) AS eventCount,
                            SUM(length(body)) AS totalCp,
                            MAX(createdAt) AS maxCreatedAt
                     FROM raw_events
                     WHERE scope = ?${nKind === "doc" ? " AND docId IS NOT NULL" : ""}
                     GROUP BY episodeKey
                   ) WHERE 1 = 1`;
        // keyExpr's offset placeholder precedes the scope placeholder.
        const args: Array<string | number> =
          nKind === "day" ? [offsetModifier, nScope] : [nScope];
        if (nSince !== null) {
          sql += ` AND startAt >= ?`;
          args.push(nSince);
        }
        if (nUntil !== null) {
          sql += ` AND startAt < ?`;
          args.push(nUntil);
        }
        if (nCursor !== null) {
          sql += ` AND (startAt > ? OR (startAt = ? AND episodeKey > ?))`;
          args.push(nCursor.startAt, nCursor.startAt, nCursor.episodeKey);
        }
        sql += ` ORDER BY startAt ASC, episodeKey ASC LIMIT ?`;
        args.push(nLimit + 1);
        rows = db.prepare(sql).all(...args) as typeof rows;
      } catch {
        throw new Error("read failed");
      }
      const shown = rows.slice(0, nLimit);
      const summaryStmt = db.prepare(
        `SELECT s.recordId AS recordId, s.coveredThrough AS coveredThrough,
                s.foldedRecordIds AS foldedRecordIds, r.status AS status
         FROM episode_summaries s
         LEFT JOIN records r ON r.id = s.recordId
         WHERE s.scope = ? AND s.kind = ? AND s.episodeKey = ? AND s.level = 'episode'
         ORDER BY s.createdAt DESC, s.recordId ASC`,
      );
      const eventPredicate =
        nKind === "session"
          ? "e.sessionId = ?"
          : nKind === "doc"
            ? "e.docId = ?"
            : "date(e.observedAt, ?) = ?";
      const pendingStmt = db.prepare(
        `SELECT 1 AS found FROM raw_events e
         WHERE e.scope = ? AND ${eventPredicate}
           AND NOT EXISTS (
             SELECT 1 FROM episode_event_done d
             WHERE d.scope = e.scope AND d.kind = ? AND d.episodeKey = ?
               AND d.eventId = e.eventId)
         LIMIT 1`,
      );
      const windowStmt = db.prepare(
        `SELECT w.recordId AS recordId FROM episode_summaries w
         JOIN records rw ON rw.id = w.recordId AND rw.status = 'active'
         WHERE w.scope = ? AND w.kind = ? AND w.episodeKey = ? AND w.level = 'window'`,
      );
      const items = shown.map((r) => {
        const summaries = summaryStmt.all(nScope, nKind, r.episodeKey) as Array<{
          recordId: string;
          coveredThrough: string | null;
          foldedRecordIds: string | null;
          status: string | null;
        }>;
        const summaryRecordIds = summaries
          .filter((s) => s.status === "active")
          .map((s) => s.recordId);
        // Explicit fold markers from every episode-level row. Timestamps are
        // never used to decide staleness: picking the "latest" row by
        // createdAt would be ambiguous on ties (and could resurrect an
        // already-folded window). A window counts as folded if any reduce
        // ever included it.
        const folded = new Set<string>();
        for (const s of summaries) {
          for (const id of parseFoldedRecordIds(s.foldedRecordIds)) folded.add(id);
        }
        const pendingArgs: Array<string | number> =
          nKind === "day"
            ? [nScope, offsetModifier, r.episodeKey, nKind, r.episodeKey]
            : [nScope, r.episodeKey, nKind, r.episodeKey];
        const pending = pendingStmt.get(...pendingArgs) !== undefined;
        const windows = windowStmt.all(nScope, nKind, r.episodeKey) as Array<{
          recordId: string;
        }>;
        const unfolded = windows.some((w) => !folded.has(w.recordId));
        const stale = pending || unfolded;
        return {
          kind: nKind,
          episodeKey: r.episodeKey,
          startAt: r.startAt,
          endAt: r.endAt,
          eventCount: r.eventCount,
          totalCp: r.totalCp,
          summaryRecordIds,
          stale,
        };
      });
      const last = shown.length > 0 ? shown[shown.length - 1] : null;
      const nextCursor =
        rows.length > nLimit && last
          ? encodeEpisodeCursor(last.startAt, last.episodeKey)
          : null;
      const stored = budgeted(ok({ items, nextCursor }), config);
      if (!stored.ok) throw new Error("response over budget");
      auditInsert(db, {
        ts: now,
        op: "episode.list",
        targetId: null,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: nLimit,
        runId: null,
        recallId: null,
        reasonCode: null,
      });
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
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

/**
 * Derived topic seeds: any current record_topics value (bodyHash matches the
 * record) that occurs inside the normalized query and is at least two code
 * points long seeds every matching record. Topic rows are derived, so an
 * empty table preserves the pre-association candidate set exactly.
 */
function topicSeedIds(
  db: DatabaseSync,
  scope: string,
  query: string,
  statuses: string[],
  since: string | null,
  until: string | null,
): string[] {
  const nq = normalizeBody(query);
  if (countCp(nq) < TOPIC_SEED_MIN_CP) return [];
  // The derived layer is empty until maintain.associate / topic.set runs.
  // Cheap existence probe: skip the DISTINCT/JOIN/ORDER BY scan entirely.
  try {
    if (!db.prepare(`SELECT 1 AS one FROM record_topics LIMIT 1`).get()) return [];
  } catch {
    return [];
  }
  const statusList = statuses.map(() => "?").join(",");
  let topicRows: Array<{ topic: string }>;
  try {
    topicRows = db
      .prepare(
        `SELECT DISTINCT t.topic AS topic
         FROM record_topics t JOIN records r ON r.id = t.recordId
         WHERE r.scope = ? AND r.status IN (${statusList}) AND t.bodyHash = r.bodyHash
         ORDER BY t.topic ASC`,
      )
      .all(scope, ...statuses) as Array<{ topic: string }>;
  } catch {
    return [];
  }
  const matched: string[] = [];
  for (const row of topicRows) {
    const key = normalizeBody(row.topic);
    if (countCp(key) >= TOPIC_SEED_MIN_CP && nq.includes(key)) matched.push(row.topic);
  }
  if (matched.length === 0) return [];

  const windowFrag = `${since === null ? "" : " AND r.createdAt >= ?"}${
    until === null ? "" : " AND r.createdAt < ?"
  }`;
  const windowArgs: Array<string | number> = [];
  if (since !== null) windowArgs.push(since);
  if (until !== null) windowArgs.push(until);
  const seeds = new Map<string, string>();
  const chunk = 400;
  try {
    for (let i = 0; i < matched.length; i += chunk) {
      const part = matched.slice(i, i + chunk);
      const topicList = part.map(() => "?").join(",");
      const rows = db
        .prepare(
          `SELECT DISTINCT r.id AS id, r.createdAt AS createdAt
           FROM records r JOIN record_topics t ON t.recordId = r.id
           WHERE r.scope = ? AND r.status IN (${statusList}) AND t.bodyHash = r.bodyHash
             AND t.topic IN (${topicList})${windowFrag}
           ORDER BY r.createdAt DESC, r.id ASC`,
        )
        .all(scope, ...statuses, ...part, ...windowArgs) as Array<{ id: string; createdAt: string }>;
      for (const row of rows) seeds.set(row.id, row.createdAt);
    }
  } catch {
    return [];
  }
  return [...seeds.entries()]
    .sort((a, b) =>
      a[1] !== b[1] ? (a[1] < b[1] ? 1 : -1) : a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0,
    )
    .slice(0, FUSION_CANDIDATE_MAX)
    .map(([id]) => id);
}

/**
 * Bounded depth-2 traversal of the derived similar_edges layer (undirected).
 * Each reached record carries `SIMILAR_FUSION_WEIGHT * edgeScore / hop`, so a
 * high-confidence similar neighbour stays below an explicit link at the same
 * hop. Empty table => empty map => score/ranking byte-identical to lexical +
 * canonical-link graph recall.
 */
function expandSimilarEdges(
  db: DatabaseSync,
  scope: string,
  frontier0: string[],
  since: string | null,
  until: string | null,
): Map<string, number> {
  const contributions = new Map<string, number>();
  const visited = new Set<string>(frontier0);
  let frontier = [...frontier0];
  // Empty derived layer: one existence probe replaces the per-frontier
  // queries (frontier0 can be 20 ids plus explicit-link neighbours).
  try {
    if (!db.prepare(`SELECT 1 AS one FROM similar_edges LIMIT 1`).get()) return contributions;
  } catch {
    return contributions;
  }
  const CHUNK = 400;
  for (let hop = 1; hop <= GRAPH_DEPTH_MAX && frontier.length > 0; hop++) {
    const rawScore = new Map<string, number>();
    for (let i = 0; i < frontier.length; i += CHUNK) {
      const part = frontier.slice(i, i + CHUNK);
      const members = new Set(part);
      const list = part.map(() => "?").join(",");
      try {
        // One batched query per hop instead of one query per frontier id.
        const rows = db
          .prepare(
            `SELECT a, b, score FROM similar_edges
             WHERE scope = ? AND (a IN (${list}) OR b IN (${list}))`,
          )
          .all(scope, ...part, ...part) as Array<{ a: string; b: string; score: number }>;
        for (const row of rows) {
          const nb = members.has(row.a) ? row.b : row.a;
          if (visited.has(nb)) continue;
          const s = typeof row.score === "number" && Number.isFinite(row.score) ? row.score : 0;
          if (s <= 0) continue;
          const prev = rawScore.get(nb);
          if (prev === undefined || s > prev) rawScore.set(nb, s);
        }
      } catch {
        /* skip this frontier chunk */
      }
    }
    const resolved: Array<{ id: string; createdAt: string; contribution: number }> = [];
    const candidates = [...rawScore.keys()];
    const createdAtById = new Map<string, string>();
    for (let i = 0; i < candidates.length; i += CHUNK) {
      const part = candidates.slice(i, i + CHUNK);
      const list = part.map(() => "?").join(",");
      try {
        const rows = db
          .prepare(
            `SELECT id, createdAt FROM records
             WHERE scope = ? AND status = 'active' AND id IN (${list})`,
          )
          .all(scope, ...part) as Array<{ id: string; createdAt: string }>;
        for (const row of rows) createdAtById.set(row.id, row.createdAt);
      } catch {
        /* dangling/unreadable similar rows are skipped */
      }
    }
    for (const [id, score] of rawScore) {
      const createdAt = createdAtById.get(id);
      if (createdAt === undefined) continue;
      if (since !== null && createdAt < since) continue;
      if (until !== null && createdAt >= until) continue;
      resolved.push({ id, createdAt, contribution: (SIMILAR_FUSION_WEIGHT * score) / hop });
    }
    resolved.sort((a, b) =>
      b.contribution !== a.contribution
        ? b.contribution - a.contribution
        : a.createdAt !== b.createdAt
          ? a.createdAt < b.createdAt ? 1 : -1
          : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const slots = Math.max(0, GRAPH_EXPAND_MAX - contributions.size);
    const next = resolved.slice(0, slots);
    for (const row of next) {
      visited.add(row.id);
      contributions.set(row.id, row.contribution);
    }
    frontier = next.map((row) => row.id);
  }
  return contributions;
}

/** Bounded depth-2 expansion over resolved active same-scope refs + backlinks. */
function expandGraph(
  db: DatabaseSync,
  scope: string,
  frontier0: string[],
  since: string | null,
  until: string | null,
): Map<string, number> {
  const dist = new Map<string, number>();
  for (const id of frontier0) {
    if (!dist.has(id)) dist.set(id, 0);
  }
  let frontier = [...frontier0];
  for (let d = 0; d < GRAPH_DEPTH_MAX && frontier.length > 0; d++) {
    const candidates = new Set<string>();
    for (const id of frontier) {
      try {
        const outs = db.prepare(`SELECT toRef FROM record_links WHERE fromId = ?`).all(id) as Array<{ toRef: string }>;
        const backs = db
          .prepare(
            `SELECT l.fromId AS fromId FROM record_links l
             JOIN records r ON r.id = l.fromId
             WHERE l.toRef = ? AND r.scope = ? AND r.status = 'active'`,
          )
          .all(id, scope) as Array<{ fromId: string }>;
        for (const nb of [...outs.map((o) => o.toRef), ...backs.map((b) => b.fromId)]) {
          if (!dist.has(nb)) candidates.add(nb);
        }
      } catch {
        /* skip this frontier member */
      }
    }
    const resolved: Array<{ id: string; createdAt: string }> = [];
    for (const id of candidates) {
      try {
        const row = db
          .prepare(`SELECT id, createdAt FROM records WHERE id = ? AND scope = ? AND status = 'active'`)
          .get(id, scope) as { id: string; createdAt: string } | undefined;
        if (!row) continue;
        if (since !== null && row.createdAt < since) continue;
        if (until !== null && row.createdAt >= until) continue;
        resolved.push(row);
      } catch {
        /* dangling/unreadable refs are skipped */
      }
    }
    resolved.sort((a, b) =>
      a.createdAt !== b.createdAt
        ? a.createdAt < b.createdAt ? 1 : -1
        : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
    );
    const next = resolved.slice(0, Math.max(0, GRAPH_EXPAND_MAX - dist.size));
    for (const row of next) dist.set(row.id, d + 1);
    frontier = next.map((row) => row.id);
  }
  return dist;
}

export interface RecallVectorInput {
  /** L2-normalized query embedding (dim VECTOR_DIM). Null/invalid => lexical+graph fallback. */
  vec: Float32Array | null | undefined;
  /** Candidates cap (default VECTOR_CANDIDATE_MAX, hard cap FUSION_CANDIDATE_MAX). */
  topK?: number;
}

export function recallRecords(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
  vector?: RecallVectorInput,
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
      // 2c) Vector candidates (M2): derived vec_notes cosine over active
      // same-scope rows. Missing/invalid model or vectors => empty here and
      // the rest of this recall is exactly the M1 lexical+graph path (§8).
      const vecTopK = vector?.topK ?? VECTOR_CANDIDATE_MAX;
      const vecHits = vectorHits(db, p.scope, vector?.vec, p.since, p.until, vecTopK, VECTOR_DIM);
      // F-I01-06: top-level availability report, derived from state the fused
      // recall already computed (no extra embedding or cosine computation):
      // "used" — a query vector was computed and vector candidates actually
      //   participated (vectorHits returned candidates);
      // "disabled" — the optional vectors section is not enabled;
      // "unavailable" — enabled but the query vector or in-scope index produced
      //   no candidates (model/index/query missing or failed): this recall ran
      //   the lexical+graph fallback.
      const vectorState: "used" | "disabled" | "unavailable" =
        vector?.vec && vecHits.length > 0
          ? "used"
          : vectorsEnabled(config)
            ? "unavailable"
            : "disabled";
      const vecRank = new Map<string, number>();
      vecHits.forEach((h, i) => {
        if (!vecRank.has(h.id)) vecRank.set(h.id, i);
      });
      // 3) Exact tag/link seeds + derived topic seeds (same fixed seed weight).
      const seedIds = new Set<string>(tagSeedIds(db, p.scope, p.tags, p.since, p.until));
      for (const id of topicSeedIds(db, p.scope, p.query, ["active"], p.since, p.until)) {
        seedIds.add(id);
      }
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
      // 2d) Canonical substitute ranks (bounded to the ≤FUSION_CANDIDATE_MAX
      // canonical hit ids). A canonical hit whose derived index entry is
      // missing or stale only carries the flat +1 canon bonus and is
      // displaced from small top-k by healthy bigram-overlap competitors.
      // For those, substitute the lexical signal they would have received:
      // FTS-damaged-and-missing-from-lexRank gets the FTS weight, bigram-
      // damaged-and-missing-from-biRank gets the bigram weight, ranked by a
      // cheap deterministic char-bigram overlap between the normalized query
      // and the canonical bodyNorm already in memory (ties: canonical order).
      // Each damage lookup is one bounded query; a lookup failure treats
      // every canonical hit as damaged for that index (fail toward
      // findability) without throwing. Healthy derived entries never reach
      // these maps, so the healthy-index path scores byte-identically.
      const lexSub = new Map<string, number>();
      const biSub = new Map<string, number>();
      if (canonSet.size > 0) {
        const canonIds = canonHits.slice(0, FUSION_CANDIDATE_MAX).map((h) => h.id);
        const bodyNormOf = new Map<string, string>(
          canonHits.slice(0, FUSION_CANDIDATE_MAX).map((h) => [h.id, h.bodyNorm]),
        );
        const ftsHealthy = new Set<string>();
        const biHealthy = new Set<string>();
        try {
          const ph = canonIds.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT recordId, body FROM fts_notes WHERE recordId IN (${ph})`)
            .all(...canonIds) as Array<{ recordId: string; body: string }>;
          for (const r of rows) {
            // fts_notes.body is indexed from records.bodyNorm (see
            // bestEffortIndexNote/rebuildDerivedIndexes): a row whose indexed
            // text no longer equals the canonical bodyNorm is stale damage.
            if (r.body === bodyNormOf.get(r.recordId)) ftsHealthy.add(r.recordId);
          }
        } catch {
          /* lookup failed: every canonical hit is treated as FTS-damaged */
        }
        try {
          const ph = canonIds.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT id, bigram FROM char_bigrams WHERE kind = 'note' AND id IN (${ph})`)
            .all(...canonIds) as Array<{ id: string; bigram: string }>;
          const got = new Map<string, Set<string>>();
          for (const r of rows) {
            let s = got.get(r.id);
            if (!s) {
              s = new Set<string>();
              got.set(r.id, s);
            }
            s.add(r.bigram);
          }
          for (const id of canonIds) {
            const want = new Set(bigramsOf(bodyNormOf.get(id) ?? ""));
            const have = got.get(id);
            if (have !== undefined && have.size === want.size && [...want].every((b) => have.has(b))) {
              biHealthy.add(id);
            }
          }
        } catch {
          /* lookup failed: every canonical hit is treated as bigram-damaged */
        }
        const qBigrams = new Set(bigramsOf(p.query));
        const overlapOf = (id: string): number => {
          const bs = new Set(bigramsOf(bodyNormOf.get(id) ?? ""));
          let n = 0;
          for (const b of qBigrams) {
            if (bs.has(b)) n += 1;
          }
          return n;
        };
        const canonOrder = new Map<string, number>();
        canonHits.forEach((h, i) => {
          if (!canonOrder.has(h.id)) canonOrder.set(h.id, i);
        });
        const damaged = canonIds
          .filter((id) => !ftsHealthy.has(id) || !biHealthy.has(id))
          .sort(
            (a, b) =>
              overlapOf(b) - overlapOf(a) ||
              (canonOrder.get(a) as number) - (canonOrder.get(b) as number) ||
              (a < b ? -1 : a > b ? 1 : 0),
          );
        damaged.forEach((id, i) => {
          if (!ftsHealthy.has(id) && !lexRank.has(id)) lexSub.set(id, i);
          if (!biHealthy.has(id) && !biRank.has(id)) biSub.set(id, i);
        });
      }
      const pool = new Set<string>([...lexRank.keys(), ...biRank.keys(), ...rawSet, ...canonSet, ...vecRank.keys(), ...seedIds]);
      // Pool cap: keep top 60 by lexical+vector pre-order (lex rank, then id).
      let poolIds = [...pool];
      if (poolIds.length > FUSION_CANDIDATE_MAX) {
        const preScore = (id: string): number => {
          const lr = lexRank.has(id) ? 1 / (1 + (lexRank.get(id) as number)) : 0;
          const br = biRank.has(id) ? 0.5 / (1 + (biRank.get(id) as number)) : 0;
          const vr = vecRank.has(id) ? VECTOR_FUSION_WEIGHT / 4 / (1 + (vecRank.get(id) as number)) : 0;
          // Substitute lexical signal for damaged canonical-only hits.
          const ls = lexRank.has(id) || !lexSub.has(id) ? 0 : 1 / (1 + (lexSub.get(id) as number));
          const bs = biRank.has(id) || !biSub.has(id) ? 0 : 0.5 / (1 + (biSub.get(id) as number));
          return lr + ls + br + bs + vr + (rawSet.has(id) ? 2 : 0) + (canonSet.has(id) ? 1 : 0) + (seedIds.has(id) ? 0.25 : 0);
        };
        poolIds.sort((a, b) => preScore(b) - preScore(a) || (a < b ? -1 : a > b ? 1 : 0));
        poolIds = poolIds.slice(0, FUSION_CANDIDATE_MAX);
      }
      // 4) Bounded graph expansion from seeds + top lexical/vector ids.
      const vecTopIds = [...vecRank.keys()].slice(0, 10);
      const frontier0 = [...new Set<string>([...seedIds, ...poolIds.slice(0, 10), ...vecTopIds])].slice(0, 20);
      const graphDist = expandGraph(db, p.scope, frontier0, p.since, p.until);
      // 4b) Derived similar-edge expansion from the same frontier plus the
      // explicit-link neighbours reached above (undirected, weighted by score
      // and below explicit links). Empty table => no change.
      const similarScores = expandSimilarEdges(
        db,
        p.scope,
        [...new Set<string>([...frontier0, ...graphDist.keys()])],
        p.since,
        p.until,
      );

      // Heat lookup for the bounded pool only.
      const heat = new Map<string, number>();
      if (poolIds.length > 0 || graphDist.size > 0 || similarScores.size > 0) {
        const allIds = [...new Set<string>([...poolIds, ...graphDist.keys(), ...similarScores.keys()])];
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
        // Substitute FTS signal for canonical hits missing from lexRank
        // because their fts_notes entry is missing or stale.
        else if (lexSub.has(id)) s += 3 / (1 + (lexSub.get(id) as number));
        if (biRank.has(id)) s += 1.5 / (1 + (biRank.get(id) as number));
        // Substitute bigram signal for canonical hits missing from biRank
        // because their char_bigrams entry is missing or stale.
        else if (biSub.has(id)) s += 1.5 / (1 + (biSub.get(id) as number));
        if (vecRank.has(id)) s += VECTOR_FUSION_WEIGHT / (1 + (vecRank.get(id) as number));
        if (rawSet.has(id)) s += 2;
        if (canonSet.has(id)) s += 1;
        if (seedIds.has(id)) s += 1;
        const d = graphDist.get(id);
        if (d !== undefined && d > 0) s += (GRAPH_DEPTH_MAX + 1 - d) * 0.5;
        const sw = similarScores.get(id);
        if (sw !== undefined) s += sw;
        s += Math.min(heat.get(id) ?? 0, 20) * 0.02;
        return s;
      };

      // Candidate metadata for final ordering (createdAt for tie-break).
      // revision/kind come from the same rows: recall items carry the source
      // record identity (F-I01-01 additions, backward-compatible fields).
      const meta = new Map<string, { createdAt: string; revision: number; kind: string }>();
      const orderIds = [...new Set<string>([...poolIds, ...graphDist.keys(), ...similarScores.keys()])];
      if (orderIds.length > 0) {
        try {
          const placeholders = orderIds.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT id, createdAt, revision, kind FROM records WHERE id IN (${placeholders})`)
            .all(...orderIds) as Array<{ id: string; createdAt: string; revision: number; kind: string }>;
          for (const r of rows) meta.set(r.id, { createdAt: r.createdAt, revision: r.revision, kind: r.kind });
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

      // Bounded projection: snippets only, never raw bodies. Items carry the
      // source record's revision and kind alongside the pinned snippet
      // (backward-compatible additions; existing keys unchanged).
      let items: Array<{
        id: string;
        snippet: string;
        truncated: boolean;
        tags: string[];
        createdAt: string;
        revision: number;
        kind: string;
      }>;
      try {
        items = ranked.map((id) => {
          const m = meta.get(id) as { createdAt: string; revision: number; kind: string };
          const row = db
            .prepare(`SELECT body, createdAt FROM records WHERE id = ?`)
            .get(id) as { body: string; createdAt: string };
          const { snippet, truncated } = snippetFor(row.body, config.limits.snippetMaxCp);
          const tags = (
            db.prepare(`SELECT tag FROM record_tags WHERE recordId = ? ORDER BY tag ASC`).all(id) as Array<{ tag: string }>
          ).map((r) => r.tag);
          return { id, snippet, truncated, tags, createdAt: m.createdAt, revision: m.revision, kind: m.kind };
        });
      } catch {
        throw new Error("read failed");
      }

      const probe: ResponseEnvelope = ok({ recallId, items, vector: vectorState });
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
      // Bounded exposures ledger (prune oldest beyond cap). Prune failure
      // must fail the recall closed so the strict global 1000-row cap is
      // never exceeded: the surrounding transaction rolls back the new
      // exposures + audit together.
      db.prepare(
        `DELETE FROM exposures WHERE rowid NOT IN (SELECT rowid FROM exposures ORDER BY ts DESC, rowid DESC LIMIT ?)`,
      ).run(EXPOSURES_CAP);
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
    // Recovery: validated-feedback reviews lost with the original post-commit
    // enqueue are re-enqueued here (open dedupe keeps this safe). Reachable
    // only with the same exposure-verified ids (requestHash matched).
    for (const id of ids) {
      enqueueCultivationReview(db, config, { recordId: id, scope: nScope, trigger: "feedback", runId: nRunId, now: nowIso() });
    }
    return replaySaved(saved.responseJson, config);
  }
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);
  let committedFeedback: ResponseEnvelope;
  try {
    committedFeedback = withTransaction(db, (): ResponseEnvelope => {
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
    // M3 cultivation reviews for validated ACTUAL use only: this point is
    // reachable solely after exposure verification passed, so every id here
    // is genuinely cited. Best-effort; never affects the committed envelope.
    for (const id of ids) {
      enqueueCultivationReview(db, config, { recordId: id, scope: nScope, trigger: "feedback", runId: nRunId, now });
    }
    return committedFeedback;
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
        for (const id of ids) {
          enqueueCultivationReview(db, config, { recordId: id, scope: nScope, trigger: "feedback", runId: nRunId, now: nowIso() });
        }
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

interface CarriedEpisodeSummaryRow {
  scope: string;
  kind: EpisodeKind;
  episodeKey: string;
  level: EpisodeLevel;
  eventId: string | null;
  spanStart: number | null;
  spanEnd: number | null;
  coveredThrough: string | null;
  foldedRecordIds: string | null;
  verbatim: number;
}

/**
 * Keep the derived episode ledger consistent with a canonical correction.
 * A new revision changes the record id; without carrying rows forward,
 * episode.list would drop an episode summary whose old id was superseded, and
 * a corrected window would look unfolded. Runs inside the correction txn and
 * before any caller `afterInsert` (which uses INSERT OR REPLACE) so the
 * maintainer's fresh ledger data wins for the new id.
 */
function carryForwardEpisodeSummaries(
  db: DatabaseSync,
  oldId: string,
  newId: string,
  now: string,
): void {
  let rows: CarriedEpisodeSummaryRow[];
  try {
    rows = db
      .prepare(
        `SELECT scope, kind, episodeKey, level, eventId, spanStart, spanEnd,
                coveredThrough, foldedRecordIds, verbatim
         FROM episode_summaries WHERE recordId = ?`,
      )
      .all(oldId) as unknown as CarriedEpisodeSummaryRow[];
  } catch {
    return;
  }
  const insert = db.prepare(
    `INSERT OR IGNORE INTO episode_summaries(
       scope, kind, episodeKey, level, recordId, eventId,
       spanStart, spanEnd, coveredThrough, foldedRecordIds, verbatim, createdAt)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const row of rows) {
    insert.run(
      row.scope,
      row.kind,
      row.episodeKey,
      row.level,
      newId,
      row.eventId,
      row.spanStart,
      row.spanEnd,
      row.coveredThrough,
      row.foldedRecordIds,
      row.verbatim,
      now,
    );
  }
  // Episode-level fold markers may still name the old window id. Rewrite them
  // to the new revision so the corrected window stays folded and the episode
  // is not reported stale again.
  let foldedRows: Array<CarriedEpisodeSummaryRow & { recordId: string; createdAt: string }>;
  try {
    foldedRows = db
      .prepare(
        `SELECT scope, kind, episodeKey, level, recordId, eventId, spanStart,
                spanEnd, coveredThrough, foldedRecordIds, verbatim, createdAt
         FROM episode_summaries ep
         WHERE ep.level = 'episode'
           AND EXISTS (
             SELECT 1 FROM json_each(COALESCE(ep.foldedRecordIds, '[]')) j
             WHERE j.value = ?)`,
      )
      .all(oldId) as unknown as typeof foldedRows;
  } catch {
    return;
  }
  for (const row of foldedRows) {
    const ids = parseFoldedRecordIds(row.foldedRecordIds).map((id) =>
      id === oldId ? newId : id,
    );
    insertEpisodeSummary(db, {
      scope: row.scope,
      kind: row.kind,
      episodeKey: row.episodeKey,
      level: row.level,
      recordId: row.recordId,
      eventId: row.eventId,
      spanStart: row.spanStart,
      spanEnd: row.spanEnd,
      coveredThrough: row.coveredThrough,
      foldedRecordIds: [...new Set(ids)],
      verbatim: row.verbatim === 1,
      createdAt: row.createdAt,
    });
  }
}

export function correctRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
  fence?: CanonicalWriteFence,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["recordId", "body", "kind", "provenance", "scope", "links", "sourceRefs", "runId", "privacy"]);
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
  // F-I01-05 optional privacy on corrections: when absent the new revision
  // inherits the superseded record's privacy (including null); when present
  // it overrides. Strict shape either way.
  const nPrivacy = parsePrivacyParam(params["privacy"]);
  if (nPrivacy === "invalid") return budgeted(bad(), config);

  const reqHash = requestHashFor(
    "record.correct",
    nPrivacy === null
      ? // Legacy compatibility: omit the key entirely when absent (pre-PR hash).
        {
          body: body as string,
          kind: "correction",
          links: nLinks,
          observedAt: prov.observedAt,
          recordId,
          runId: nRunId,
          scope: nScope,
          source: prov.source,
          sourceRefs: nRefs,
        }
      : {
          body: body as string,
          kind: "correction",
          links: nLinks,
          observedAt: prov.observedAt,
          privacy: nPrivacy,
          recordId,
          runId: nRunId,
          scope: nScope,
          source: prov.source,
          sourceRefs: nRefs,
        },
  );

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
    const replayId = savedRecordId(saved.responseJson);
    if (replayId) {
      postCommitEnqueueProjections(
        db,
        nScope,
        [replayId, recordId],
        [...outboundRefsOf(db, recordId), ...nLinks],
      );
      // Recovery: re-enqueue the corrected-revision review when the original
      // post-commit enqueue was lost (open dedupe keeps this safe).
      enqueueCultivationReview(db, config, { recordId: replayId, scope: nScope, trigger: "correct", runId: nRunId, now: nowIso() });
    }
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
      assertCanonicalWriteFence(db, fence);
      let target: { scope: string; status: string; revision: number; privacySensitivity: string | null; privacyOrigin: string | null } | undefined;
      try {
        target = db
          .prepare(`SELECT scope, status, revision, privacySensitivity, privacyOrigin FROM records WHERE id = ?`)
          .get(recordId) as { scope: string; status: string; revision: number; privacySensitivity: string | null; privacyOrigin: string | null } | undefined;
      } catch {
        throw new Error("read failed");
      }
      if (!target) throw new Error("missing");
      if (target.scope !== nScope) throw new Error("scope mismatch");
      if (target.status !== "active") throw new Error("not active");
      // F-I01-05: explicit privacy overrides; absence inherits the superseded
      // record's privacy (including null for legacy rows).
      const effPrivacy: PrivacyMetadata | null =
        nPrivacy ?? privacyFromColumns(target.privacySensitivity, target.privacyOrigin);
      verifySourceRefsInTxn(db, nScope, nRefs);
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
        `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt, privacySensitivity, privacyOrigin)
         VALUES (?, ?, ?, ?, 'correction', ?, ?, ?, 'active', ?, ?, ?, ?, ?)`,
      ).run(newId, rawBody, nBody, bodyHashFor(nBody), prov.source, prov.observedAt, nScope, recordId, target.revision + 1, now,
        effPrivacy === null ? null : effPrivacy.sensitivity, effPrivacy === null ? null : effPrivacy.origin);
      for (const l of nLinks) {
        db.prepare(`INSERT INTO record_links(fromId, toRef) VALUES (?, ?)`).run(newId, l);
      }
      insertSourceRefs(db, newId, nRefs);
      db.prepare(`INSERT OR IGNORE INTO note_heat(recordId, usedCount, lastUsedAt) VALUES (?, 0, ?)`).run(newId, now);
      // Carry the derived ledger first; a caller's afterInsert may then
      // replace the new-id row with its fresh fold/coverage data.
      carryForwardEpisodeSummaries(db, recordId, newId, now);
      fence?.afterInsert?.(db, newId);
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
    // M3 cultivation review for the corrected revision (best-effort).
    enqueueCultivationReview(db, config, { recordId: newId, scope: nScope, trigger: "correct", runId: nRunId, now });
    // Derived indexes post-commit, best-effort: failure never rolls back canonical.
    bestEffortIndexNote(db, newId, nBody);
    return committed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "lease lost") return budgeted(fail("CONFLICT"), config);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "missing" || msg === "source lost") {
      // Distinguish missing target (NOT_FOUND) from missing source ref.
      if (msg === "source lost") return budgeted(fail("NOT_FOUND"), config);
      return budgeted(fail("NOT_FOUND"), config);
    }
    if (msg === "scope mismatch" || msg === "source scope") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "source span") return budgeted(bad(), config);
    if (msg === "not active") return budgeted(fail("CONFLICT"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === "record.correct" && again.requestHash === reqHash) {
        const replayId = savedRecordId(again.responseJson);
        if (replayId) {
          postCommitEnqueueProjections(
            db,
            nScope,
            [replayId, recordId],
            [...outboundRefsOf(db, recordId), ...nLinks],
          );
          enqueueCultivationReview(db, config, { recordId: replayId, scope: nScope, trigger: "correct", runId: nRunId, now: nowIso() });
        }
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
  fence?: CanonicalWriteFence,
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
    postCommitEnqueueProjections(db, nScope, [id], outboundRefsOf(db, id));
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
      assertCanonicalWriteFence(db, fence);
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
    if (msg === "lease lost") return budgeted(fail("CONFLICT"), config);
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
        postCommitEnqueueProjections(db, nScope, [id], outboundRefsOf(db, id));
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* ------------------------------------------------------------------ */
/* record.retire / record.reactivate (reversible durable retirement)  */
/* ------------------------------------------------------------------ */

/**
 * Shared reversible-transition core: active<->retired only. Already-there is
 * an idempotent OK no-op (operations + audit still commit so replays are
 * stable); superseded/archived are never moved here (CONFLICT). Rows are
 * always kept; heat/usage untouched; projection re-queued post-commit.
 */
function transitionRetirement(
  db: DatabaseSync,
  config: AppConfig,
  op: "record.retire" | "record.reactivate",
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride: string | undefined,
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
  const codes = op === "record.retire" ? RETIRE_REASONS : REACTIVATE_REASONS;
  if (typeof reasonCode !== "string" || !(codes as readonly string[]).includes(reasonCode)) {
    return budgeted(bad(), config);
  }
  const from = op === "record.retire" ? "active" : "retired";
  const to = op === "record.retire" ? "retired" : "active";

  const reqHash = sha256HexUtf8(
    canonicalStringify({ op, id, scope: nScope, reasonCode }),
  );

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== op) return budgeted(fail("CONFLICT"), config);
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(fail("CONFLICT"), config);
    postCommitEnqueueProjections(db, nScope, [id], outboundRefsOf(db, id));
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
      if (target.status !== from && target.status !== to) throw new Error("not reversible");
      const probe: ResponseEnvelope = ok({ record: { id, status: to } });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      if (target.status === from) {
        let moved: unknown;
        try {
          moved = db
            .prepare(`UPDATE records SET status=? WHERE id=? AND status=? AND scope=?`)
            .run(to, id, from, nScope);
        } catch {
          throw new Error("db over cap");
        }
        if (changedRows(moved) !== 1) throw new Error("not reversible");
      }
      // target.status === to: idempotent no-op, still ledgers below.
      const stored = budgeted(probe, config);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
      ).run(idempotencyKey, op, reqHash, JSON.stringify(stored), now);
      auditInsert(db, {
        ts: now,
        op,
        targetId: id as string,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: null,
        runId: null,
        recallId: null,
        reasonCode: reasonCode as string,
      });
      assertDbUnderCap(db, config);
      return stored;
    });
    postCommitEnqueueProjections(db, nScope, [id as string], outboundRefsOf(db, id as string));
    return committed;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "db over cap") return budgeted(fail("STORE_UNAVAILABLE"), config);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    if (msg === "missing") return budgeted(fail("NOT_FOUND"), config);
    if (msg === "scope mismatch") return budgeted(fail("FORBIDDEN_SCOPE"), config);
    if (msg === "not reversible") return budgeted(fail("CONFLICT"), config);
    if (/UNIQUE constraint failed: operations/.test(msg)) {
      let again: StoredOp | null = null;
      try {
        again = readOperation(db, idempotencyKey);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (again && again.op === op && again.requestHash === reqHash) {
        postCommitEnqueueProjections(db, nScope, [id], outboundRefsOf(db, id));
        return replaySaved(again.responseJson, config);
      }
      return budgeted(fail("CONFLICT"), config);
    }
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

export function retireRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  return transitionRetirement(db, config, "record.retire", params, idempotencyKey, nowOverride);
}

export function reactivateRecord(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  return transitionRetirement(db, config, "record.reactivate", params, idempotencyKey, nowOverride);
}

/* ------------------------------------------------------------------ */
/* record.search (explicit active+retired, no heat/reactivation)        */
/* ------------------------------------------------------------------ */

/**
 * Explicit user-directed search over active+retired (archived/superseded
 * excluded). Lexical (FTS5/BM25 + char-bigram + canonical fallback) + raw
 * descent (active+retired same-scope targets) + exact tag/link seeds;
 * deterministic fusion (score DESC, createdAt DESC, id ASC). Audit-only: NO
 * exposures row (so feedback/searchId can never heat), NO heat change, NO
 * status change — one explicit retrieval never reactivates.
 */
export function searchRecords(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["query", "tags", "link", "since", "until", "limit", "scope", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const { query, tags, link, since, until, limit, scope, runId } = params;
  if (typeof query !== "string") return budgeted(bad(), config);
  if (countCp(query) > config.limits.queryMaxCp) return budgeted(limitExceeded(), config);
  const nq = normalizeBody(query);
  if (countCp(nq) < 1) return budgeted(bad(), config);
  if (countCp(nq) > config.limits.queryMaxCp) return budgeted(limitExceeded(), config);
  const nTags = parseTags(tags, config.limits.tagsMax);
  if (nTags === "bad") return budgeted(bad(), config);
  if (nTags === "over") return budgeted(limitExceeded(), config);
  let nLink: string | null = null;
  if (link !== undefined && link !== null) {
    if (typeof link !== "string") return budgeted(bad(), config);
    const ll = checkLenCp(link, 1, 256);
    if (ll === "long") return budgeted(limitExceeded(), config);
    if (ll === "short" || hasControl(link)) return budgeted(bad(), config);
    const nl = normalizeField(link, false);
    if (countCp(nl) < 1 || countCp(nl) > 256) return budgeted(bad(), config);
    nLink = nl;
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
  let nLimit = config.limits.limitDefault;
  if (limit !== undefined) {
    if (typeof limit !== "number" || !Number.isInteger(limit)) return budgeted(bad(), config);
    if (limit < 1) return budgeted(bad(), config);
    if (limit > config.limits.limitMax) return budgeted(limitExceeded(), config);
    nLimit = limit;
  }
  const nScope = parseScope(scope);
  if (!nScope) return budgeted(bad(), config);
  const nRunId = parseRunId(runId);
  if (nRunId === "invalid") return budgeted(bad(), config);
  {
    const denied = scopeGate(db, config, nScope);
    if (denied) return denied;
  }

  const now = nowOverride ?? nowIso();
  const searchId = genId("search");
  const windowArgs = (alias: string): { frag: string; args: Array<string | number> } => {
    let frag = "";
    const args: Array<string | number> = [];
    if (nSince !== null) {
      frag += ` AND ${alias}.createdAt >= ?`;
      args.push(nSince);
    }
    if (nUntil !== null) {
      frag += ` AND ${alias}.createdAt < ?`;
      args.push(nUntil);
    }
    return { frag, args };
  };

  try {
    return withTransaction(db, (): ResponseEnvelope => {
      const lexRank = new Map<string, number>();
      const terms = nq.split(" ").map((t) => t.trim()).filter((t) => t.length > 0).slice(0, 8);
      if (terms.length > 0) {
        const match = terms.map((t) => `"${ftsEscapeTerm(t)}"*`).join(" OR ");
        try {
          const w = windowArgs("records");
          const rows = db
            .prepare(
              `SELECT f.recordId AS id, bm25(fts_notes) AS r FROM fts_notes f
               JOIN records ON records.id = f.recordId
               WHERE f.body MATCH ? AND records.scope = ? AND records.status IN ('active','retired')${w.frag}
               ORDER BY r ASC, records.createdAt DESC, f.recordId ASC LIMIT ?`,
            )
            .all(match, nScope, ...w.args, FUSION_CANDIDATE_MAX) as Array<{ id: string; r: number }>;
          rows.forEach((h, i) => {
            if (!lexRank.has(h.id)) lexRank.set(h.id, i);
          });
        } catch {
          /* bigram/canonical paths cover */
        }
      }
      const biRank = new Map<string, number>();
      {
        const bigrams = bigramsOf(nq);
        try {
          if (bigrams.length === 0) {
            const w = windowArgs("records");
            const rows = db
              .prepare(
                `SELECT id FROM records WHERE scope = ? AND status IN ('active','retired') AND instr(bodyNorm, ?) > 0${w.frag}
                 ORDER BY createdAt DESC, id ASC LIMIT ?`,
              )
              .all(nScope, nq, ...w.args, FUSION_CANDIDATE_MAX) as Array<{ id: string }>;
            rows.forEach((h, i) => {
              if (!biRank.has(h.id)) biRank.set(h.id, i);
            });
          } else {
            const placeholders = bigrams.map(() => "?").join(",");
            const w = windowArgs("records");
            const rows = db
              .prepare(
                `SELECT b.id AS id, COUNT(*) AS overlap FROM char_bigrams b
                 JOIN records ON records.id = b.id
                 WHERE b.kind = 'note' AND b.bigram IN (${placeholders}) AND records.scope = ? AND records.status IN ('active','retired')${w.frag}
                 GROUP BY b.id ORDER BY overlap DESC, records.createdAt DESC, b.id ASC LIMIT ?`,
              )
              .all(...[...bigrams, nScope, ...w.args, FUSION_CANDIDATE_MAX]) as Array<{ id: string }>;
            rows.forEach((h, i) => {
              if (!biRank.has(h.id)) biRank.set(h.id, i);
            });
          }
        } catch {
          /* canonical fallback covers */
        }
      }
      // Canonical bodyNorm fallback (active+retired): committed memory stays
      // findable for multi-token queries when derived lexical indexes (FTS +
      // bigrams) are absent or stale. Whole-query instr first, then per-term
      // OR — the same shape as recall's canonicalBodyNormHits. Merged
      // UNCONDITIONALLY (like record.recall): when only a subset of derived
      // rows is lost, the surviving derived hits are nonempty and a gated
      // fallback would skip the exact canonical match in the unindexed row.
      const canonRank = new Map<string, number>();
      {
        try {
          const w = windowArgs("records");
          const whole = db
            .prepare(
              `SELECT id FROM records WHERE scope = ? AND status IN ('active','retired') AND instr(bodyNorm, ?) > 0${w.frag}
               ORDER BY createdAt DESC, id ASC LIMIT ?`,
            )
            .all(nScope, nq, ...w.args, FUSION_CANDIDATE_MAX) as Array<{ id: string }>;
          whole.forEach((h, i) => {
            if (!canonRank.has(h.id)) canonRank.set(h.id, i);
          });
          if (whole.length === 0 && terms.length > 1) {
            const conds = terms.map(() => `instr(bodyNorm, ?) > 0`).join(" OR ");
            const w2 = windowArgs("records");
            const perTerm = db
              .prepare(
                `SELECT id FROM records WHERE scope = ? AND status IN ('active','retired') AND (${conds})${w2.frag}
                 ORDER BY createdAt DESC, id ASC LIMIT ?`,
              )
              .all(nScope, ...terms, ...w2.args, FUSION_CANDIDATE_MAX) as Array<{ id: string }>;
            perTerm.forEach((h, i) => {
              if (!canonRank.has(h.id)) canonRank.set(h.id, i);
            });
          }
        } catch {
          /* lexical paths already cover */
        }
      }
      // Raw descent mapped to active+retired same-scope records.
      const rawSet = new Set<string>();
      try {
        let eventIds: string[] = [];
        if (terms.length > 0) {
          const match = terms.map((t) => `"${ftsEscapeTerm(t)}"*`).join(" OR ");
          try {
            const rows = db
              .prepare(
                `SELECT f.eventId AS eventId FROM fts_raw f
                 JOIN raw_events ON raw_events.eventId = f.eventId
                 WHERE f.body MATCH ? AND raw_events.scope = ?
                 ORDER BY bm25(fts_raw) ASC, raw_events.createdAt DESC, f.eventId ASC LIMIT ?`,
              )
              .all(match, nScope, RAW_DESCENT_MAX) as Array<{ eventId: string }>;
            eventIds = rows.map((r) => r.eventId);
          } catch {
            eventIds = [];
          }
        }
        if (eventIds.length === 0) {
          try {
            const rows = db
              .prepare(
                `SELECT eventId FROM raw_events WHERE scope = ? AND instr(bodyNorm, ?) > 0
                 ORDER BY createdAt DESC, eventId ASC LIMIT ?`,
              )
              .all(nScope, nq, RAW_DESCENT_MAX) as Array<{ eventId: string }>;
            eventIds = rows.map((r) => r.eventId);
          } catch {
            eventIds = [];
          }
        }
        if (eventIds.length > 0) {
          const placeholders = eventIds.map(() => "?").join(",");
          const w = windowArgs("records");
          const rows = db
            .prepare(
              `SELECT DISTINCT s.recordId AS id FROM record_source_refs s
               JOIN records ON records.id = s.recordId
               WHERE s.eventId IN (${placeholders}) AND records.scope = ? AND records.status IN ('active','retired')${w.frag}`,
            )
            .all(...[...eventIds, nScope, ...w.args]) as Array<{ id: string }>;
          for (const r of rows) rawSet.add(r.id);
        }
      } catch {
        /* lexical paths already cover */
      }
      // Exact tag/link seeds + derived topic seeds (active+retired, windowed).
      const seedIds = new Set<string>();
      if (nTags.length > 0) {
        try {
          let sql = `SELECT records.id AS id FROM records WHERE scope = ? AND status IN ('active','retired')`;
          const args: Array<string | number> = [nScope];
          const w = windowArgs("records");
          sql += w.frag;
          args.push(...w.args);
          for (const t of nTags) {
            sql += ` AND EXISTS (SELECT 1 FROM record_tags WHERE recordId = records.id AND tag = ?)`;
            args.push(t);
          }
          sql += ` ORDER BY createdAt DESC, id ASC LIMIT ?`;
          args.push(FUSION_CANDIDATE_MAX);
          for (const r of db.prepare(sql).all(...args) as Array<{ id: string }>) seedIds.add(r.id);
        } catch {
          /* ignore */
        }
      }
      if (nLink !== null) {
        try {
          const w = windowArgs("records");
          const target = db
            .prepare(
              `SELECT id FROM records WHERE id = ? AND scope = ? AND status IN ('active','retired')${w.frag}`,
            )
            .get(nLink, nScope, ...w.args) as { id: string } | undefined;
          if (target) seedIds.add(target.id);
        } catch {
          /* ignore */
        }
      }
      for (const id of topicSeedIds(db, nScope, nq, ["active", "retired"], nSince, nUntil)) {
        seedIds.add(id);
      }

      const score = (id: string): number => {
        let s = 0;
        if (lexRank.has(id)) s += 3 / (1 + (lexRank.get(id) as number));
        if (biRank.has(id)) s += 1.5 / (1 + (biRank.get(id) as number));
        if (canonRank.has(id)) s += 1.5 / (1 + (canonRank.get(id) as number));
        if (rawSet.has(id)) s += 2;
        if (seedIds.has(id)) s += 1;
        return s;
      };
      const pool = [...new Set<string>([...lexRank.keys(), ...biRank.keys(), ...canonRank.keys(), ...rawSet, ...seedIds])];
      const meta = new Map<string, { createdAt: string; status: string }>();
      if (pool.length > 0) {
        try {
          const placeholders = pool.map(() => "?").join(",");
          const rows = db
            .prepare(`SELECT id, createdAt, status FROM records WHERE id IN (${placeholders})`)
            .all(...pool) as Array<{ id: string; createdAt: string; status: string }>;
          for (const r of rows) meta.set(r.id, { createdAt: r.createdAt, status: r.status });
        } catch {
          throw new Error("read failed");
        }
      }
      const ranked = pool
        .filter((id) => meta.has(id))
        .sort((a, b) => {
          const sa = score(a);
          const sb = score(b);
          if (sa !== sb) return sb - sa;
          const ca = (meta.get(a) as { createdAt: string }).createdAt;
          const cb = (meta.get(b) as { createdAt: string }).createdAt;
          if (ca !== cb) return ca < cb ? 1 : -1;
          return a < b ? -1 : a > b ? 1 : 0;
        })
        .slice(0, nLimit);

      let items: Array<{
        id: string;
        snippet: string;
        truncated: boolean;
        tags: string[];
        status: string;
        revision: number;
        createdAt: string;
        privacy: PrivacyMetadata | null;
      }>;
      try {
        items = ranked.map((id) => {
          const row = db
            .prepare(`SELECT body, createdAt, status, revision, privacySensitivity, privacyOrigin FROM records WHERE id = ?`)
            .get(id) as { body: string; createdAt: string; status: string; revision: number; privacySensitivity: string | null; privacyOrigin: string | null };
          const { snippet, truncated } = snippetFor(row.body, config.limits.snippetMaxCp);
          const tags = (
            db.prepare(`SELECT tag FROM record_tags WHERE recordId = ? ORDER BY tag ASC`).all(id) as Array<{ tag: string }>
          ).map((r) => r.tag);
          return {
            id,
            snippet,
            truncated,
            tags,
            status: row.status,
            revision: row.revision,
            createdAt: row.createdAt,
            privacy: privacyFromColumns(row.privacySensitivity, row.privacyOrigin),
          };
        });
      } catch {
        throw new Error("read failed");
      }

      const probe: ResponseEnvelope = ok({ searchId, items });
      if (!successFits(probe, config.limits.responseMaxBytes)) throw new Error("response over budget");
      const stored = budgeted(probe, config);
      if (!stored.ok) throw new Error("response over budget");
      // Audit-only: deliberately NO exposures insert (feedback can never heat
      // from a searchId) and NO heat/reactivation side effects.
      auditInsert(db, {
        ts: now,
        op: "record.search",
        targetId: searchId,
        code: stored.code,
        scope: nScope,
        bytes: Buffer.byteLength(JSON.stringify(stored), "utf8"),
        limitN: nLimit,
        runId: nRunId,
        recallId: searchId,
        reasonCode: null,
      });
      return stored;
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg === "response over budget") return budgeted(fail("LIMIT_EXCEEDED"), config);
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

/* Re-exported for tests/smoke: id format check. */
export function qAll<T>(db: DatabaseSync, sql: string, args: Array<string | number>): T[] {
  return db.prepare(sql).all(...(args as [])) as T[];
}
