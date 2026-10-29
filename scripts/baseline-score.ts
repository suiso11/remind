/**
 * R13 M1 synthetic baseline pure scoring (no I/O, no CLI, no store).
 * Honest denominators, no thresholds, no semantic completion claims.
 */

export const SCORE_K = 3;

export interface PositiveScore {
  hits: number;
  pAt3: number;
  recall: number;
  rr: number;
  firstRank: number | null;
}

export interface ValidatedIds {
  ok: true;
  ids: string[];
}

export interface InvalidIds {
  ok: false;
  reason: string;
}

import { MESSAGES, UNSUPPORTED_PROTOCOL_VERSION, type ErrorCode } from "../src/protocol.js";

/** Intersection size of ordered-unique returned vs gold (both actual IDs). */
export function scorePositive(
  returnedIds: string[],
  goldIds: string[],
  k: number = SCORE_K,
): PositiveScore {
  const goldSet = new Set(goldIds);
  let hits = 0;
  let firstRank: number | null = null;
  const bound = Math.min(returnedIds.length, k);
  for (let i = 0; i < bound; i++) {
    const id = returnedIds[i] as string;
    if (goldSet.has(id)) {
      hits += 1;
      if (firstRank === null) firstRank = i + 1;
    }
  }
  const pAt3 = hits / k;
  const recall = goldIds.length === 0 ? (returnedIds.length === 0 ? 1 : 0) : hits / goldIds.length;
  const rr = firstRank === null ? 0 : 1 / firstRank;
  return { hits, pAt3, recall, rr, firstRank };
}

/** Actual response validator: <=k, unique, non-empty strings. Duplicates INVALID. */
export function validateReturnedIds(
  ids: unknown,
  k: number = SCORE_K,
): ValidatedIds | InvalidIds {
  if (!Array.isArray(ids)) return { ok: false, reason: "not-array" };
  if (ids.length > k) return { ok: false, reason: "over-limit" };
  const seen = new Set<string>();
  for (const v of ids) {
    if (typeof v !== "string" || v.length === 0 || v.length > 256) {
      return { ok: false, reason: "bad-id" };
    }
    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001F\u007F-\u009F]/.test(v)) return { ok: false, reason: "bad-id" };
    if (seen.has(v)) return { ok: false, reason: "duplicate" };
    seen.add(v);
  }
  return { ok: true, ids: [...seen] };
}

export function hasDuplicateIds(ids: string[]): boolean {
  return new Set(ids).size !== ids.length;
}

/**
 * Invariant check: every returned ID must be a known ACTIVE same-scope ID.
 * Unknown / foreign / non-active (superseded/archived) => explicit invariant
 * failure. Unrelated ACTIVE IDs are valid false positives, NOT failures.
 */
export function findInvariantViolations(
  returnedIds: string[],
  activeIds: Set<string>,
): string[] {
  const bad: string[] = [];
  for (const id of returnedIds) {
    if (!activeIds.has(id)) bad.push(id);
  }
  return bad;
}

export type NegativeOutcome = "validEmpty" | "validNonempty" | "failure";

export interface NegativeClass {
  outcome: NegativeOutcome;
  pAt3: null;
  recall: null;
  rr: null;
}

/** Negative quality metrics are always null and excluded from positive averages. */
export function classifyNegative(args: {
  transportFailed: boolean;
  ok: boolean;
  itemsCount: number | null;
}): NegativeClass {
  if (args.transportFailed || !args.ok || args.itemsCount === null) {
    return { outcome: "failure", pAt3: null, recall: null, rr: null };
  }
  if (args.itemsCount === 0) return { outcome: "validEmpty", pAt3: null, recall: null, rr: null };
  return { outcome: "validNonempty", pAt3: null, recall: null, rr: null };
}

export interface PositiveAggregate {
  count: number;
  failed: number;
  meanPAt3: number;
  meanRecall: number;
  meanRR: number;
}

/**
 * Failed/timeout/invalid positives score ZERO but stay in the denominator.
 */
export function aggregatePositive(
  entries: Array<{ failed: boolean; pAt3: number; recall: number; rr: number }>,
): PositiveAggregate {
  const count = entries.length;
  if (count === 0) return { count: 0, failed: 0, meanPAt3: 0, meanRecall: 0, meanRR: 0 };
  let failed = 0;
  let sP = 0;
  let sR = 0;
  let sRR = 0;
  for (const e of entries) {
    if (e.failed) failed += 1;
    sP += e.failed ? 0 : e.pAt3;
    sR += e.failed ? 0 : e.recall;
    sRR += e.failed ? 0 : e.rr;
  }
  return {
    count,
    failed,
    meanPAt3: sP / count,
    meanRecall: sR / count,
    meanRR: sRR / count,
  };
}

export interface LatencyStats {
  count: number;
  min: number;
  mean: number;
  median: number;
  p95: number;
  max: number;
}

/**
 * Successful/all/failure separate stats. Even median = avg of two middles.
 * Nearest-rank p95 = sorted[ceil(.95*n)-1]. Empty => null. Failed elapsed
 * must NOT be mixed into success stats (caller partitions).
 */
export function latencyStats(values: number[]): LatencyStats | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const min = sorted[0] as number;
  const max = sorted[n - 1] as number;
  const mean = sorted.reduce((a, b) => a + b, 0) / n;
  let median: number;
  if (n % 2 === 1) {
    median = sorted[(n - 1) / 2] as number;
  } else {
    median = (((sorted[n / 2 - 1] as number) + (sorted[n / 2] as number)) / 2);
  }
  const rank = Math.ceil(0.95 * n) - 1;
  const p95 = sorted[Math.min(Math.max(rank, 0), n - 1)] as number;
  return { count: n, min, mean, median, p95, max };
}

export interface NegativeFractions {
  total: number;
  validEmpty: number;
  validNonempty: number;
  failure: number;
  fracValidEmpty: number;
  fracValidNonempty: number;
  fracFailure: number;
}

export function negativeFractions(outcomes: NegativeOutcome[]): NegativeFractions {
  const total = outcomes.length;
  let validEmpty = 0;
  let validNonempty = 0;
  let failure = 0;
  for (const o of outcomes) {
    if (o === "validEmpty") validEmpty += 1;
    else if (o === "validNonempty") validNonempty += 1;
    else failure += 1;
  }
  const frac = (x: number): number => (total === 0 ? 0 : x / total);
  return {
    total,
    validEmpty,
    validNonempty,
    failure,
    fracValidEmpty: frac(validEmpty),
    fracValidNonempty: frac(validNonempty),
    fracFailure: frac(failure),
  };
}

/* ---- R13 review: strict consumer-side envelope + recall-data validators ----
 * Pure (no I/O/CLI). Reuses existing protocol definitions (MESSAGES/ErrorCode)
 * and the adopted fake-adapter recall contract (data {recallId,items},
 * items [{id,snippet,truncated,tags,createdAt}]). No API/store/schema change.
 */

const ALLOWED_CODES: ReadonlySet<string> = new Set<string>([
  "OK",
  "BAD_REQUEST",
  "NOT_FOUND",
  "CONFLICT",
  "FORBIDDEN_SCOPE",
  "STORE_UNAVAILABLE",
  "LIMIT_EXCEEDED",
  "TIMEOUT",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (n < 0xdc00 || n > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function validRecallId(s: unknown): s is string {
  return (
    typeof s === "string" &&
    s.length >= 1 &&
    s.length <= 256 &&
    !CONTROL_RE.test(s) &&
    !hasLoneSurrogate(s)
  );
}

function isCanonicalUtcMs(s: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s)) return false;
  const ms = Date.parse(s);
  if (!Number.isFinite(ms)) return false;
  try {
    return new Date(ms).toISOString() === s;
  } catch {
    return false;
  }
}

export interface RecallItem {
  id: string;
  snippet: string;
  truncated: boolean;
  tags: string[];
  createdAt: string;
  /** Additive F-I01-01 record-identity fields (optional). */
  revision?: number;
  kind?: string;
  /** v13 evidence quote (optional; null/absent for non-user_fact rows). */
  evidence?: string | null;
}

function validRecallItem(v: unknown): v is RecallItem {
  if (!isPlainObject(v)) return false;
  // Adopted contract fields plus the additive F-I01-01 keys (revision, kind
  // optional) and the v13 evidence quote. Unknown extras beyond that set
  // remain rejected.
  const keys = Object.keys(v).sort().join(",");
  if (
    keys !== "createdAt,id,snippet,tags,truncated" &&
    keys !== "createdAt,id,kind,revision,snippet,tags,truncated" &&
    keys !== "createdAt,evidence,id,kind,revision,snippet,tags,truncated"
  ) {
    return false;
  }
  if (v["revision"] !== undefined && typeof v["revision"] !== "number") return false;
  if (v["kind"] !== undefined && typeof v["kind"] !== "string") return false;
  if (v["evidence"] !== undefined && v["evidence"] !== null) {
    const ev = v["evidence"];
    if (typeof ev !== "string" || [...ev].length > 400 || CONTROL_RE.test(ev) || hasLoneSurrogate(ev)) {
      return false;
    }
  }
  if (!validRecallId(v["id"])) return false;
  if (typeof v["snippet"] !== "string" || [...(v["snippet"] as string)].length > 200) return false;
  if (hasLoneSurrogate(v["snippet"] as string)) return false;
  if (typeof v["truncated"] !== "boolean") return false;
  if (!Array.isArray(v["tags"])) return false;
  const tags = v["tags"] as unknown[];
  if (tags.length > 5) return false;
  for (const t of tags) {
    if (typeof t !== "string" || [...t].length < 1 || [...t].length > 256 || CONTROL_RE.test(t)) return false;
    if (hasLoneSurrogate(t)) return false;
  }
  if (typeof v["createdAt"] !== "string" || !isCanonicalUtcMs(v["createdAt"] as string)) return false;
  return true;
}

export type EnvelopeCheck =
  | { ok: true; v: 1; success: boolean; code: ErrorCode }
  | { ok: false; reason: string };

/**
 * Strict consumer-side envelope value check. Caller already verified the
 * 6 key names; this verifies v/ok/code/message/deduplicated VALUES via the
 * existing protocol MESSAGES table plus success/error shape consistency
 * (success => data is a plain object; error => data is null).
 */
export function validateEnvelopeValues(parsed: Record<string, unknown>): EnvelopeCheck {
  if ((parsed as { v?: unknown }).v !== 1) return { ok: false, reason: "bad-v" };
  if (typeof parsed["ok"] !== "boolean") return { ok: false, reason: "bad-ok" };
  if (typeof parsed["deduplicated"] !== "boolean") return { ok: false, reason: "bad-deduplicated" };
  const code = parsed["code"];
  if (typeof code !== "string" || !ALLOWED_CODES.has(code)) return { ok: false, reason: "bad-code" };
  if (typeof parsed["message"] !== "string") return { ok: false, reason: "bad-message" };
  // F-I01-07: BAD_REQUEST may carry the fixed protocol-version-mismatch
  // message instead of the plain table message (shared constant with the
  // emitter); every other code must match its table entry exactly.
  const expectedMessages =
    code === "BAD_REQUEST"
      ? [(MESSAGES as Record<string, string>).BAD_REQUEST, UNSUPPORTED_PROTOCOL_VERSION]
      : [(MESSAGES as Record<string, string>)[code]];
  if (!expectedMessages.includes(parsed["message"] as string)) {
    return { ok: false, reason: "bad-message" };
  }
  const success = parsed["ok"] === true;
  if (success) {
    if (code !== "OK") return { ok: false, reason: "ok-code-mismatch" };
    if (!isPlainObject(parsed["data"])) return { ok: false, reason: "bad-data" };
  } else {
    if (code === "OK") return { ok: false, reason: "ok-code-mismatch" };
    if (parsed["data"] !== null) return { ok: false, reason: "bad-data" };
  }
  return { ok: true, v: 1, success, code: code as ErrorCode };
}

/** F-I01-06 fixed availability states the recall `vector` field may take. */
const VECTOR_STATES = new Set(["used", "disabled", "unavailable"]);

export type RecallDataCheck =
  | { ok: true; recallId: string; items: RecallItem[] }
  | { ok: false; reason: string };

/**
 * Recall data contract check BEFORE any map: data must be {recallId,items}
 * (exactly, per adopted adapter contract), recallId a real id string,
 * items a real array, every item the real 5-field shape. Missing/null
 * data or items is INVALID (never a fake valid empty); null items inside
 * the array are invalid, not mappable. When the additive F-I01-06 `vector`
 * availability key is present it must be one of the fixed enum states
 * used|disabled|unavailable; any other value is invalid, not mappable.
 */
export function validateRecallData(data: unknown): RecallDataCheck {
  if (!isPlainObject(data)) return { ok: false, reason: "bad-data" };
  // F-I01-06 additive top-level `vector` availability field is accepted.
  const dataKeys = Object.keys(data).sort().join(",");
  if (dataKeys !== "items,recallId" && dataKeys !== "items,recallId,vector") {
    return { ok: false, reason: "bad-data" };
  }
  if (dataKeys === "items,recallId,vector") {
    const v = data["vector"];
    if (typeof v !== "string" || !VECTOR_STATES.has(v)) {
      return { ok: false, reason: "bad-vector" };
    }
  }
  if (!validRecallId(data["recallId"])) return { ok: false, reason: "bad-recallId" };
  if (!Array.isArray(data["items"])) return { ok: false, reason: "bad-items" };
  const items = data["items"] as unknown[];
  for (const it of items) {
    if (!validRecallItem(it)) return { ok: false, reason: "bad-item" };
  }
  return { ok: true, recallId: data["recallId"] as string, items: items as RecallItem[] };
}
