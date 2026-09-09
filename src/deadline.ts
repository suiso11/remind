/**
 * P1 fix: effective overall automated-CLI deadline for synchronous SQLite work.
 *
 * Honest constraint: node:sqlite DatabaseSync calls are synchronous. A plain
 * JS setTimeout on the same thread CANNOT interrupt a blocked BEGIN
 * IMMEDIATE (SQLite busy wait) or a long instr() scan while it runs. The two
 * effective mechanisms here are therefore:
 *  (1) bound the SQLite busy wait itself: effectiveBusyMs = min(busyMs,
 *      remaining cliMs), applied as PRAGMA busy_timeout before the op, so a
 *      held write lock can never block past the remaining CLI deadline; and
 *  (2) run the whole store op on a worker thread whose lifetime is bounded
 *      by an INDEPENDENT timer on the parent thread: on expiry the parent
 *      calls worker.terminate(), which stops a long scan even mid-query.
 *
 * Unknown-outcome rule: a terminated worker may have committed before
 * termination (or not). The CLI answers TIMEOUT and the caller replays with
 * the same idempotency key + params: committed write ops replay the stored
 * envelope deterministically; uncommitted work was rolled back by closing the
 * worker's connection (no orphan txn survives a terminated worker because
 * the worker always closes its own connection in a finally block, and
 * SQLite rolls back an open transaction on close).
 */
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { AppConfig } from "./config.js";
import type { ResponseEnvelope } from "./protocol.js";

/** Bound a configured busy wait by the remaining overall deadline. */
export function effectiveBusyMs(busyMs: number, remainingMs: number): number {
  if (!Number.isFinite(remainingMs) || remainingMs <= 0) return 0;
  if (!Number.isFinite(busyMs) || busyMs <= 0) return 0;
  return Math.max(0, Math.min(Math.floor(busyMs), Math.floor(remainingMs)));
}

export interface WorkerOpRequest {
  dbFile: string;
  config: AppConfig;
  op: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  effectiveBusyMs: number;
}

export type WorkerOpOutcome =
  | { timedOut: false; res: ResponseEnvelope }
  | { timedOut: true };

function workerEntryPath(): string {
  // dist layout mirrors src: dist/src/worker-op.js. __filename here is
  // dist/src/deadline.js in production/tests (built via tsc first).
  try {
    if (typeof __filename === "string" && __filename.length > 0) {
      return path.join(path.dirname(__filename), "worker-op.js");
    }
  } catch {
    /* fall through */
  }
  return path.join(process.cwd(), "dist", "src", "worker-op.js");
}

/**
 * Run one validated store op in a worker thread bounded by remainingMs.
 * Resolves timedOut:true when the independent parent timer fires first
 * (worker terminated); otherwise the worker's envelope. Never throws: worker
 * errors/close without a message resolve to a STORE_UNAVAILABLE-shaped
 * outcome via the caller (here: timedOut:false is only for real replies; a
 * crash resolves as a thrown envelope the caller maps -- implemented as a
 * generic failure reply through `onError` below).
 */
export function runStoreOpWithDeadline(
  req: WorkerOpRequest,
  remainingMs: number,
): Promise<WorkerOpOutcome> {
  const budget = Math.max(0, Math.floor(remainingMs));
  if (budget <= 0) return Promise.resolve({ timedOut: true });
  return new Promise((resolve) => {
    let settled = false;
    let worker: Worker | null = null;
    const done = (out: WorkerOpOutcome): void => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timer);
      } catch {
        /* ignore */
      }
      // Best-effort terminate: a finished worker may already have exited;
      // a timed-out worker is killed here to interrupt a long scan.
      try {
        void worker?.terminate();
      } catch {
        /* ignore */
      }
      resolve(out);
    };
    const timer = setTimeout(() => done({ timedOut: true }), budget);
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* ignore */
    }
    try {
      worker = new Worker(workerEntryPath(), { workerData: req });
    } catch {
      done({ timedOut: true });
      return;
    }
    worker.once("message", (msg: unknown) => {
      const res = (msg as { res?: ResponseEnvelope } | null)?.res;
      if (res && typeof res === "object" && typeof (res as { ok?: unknown }).ok === "boolean") {
        done({ timedOut: false, res: res as ResponseEnvelope });
      } else {
        // Worker replied without an envelope (should not happen): treat as
        // an expired bound rather than fabricating success.
        done({ timedOut: true });
      }
    });
    worker.once("error", () => done({ timedOut: true }));
    worker.once("exit", (code: number) => {
      // A crash exit without a message must not hang: map to timeout
      // (unknown outcome) so the CLI answers TIMEOUT, never a late OK.
      if (!settled && code !== 0) done({ timedOut: true });
    });
  });
}
