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

/** Intersection size of ordered-unique returned vs gold (both actual IDs). */
export function scorePositive(
  returnedIds: string[],
  goldIds: string[],
  k: number = SCORE_K,
): PositiveScore {
  const goldSet = new Set(goldIds);
  let hits = 0;
  let firstRank: number | null = null;
  for (let i = 0; i < returnedIds.length; i++) {
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
