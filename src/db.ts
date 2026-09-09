import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { resolveDbPath } from "./config.js";
import { ensureM1Schema, hasLegacyApprovalSchema } from "./store.js";

/** Canonical M1 schema version. Fresh and compatible DBs carry exactly 2. */
export const M1_USER_VERSION = 2;

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
 * create the M1 v2 schema, stamp PRAGMA user_version=2.
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
    if (uv !== 0 && uv !== M1_USER_VERSION) {
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
    db.exec(`CREATE TABLE IF NOT EXISTS scopes(scope TEXT PRIMARY KEY)`);
    const ins = db.prepare(`INSERT OR IGNORE INTO scopes(scope) VALUES (?)`);
    for (const s of config.allowedScopes) {
      ins.run(s);
    }
    // M1 canonical + derived tables. Additive only; never drops rows.
    ensureM1Schema(db);
    db.exec(`PRAGMA user_version = ${M1_USER_VERSION}`);
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
