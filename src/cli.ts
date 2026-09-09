#!/usr/bin/env node
/**
 * memory-cli M1 (autonomous, no human gate).
 * Usage: memory-cli --config ./memory.config.json < request.jsonl
 *
 * Protocol: exactly ONE LF-framed stdin request. The first LF (0x0A)
 * terminates the request; the CLI responds without waiting for EOF so a
 * held-open pipe cannot hang it. Bytes already buffered after the first LF
 * that contain non-whitespace make the request BAD_REQUEST (multiline);
 * trailing whitespace-only bytes are ignored. EOF without LF also
 * terminates the single line. Leading empty lines are skipped. An EOF with
 * zero/non-whitespace-only bytes is "bad input" (stderr, non-zero, no
 * stdout JSON).
 *
 * Bounds: raw stdin bytes are capped at 32768 (RAW_MAX_BYTES) while
 * streaming, before buffering/parsing. The overall cliMs deadline from
 * startup config aborts a never-ending stdin => TIMEOUT envelope. The store
 * op runs on a worker thread bounded by the REMAINING cliMs: the SQLite busy
 * wait is clamped to min(busyMs, remaining) and an independent parent timer
 * answers TIMEOUT on expiry (unknown commit outcome; idempotent replay via
 * the same key + params) followed by whole-process exit. worker.terminate()
 * is best-effort only; the reliable bound is the parent's timely TIMEOUT
 * plus OS process exit (SQLite recovery decides the commit outcome).
 *
 * Autonomous ops (all direct-commit, no approval/TTY):
 *   event.append, record.remember, record.get, record.list,
 *   record.recall, record.feedback, record.correct, record.archive
 *
 * Startup: missing vaultPath, unknown config fields, legacy approval-schema
 * DBs, and unreadable DBs fail with a FIXED stderr line + non-zero exit and
 * never emit stdout JSON. A legacy DB is never mutated or deleted.
 */
import { loadConfig } from "./config.js";
import {
  RAW_MAX_BYTES,
  applyResponseBudget,
  checkRawSize,
  fail,
  validateRequest,
  type ResponseEnvelope,
} from "./protocol.js";
import { initDb, isLegacyDbError } from "./db.js";
import { effectiveBusyMs, runStoreOpWithDeadline } from "./deadline.js";
import * as fs from "node:fs";
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
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";

/** Fixed stderr lines: no echo of args, config, or exception text. */
const STDERR_ARGS = "error: bad arguments\n";
const STDERR_CONFIG = "error: invalid config\n";
const STDERR_DB = "error: store unavailable\n";
const STDERR_LEGACY =
  "error: legacy store: back up existing data and configure a new DB file\n";
const STDERR_INPUT = "error: bad input\n";

function emitJsonLine(res: ResponseEnvelope): void {
  try {
    fs.writeSync(1, JSON.stringify(res) + "\n");
  } catch {
    try {
      process.stdout.write(JSON.stringify(res) + "\n");
    } catch {
      /* ignore */
    }
  }
}

function usage(): string {
  return "usage: memory-cli --config <path>";
}

function parseArgs(argv: string[]): { configPath: string } {
  let configPath: string | null = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--config" && i + 1 < argv.length) {
      configPath = argv[++i];
    } else if (a === "--help" || a === "-h") {
      process.stderr.write(usage() + "\n");
      process.exit(0);
    } else {
      throw new Error("bad arguments");
    }
  }
  if (!configPath) throw new Error("bad arguments");
  return { configPath };
}

type StdinResult =
  | { kind: "line"; rawBytes: Buffer; trailingNonEmpty: boolean }
  | { kind: "empty" }
  | { kind: "overflow" }
  | { kind: "timeout" };

function hasNonWs(b: Buffer): boolean {
  for (let i = 0; i < b.length; i++) {
    const c = b[i];
    if (c !== 0x20 && c !== 0x09 && c !== 0x0d && c !== 0x0a) return true;
  }
  return false;
}

function stripTrailingCr(b: Buffer): Buffer {
  if (b.length > 0 && b[b.length - 1] === 0x0d) return b.subarray(0, b.length - 1);
  return b;
}

export function readFirstLine(
  maxBytes: number,
  timeoutMs: number,
): Promise<StdinResult> {
  return new Promise((resolve) => {
    let settled = false;
    let total = 0;
    let chunks: Buffer[] = [];
    let chunkLen = 0;
    const stdin = process.stdin;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({ kind: "timeout" });
    }, Math.max(0, timeoutMs));
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* ignore */
    }

    function buffered(): Buffer {
      return Buffer.concat(chunks, chunkLen);
    }

    function cleanup(): void {
      clearTimeout(timer);
      try {
        stdin.removeAllListeners("data");
        stdin.removeAllListeners("end");
        stdin.removeAllListeners("error");
        stdin.removeAllListeners("close");
      } catch {
        /* ignore */
      }
      try {
        stdin.pause();
      } catch {
        /* ignore */
      }
      try {
        const s = stdin as unknown as { destroy?: () => void };
        if (typeof s.destroy === "function") s.destroy();
      } catch {
        /* ignore */
      }
    }

    function finish(r: StdinResult): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    }

    function tryExtract(eof: boolean): boolean {
      const buf = buffered();
      const lf = buf.indexOf(0x0a);
      if (lf >= 0) {
        let start = 0;
        while (true) {
          const next = buf.indexOf(0x0a, start);
          if (next < 0) {
            if (start > 0) {
              const rest = buf.subarray(start);
              chunks = rest.length > 0 ? [Buffer.from(rest)] : [];
              chunkLen = rest.length;
            }
            return false;
          }
          const cand = stripTrailingCr(buf.subarray(start, next));
          if (!hasNonWs(cand)) {
            start = next + 1;
            if (start >= buf.length) {
              chunks = [];
              chunkLen = 0;
              return false;
            }
            continue;
          }
          const remainder = buf.subarray(next + 1);
          finish({
            kind: "line",
            rawBytes: Buffer.from(cand),
            trailingNonEmpty: hasNonWs(remainder),
          });
          return true;
        }
      }
      if (eof) {
        if (buf.length === 0 || !hasNonWs(buf)) {
          finish({ kind: "empty" });
          return true;
        }
        finish({
          kind: "line",
          rawBytes: Buffer.from(stripTrailingCr(buf)),
          trailingNonEmpty: false,
        });
        return true;
      }
      return false;
    }

    function onData(chunk: Buffer): void {
      if (settled) return;
      const b = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += b.length;
      if (total > maxBytes) {
        finish({ kind: "overflow" });
        return;
      }
      chunks.push(b);
      chunkLen += b.length;
      tryExtract(false);
    }

    function onEnd(): void {
      if (settled) return;
      tryExtract(true);
      if (!settled) finish({ kind: "empty" });
    }

    function onErr(): void {
      finish({ kind: "empty" });
    }

    stdin.on("data", onData);
    stdin.once("end", onEnd);
    stdin.once("error", onErr);
    stdin.once("close", () => {
      if (!settled) onEnd();
    });
    try {
      stdin.resume();
    } catch {
      finish({ kind: "empty" });
    }
  });
}

export function decodeLineFatal(rawBytes: Buffer): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(rawBytes);
  } catch {
    return null;
  }
}

/** Route a validated JSON request against an open DB (M1 domain ops). */
export function handleValidatedRequest(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
  op: string,
  params: Record<string, unknown>,
  idempotencyKey?: string,
): ResponseEnvelope {
  const needKey = (v: string | undefined): v is string => typeof v === "string";
  switch (op) {
    case "event.append":
      if (!needKey(idempotencyKey)) return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
      return eventAppend(db, config, params, idempotencyKey);
    case "record.remember":
      if (!needKey(idempotencyKey)) return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
      return rememberRecord(db, config, params, idempotencyKey);
    case "record.get":
      return getRecord(db, config, params);
    case "record.list":
      return listRecords(db, config, params);
    case "record.recall":
      return recallRecords(db, config, params);
    case "record.feedback":
      if (!needKey(idempotencyKey)) return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
      return feedbackRecords(db, config, params, idempotencyKey);
    case "record.correct":
      if (!needKey(idempotencyKey)) return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
      return correctRecord(db, config, params, idempotencyKey);
    case "record.archive":
      if (!needKey(idempotencyKey)) return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
      return archiveRecord(db, config, params, idempotencyKey);
    default:
      return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
  }
}

/** Post-commit policy: a known committed success is never replaced by
 * TIMEOUT or a DB-close failure. Unknown-outcome cases keep idempotent
 * replay via the caller's same key + params. */
export function preserveCommittedResult(
  res: ResponseEnvelope,
  timedOut: boolean,
  closeFailed: boolean,
  maxBytes: number,
): ResponseEnvelope {
  if (res.ok) return res;
  if (timedOut) return applyResponseBudget(fail("TIMEOUT"), maxBytes);
  if (closeFailed) return applyResponseBudget(fail("STORE_UNAVAILABLE"), maxBytes);
  return res;
}

const STORE_OPS = new Set([
  "event.append",
  "record.remember",
  "record.get",
  "record.list",
  "record.recall",
  "record.feedback",
  "record.correct",
  "record.archive",
]);

async function main(): Promise<void> {
  const started = Date.now();
  const rawArgv = process.argv.slice(2);
  let configPath: string;
  try {
    configPath = parseArgs(rawArgv).configPath;
  } catch {
    process.stderr.write(STDERR_ARGS);
    process.exit(2);
    return;
  }
  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    process.stderr.write(STDERR_CONFIG);
    process.exit(2);
    return;
  }
  const elapsed = (): number => Date.now() - started;
  const remaining = (): number => config.timeouts.cliMs - elapsed();
  let db: { close(): void } | null = null;
  let dbFile = "";
  try {
    const startupEff = effectiveBusyMs(config.timeouts.busyMs, remaining());
    const opened = initDb(config, configPath, startupEff);
    db = opened.db;
    dbFile = opened.dbFile;
  } catch (e) {
    if (isLegacyDbError(e)) {
      process.stderr.write(STDERR_LEGACY);
      process.exit(3);
      return;
    }
    const msg = e instanceof Error ? e.message : String(e);
    if (/busy|locked|timeout/i.test(msg)) {
      const timedOut = Date.now() - started > config.timeouts.cliMs;
      const res = applyResponseBudget(
        fail(timedOut ? "TIMEOUT" : "STORE_UNAVAILABLE"),
        config.limits.responseMaxBytes,
      );
      emitJsonLine(res);
      process.exit(0);
      return;
    }
    process.stderr.write(STDERR_DB);
    process.exit(3);
    return;
  }

  const closeDb = (): void => {
    try {
      db?.close();
    } catch {
      /* ignore; close failure handled at the single close point below */
    }
  };

  const stdinRes = await readFirstLine(RAW_MAX_BYTES, remaining());
  if (stdinRes.kind === "timeout" || elapsed() > config.timeouts.cliMs) {
    const res = applyResponseBudget(fail("TIMEOUT"), config.limits.responseMaxBytes);
    closeDb();
    emitJsonLine(res);
    process.exit(0);
    return;
  }
  if (stdinRes.kind === "overflow") {
    const res = applyResponseBudget(fail("LIMIT_EXCEEDED"), config.limits.responseMaxBytes);
    closeDb();
    emitJsonLine(res);
    process.exit(0);
    return;
  }
  if (stdinRes.kind === "empty") {
    process.stderr.write(STDERR_INPUT);
    closeDb();
    process.exit(2);
    return;
  }

  let res: ResponseEnvelope = applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
  if (stdinRes.trailingNonEmpty) {
    res = applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
  } else {
    const line = decodeLineFatal(stdinRes.rawBytes);
    if (line === null) {
      res = applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
    } else if (line.trim().length === 0) {
      process.stderr.write(STDERR_INPUT);
      closeDb();
      process.exit(2);
      return;
    } else {
      const over = checkRawSize(line);
      if (over) {
        res = applyResponseBudget(over, config.limits.responseMaxBytes);
      } else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch {
          res = applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
          parsed = undefined;
        }
        if (parsed !== undefined) {
          const v = validateRequest(parsed);
          if (!v.ok) {
            res = applyResponseBudget(v.res, config.limits.responseMaxBytes);
          } else if (STORE_OPS.has(v.req.op)) {
            const opRemaining = remaining();
            if (opRemaining <= 0) {
              res = applyResponseBudget(fail("TIMEOUT"), config.limits.responseMaxBytes);
            } else {
              closeDb();
              db = null;
              const eff = effectiveBusyMs(config.timeouts.busyMs, opRemaining);
              try {
                const outcome = await runStoreOpWithDeadline(
                  {
                    dbFile,
                    config,
                    configPath,
                    op: v.req.op,
                    params: v.req.params,
                    idempotencyKey: v.req.idempotencyKey,
                    effectiveBusyMs: eff,
                  },
                  opRemaining,
                );
                if (outcome.timedOut) {
                  res = applyResponseBudget(fail("TIMEOUT"), config.limits.responseMaxBytes);
                } else {
                  res = outcome.res;
                }
              } catch {
                res = applyResponseBudget(fail("STORE_UNAVAILABLE"), config.limits.responseMaxBytes);
              }
            }
          } else {
            res = applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
          }
        }
      }
    }
  }

  const timedOut = elapsed() > config.timeouts.cliMs;
  let closeFailed = false;
  try {
    db?.close();
  } catch {
    closeFailed = true;
  }
  res = preserveCommittedResult(res, timedOut, closeFailed, config.limits.responseMaxBytes);
  emitJsonLine(res);
  process.exit(0);
}

function isCliEntry(): boolean {
  try {
    return (
      (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("src/cli.js") ||
      (process.argv[1] ?? "").replace(/\\/g, "/").endsWith("dist/src/cli.js")
    );
  } catch {
    return false;
  }
}

if (isCliEntry()) void main();
