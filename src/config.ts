import * as fs from "node:fs";
import * as path from "node:path";

export interface LimitsConfig {
  bodyMaxCp: number;
  queryMaxCp: number;
  tagsMax: number;
  limitDefault: number;
  limitMax: number;
  snippetMaxCp: number;
  responseMaxBytes: number;
}

export interface TimeoutsConfig {
  cliMs: number;
  busyMs: number;
}

export interface AppConfig {
  dbPath: string;
  allowedScopes: string[];
  candidateTtlSec: number;
  limits: LimitsConfig;
  timeouts: TimeoutsConfig;
  dbMaxBytes: number;
}

const TOP_KEYS = [
  "dbPath",
  "allowedScopes",
  "candidateTtlSec",
  "limits",
  "timeouts",
  "dbMaxBytes",
] as const;
const LIMIT_KEYS = [
  "bodyMaxCp",
  "queryMaxCp",
  "tagsMax",
  "limitDefault",
  "limitMax",
  "snippetMaxCp",
  "responseMaxBytes",
] as const;
const TIMEOUT_KEYS = ["cliMs", "busyMs"] as const;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isInt(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n);
}

/** Code points (not UTF-16 units, not grapheme clusters). */
export function countCp(s: string): number {
  return [...s].length;
}

function hasControl(s: string): boolean {
  // NUL, C0/C1 controls, DEL. Newlines are handled per-field by callers;
  // config scope strings forbid all controls including newline.
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F-\u009F]/.test(s);
}

function checkScopeString(s: unknown): string | null {
  if (typeof s !== "string") return "scope must be a string";
  const n = countCp(s);
  if (n < 1 || n > 256) return "scope length must be 1..256 code points";
  if (hasControl(s)) return "scope must not contain control characters";
  return null;
}

function checkRange(
  name: string,
  v: unknown,
  min: number,
  max: number,
): string | null {
  if (!isInt(v)) return `${name} must be an integer`;
  if (v < min || v > max) return `${name} must be in ${min}..${max}`;
  return null;
}

/**
 * Strict startup config loader. Only the config file supplies values;
 * env vars and request JSON can never override limits. Unknown fields
 * are rejected. Throws Error("...") on any problem; CLI turns that
 * into a non-zero startup failure with no stdout JSON.
 */
export function loadConfig(configPath: string): AppConfig {
  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf8");
  } catch (e) {
    throw new Error(
      `cannot read config file: ${e instanceof Error ? e.message : String(e)}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("config file is not valid JSON");
  }
  if (!isPlainObject(parsed)) throw new Error("config root must be an object");
  for (const k of Object.keys(parsed)) {
    if (!(TOP_KEYS as readonly string[]).includes(k)) {
      throw new Error(`unknown config field: ${k}`);
    }
  }
  const { dbPath, allowedScopes, candidateTtlSec, limits, timeouts, dbMaxBytes } =
    parsed;

  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("dbPath must be a non-empty string");
  }
  if (dbPath.includes("\u0000")) throw new Error("dbPath is invalid");

  if (!Array.isArray(allowedScopes) || allowedScopes.length === 0) {
    throw new Error("allowedScopes must be a non-empty array");
  }
  if (allowedScopes.length > 64) {
    throw new Error("allowedScopes must have at most 64 entries");
  }
  const seen = new Set<string>();
  for (const s of allowedScopes) {
    const err = checkScopeString(s);
    if (err) throw new Error(`allowedScopes: ${err}`);
    if (seen.has(s as string)) throw new Error("allowedScopes has duplicates");
    seen.add(s as string);
  }

  let err = checkRange("candidateTtlSec", candidateTtlSec, 1, 31536000);
  if (err) throw new Error(err);

  if (!isPlainObject(limits)) throw new Error("limits must be an object");
  for (const k of Object.keys(limits)) {
    if (!(LIMIT_KEYS as readonly string[]).includes(k)) {
      throw new Error(`unknown limits field: ${k}`);
    }
  }
  const lim = limits as Record<string, unknown>;
  const checks: Array<[string, number, number]> = [
    ["bodyMaxCp", 1, 10000],
    ["queryMaxCp", 1, 2000],
    ["tagsMax", 0, 16],
    ["limitDefault", 1, 100],
    ["limitMax", 1, 100],
    ["snippetMaxCp", 1, 1000],
    ["responseMaxBytes", 1024, 65536],
  ];
  for (const [name, min, max] of checks) {
    if (!(name in lim)) throw new Error(`limits.${name} is missing`);
    const e2 = checkRange(`limits.${name}`, lim[name], min, max);
    if (e2) throw new Error(e2);
  }
  const limitDefault = lim["limitDefault"] as number;
  const limitMax = lim["limitMax"] as number;
  if (limitDefault > limitMax) {
    throw new Error("limits.limitDefault must be <= limits.limitMax");
  }

  if (!isPlainObject(timeouts)) throw new Error("timeouts must be an object");
  for (const k of Object.keys(timeouts)) {
    if (!(TIMEOUT_KEYS as readonly string[]).includes(k)) {
      throw new Error(`unknown timeouts field: ${k}`);
    }
  }
  const to = timeouts as Record<string, unknown>;
  err = checkRange("timeouts.cliMs", to["cliMs"], 100, 60000);
  if (err) throw new Error(err);
  err = checkRange("timeouts.busyMs", to["busyMs"], 100, 10000);
  if (err) throw new Error(err);

  err = checkRange("dbMaxBytes", dbMaxBytes, 1048576, 1073741824);
  if (err) throw new Error(err);

  return {
    dbPath: dbPath as string,
    allowedScopes: allowedScopes as string[],
    candidateTtlSec: candidateTtlSec as number,
    limits: {
      bodyMaxCp: lim["bodyMaxCp"] as number,
      queryMaxCp: lim["queryMaxCp"] as number,
      tagsMax: lim["tagsMax"] as number,
      limitDefault: limitDefault,
      limitMax: limitMax,
      snippetMaxCp: lim["snippetMaxCp"] as number,
      responseMaxBytes: lim["responseMaxBytes"] as number,
    },
    timeouts: {
      cliMs: to["cliMs"] as number,
      busyMs: to["busyMs"] as number,
    },
    dbMaxBytes: dbMaxBytes as number,
  };
}

/** Resolve dbPath relative to the config file directory. */
export function resolveDbPath(configPath: string, dbPath: string): string {
  if (path.isAbsolute(dbPath)) return dbPath;
  return path.resolve(path.dirname(path.resolve(configPath)), dbPath);
}
