#!/usr/bin/env node
/**
 * memory-cli T1 foundation.
 * Usage: memory-cli --config ./memory.config.json < request.jsonl
 * Reads one stdin JSON line, writes one stdout JSON line (UTF-8, LF).
 * Exit codes: 0 = envelope written (even ok:false business errors);
 * non-zero = startup failure (bad args/config/DB/stdin) with NO stdout JSON.
 * Domain operations (candidate/record tables) land in T2-T4; T1 validates
 * the envelope strictly and reports the foundation status honestly.
 */
import * as fs from "node:fs";
import { loadConfig } from "./config.js";
import {
  applyResponseBudget,
  checkRawSize,
  fail,
  ok,
  validateRequest,
  type ResponseEnvelope,
} from "./protocol.js";
import { initDb } from "./db.js";

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
      throw new Error(`${usage()} (unknown argument: ${a})`);
    }
  }
  if (!configPath) throw new Error(usage() + " (--config is required)");
  return { configPath };
}

function readStdinLine(): string {
  let raw: string;
  try {
    raw = fs.readFileSync(0, "utf8");
  } catch (e) {
    throw new Error(`cannot read stdin: ${String(e)}`);
  }
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) throw new Error("empty stdin request");
  if (lines.length > 1) {
    // More than one JSON line on stdin is a bad request, but it is a
    // *business* error (envelope path), not a startup failure.
    return "__MULTILINE__";
  }
  // Strip a single trailing CR if present; internal structure is JSON's business.
  return lines[0].replace(/\r$/, "");
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
  // T1 has no domain tables yet: acknowledge the valid envelope honestly.
  // T2-T4 implement candidate.create/get, record.recall, correct-request.
  return applyResponseBudget(
    ok({ t1: "foundation", op: v.req.op, domain: "not-implemented" }),
    responseMaxBytes,
  );
}

function main(): void {
  let configPath: string;
  try {
    configPath = parseArgs(process.argv.slice(2)).configPath;
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(2);
    return;
  }
  let config;
  try {
    config = loadConfig(configPath);
  } catch (e) {
    process.stderr.write(
      `error: invalid config: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(2);
    return;
  }
  const started = Date.now();
  let db: { close(): void } | null = null;
  try {
    const opened = initDb(config, configPath);
    db = opened.db;
  } catch (e) {
    process.stderr.write(
      `error: db unavailable: ${e instanceof Error ? e.message : String(e)}\n`,
    );
    process.exit(3);
    return;
  }
  let line: string;
  try {
    line = readStdinLine();
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    process.exit(2);
    return;
  }
  let res = handleRawInput(line, config.limits.responseMaxBytes);
  if (Date.now() - started > config.timeouts.cliMs) {
    res = fail("TIMEOUT");
  }
  try {
    db.close();
  } catch {
    res = fail("STORE_UNAVAILABLE");
  }
  process.stdout.write(JSON.stringify(res) + "\n");
  process.exit(0);
}

main();
