/**
 * Shared retention model: nature labels, scoring parameters, weight shapes,
 * and the pure factor computation helpers.
 *
 * Both activation.ts (scoring, preview, maintenance) and retention_learn.ts
 * (harvest, fit) depend on this module. It imports nothing from either, which
 * keeps the activation <-> learner dependency acyclic: activation may import
 * the learner directly, and the learner only imports this shared model.
 */

/** Record status values the activation model understands. */
export type ActivationStatus = "active" | "retired" | "superseded" | "archived";

/** Record kinds the retention score distinguishes. */
export type ActivationKind =
  | "user_fact"
  | "model_inference"
  | "summary"
  | "correction";

/** Nature labels produced by the combined retention classifier. */
export const NATURE_LABELS = [
  "FACT",
  "PREFERENCE",
  "OPINION",
  "PLAN",
  "EVENT",
  "RELATIONSHIP",
  "PROJECT",
  "EMOTION",
  "TRANSIENT",
  "GREETING",
  "CHATOPS",
] as const;
export type NatureLabel = (typeof NATURE_LABELS)[number];

export interface ActivationParams {
  decay: number;
  tauRetire: number;
  tauReactivate: number;
  minAgeHours: number;
  wImportance: number;
  wKind: Record<ActivationKind, number>;
  wNature: Record<NatureLabel, number>;
  wLinks: number;
  expiryGraceDays: number;
  wExpired: number;
  wConsolidated: number;
  minAgeHoursByNature: Partial<Record<NatureLabel, number>>;
}

export const ACTIVATION_DEFAULTS: ActivationParams = {
  decay: 0.5,
  tauRetire: -1.5,
  tauReactivate: -0.5,
  minAgeHours: 72,
  wImportance: 2.0,
  wKind: {
    user_fact: 1.0,
    model_inference: 0.0,
    summary: 0.3,
    correction: 1.0,
  },
  wNature: {
    FACT: 1.0,
    PREFERENCE: 1.0,
    RELATIONSHIP: 1.2,
    PROJECT: 1.0,
    OPINION: 0.6,
    PLAN: 0.6,
    EVENT: 0.4,
    EMOTION: -0.8,
    TRANSIENT: -1.5,
    GREETING: -2.5,
    CHATOPS: -2.0,
  },
  wLinks: 0.8,
  expiryGraceDays: 3,
  wExpired: 2.0,
  wConsolidated: 0.5,
  minAgeHoursByNature: {
    GREETING: 24,
    CHATOPS: 24,
    EMOTION: 72,
    TRANSIENT: 72,
  },
};

/** Convert an ISO string / epoch value / Date to epoch ms, or null. */
export function toMs(value: string | number | Date): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

/** Clamp to [0,1]; non-finite values use the neutral 0.5. */
export function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/** Latest absolute date in the body (UTC midnight), or null if none. */
export function latestAbsoluteDateMs(body: string): number | null {
  let latest: number | null = null;
  const consider = (y: number, m: number, d: number): void => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const ms = Date.UTC(y, m - 1, d);
    const dt = new Date(ms);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return;
    if (latest === null || ms > latest) latest = ms;
  };
  for (const m of body.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    consider(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of body.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/g)) {
    consider(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return latest;
}

/**
 * Deterministic date expiry signal: only PLAN/EVENT/TRANSIENT bodies are
 * considered. True when the latest absolute date (YYYY-MM-DD or
 * YYYY年M月D日) is strictly more than `graceDays` before now.
 */
export function isExpiredDated(
  body: string,
  nature: NatureLabel | null,
  now: string | number | Date,
  graceDays: number,
): boolean {
  if (nature !== "PLAN" && nature !== "EVENT" && nature !== "TRANSIENT") return false;
  const nowMs = toMs(now);
  const latest = latestAbsoluteDateMs(body);
  if (nowMs === null || latest === null) return false;
  return nowMs - latest > graceDays * 86_400_000;
}

/** The input shape the retention factors actually read. */
export interface RetentionFactorInput {
  kind: ActivationKind;
  createdAt: string;
  importance: number | null;
  eventTimes: ReadonlyArray<string>;
  nature?: NatureLabel | null;
  links?: number;
  expired?: boolean;
  consolidated?: boolean;
}

export interface RetentionFactors {
  base: number;
  kind: number;
  importance: number;
  nature: number;
  links: number;
  expired: number;
  consolidated: number;
  total: number;
}

/**
 * Multi-factor retention factors. `base` is the ACT-R base-level activation
 * (createdAt + usage/feedback + predecessor usage + corrections +
 * reactivations, with decay d); the remaining factors are additive. Missing
 * optional signals contribute zero, except importance (neutral 0.5).
 * Invalid event timestamps are ignored; no usable event time yields -Infinity.
 */
export function computeRetentionFactors(
  input: RetentionFactorInput,
  params: ActivationParams,
  now: string | number | Date,
): RetentionFactors {
  const nowMs = toMs(now);
  if (nowMs === null) {
    return {
      base: Number.NaN,
      kind: 0,
      importance: 0,
      nature: 0,
      links: 0,
      expired: 0,
      consolidated: 0,
      total: Number.NaN,
    };
  }
  let sum = 0;
  const times: Array<string | number> = [input.createdAt, ...input.eventTimes];
  for (const t of times) {
    const ms = toMs(t);
    if (ms === null) continue;
    const hours = Math.max((nowMs - ms) / 3_600_000, 1);
    sum += Math.pow(hours, -params.decay);
  }
  const base = sum <= 0 ? Number.NEGATIVE_INFINITY : Math.log(sum);
  const importanceValue = clamp01(input.importance ?? 0.5);
  const kind = params.wKind[input.kind] ?? 0;
  const importance = params.wImportance * importanceValue;
  const nature = input.nature ? params.wNature[input.nature] ?? 0 : 0;
  const linkCount = Math.max(0, input.links ?? 0);
  const links = params.wLinks * Math.log(1 + linkCount);
  const expired = input.expired === true ? -params.wExpired : 0;
  const consolidated =
    input.consolidated === true && importanceValue < 2 / 3 ? -params.wConsolidated : 0;
  return {
    base,
    kind,
    importance,
    nature,
    links,
    expired,
    consolidated,
    total: base + kind + importance + nature + links + expired + consolidated,
  };
}

/** Total retention score R (sum of computeRetentionFactors). */
export function computeActivation(
  input: RetentionFactorInput,
  params: ActivationParams,
  now: string | number | Date,
): number {
  return computeRetentionFactors(input, params, now).total;
}

/**
 * Base-level activation at `ts` using only events strictly before it. This is
 * the leak-free feature used by the retention learner: the labeled usage at
 * the exposure's own recall happens at/after `ts` and is therefore excluded.
 * Returns -Infinity when the record did not exist yet at `ts`.
 */
export function baseActivationBefore(
  input: Pick<RetentionFactorInput, "createdAt" | "kind" | "importance" | "eventTimes">,
  params: ActivationParams,
  ts: string | number | Date,
): number {
  const tsMs = toMs(ts);
  const createdMs = toMs(input.createdAt);
  if (tsMs === null || createdMs === null || createdMs >= tsMs) {
    return Number.NEGATIVE_INFINITY;
  }
  const events = input.eventTimes.filter((t) => {
    const ms = toMs(t);
    return ms !== null && ms < tsMs;
  });
  return computeRetentionFactors(
    {
      createdAt: input.createdAt,
      kind: input.kind,
      importance: input.importance,
      eventTimes: events,
    },
    params,
    ts,
  ).base;
}

/** Flat parameter order: kind weights, nature weights, scalars. */
export const KIND_ORDER: readonly ActivationKind[] = [
  "user_fact",
  "model_inference",
  "summary",
  "correction",
] as const;
export const NATURE_ORDER: readonly NatureLabel[] = NATURE_LABELS;
export const W_KIND = 0;
export const W_NATURE = KIND_ORDER.length;
export const W_IMPORTANCE = W_NATURE + NATURE_ORDER.length;
export const W_LINKS = W_IMPORTANCE + 1;
export const W_EXPIRED = W_LINKS + 1;
export const W_CONSOLIDATED = W_EXPIRED + 1;
export const RETENTION_WEIGHT_COUNT = W_CONSOLIDATED + 1;

/** Nature labels that must stay non-positive (transient chatter penalty). */
export const NON_POSITIVE_NATURES = new Set<NatureLabel>([
  "GREETING",
  "CHATOPS",
  "TRANSIENT",
  "EMOTION",
]);
/** Scalars constrained to be non-negative. */
export const NON_NEGATIVE_INDICES = new Set<number>([
  W_IMPORTANCE,
  W_LINKS,
  W_EXPIRED,
  W_CONSOLIDATED,
]);
export const NON_POSITIVE_INDICES = new Set<number>(
  [...NON_POSITIVE_NATURES].map((label) => W_NATURE + NATURE_ORDER.indexOf(label)),
);

/** Learnable weights, aligned with the factor structure of computeRetentionFactors. */
export interface RetentionWeights {
  wKind: Record<ActivationKind, number>;
  wNature: Record<NatureLabel, number>;
  wImportance: number;
  wLinks: number;
  wExpired: number;
  wConsolidated: number;
}

/** Snapshot config/default weights as the learnable vector's object form. */
export function weightsFromParams(params: ActivationParams): RetentionWeights {
  const wNature = {} as Record<NatureLabel, number>;
  for (const label of NATURE_ORDER) wNature[label] = params.wNature[label] ?? 0;
  const wKind = {} as Record<ActivationKind, number>;
  for (const kind of KIND_ORDER) wKind[kind] = params.wKind[kind] ?? 0;
  return {
    wKind,
    wNature,
    wImportance: params.wImportance,
    wLinks: params.wLinks,
    wExpired: params.wExpired,
    wConsolidated: params.wConsolidated,
  };
}

/** Copy the learned weights onto an otherwise unchanged scoring parameter set. */
export function paramsWithWeights(
  params: ActivationParams,
  weights: RetentionWeights,
): ActivationParams {
  return {
    ...params,
    wKind: { ...weights.wKind },
    wNature: { ...weights.wNature },
    wImportance: weights.wImportance,
    wLinks: weights.wLinks,
    wExpired: weights.wExpired,
    wConsolidated: weights.wConsolidated,
  };
}

/** Flatten the weight object into the optimizer's parameter order. */
export function flattenWeights(w: RetentionWeights): number[] {
  const out: number[] = [];
  for (const kind of KIND_ORDER) out.push(w.wKind[kind]);
  for (const label of NATURE_ORDER) out.push(w.wNature[label]);
  out.push(w.wImportance, w.wLinks, w.wExpired, w.wConsolidated);
  return out;
}

/** Inverse of flattenWeights. */
export function unflattenWeights(v: readonly number[]): RetentionWeights {
  const wKind = {} as Record<ActivationKind, number>;
  for (let i = 0; i < KIND_ORDER.length; i++) wKind[KIND_ORDER[i]] = v[W_KIND + i];
  const wNature = {} as Record<NatureLabel, number>;
  for (let i = 0; i < NATURE_ORDER.length; i++) wNature[NATURE_ORDER[i]] = v[W_NATURE + i];
  return {
    wKind,
    wNature,
    wImportance: v[W_IMPORTANCE],
    wLinks: v[W_LINKS],
    wExpired: v[W_EXPIRED],
    wConsolidated: v[W_CONSOLIDATED],
  };
}
