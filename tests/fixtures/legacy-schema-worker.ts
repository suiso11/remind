/**
 * Legacy record_source_refs migration contender (test-only fixture).
 *
 * Opens its own DatabaseSync on the shared legacy file with the configured
 * busy timeout, signals ready, then calls the REAL ensureM1Schema. It never
 * fakes schema rows or migration results: the returned columns, rows, and
 * index name are read back from SQLite after the call.
 *
 * workerData: { dbPath: string; busyMs: number }
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import { ensureM1Schema } from "../../src/store.js";

interface LegacySchemaRequest {
  dbPath: string;
  busyMs: number;
}

interface LegacySchemaResult {
  ok: boolean;
  error?: string;
  elapsedMs: number;
  cols: string[];
  rows: Array<{
    recordId: string;
    eventId: string;
    spanStart: number | null;
    spanEnd: number | null;
  }>;
  index: string | null;
}

const req = workerData as LegacySchemaRequest;
const started = Date.now();
const db = new DatabaseSync(req.dbPath);
let result: LegacySchemaResult;
try {
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(req.busyMs))}`);
  parentPort?.postMessage({ type: "ready" });
  ensureM1Schema(db);
  const cols = (
    db.prepare(`PRAGMA table_info(record_source_refs)`).all() as Array<{ name: string }>
  ).map((c) => c.name);
  const rows = db
    .prepare(
      `SELECT recordId, eventId, spanStart, spanEnd
       FROM record_source_refs
       ORDER BY recordId ASC, eventId ASC, spanStart ASC`,
    )
    .all() as unknown as LegacySchemaResult["rows"];
  const index = db
    .prepare(`SELECT name FROM sqlite_master WHERE type='index' AND name='idx_source_refs_unique'`)
    .get() as { name: string } | undefined;
  result = {
    ok: true,
    elapsedMs: Date.now() - started,
    cols,
    rows,
    index: index?.name ?? null,
  };
} catch (e) {
  result = {
    ok: false,
    error: e instanceof Error ? e.message : String(e),
    elapsedMs: Date.now() - started,
    cols: [],
    rows: [],
    index: null,
  };
} finally {
  db.close();
}
parentPort?.postMessage({ type: "result", result });
