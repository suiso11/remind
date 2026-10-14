import assert from "node:assert/strict";
import { DatabaseSync, constants } from "node:sqlite";
import { parentPort, threadId, workerData } from "node:worker_threads";
import type { AppConfig } from "../../src/config.js";
import type { ResponseEnvelope } from "../../src/protocol.js";
import { correctRecord } from "../../src/store.js";

export interface CorrectionRaceRequest {
  config: AppConfig;
  params: Record<string, unknown>;
  idempotencyKey: string;
  barrier: SharedArrayBuffer;
}

export interface CorrectionRaceReady {
  type: "ready";
  threadId: number;
  dbFile: string;
  targetStatus: string;
}

export interface CorrectionRaceResult {
  type: "result";
  res: ResponseEnvelope;
  transactions: { begin: number; commit: number; rollback: number };
  inTransaction: boolean;
}

function waitFor(shared: Int32Array, index: number, expected: number): void {
  const deadline = Date.now() + 10_000;
  while (true) {
    const value = Atomics.load(shared, index);
    if (value === expected) return;
    const remaining = deadline - Date.now();
    assert.ok(remaining > 0, "correction race barrier timed out");
    Atomics.wait(shared, index, value, remaining);
  }
}

function main(): void {
  assert.ok(parentPort, "correction race fixture requires a worker thread");
  const req = workerData as CorrectionRaceRequest;
  const shared = new Int32Array(req.barrier);
  // This handle is created inside this worker, never passed from the parent.
  const db = new DatabaseSync(req.config.dbPath);
  try {
    db.exec(`PRAGMA busy_timeout = ${req.config.timeouts.busyMs}`);
    const file = db.prepare("PRAGMA database_list").all().find((row) => row.name === "main");
    assert.ok(file);
    assert.ok(typeof file.file === "string");
    const target = db.prepare("SELECT status FROM records WHERE id=?").get(req.params.recordId as string);
    assert.ok(target);
    assert.ok(typeof target.status === "string");
    parentPort.postMessage({
      type: "ready",
      threadId,
      dbFile: file.file,
      targetStatus: target.status,
    } satisfies CorrectionRaceReady);
    waitFor(shared, 0, 1);

    const transactions = { begin: 0, commit: 0, rollback: 0 };
    // Observe real SQLite statements without replacing/denying any operation.
    // Rendezvous inside both correctRecord calls, immediately before SQLite
    // executes BEGIN: neither contender can finish before the other enters.
    db.setAuthorizer((action, arg1) => {
      if (action === constants.SQLITE_TRANSACTION) {
        if (arg1 === "BEGIN") {
          transactions.begin++;
          Atomics.add(shared, 1, 1);
          Atomics.notify(shared, 1);
          waitFor(shared, 1, 2);
        } else if (arg1 === "COMMIT") {
          transactions.commit++;
        } else if (arg1 === "ROLLBACK") {
          transactions.rollback++;
        }
      }
      return constants.SQLITE_OK;
    });
    const res = correctRecord(db, req.config, req.params, req.idempotencyKey);
    parentPort.postMessage({
      type: "result",
      res,
      transactions,
      inTransaction: db.isTransaction,
    } satisfies CorrectionRaceResult);
  } finally {
    db.close();
  }
}

main();
