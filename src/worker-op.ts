/**
 * Worker entry for deadline enforcement (runs on the worker thread).
 * Opens its OWN SQLite connection (never shares the parent's handle),
 * applies the parent-computed effective busy timeout, runs exactly one
 * validated store op, posts {res} back, and closes.
 *
 * M2: record.recall embeds the normalized query with the pinned local model
 * (offline only, bounded by vectors.timeoutMs) and fuses vector candidates
 * with lexical/raw/graph. Missing/invalid model or vectors degrade to the M1
 * lexical+graph path inside the same transaction (§8). Writes never embed
 * inline (deadlines preserved): vectors are populated by scripts/rebuild-vectors.
 */
import { parentPort, workerData } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  archiveRecord,
  correctRecord,
  eventAppend,
  feedbackRecords,
  getEvent,
  getRecord,
  listEpisodes,
  listRecords,
  rangeEvents,
  reactivateRecord,
  recallRecords,
  recordSources,
  rememberRecord,
  retireRecord,
  searchRecords,
  type RecallVectorInput,
} from "./store.js";
import { episodeWindows, maintainEpisodes } from "./episodes.js";
import { drainProjection } from "./projection.js";
import { applyResponseBudget, fail } from "./protocol.js";
import { normalizeBody } from "./normalize.js";
import { maintainDistill } from "./distill.js";
import {
  embedTexts,
  resolveModelDir,
  vectorEmbedBudgetMs,
  vectorTimeoutMs,
  vectorTopK,
  vectorsEnabled,
} from "./vectors.js";

interface Req {
  dbFile: string;
  config: AppConfig;
  configPath: string;
  op: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
  effectiveBusyMs: number;
  /** Remaining operation budget (ms) at dispatch; caps vector inference. */
  remainingMs?: number;
}

async function recallVectorFor(
  req: Req,
  workerStartMs: number,
): Promise<RecallVectorInput | undefined> {
  try {
    if (!vectorsEnabled(req.config)) return undefined;
    const q = req.params["query"];
    if (typeof q !== "string" || q.length === 0) return undefined;
    const nq = normalizeBody(q);
    if (nq.length === 0) return undefined;
    // Cap embedding by the remaining recall deadline with room for the
    // lexical fallback; null => skip vectors now (lexical+graph recall).
    const budget = vectorEmbedBudgetMs(vectorTimeoutMs(req.config), req.remainingMs, Date.now() - workerStartMs);
    if (budget === null) return undefined;
    const modelDir = resolveModelDir(req.config, req.configPath);
    const vecs = await embedTexts([nq], modelDir, budget);
    if (!vecs || vecs.length !== 1 || !vecs[0]) return undefined;
    return { vec: vecs[0] as Float32Array, topK: vectorTopK(req.config) };
  } catch {
    return undefined;
  }
}

function runOpSync(db: DatabaseSync, req: Req, vector?: RecallVectorInput) {
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
    case "record.sources":
      return recordSources(db, cfg, req.params);
    case "event.get":
      return getEvent(db, cfg, req.params);
    case "event.range":
      return rangeEvents(db, cfg, req.params);
    case "episode.list":
      return listEpisodes(db, cfg, req.params);
    case "episode.windows":
      return episodeWindows(db, cfg, req.params);
    case "record.recall":
      return recallRecords(db, cfg, req.params, undefined, vector);
    case "record.search":
      return searchRecords(db, cfg, req.params);
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
    case "record.retire":
      if (typeof req.idempotencyKey !== "string") {
        return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      }
      return retireRecord(db, cfg, req.params, req.idempotencyKey);
    case "record.reactivate":
      if (typeof req.idempotencyKey !== "string") {
        return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
      }
      return reactivateRecord(db, cfg, req.params, req.idempotencyKey);
    default:
      return applyResponseBudget(fail("BAD_REQUEST"), cfg.limits.responseMaxBytes);
  }
}

async function runOpAsync(db: DatabaseSync, req: Req, workerStartMs: number) {
  if (req.op === "maintain.episodes") {
    if (typeof req.idempotencyKey !== "string") {
      return applyResponseBudget(fail("BAD_REQUEST"), req.config.limits.responseMaxBytes);
    }
    return maintainEpisodes(db, req.config, req.configPath, req.params, req.idempotencyKey);
  }
  if (req.op === "maintain.distill") {
    if (typeof req.idempotencyKey !== "string") {
      return applyResponseBudget(fail("BAD_REQUEST"), req.config.limits.responseMaxBytes);
    }
    // Model inference runs inside maintainDistill but strictly OUTSIDE any
    // canonical transaction (lease/dequeue/apply/settle are short separate
    // transactions around the inference phase).
    return maintainDistill(db, req.config, req.configPath, req.params, req.idempotencyKey);
  }
  return runOpSync(db, req, req.op === "record.recall" ? await recallVectorFor(req, workerStartMs) : undefined);
}

async function main(): Promise<void> {
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
    const workerStartMs = Date.now();
    // Vector query embedding happens BEFORE the recall transaction so the
    // same bounded fusion runs inside it. Any failure => undefined =>
    // lexical+graph fallback (never an error). maintain.distill runs its own
    // async drain (inference strictly outside canonical transactions).
    const res = await runOpAsync(db, req, workerStartMs);
    // Deliver the committed envelope before optional projection work so a
    // slow drain cannot turn a known commit into a parent-side TIMEOUT.
    post(res);
    try {
      drainProjection(db, req.config, req.configPath);
    } catch {
      /* queue retry next time */
    }
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

void main();
