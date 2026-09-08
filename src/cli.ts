#!/usr/bin/env node
/**
 * memory-cli T1 foundation (hardened).
 * Usage: memory-cli --config ./memory.config.json < request.jsonl
 *
 * Protocol: exactly ONE LF-framed stdin request. The first LF (0x0A)
 * terminates the request; the CLI responds without waiting for EOF so a
 * held-open pipe cannot hang it. Bytes already buffered after the first LF
 * that contain non-whitespace make the request BAD_REQUEST (multiline);
 * trailing whitespace-only bytes are ignored. EOF without LF also
 * terminates the single line (backwards compatible). Leading empty lines
 * are skipped. An EOF with zero/non-whitespace-only bytes is "bad input"
 * (stderr, non-zero, no stdout JSON).
 *
 * Bounds: raw stdin bytes are capped at 32768 (RAW_MAX_BYTES) *while
 * streaming*, before buffering/parsing. Exceeding bytes => LIMIT_EXCEEDED
 * envelope even with no newline. The overall cliMs deadline from startup
 * config aborts a never-ending stdin => TIMEOUT envelope. Line bytes are
 * decoded as UTF-8 with fatal:true; invalid bytes => BAD_REQUEST envelope.
 *
 * Errors: startup/config/db/input-path stderr carries FIXED codes only and
 * never echoes argv, config contents, or exception messages. All stdout
 * JSON envelopes pass the responseMaxBytes budget (fail-closed
 * LIMIT_EXCEEDED, never truncated).
 *
 * Honesty: T3-T4 domain ops (record.recall/correct-request, archive)
  * return ok:false NOT_IMPLEMENTED until their tasks land; this file never
  * returns ok:true for unimplemented domain ops.
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
import { initDb } from "./db.js";
import { escapeForTerminal } from "./normalize.js";
import {
  approveCandidate,
  createCandidate,
  getCandidateForReview,
  getCandidateMeta,
  rejectCandidate,
} from "./store.js";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";

/** Fixed stderr lines: no echo of args, config, or exception text. */
const STDERR_ARGS = "error: bad arguments\n";
const STDERR_CONFIG = "error: invalid config\n";
const STDERR_DB = "error: store unavailable\n";
const STDERR_INPUT = "error: bad input\n";

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
      // Fixed error: never echo the offending argument value.
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

/**
 * Bounded async stdin reader: resolves on the first LF without waiting for
 * EOF, enforces the raw byte cap incrementally, and enforces the deadline
 * even when the pipe is held open with no EOF. Skips leading empty lines.
 */
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
    // Ensure the timer alone never keeps the loop alive.
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

    /** Try to extract the first non-empty line from buffered bytes. */
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
      // Stream read failure: fixed input error, no echo.
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

export function handleRawInput(
  line: string,
  responseMaxBytes: number,
): ResponseEnvelope {
  if (line === "__MULTILINE__") {
    return applyResponseBudget(fail("BAD_REQUEST"), responseMaxBytes);
  }
  const over = checkRawSize(line);
  if (over) return applyResponseBudget(over, responseMaxBytes);
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return applyResponseBudget(fail("BAD_REQUEST"), responseMaxBytes);
  }
  const v = validateRequest(parsed);
  if (!v.ok) return applyResponseBudget(v.res, responseMaxBytes);
  // T2 routes candidate.create/get to the store; T3-T4 ops stay honest.
  return applyResponseBudget(fail("NOT_IMPLEMENTED"), responseMaxBytes);
}

/** Route a validated JSON request against an open DB (T2: candidates). */
export function handleValidatedRequest(
  db: DatabaseSync,
  config: AppConfig,
  op: string,
  params: Record<string, unknown>,
  idempotencyKey?: string,
): ResponseEnvelope {
  if (op === "candidate.create") {
    // Envelope guarantees the key; double-check fail-closed.
    if (typeof idempotencyKey !== "string") return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
    return createCandidate(db, config, params, idempotencyKey);
  }
  if (op === "candidate.get") {
    return getCandidateMeta(db, config, params);
  }
  // T3 (record.recall) / T4 (record.correct-request, archive): honest deferral.
  return applyResponseBudget(fail("NOT_IMPLEMENTED"), config.limits.responseMaxBytes);
}

const HUMAN_SUBCOMMANDS = new Set(["review", "approve", "reject", "archive"]);

function parseHumanArgs(argv: string[]): { sub: string; opts: Record<string, string> } | null {
  if (argv.length === 0 || !HUMAN_SUBCOMMANDS.has(argv[0] as string)) return null;
  const sub = argv[0] as string;
  const opts: Record<string, string> = {};
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if ((a === "--config" || a === "--id" || a === "--scope" || a === "--token" || a === "--idempotency-key" || a === "--reason-code") && i + 1 < argv.length) {
      opts[a] = argv[++i] as string;
    } else {
      // Unknown flags (including --confirm / --yes) are rejected as
      // BAD_REQUEST JSON by the caller; never silently accepted.
      return { sub, opts: { ...opts, __bad: a } };
    }
  }
  return { sub, opts };
}

function readConfirmLine(timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    let settled = false;
    let buf = "";
    const stdin = process.stdin;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(null);
    }, Math.max(0, timeoutMs));
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* ignore */
    }
    function cleanup(): void {
      clearTimeout(timer);
      try {
        stdin.removeAllListeners("data");
        stdin.removeAllListeners("end");
        stdin.removeAllListeners("error");
      } catch {
        /* ignore */
      }
      try {
        stdin.pause();
      } catch {
        /* ignore */
      }
    }
    function done(v: string | null): void {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(v);
    }
    stdin.setEncoding("utf8");
    stdin.on("data", (d: string) => {
      buf += d;
      const lf = buf.indexOf("\n");
      if (lf >= 0) done(buf.slice(0, lf));
    });
    stdin.on("end", () => done(buf));
    stdin.on("error", () => done(null));
    try {
      stdin.resume();
    } catch {
      done(null);
    }
  });
}

async function runHuman(
  sub: string,
  opts: Record<string, string>,
  config: AppConfig,
  db: DatabaseSync,
  started: number,
): Promise<void> {
  const remaining = (): number => config.timeouts.cliMs - (Date.now() - started);
  const outJson = (res: ResponseEnvelope): void => {
    const capped = applyResponseBudget(res, config.limits.responseMaxBytes);
    process.stdout.write(JSON.stringify(capped) + "\n");
  };
  if (opts["__bad"]) {
    outJson(fail("BAD_REQUEST"));
    process.exit(0);
    return;
  }
  // Archive is a T4 operation: honest deferral on the human path too.
  if (sub === "archive") {
    outJson(fail("NOT_IMPLEMENTED"));
    process.exit(0);
    return;
  }
  const id = opts["--id"];
  const scope = opts["--scope"];
  if (!id || !scope) {
    outJson(fail("BAD_REQUEST"));
    process.exit(0);
    return;
  }
  // TTY is mandatory for every human op: no piped approval, no file capture
  // of the review body via this path's assumptions. Non-TTY approve/reject
  // get a machine-readable FORBIDDEN; review gets a fixed stderr + non-zero.
  const stdinTty = !!process.stdin.isTTY;
  if (!stdinTty) {
    if (sub === "review") {
      process.stderr.write("error: human operation requires tty\n");
      process.exit(2);
      return;
    }
    outJson(fail("FORBIDDEN"));
    process.exit(0);
    return;
  }
  if (sub === "review") {
    const r = getCandidateForReview(db, id, scope);
    if (!r.ok) {
      // Metadata-only failure on stdout would risk confusion with the review
      // text; use the fixed JSON envelope so callers can branch safely.
      // (No body is emitted on failure paths.)
      if (r.code === "FORBIDDEN_SCOPE") outJson(fail("FORBIDDEN_SCOPE"));
      else if (r.code === "NOT_FOUND") outJson(fail("NOT_FOUND"));
      else if (r.code === "STORE_UNAVAILABLE") outJson(fail("STORE_UNAVAILABLE"));
      else outJson(fail("BAD_REQUEST"));
      process.exit(0);
      return;
    }
    // Explicit TTY review: complete immutable body (escaped) + metadata +
    // canonical digest. Display only; approval happens via approve + yes.
    const lines = [
      `id: ${escapeForTerminal(r.row.id)}`,
      `status: ${escapeForTerminal(r.row.status)}`,
      `kind: ${escapeForTerminal(r.row.kind)}`,
      `scope: ${escapeForTerminal(r.row.scope)}`,
      `source: ${escapeForTerminal(r.row.source)}`,
      `observedAt: ${escapeForTerminal(r.row.observedAt)}`,
      `createdAt: ${escapeForTerminal(r.row.createdAt)}`,
      `expiresAt: ${escapeForTerminal(r.row.expiresAt)}`,
      `bodyHash: ${escapeForTerminal(r.row.bodyHash)}`,
      `supersedes: ${escapeForTerminal(r.row.supersedes ?? "null")}`,
      `tags: ${escapeForTerminal(JSON.stringify(r.tags))}`,
      `link: ${escapeForTerminal(r.link ?? "null")}`,
      `approvalToken: ${r.token}`,
      `--- body ---`,
      escapeForTerminal(r.row.body),
      `--- end ---`,
    ];
    process.stdout.write(lines.join("\n") + "\n");
    process.exit(0);
    return;
  }
  const token = opts["--token"];
  const key = opts["--idempotency-key"];
  if (!token || !key) {
    outJson(fail("BAD_REQUEST"));
    process.exit(0);
    return;
  }
  // Interactive confirmation from the real TTY; --confirm-style flags were
  // already rejected above and natural-language text is never accepted.
  try {
    process.stderr.write("confirm: type yes to continue\n");
  } catch {
    /* ignore */
  }
  const answer = await readConfirmLine(remaining());
  if (answer === null || answer.trim() !== "yes") {
    outJson(fail("BAD_REQUEST"));
    process.exit(0);
    return;
  }
  if (Date.now() - started > config.timeouts.cliMs) {
    outJson(fail("TIMEOUT"));
    process.exit(0);
    return;
  }
  if (sub === "approve") {
    outJson(approveCandidate(db, config, { id, scope, token, idempotencyKey: key }));
    process.exit(0);
    return;
  }
  // reject
  const reason = opts["--reason-code"];
  if (!reason) {
    outJson(fail("BAD_REQUEST"));
    process.exit(0);
    return;
  }
  outJson(rejectCandidate(db, config, { id, scope, token, idempotencyKey: key, reasonCode: reason }));
  process.exit(0);
}

async function main(): Promise<void> {
  const started = Date.now();
  const rawArgv = process.argv.slice(2);
  // Human terminal path branches before any stdin read.
  const human = parseHumanArgs(rawArgv);
  let configPath: string;
  if (human) {
    const cp = human.opts["--config"];
    if (!cp) {
      // Missing --config on the human path is a startup failure (no stdout).
      process.stderr.write(STDERR_ARGS);
      process.exit(2);
      return;
    }
    configPath = cp;
    let hConfig;
    try {
      hConfig = loadConfig(configPath);
    } catch {
      process.stderr.write(STDERR_CONFIG);
      process.exit(2);
      return;
    }
    let hDb: DatabaseSync | null = null;
    try {
      hDb = initDb(hConfig, configPath).db as unknown as DatabaseSync;
    } catch {
      process.stderr.write(STDERR_DB);
      process.exit(3);
      return;
    }
    try {
      await runHuman(human.sub, human.opts, hConfig, hDb, started);
    } finally {
      try {
        hDb.close();
      } catch {
        /* ignore */
      }
    }
    return;
  }
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
  let db: { close(): void } | null = null;
  let rawDb: DatabaseSync | null = null;
  try {
    const opened = initDb(config, configPath);
    db = opened.db;
    rawDb = opened.db as unknown as DatabaseSync;
  } catch {
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

  const elapsed = (): number => Date.now() - started;
  const remaining = (): number => config.timeouts.cliMs - elapsed();

  // Bounded stdin read with the real remaining deadline.
  const stdinRes = await readFirstLine(RAW_MAX_BYTES, remaining());
  if (stdinRes.kind === "timeout" || elapsed() > config.timeouts.cliMs) {
    const res = applyResponseBudget(
      fail("TIMEOUT"),
      config.limits.responseMaxBytes,
    );
    closeDb();
    process.stdout.write(JSON.stringify(res) + "\n");
    process.exit(0);
    return;
  }
  if (stdinRes.kind === "overflow") {
    const res = applyResponseBudget(
      fail("LIMIT_EXCEEDED"),
      config.limits.responseMaxBytes,
    );
    closeDb();
    process.stdout.write(JSON.stringify(res) + "\n");
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
    // Sensible multiline handling: more than one non-empty LF-framed line
    // already buffered is a business error, without waiting for EOF.
    res = applyResponseBudget(
      fail("BAD_REQUEST"),
      config.limits.responseMaxBytes,
    );
  } else {
    const line = decodeLineFatal(stdinRes.rawBytes);
    if (line === null) {
      res = applyResponseBudget(
        fail("BAD_REQUEST"),
        config.limits.responseMaxBytes,
      );
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
          } else if (rawDb && (v.req.op === "candidate.create" || v.req.op === "candidate.get")) {
            try {
              res = handleValidatedRequest(rawDb, config, v.req.op, v.req.params, v.req.idempotencyKey);
            } catch {
              res = applyResponseBudget(fail("STORE_UNAVAILABLE"), config.limits.responseMaxBytes);
            }
          } else {
            // T3-T4 remain honest: recall / correct-request are not implemented.
            res = applyResponseBudget(fail("NOT_IMPLEMENTED"), config.limits.responseMaxBytes);
          }
        }
      }
    }
  }

  if (elapsed() > config.timeouts.cliMs) {
    res = applyResponseBudget(fail("TIMEOUT"), config.limits.responseMaxBytes);
  }
  try {
    db?.close();
  } catch {
    res = applyResponseBudget(
      fail("STORE_UNAVAILABLE"),
      config.limits.responseMaxBytes,
    );
  }
  process.stdout.write(JSON.stringify(res) + "\n");
  process.exit(0);
}

void main();
