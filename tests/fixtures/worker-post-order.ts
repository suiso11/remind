/**
 * Deterministic post-before-drain ordering probe (test-only, no production
 * path change).
 *
 * This module is the worker entry for exactly one test. It wraps
 * DatabaseSync.prototype.exec pass-through ONLY to attach an always-SQLITE_OK
 * native authorizer after the first real PRAGMA, then loads the REAL
 * production worker (../../src/worker-op.js) unmodified with the same
 * workerData. It never fakes store/worker/response data and never returns
 * synthetic SQLite results: every exec calls through to the original and
 * returns its real result; the authorizer always returns SQLITE_OK.
 *
 * Drain-entry signal: the authorizer watches for SQLITE_READ of
 * projection_queue.attempts. Per clean source src/projection.ts, the ONLY
 * statement reading that column is the drain SELECT
 *   SELECT recordId, attempts FROM projection_queue WHERE nextAt <= ? ...
 * (enqueue is INSERT OR IGNORE, dequeue is DELETE, projectOneRecord reads
 * records/tags/links/refs only). On the first such read it posts a
 * side-channel {stage:"drain-enter"} and blocks the native callback on the
 * parent-held gate SAB until release.
 *
 * Ordering proof: production post({res}) happens before drainProjection in
 * worker-op.js, and both messages share the same parentPort FIFO, so the
 * parent must already hold the real committed envelope before it can observe
 * the stage message. If production post were moved after the drain, the
 * stage would arrive first with no response and the parent assertion fails
 * with no reliance on startup timing.
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync, constants } from "node:sqlite";

const gate: SharedArrayBuffer | undefined = (workerData as { __gate?: SharedArrayBuffer }).__gate;
const view = gate ? new Int32Array(gate) : null;

const proto = DatabaseSync.prototype as unknown as {
  exec: (sql: string, ...rest: unknown[]) => unknown;
};
const origExec = proto.exec;
let authorizerAttached = false;

function attachAuthorizer(db: unknown): void {
  if (authorizerAttached) return;
  authorizerAttached = true;
  try {
    (db as DatabaseSync).setAuthorizer((action: number, table: unknown, column: unknown) => {
      try {
        if (
          action === constants.SQLITE_READ &&
          table === "projection_queue" &&
          column === "attempts" &&
          view
        ) {
          try {
            parentPort?.postMessage({ stage: "drain-enter" });
          } catch {
            /* ignore */
          }
          // Gate the actual drain SELECT until the parent releases. Bounded
          // wait only so a parent failure cannot hang CI forever; the parent
          // watchdog always releases on failure paths.
          try {
            Atomics.wait(view, 0, 0, 15000);
          } catch {
            /* ignore */
          }
        }
      } catch {
        /* observer must never break the op */
      }
      return constants.SQLITE_OK;
    });
  } catch {
    /* ignore */
  }
}

(proto as { exec: unknown }).exec = function (this: unknown, sql: string, ...rest: unknown[]): unknown {
  const out = (origExec as (...a: unknown[]) => unknown).call(this, sql, ...rest);
  try {
    if (!authorizerAttached && typeof sql === "string" && /busy_timeout/i.test(sql)) {
      attachAuthorizer(this);
    }
  } catch {
    /* ignore */
  }
  return out;
};

// Load the REAL production worker with the same workerData. Its main() runs
// on import: own connection, real pragma, real op, real post({res}), real
// drain, close. Extra __gate workerData field is ignored by production code.
void import("../../src/worker-op.js").then(
  () => {
    try {
      parentPort?.close();
    } catch {
      /* ignore */
    }
  },
  () => {
    try {
      parentPort?.close();
    } catch {
      /* ignore */
    }
  },
);
