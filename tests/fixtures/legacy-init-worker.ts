/**
 * Concurrent initDb contender (test-only fixture).
 *
 * Opens the shared legacy DB through the REAL initDb path with the configured
 * busy timeout, then reports the committed schema version. Used to prove that
 * schema initialization serializes: a second opener waits on the first's write
 * lock and completes after it instead of racing a stale table_info snapshot
 * into a "duplicate column" failure.
 *
 * workerData: { dbPath: string; configPath: string; config: AppConfig; busyMs: number }
 */
import { parentPort, workerData } from "node:worker_threads";
import type { AppConfig } from "../../src/config.js";
import { initDb } from "../../src/db.js";

interface LegacyInitRequest {
  dbPath: string;
  configPath: string;
  config: AppConfig;
  busyMs: number;
}

const req = workerData as LegacyInitRequest;
try {
  parentPort?.postMessage({ type: "ready" });
  const opened = initDb(req.config, req.configPath, req.busyMs);
  let userVersion = 0;
  try {
    userVersion = (
      opened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }
    ).user_version;
  } finally {
    opened.db.close();
  }
  parentPort?.postMessage({ type: "result", result: { ok: true, userVersion } });
} catch (e) {
  parentPort?.postMessage({
    type: "result",
    result: { ok: false, error: e instanceof Error ? e.message : String(e) },
  });
}
