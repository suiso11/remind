import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { resolveDbPath } from "./config.js";
import {
  LEGACY_M1_USER_VERSION,
  LEGACY_SCHEMA_VERSION_3,
  LEGACY_SCHEMA_VERSION_4,
  LEGACY_SCHEMA_VERSION_5,
  LEGACY_SCHEMA_VERSION_6,
  LEGACY_SCHEMA_VERSION_7,
  LEGACY_SCHEMA_VERSION_8,
  LEGACY_SCHEMA_VERSION_9,
  LEGACY_SCHEMA_VERSION_10,
  LEGACY_SCHEMA_VERSION_11,
  LEGACY_SCHEMA_VERSION_12,
  SCHEMA_VERSION,
  ensureM1Schema,
  hasLegacyApprovalSchema,
} from "./store.js";

export { SCHEMA_VERSION } from "./store.js";

/** Canonical schema version. Fresh and upgraded DBs carry exactly this value. */
export const M1_USER_VERSION = SCHEMA_VERSION;

/**
 * Fixed safe startup error for legacy approval-schema databases. Emitted on
 * stderr with a non-zero exit; the old file is never mutated or deleted.
 * Operator action: back up the old file, then point dbPath at a new file.
 */
export const LEGACY_DB_MESSAGE =
  "legacy approval schema detected: back up existing data and configure a new DB file";

export function isLegacyDbError(e: unknown): boolean {
  return e instanceof Error && e.message === LEGACY_DB_MESSAGE;
}

export function applyEffectiveBusyTimeout(
  db: DatabaseSync,
  busyMs: number,
  remainingMs: number,
): number {
  const eff =
    !Number.isFinite(remainingMs) || remainingMs <= 0
      ? 0
      : Math.max(0, Math.min(Math.floor(busyMs), Math.floor(remainingMs)));
  db.exec(`PRAGMA busy_timeout = ${eff}`);
  return eff;
}

function readUserVersion(db: DatabaseSync): number {
  const row = db
    .prepare(`PRAGMA user_version`)
    .get() as { user_version: number } | undefined;
  return row?.user_version ?? 0;
}

/**
 * M1 SQLite foundation: open/create the DB file, set busy_timeout from
 * startup config, seed allowed scopes additively (never delete rows),
 * create the current additive schema, stamp PRAGMA user_version=SCHEMA_VERSION.
 *
 * Legacy approval-schema databases (candidates table, candidateId records,
 * or any unexpected user_version) FAIL STARTUP with the fixed legacy error
 * and are NOT mutated: no DDL, no deletes, no silent migration. The caller
 * maps this to a fixed stderr line + non-zero exit.
 */
export function initDb(
  config: AppConfig,
  configPath: string,
  busyMsOverride?: number,
): { db: DatabaseSync; dbFile: string } {
  const dbFile = resolveDbPath(configPath, config.dbPath);
  const dir = path.dirname(dbFile);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`cannot create db directory: ${String(e)}`);
  }

  // Over-cap DBs still open for reads: no startup refusal based solely on
  // configured dbMaxBytes. Write paths enforce the cap per-operation.

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbFile);
  } catch (e) {
    throw new Error(
      `cannot open db: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    const busy =
      typeof busyMsOverride === "number" && Number.isFinite(busyMsOverride)
        ? Math.max(0, Math.floor(busyMsOverride))
        : config.timeouts.busyMs;
    // busy_timeout is per-connection (not persisted); set it before the
    // legacy checks. journal_mode=WAL persists (header + sidecars), so it
    // must stay after user_version/legacy approval-schema approval.
    db.exec(`PRAGMA busy_timeout = ${busy};`);

    const uv = readUserVersion(db);
    // 0 = fresh; 2 = original M1 stamp; 3 = pre-topic-origin; 4 = pre-derived
    // association tables; 5 = pre-whole-scope edge fingerprint; 6 = pre-record-
    // importance; 7 = pre-consolidation-cluster-ledger (record_importance,
    // i.e. PR #32's activation v7, already present); 8 = pre-consolidate-
    // rotation-cursor, 9 = pre-nature-ledger, 10 = pre-retention-learning,
    // 11 = pre-model-qualified-source, 12 = pre-evidence-quote (6-12 are
    // upgraded in place); SCHEMA_VERSION = already current. Anything else is
    // an unrelated/legacy file.
    if (
      uv !== 0 &&
      uv !== LEGACY_M1_USER_VERSION &&
      uv !== LEGACY_SCHEMA_VERSION_3 &&
      uv !== LEGACY_SCHEMA_VERSION_4 &&
      uv !== LEGACY_SCHEMA_VERSION_5 &&
      uv !== LEGACY_SCHEMA_VERSION_6 &&
      uv !== LEGACY_SCHEMA_VERSION_7 &&
      uv !== LEGACY_SCHEMA_VERSION_8 &&
      uv !== LEGACY_SCHEMA_VERSION_9 &&
      uv !== LEGACY_SCHEMA_VERSION_10 &&
      uv !== LEGACY_SCHEMA_VERSION_11 &&
      uv !== LEGACY_SCHEMA_VERSION_12 &&
      uv !== SCHEMA_VERSION
    ) {
      throw new Error(LEGACY_DB_MESSAGE);
    }
    // Any trace of the old candidate/approval architecture is legacy,
    // including a version-0 file that already holds old tables (e.g. a
    // pre-M1 database whose user_version was never stamped).
    if (hasLegacyApprovalSchema(db)) {
      throw new Error(LEGACY_DB_MESSAGE);
    }
    if (uv === 0) {
      // A version-0 file that already holds M1-shaped tables without the
      // stamp is unexpected: refuse rather than guess (no silent adoption).
      const names = db
        .prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string }>;
      const nonScope = names.filter((r) => r.name !== "scopes");
      if (nonScope.length > 0) {
        throw new Error(LEGACY_DB_MESSAGE);
      }
    }

    // Persistent WAL mode only after the file is approved as M1-compatible,
    // so rejected legacy files are never mutated by startup.
    db.exec(`PRAGMA journal_mode = WAL;`);
    const seedScopes = (ensureTable: boolean): void => {
      if (ensureTable) {
        db.exec(`CREATE TABLE IF NOT EXISTS scopes(scope TEXT PRIMARY KEY)`);
      }
      // Read first so the already-current fast path performs no write at all
      // when the configured scopes are already present.
      const existing = new Set(
        (db.prepare(`SELECT scope FROM scopes`).all() as Array<{ scope: string }>).map(
          (r) => r.scope,
        ),
      );
      const ins = db.prepare(`INSERT OR IGNORE INTO scopes(scope) VALUES (?)`);
      for (const s of config.allowedScopes) {
        if (!existing.has(s)) ins.run(s);
      }
    };
    const initialize = (): void => {
      seedScopes(true);
      // M1 canonical + derived tables. Additive only; never drops rows.
      // ensureM1Schema composes with our outer transaction via savepoints.
      ensureM1Schema(db);
    };
    if (uv === SCHEMA_VERSION) {
      // Fast path: the schema is already current, so skip the write lock,
      // every DDL statement, and every PRAGMA table_info inspection (scope
      // seeding is read-only when the configured scopes already exist). The
      // derived association tables are created by the versioned migration.
      seedScopes(false);
    } else {
      // ONE write lock spans every inspection, ALTER/TABLE rebuild, index
      // creation and the version stamp. A concurrent opener waits on
      // busy_timeout instead of racing its stale table_info snapshot.
      db.exec("BEGIN IMMEDIATE");
      try {
        // Re-check under the lock: another opener may have finished the
        // upgrade while this connection was waiting.
        if (readUserVersion(db) === SCHEMA_VERSION) {
          seedScopes(false);
        } else {
          initialize();
          db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
        }
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
    }
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    if (isLegacyDbError(e)) throw e;
    throw new Error(
      `db init failed: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  return { db, dbFile };
}

/** Read the seeded scope list (startup config AND DB rows are both consulted). */
export function listScopes(db: DatabaseSync): string[] {
  const rows = db
    .prepare(`SELECT scope FROM scopes ORDER BY scope ASC`)
    .all() as Array<{ scope: string }>;
  return rows.map((r) => r.scope);
}
