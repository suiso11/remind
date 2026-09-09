/**
 * Worker entry for deadline enforcement (runs on the worker thread).
 * Opens its OWN SQLite connection (never shares the parent's handle),
 * applies the parent-computed effective busy timeout, runs exactly one
 * validated store op, drains the bounded projection queue (best-effort,
 * never hides committed memory), posts {res} back, and closes.
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  archiveRecord,
  correctRecord,
  eventAppend,
  feedbackRecords,
  getRecord,
  listRecords,
  recallRecords,
  rememberRecord,
} from "./store.js";
import { drainProjection } from "./projection.js";
import { applyResponseBudget, fail } from "./protocol.js";

interface Req {
  dbFile: string;
  config: AppConfig;
  configPath: string;
  op: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  effectiveBusyMs: number;
}

function runOp(db: DatabaseSync, req: Req) {
  const cfg = req.config;
  switch (req.op) {
    case "event.append":
      if (typeof req.idempotencyKey !== "string") {
        return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      }
      return eventAppend(db, cfg, req.params, req.idempotencyKey);
    case "record.remember":
      if (typeof req.idempotencyKey !== "string") {
        return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      }
      return rememberRecord(db, cfg, req.params, req.idempotencyKey);
    case "record.get":
      return getRecord(db, cfg, req.params);
    case "record.list":
      return listRecords(db, cfg, req.params);
    case "record.recall":
      return recallRecords(db, cfg, req.params);
    case "record.feedback":
      if (typeof req.idempotencyKey !== "string") {
        return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      }
      return feedbackRecords(db, cfg, req.params, req.idempotencyKey);
    case "record.correct":
      if (typeof req.idempotencyKey !== "string") {
        return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      }
      return correctRecord(db, cfg, req.params, req.idempotencyKey);
    case "record.archive":
      if (typeof req.idempotencyKey !== "string") {
        return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      }
      return archiveRecord(db, cfg, req.params, req.idempotencyKey);
    default:
      return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
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
    db.exec(`PRAGMA busy_timeout = ${busy}`);
    const res = runOp(db, req);
    // Post-commit projection (bounded, best-effort): a projection failure
    // never replaces the committed envelope.
    try {
      drainProjection(db, req.config, req.configPath);
    } catch {
      /* queue retry next time */
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
      /* ignore */
    }
  }
}

main();
