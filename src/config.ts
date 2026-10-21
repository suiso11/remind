import * as fs from "node:fs";
import * as path from "node:path";

export interface LimitsConfig {
  bodyMaxCp: number;
  queryMaxCp: number;
  tagsMax: number;
  linksMax: number;
  sourceRefsMax: number;
  limitDefault: number;
  limitMax: number;
  snippetMaxCp: number;
  responseMaxBytes: number;
  /**
   * P1 raw-read bounds. Optional in the interface so existing programmatic
   * configs keep compiling; loadConfig fills the documented defaults.
   */
  rawBodyMaxCp?: number;
  rawPageMaxCp?: number;
  rangeLimitMax?: number;
}

export interface TimeoutsConfig {
  cliMs: number;
  busyMs: number;
}

export interface VectorsConfig {
  modelDir: string;
  topK: number;
  timeoutMs: number;
  enabled: boolean;
}

/**
 * M3 cultivation bounds (U5 implementation choices, startup-only).
 * All optional: absent preserves existing behavior (queue still functions
 * with defaults; no model is required by this slice).
 */
export interface CultivationConfig {
  /** Max pending+leased review rows (default 500). Enqueue beyond drops, never fails the canonical write. */
  queueMax: number;
  /** Max actions per applyCultivationBatch call (default 20). */
  batchMax: number;
  /** Single-flight lease TTL in ms (default 120000). Expired leases are reclaimable (crash support). */
  leaseTtlMs: number;
  /** Max retries per queued review before it is marked failed (default 5). */
  reviewMaxAttempts: number;
}

export interface LlmConfig {
  modelDir: string;
  timeoutMs: number;
  enabled: boolean;
  /** Max new tokens per generation (default 48). */
  maxNewTokens: number;
  /** Max prompt characters per inference (default 2000). */
  maxPromptChars: number;
}

export interface MaintenanceConfig {
  /** Whole-operation deadline for maintain.distill in ms (default 120000). */
  timeoutMs: number;
}

/**
 * P2 episode derivation bounds (startup-only, optional). Absent uses the
 * documented defaults. utcOffsetMinutes only shifts the `day` episode key;
 * stored timestamps stay canonical UTC.
 */
export interface EpisodesConfig {
  /** Local-day offset from UTC in minutes (default 0). */
  utcOffsetMinutes: number;
  /** Max code points of raw events folded into one window (default 1200). */
  windowMaxCp: number;
  /** Max new tokens per episode summary generation (default 128). */
  maxNewTokens: number;
  /** Max episodes processed per batch (default 5). */
  batchMax: number;
}

export interface AppConfig {
  dbPath: string;
  vaultPath: string;
  allowedScopes: string[];
  limits: LimitsConfig;
  timeouts: TimeoutsConfig;
  dbMaxBytes: number;
  /** M2 semantic vectors (optional; absent preserves M1 behavior with offline fallback). */
  vectors?: VectorsConfig;
  /** M3 cultivation queue/lease bounds (optional; absent uses defaults, no model required). */
  cultivation?: CultivationConfig;
  /** M3 local LLM runtime (optional; absent/disabled keeps distill degraded + fast). */
  llm?: LlmConfig;
  /** M3 maintenance deadline (optional; absent uses the default long budget). */
  maintenance?: MaintenanceConfig;
  /** P2 episode derivation bounds (optional; absent uses documented defaults). */
  episodes?: EpisodesConfig;
  /**
   * F-I01-05 (optional boolean, default false): when true, event.append and
   * record.remember without a `privacy` object are BAD_REQUEST (no side
   * effects). Backward-compatible: absent preserves current behavior.
   */
  requirePrivacy?: boolean;
}

const TOP_KEYS = [
  "dbPath",
  "vaultPath",
  "allowedScopes",
  "limits",
  "timeouts",
  "dbMaxBytes",
  "vectors",
  "cultivation",
  "llm",
  "maintenance",
  "episodes",
  "requirePrivacy",
] as const;
const LIMIT_KEYS = [
  "bodyMaxCp",
  "queryMaxCp",
  "tagsMax",
  "linksMax",
  "sourceRefsMax",
  "limitDefault",
  "limitMax",
  "snippetMaxCp",
  "responseMaxBytes",
  "rawBodyMaxCp",
  "rawPageMaxCp",
  "rangeLimitMax",
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
 * Strict startup config loader (M1). Only the config file supplies values;
 * env vars and request JSON can never override limits. `vaultPath` (local
 * Markdown projection target) is REQUIRED: missing/empty is a startup
 * failure. Unknown fields are rejected. Throws Error("...") on any problem;
 * CLI turns that into a non-zero startup failure with no stdout JSON.
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
  const { dbPath, vaultPath, allowedScopes, limits, timeouts, dbMaxBytes } =
    parsed;

  if (typeof dbPath !== "string" || dbPath.length === 0) {
    throw new Error("dbPath must be a non-empty string");
  }
  if (dbPath.includes("\u0000")) throw new Error("dbPath is invalid");
  if (typeof vaultPath !== "string" || vaultPath.length === 0) {
    throw new Error("vaultPath must be a non-empty string");
  }
  if (vaultPath.includes("\u0000")) throw new Error("vaultPath is invalid");

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
    ["linksMax", 0, 16],
    ["sourceRefsMax", 0, 16],
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
  const rawBodyMaxCpRaw = lim["rawBodyMaxCp"] ?? RAW_BODY_MAX_CP_DEFAULT;
  const eRb = checkRange("limits.rawBodyMaxCp", rawBodyMaxCpRaw, 1, 65536);
  if (eRb) throw new Error(eRb);
  const rawBodyMaxCp = rawBodyMaxCpRaw as number;
  const rawPageMaxCpRaw = lim["rawPageMaxCp"] ?? RAW_PAGE_MAX_CP_DEFAULT;
  const eRp = checkRange("limits.rawPageMaxCp", rawPageMaxCpRaw, 1, 65536);
  if (eRp) throw new Error(eRp);
  const rawPageMaxCp = rawPageMaxCpRaw as number;
  const rangeLimitMaxRaw = lim["rangeLimitMax"] ?? RANGE_LIMIT_MAX_DEFAULT;
  const eRl = checkRange("limits.rangeLimitMax", rangeLimitMaxRaw, 1, 1000);
  if (eRl) throw new Error(eRl);
  const rangeLimitMax = rangeLimitMaxRaw as number;
  if (limitDefault > rangeLimitMax) {
    throw new Error("limits.limitDefault must be <= limits.rangeLimitMax");
  }

  if (!isPlainObject(timeouts)) throw new Error("timeouts must be an object");
  for (const k of Object.keys(timeouts)) {
    if (!(TIMEOUT_KEYS as readonly string[]).includes(k)) {
      throw new Error(`unknown timeouts field: ${k}`);
    }
  }
  const to = timeouts as Record<string, unknown>;
  let err = checkRange("timeouts.cliMs", to["cliMs"], 100, 60000);
  if (err) throw new Error(err);
  err = checkRange("timeouts.busyMs", to["busyMs"], 100, 10000);
  if (err) throw new Error(err);

  err = checkRange("dbMaxBytes", dbMaxBytes, 1048576, 1073741824);
  if (err) throw new Error(err);

  let vectors: VectorsConfig | undefined;
  if ("vectors" in parsed && (parsed as Record<string, unknown>)["vectors"] !== undefined) {
    const v = (parsed as Record<string, unknown>)["vectors"];
    if (!isPlainObject(v)) throw new Error("vectors must be an object");
    for (const k of Object.keys(v)) {
      if (!["modelDir", "topK", "timeoutMs", "enabled"].includes(k)) {
        throw new Error(`unknown vectors field: ${k}`);
      }
    }
    const modelDir = v["modelDir"] ?? "./models/paraphrase-multilingual-MiniLM-L12-v2";
    if (typeof modelDir !== "string" || modelDir.length === 0 || modelDir.includes("\u0000")) {
      throw new Error("vectors.modelDir must be a non-empty string");
    }
    const topK = v["topK"] ?? 20;
    const eTop = checkRange("vectors.topK", topK, 1, 60);
    if (eTop) throw new Error(eTop);
    const timeoutMs = v["timeoutMs"] ?? 15000;
    const eTo = checkRange("vectors.timeoutMs", timeoutMs, 500, 60000);
    if (eTo) throw new Error(eTo);
    const enabled = v["enabled"] ?? true;
    if (typeof enabled !== "boolean") throw new Error("vectors.enabled must be a boolean");
    vectors = {
      modelDir: modelDir as string,
      topK: topK as number,
      timeoutMs: timeoutMs as number,
      enabled: enabled as boolean,
    };
  }

  let cultivation: CultivationConfig | undefined;
  if ("cultivation" in parsed && (parsed as Record<string, unknown>)["cultivation"] !== undefined) {
    const c = (parsed as Record<string, unknown>)["cultivation"];
    if (!isPlainObject(c)) throw new Error("cultivation must be an object");
    for (const k of Object.keys(c)) {
      if (!["queueMax", "batchMax", "leaseTtlMs", "reviewMaxAttempts"].includes(k)) {
        throw new Error(`unknown cultivation field: ${k}`);
      }
    }
    const queueMax = c["queueMax"] ?? CULTIVATION_DEFAULT_QUEUE_MAX;
    const eQ = checkRange("cultivation.queueMax", queueMax, 1, 10000);
    if (eQ) throw new Error(eQ);
    const batchMax = c["batchMax"] ?? CULTIVATION_DEFAULT_BATCH_MAX;
    const eB = checkRange("cultivation.batchMax", batchMax, 1, 50);
    if (eB) throw new Error(eB);
    const leaseTtlMs = c["leaseTtlMs"] ?? CULTIVATION_DEFAULT_LEASE_TTL_MS;
    const eL = checkRange("cultivation.leaseTtlMs", leaseTtlMs, 5000, 600000);
    if (eL) throw new Error(eL);
    const reviewMaxAttempts = c["reviewMaxAttempts"] ?? CULTIVATION_DEFAULT_REVIEW_MAX_ATTEMPTS;
    const eR = checkRange("cultivation.reviewMaxAttempts", reviewMaxAttempts, 1, 10);
    if (eR) throw new Error(eR);
    cultivation = {
      queueMax: queueMax as number,
      batchMax: batchMax as number,
      leaseTtlMs: leaseTtlMs as number,
      reviewMaxAttempts: reviewMaxAttempts as number,
    };
  }

  let llm: LlmConfig | undefined;
  if ("llm" in parsed && (parsed as Record<string, unknown>)["llm"] !== undefined) {
    const l = (parsed as Record<string, unknown>)["llm"];
    if (!isPlainObject(l)) throw new Error("llm must be an object");
    for (const k of Object.keys(l)) {
      if (!["modelDir", "timeoutMs", "enabled", "maxNewTokens", "maxPromptChars"].includes(k)) {
        throw new Error(`unknown llm field: ${k}`);
      }
    }
    const modelDir = l["modelDir"] ?? LLM_DEFAULT_MODEL_DIR;
    if (typeof modelDir !== "string" || modelDir.length === 0 || modelDir.includes("\u0000")) {
      throw new Error("llm.modelDir must be a non-empty string");
    }
    const timeoutMs = l["timeoutMs"] ?? LLM_DEFAULT_TIMEOUT_MS;
    const eT = checkRange("llm.timeoutMs", timeoutMs, 500, 300000);
    if (eT) throw new Error(eT);
    const enabled = l["enabled"] ?? true;
    if (typeof enabled !== "boolean") throw new Error("llm.enabled must be a boolean");
    const maxNewTokens = l["maxNewTokens"] ?? LLM_DEFAULT_MAX_NEW_TOKENS;
    const eN = checkRange("llm.maxNewTokens", maxNewTokens, 1, 256);
    if (eN) throw new Error(eN);
    const maxPromptChars = l["maxPromptChars"] ?? LLM_DEFAULT_MAX_PROMPT_CHARS;
    const eP = checkRange("llm.maxPromptChars", maxPromptChars, 500, 8000);
    if (eP) throw new Error(eP);
    llm = {
      modelDir: modelDir as string,
      timeoutMs: timeoutMs as number,
      enabled: enabled as boolean,
      maxNewTokens: maxNewTokens as number,
      maxPromptChars: maxPromptChars as number,
    };
  }

  let maintenance: MaintenanceConfig | undefined;
  if ("maintenance" in parsed && (parsed as Record<string, unknown>)["maintenance"] !== undefined) {
    const m = (parsed as Record<string, unknown>)["maintenance"];
    if (!isPlainObject(m)) throw new Error("maintenance must be an object");
    for (const k of Object.keys(m)) {
      if (!["timeoutMs"].includes(k)) {
        throw new Error(`unknown maintenance field: ${k}`);
      }
    }
    const timeoutMs = m["timeoutMs"] ?? MAINTENANCE_DEFAULT_TIMEOUT_MS;
    const eT = checkRange("maintenance.timeoutMs", timeoutMs, 5000, 600000);
    if (eT) throw new Error(eT);
    maintenance = { timeoutMs: timeoutMs as number };
  }

  let episodes: EpisodesConfig | undefined;
  if ("episodes" in parsed && (parsed as Record<string, unknown>)["episodes"] !== undefined) {
    const ep = (parsed as Record<string, unknown>)["episodes"];
    if (!isPlainObject(ep)) throw new Error("episodes must be an object");
    for (const k of Object.keys(ep)) {
      if (!["utcOffsetMinutes", "windowMaxCp", "maxNewTokens", "batchMax"].includes(k)) {
        throw new Error(`unknown episodes field: ${k}`);
      }
    }
    const utcOffsetMinutes = ep["utcOffsetMinutes"] ?? EPISODES_DEFAULT_UTC_OFFSET_MINUTES;
    const eO = checkRange("episodes.utcOffsetMinutes", utcOffsetMinutes, -720, 840);
    if (eO) throw new Error(eO);
    const windowMaxCp = ep["windowMaxCp"] ?? EPISODES_DEFAULT_WINDOW_MAX_CP;
    const eW = checkRange("episodes.windowMaxCp", windowMaxCp, 200, 4000);
    if (eW) throw new Error(eW);
    const maxNewTokens = ep["maxNewTokens"] ?? EPISODES_DEFAULT_MAX_NEW_TOKENS;
    const eN = checkRange("episodes.maxNewTokens", maxNewTokens, 16, 256);
    if (eN) throw new Error(eN);
    const batchMax = ep["batchMax"] ?? EPISODES_DEFAULT_BATCH_MAX;
    const eB = checkRange("episodes.batchMax", batchMax, 1, 50);
    if (eB) throw new Error(eB);
    episodes = {
      utcOffsetMinutes: utcOffsetMinutes as number,
      windowMaxCp: windowMaxCp as number,
      maxNewTokens: maxNewTokens as number,
      batchMax: batchMax as number,
    };
  }

  let requirePrivacy: boolean | undefined;
  if ("requirePrivacy" in parsed && (parsed as Record<string, unknown>)["requirePrivacy"] !== undefined) {
    const rp = (parsed as Record<string, unknown>)["requirePrivacy"];
    if (typeof rp !== "boolean") throw new Error("requirePrivacy must be a boolean");
    requirePrivacy = rp;
  }

  return {
    dbPath: dbPath as string,
    vaultPath: vaultPath as string,
    allowedScopes: allowedScopes as string[],
    limits: {
      bodyMaxCp: lim["bodyMaxCp"] as number,
      queryMaxCp: lim["queryMaxCp"] as number,
      tagsMax: lim["tagsMax"] as number,
      linksMax: lim["linksMax"] as number,
      sourceRefsMax: lim["sourceRefsMax"] as number,
      limitDefault: limitDefault,
      limitMax: limitMax,
      snippetMaxCp: lim["snippetMaxCp"] as number,
      responseMaxBytes: lim["responseMaxBytes"] as number,
      rawBodyMaxCp,
      rawPageMaxCp,
      rangeLimitMax,
    },
    timeouts: {
      cliMs: to["cliMs"] as number,
      busyMs: to["busyMs"] as number,
    },
    dbMaxBytes: dbMaxBytes as number,
    ...(vectors ? { vectors } : {}),
    ...(cultivation ? { cultivation } : {}),
    ...(llm ? { llm } : {}),
    ...(maintenance ? { maintenance } : {}),
    ...(episodes ? { episodes } : {}),
    ...(requirePrivacy !== undefined ? { requirePrivacy } : {}),
  };
}

/** P1 raw-read defaults (applied when the limits keys are absent). */
export const RAW_BODY_MAX_CP_DEFAULT = 8000;
export const RAW_PAGE_MAX_CP_DEFAULT = 2000;
export const RANGE_LIMIT_MAX_DEFAULT = 50;

/** Resolved raw-read bounds for programmatic configs that omit the keys. */
export function rawBodyMaxCp(config: AppConfig): number {
  return config.limits.rawBodyMaxCp ?? RAW_BODY_MAX_CP_DEFAULT;
}
export function rawPageMaxCp(config: AppConfig): number {
  return config.limits.rawPageMaxCp ?? RAW_PAGE_MAX_CP_DEFAULT;
}
export function rangeLimitMax(config: AppConfig): number {
  return config.limits.rangeLimitMax ?? RANGE_LIMIT_MAX_DEFAULT;
}

/** M3 local-LLM + maintenance defaults (startup-only; documented in docs/retention.md). */
export const LLM_DEFAULT_MODEL_DIR = "./models/qwen25-15b-instruct";
export const LLM_DEFAULT_TIMEOUT_MS = 60000;
export const LLM_DEFAULT_MAX_NEW_TOKENS = 48;
export const LLM_DEFAULT_MAX_PROMPT_CHARS = 2000;
export const MAINTENANCE_DEFAULT_TIMEOUT_MS = 120000;

/** P2 episode defaults (startup-only; documented in memory.config.example.json). */
export const EPISODES_DEFAULT_UTC_OFFSET_MINUTES = 0;
export const EPISODES_DEFAULT_WINDOW_MAX_CP = 1200;
export const EPISODES_DEFAULT_MAX_NEW_TOKENS = 128;
export const EPISODES_DEFAULT_BATCH_MAX = 5;

export function episodesBounds(config: AppConfig): Required<EpisodesConfig> {
  return {
    utcOffsetMinutes:
      config.episodes?.utcOffsetMinutes ?? EPISODES_DEFAULT_UTC_OFFSET_MINUTES,
    windowMaxCp: config.episodes?.windowMaxCp ?? EPISODES_DEFAULT_WINDOW_MAX_CP,
    maxNewTokens: config.episodes?.maxNewTokens ?? EPISODES_DEFAULT_MAX_NEW_TOKENS,
    batchMax: config.episodes?.batchMax ?? EPISODES_DEFAULT_BATCH_MAX,
  };
}

export function llmBounds(config: AppConfig): Required<LlmConfig> {
  return {
    modelDir: config.llm?.modelDir ?? LLM_DEFAULT_MODEL_DIR,
    timeoutMs: config.llm?.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS,
    enabled: config.llm?.enabled ?? false,
    maxNewTokens: config.llm?.maxNewTokens ?? LLM_DEFAULT_MAX_NEW_TOKENS,
    maxPromptChars: config.llm?.maxPromptChars ?? LLM_DEFAULT_MAX_PROMPT_CHARS,
  };
}

export function maintenanceTimeoutMs(config: AppConfig): number {
  const t = config.maintenance?.timeoutMs ?? MAINTENANCE_DEFAULT_TIMEOUT_MS;
  return Number.isInteger(t) && t >= 5000 && t <= 600000 ? t : MAINTENANCE_DEFAULT_TIMEOUT_MS;
}

/** M3 cultivation defaults (U5 implementation choices; documented in docs/retention.md). */
export const CULTIVATION_DEFAULT_QUEUE_MAX = 500;
export const CULTIVATION_DEFAULT_BATCH_MAX = 20;
export const CULTIVATION_DEFAULT_LEASE_TTL_MS = 120000;
export const CULTIVATION_DEFAULT_REVIEW_MAX_ATTEMPTS = 5;

export function cultivationBounds(config: AppConfig): Required<CultivationConfig> {
  return {
    queueMax: config.cultivation?.queueMax ?? CULTIVATION_DEFAULT_QUEUE_MAX,
    batchMax: config.cultivation?.batchMax ?? CULTIVATION_DEFAULT_BATCH_MAX,
    leaseTtlMs: config.cultivation?.leaseTtlMs ?? CULTIVATION_DEFAULT_LEASE_TTL_MS,
    reviewMaxAttempts:
      config.cultivation?.reviewMaxAttempts ?? CULTIVATION_DEFAULT_REVIEW_MAX_ATTEMPTS,
  };
}

/**
 * F-I01-05 gate (default false): true only when the config explicitly sets
 * requirePrivacy to a boolean true.
 */
export function requirePrivacyEnabled(config: AppConfig): boolean {
  return config.requirePrivacy === true;
}

/** Resolve a config-relative path against the config file directory. */
export function resolveConfigDirPath(configPath: string, p: string): string {
  if (path.isAbsolute(p)) return p;
  return path.resolve(path.dirname(path.resolve(configPath)), p);
}

/** Resolve dbPath relative to the config file directory. */
export function resolveDbPath(configPath: string, dbPath: string): string {
  return resolveConfigDirPath(configPath, dbPath);
}

/** Resolve vaultPath relative to the config file directory. */
export function resolveVaultPath(
  configPath: string,
  vaultPath: string,
): string {
  return resolveConfigDirPath(configPath, vaultPath);
}
