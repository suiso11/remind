import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { resolveDbPath } from "./config.js";

/**
 * T1 SQLite foundation: open/create the DB file, set busy_timeout from
 * startup config, create the `scopes` table, seed allowed scopes
 * additively (never delete existing rows). Later tasks (T2-T4) add
 * the remaining tables in this same module.
 */
export function initDb(
  config: AppConfig,
  configPath: string,
): { db: DatabaseSync; dbFile: string } {
  const dbFile = resolveDbPath(configPath, config.dbPath);
  const dir = path.dirname(dbFile);
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch (e) {
    throw new Error(`cannot create db directory: ${String(e)}`);
  }

  // Fail closed when the DB file already exceeds the configured max.
  try {
    const st = fs.statSync(dbFile);
    if (st.size > config.dbMaxBytes) {
      throw new Error("db file exceeds dbMaxBytes");
    }
  } catch (e) {
    if (e instanceof Error && e.message === "db file exceeds dbMaxBytes") {
      throw e;
    }
    // Missing file is fine (will be created on open).
  }

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbFile);
  } catch (e) {
    throw new Error(
      `cannot open db: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  try {
    db.exec(
      `PRAGMA journal_mode = WAL; PRAGMA busy_timeout = ${config.timeouts.busyMs};`,
    );
    db.exec(`CREATE TABLE IF NOT EXISTS scopes(scope TEXT PRIMARY KEY)`);
    const ins = db.prepare(
      `INSERT OR IGNORE INTO scopes(scope) VALUES (?)`,
    );
    for (const s of config.allowedScopes) {
      ins.run(s);
    }
  } catch (e) {
    try {
      db.close();
    } catch {
      /* ignore */
    }
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
