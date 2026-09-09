/**
 * Worker entry for P1 deadline enforcement (runs on the worker thread).
 * Opens its OWN SQLite connection (never shares the parent's handle),
 * applies the parent-computed effective busy timeout, runs exactly one
 * validated store op, posts {res} back, and attempts to close its connection.
 * Honest limit: when the parent's deadline fires, worker.terminate() is
 * best-effort and may NOT unwind the finally below nor interrupt native
 * SQLite promptly; the CLI's reliable bound is its own TIMEOUT response
 * plus whole-process exit (OS closes handles, SQLite recovery decides the
 * commit outcome, which stays UNKNOWN to the caller).
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  approveCandidate,
  correctRequest,
  createCandidate,
  getCandidateMeta,
  recallRecords,
  rejectCandidate,
} from "./store.js";
import { applyResponseBudget, fail } from "./protocol.js";

interface Req {
  dbFile: string;
  config: AppConfig;
  op: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  effectiveBusyMs: number;
}

function main(): void {
  const req = workerData as Req;
  const post = (res: unknown): void => {
    try {
      parentPort?.postMessage({ res });
    } catch {
      /* parent gone; ignore */
    }
  };
  let db: DatabaseSync | null = null;
  try {
    const busy = Math.max(0, Math.floor(req.effectiveBusyMs));
    db = new DatabaseSync(req.dbFile);
    // Bound lock waits by the parent's remaining deadline (never the raw
    // configured busyMs when it exceeds the remaining budget).
    db.exec(`PRAGMA busy_timeout = ${busy}`);
    const cfg = req.config;
    let res;
    if (req.op === "candidate.create") {
      if (typeof req.idempotencyKey !== "string") {
        res = applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      } else {
        res = createCandidate(db, cfg, req.params, req.idempotencyKey);
      }
    } else if (req.op === "candidate.get") {
      res = getCandidateMeta(db, cfg, req.params);
    } else if (req.op === "record.recall") {
      res = recallRecords(db, cfg, req.params);
    } else if (req.op === "record.correct-request") {
      // T4: deadline worker path stays wired for JSON correct requests with
      // the same size/auth/response-budget/DB-failure semantics as the
      // direct call (the store owns all gates; approve/archive/reject stay
      // human-terminal-only and never route here).
      if (typeof req.idempotencyKey !== "string") {
        res = applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      } else {
        res = correctRequest(db, cfg, req.params, req.idempotencyKey);
      }
    } else {
      res = applyResponseBudget(fail("NOT_IMPLEMENTED"), cfg.limits.responseMaxBytes);
    }
    post(res);
  } catch {
    try {
      const cfg = (workerData as Req).config;
      post(applyResponseBudget(fail("STORE_UNAVAILABLE"), cfg.limits.responseMaxBytes));
    } catch {
      /* ignore */
    }
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore: close failure is reported via the envelope, not raw text */
    }
  }
}

main();
