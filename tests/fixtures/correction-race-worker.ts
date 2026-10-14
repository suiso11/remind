/**
 * Shared-file concurrent correction race contender (test-only fixture).
 *
 * Unified for both sequential-race (type: ready/result) and hardened
 * shared-file race (ready:true + begin/commit/rollback) consumers.
 * Each worker owns an ACTUAL new DatabaseSync on the same shared file with
 * its own PRAGMA busy_timeout, verifies the real main filename via
 * `PRAGMA database_list` plus the live target status, posts ready with its
 * positive worker threadId, then waits on the parent start gate before
 * calling the REAL correctRecord. It never fakes store/worker/response data
 * and never returns synthetic SQLite results.
 *
 * Native authorizer semantics: ALWAYS SQLITE_OK (pass-through). On
 * SQLITE_TRANSACTION BEGIN it increments the BEGIN counter and the shared
 * arrival slot, then spins (no sleeps) until BOTH contenders have arrived
 * BEFORE the native BEGIN executes -- forcing a genuine same-file race.
 * COMMIT/ROLLBACK only increment counters. A ten-second watchdog bounds
 * every Atomics loop so a stuck rendezvous fails loudly instead of hanging.
 *
 * workerData: { config, params, idempotencyKey, barrier } where barrier is a
 * SharedArrayBuffer of 2 Int32: index 0 = parent start gate, index 1 = BEGIN
 * arrivals. The worker posts a dual-shape ready
 * { type:"ready", ready:true, threadId, dbFile, targetStatus, status }, then
 * on release posts the actual dual-shape result
 * { type:"result", res, transactions:{begin,commit,rollback},
 *   begin, commit, rollback, inTransaction, isTransaction, threadId },
 * closes its db, and closes its port so the parent observes a successful
 * worker exit before resolving the result.
 */
import { parentPort, threadId, workerData } from "node:worker_threads";
import { DatabaseSync, constants } from "node:sqlite";
import { correctRecord } from "../../src/store.js";
import type { AppConfig } from "../../src/config.js";
import type { ResponseEnvelope } from "../../src/protocol.js";

export interface CorrectionRaceRequest {
  config: AppConfig;
  params: Record<string, unknown>;
  idempotencyKey: string;
  barrier: SharedArrayBuffer;
}

export interface CorrectionRaceReady {
  type: "ready";
  ready: true;
  threadId: number;
  dbFile: string;
  targetStatus: string;
  status: string | null;
}

export interface CorrectionRaceResult {
  type: "result";
  res: ResponseEnvelope;
  transactions: { begin: number; commit: number; rollback: number };
  begin: number;
  commit: number;
  rollback: number;
  inTransaction: boolean;
  isTransaction: unknown;
  threadId: number;
}

const RENDEZVOUS_MS = 10000;

function spinUntil(barr: Int32Array, index: 0 | 1, want: number, what: string): void {
  const t0 = Date.now();
  while (Atomics.load(barr, index) !== want) {
    if (Date.now() - t0 > RENDEZVOUS_MS) {
      throw new Error(`correction-race fixture timeout waiting for ${what}`);
    }
  }
}

function main(): void {
  const req = workerData as CorrectionRaceRequest;
  const barr = new Int32Array(req.barrier);
  const db = new DatabaseSync(req.config.dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = 10000`);
    const recordId = req.params["recordId"];
    if (typeof recordId !== "string" || recordId.length === 0) {
      throw new Error("correction-race fixture: params.recordId must be a non-empty string");
    }
    let begin = 0;
    let commit = 0;
    let rollback = 0;
    db.setAuthorizer((action: number, arg1: unknown) => {
      // Verified against clean source + runtime: for SQLITE_TRANSACTION the
      // operation word ("BEGIN"/"COMMIT"/"ROLLBACK") arrives in arg1.
      if (action === constants.SQLITE_TRANSACTION && typeof arg1 === "string") {
        if (arg1 === "BEGIN") {
          begin += 1;
          Atomics.add(barr, 1, 1);
          Atomics.notify(barr, 1);
          spinUntil(barr, 1, 2, "BEGIN rendezvous");
        } else if (arg1 === "COMMIT") {
          commit += 1;
        } else if (arg1 === "ROLLBACK") {
          rollback += 1;
        }
      }
      return constants.SQLITE_OK;
    });
    const dblist = db.prepare(`PRAGMA database_list`).all() as Array<{ name: string; file: string }>;
    const mainFile = dblist.find((r) => r.name === "main")?.file ?? "";
    const target = db.prepare(`SELECT status FROM records WHERE id = ?`).get(recordId) as
      | { status: string }
      | undefined;
    const status = target?.status ?? null;
    parentPort?.postMessage({
      type: "ready",
      ready: true,
      threadId,
      dbFile: mainFile,
      targetStatus: status ?? "",
      status,
    } satisfies CorrectionRaceReady);
    spinUntil(barr, 0, 1, "parent start gate");
    const res = correctRecord(db, req.config, req.params, req.idempotencyKey);
    const isTransaction: unknown = (db as DatabaseSync).isTransaction;
    parentPort?.postMessage({
      type: "result",
      res,
      transactions: { begin, commit, rollback },
      begin,
      commit,
      rollback,
      inTransaction: Boolean(isTransaction),
      isTransaction,
      threadId,
    } satisfies CorrectionRaceResult);
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    try {
      parentPort?.close();
    } catch {
      /* ignore */
    }
  }
}

main();
