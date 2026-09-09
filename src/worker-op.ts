/**
 * Worker entry for P1 deadline enforcement (runs on the worker thread).
 * Opens its OWN SQLite connection (never shares the parent's handle),
 * applies the parent-computed effective busy timeout, optionally honors the
 * test-only REMIND_WORKER_DELAY_MS synchronous delay (to deterministically
 * exercise the parent's independent deadline in tests), runs exactly one
 * validated store op, posts {res} back, and always closes its connection
 * (open transactions roll back on close: no orphan txn after terminate).
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  approveCandidate,
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

function testOnlyDelay(): void {
  // Test hook only: simulate a long deterministic scan without needing a
  // huge dataset. Production never sets this env var.
  const raw = process.env["REMIND_WORKER_DELAY_MS"];
  if (!raw) return;
  const ms = Number(raw);
  if (!Number.isFinite(ms) || ms <= 0) return;
  const end = Date.now() + Math.min(ms, 30000);
  while (Date.now() < end) {
    // Synchronous block: a same-thread setTimeout could not interrupt this;
    // only the parent's worker.terminate() stops it (the point of P1).
  }
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
    testOnlyDelay();
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
