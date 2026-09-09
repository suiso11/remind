/**
 * P1 fix: effective overall automated-CLI deadline for synchronous SQLite work.
 *
 * CLI-only contract (honest): the automated JSON path bounds the WHOLE
 * operation by an INDEPENDENT parent timer followed by whole-process exit.
 * There is no long-lived safe-cancellation promise: when the timer fires the
 * CLI answers TIMEOUT (unknown commit outcome) and exits, letting the OS
 * close handles. SQLite recovery then decides what committed; a TIMEOUT must
 * never be read as "rolled back". Callers replay with the same idempotency
 * key + params: a committed write replays the stored envelope with
 * deduplicated:true, uncommitted work is resolved by re-execution.
 *
 * Two mechanisms:
 *  (1) bound the SQLite busy wait itself: effectiveBusyMs = min(busyMs,
 *      remaining cliMs), applied as PRAGMA busy_timeout before the op, so a
 *      held write lock cannot block past the remaining CLI deadline; and
 *  (2) run the whole store op on a worker thread bounded by the independent
 *      parent timer. On expiry the parent answers TIMEOUT; worker.terminate()
 *      is attempted best-effort only: Worker.terminate does NOT reliably
 *      unwind the worker's finally blocks nor promptly interrupt native
 *      SQLite calls, so no rollback is promised. The reliable bound is the
 *      parent's timely TIMEOUT response plus process exit (fs.writeSync +
 *      process.exit), which closes the parent handle; the worker is an
 *      OS-level thread whose handles close on process exit.
 */
import { Worker } from "node:worker_threads";
import * as path from "node:path";
import type { AppConfig } from "./config.js";
import { applyResponseBudget, fail, type ResponseEnvelope } from "./protocol.js";

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

function storeUnavailable(req: WorkerOpRequest): ResponseEnvelope {
  try {
    return applyResponseBudget(fail("STORE_UNAVAILABLE"), req.config.limits.responseMaxBytes);
  } catch {
    return fail("STORE_UNAVAILABLE") as ResponseEnvelope;
  }
}

/**
 * Run one validated store op in a worker thread bounded by remainingMs.
 *
 * Contract:
 * - Real worker message before the deadline wins: resolves timedOut:false
 *   with the worker's envelope (success or domain error preserved).
 * - Deadline elapsed first: resolves timedOut:true (caller answers TIMEOUT,
 *   unknown commit outcome). Late worker messages are ignored (no late OK).
 * - Worker construction failure, worker 'error', or exit without a usable
 *   message resolves IMMEDIATELY as timedOut:false with a STORE_UNAVAILABLE
 *   envelope (never a false TIMEOUT). The timer stays live until settlement:
 *   it is only cleared inside done(), i.e. once one of the above outcomes
 *   has been chosen.
 * - Termination after settlement is best-effort only (see header).
 */
export function runStoreOpWithDeadline(
  req: WorkerOpRequest,
  remainingMs: number,
  workerPathOverride?: string,
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
      // Best-effort terminate only: Worker.terminate() does not reliably
      // unwind worker finally blocks nor interrupt native SQLite promptly.
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
      worker = new Worker(workerPathOverride ?? workerEntryPath(), { workerData: req });
    } catch {
      done({ timedOut: false, res: storeUnavailable(req) });
      return;
    }
    worker.once("message", (msg: unknown) => {
      const res = (msg as { res?: ResponseEnvelope } | null)?.res;
      if (res && typeof res === "object" && typeof (res as { ok?: unknown }).ok === "boolean") {
        done({ timedOut: false, res: res as ResponseEnvelope });
      } else {
        // Worker replied without an envelope: immediate failure, not a
        // deadline expiry.
        done({ timedOut: false, res: storeUnavailable(req) });
      }
    });
    worker.once("error", () => done({ timedOut: false, res: storeUnavailable(req) }));
    worker.once("exit", () => {
      // Crash/normal exit without a usable message: immediate
      // STORE_UNAVAILABLE so the CLI never hangs and never emits a false
      // TIMEOUT. If a message already settled us, this is a no-op.
      if (!settled) done({ timedOut: false, res: storeUnavailable(req) });
    });
  });
}
