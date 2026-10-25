/**
 * Retention weight learner: PART A (harvest + feature snapshot).
 *
 * The learner turns recall outcomes into supervised examples without touching
 * canonical memory. Two label sources are harvested:
 *   - exposure outcomes: an exposures row older than the label horizon is a
 *     positive when a usage row exists for the same (recallId, recordId);
 *   - explicit user transitions from the audit ledger: USER_REQUESTED
 *     reactivation is positive, NO_LONGER_USEFUL retirement is negative.
 *
 * Features are snapshotted at the example timestamp. Base-level activation
 * uses ONLY events strictly before that timestamp (no leakage of the labeled
 * usage). The remaining signals (kind, nature, importance, links, expired,
 * consolidated) reuse the activation.ts loaders; nature/importance and links
 * are current-state approximations, documented in the snapshot.
 *
 * The optimizer/acceptance step is intentionally not part of this slice.
 */
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { activationBounds, retentionLearnBounds } from "./config.js";
import {
  baseActivationBefore,
  flattenWeights,
  isExpiredDated,
  paramsWithWeights,
  unflattenWeights,
  weightsFromParams,
  KIND_ORDER,
  NATURE_LABELS,
  NATURE_ORDER,
  NON_NEGATIVE_INDICES,
  NON_POSITIVE_INDICES,
  RETENTION_WEIGHT_COUNT,
  W_CONSOLIDATED,
  W_EXPIRED,
  W_IMPORTANCE,
  W_KIND,
  W_LINKS,
  W_NATURE,
  type ActivationKind,
  type ActivationParams,
  type NatureLabel,
  type RetentionWeights,
} from "./retention_model.js";
import { loadActivationInputs, type ActivationInput } from "./retention_inputs.js";

// Re-export the model helpers that belonged to this module before the split.
export {
  RETENTION_WEIGHT_COUNT,
  paramsWithWeights,
  weightsFromParams,
  type RetentionWeights,
} from "./retention_model.js";

/** Maximum new examples inserted by one harvest call. */
export const HARVEST_MAX_NEW = 2000;
/** Hard table cap; oldest rows are pruned after every harvest. */
export const RETENTION_EXAMPLES_MAX = 20000;
/** Weight of a calibrated exposure label. */
export const EXPOSURE_WEIGHT = 1;
/** Weight of an explicit user transition label. */
export const USER_TRANSITION_WEIGHT = 5;
export const USER_REACTIVATE_SOURCE = "user_reactivate";
export const USER_RETIRE_SOURCE = "user_retire";
export const EXPOSURE_SOURCE = "exposure";

/** Every audit op that can stage an active<->retired transition. */
const TRANSITION_OPS = [
  "record.retire",
  "record.reactivate",
  "maintain.cultivate",
  "maintain.cultivation",
  "maintain.distill",
  "maintain.activation",
] as const;

export interface HarvestResult {
  /** Rows inserted by this call. */
  harvested: number;
  /** Total examples currently stored. */
  examples: number;
  /** Total positively labeled examples currently stored. */
  positives: number;
}

export interface RetentionFeatureSnapshot {
  /** ACT-R base-level activation over events strictly before ts. */
  base: number | null;
  kind: ActivationKind;
  nature: NatureLabel | null;
  /** Current record_importance value (approximation; may be null/stale). */
  importance: number | null;
  /** ln-ready link mass: canonical active links + 0.5 * similar edges. */
  links: number;
  /** Expiry rule evaluated at ts. */
  expired: boolean;
  consolidated: boolean;
}

interface Candidate {
  recallId: string;
  recordId: string;
  source: string;
  ts: string;
  label: number;
  weight: number;
}

function snapshotFor(
  input: ActivationInput,
  ts: string,
  params: ReturnType<typeof activationBounds>,
): RetentionFeatureSnapshot {
  const base = baseActivationBefore(input, params, ts);
  return {
    base: Number.isFinite(base) ? base : null,
    kind: input.kind,
    nature: input.nature,
    importance: input.importance,
    links: input.links,
    expired: isExpiredDated(input.body, input.nature, ts, params.expiryGraceDays),
    consolidated: input.consolidated,
  };
}

/**
 * Feature snapshot for one record at `ts`. Returns null when the record does
 * not exist in this scope or ts is invalid.
 */
export function retentionFeatures(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  recordId: string,
  ts: string,
): RetentionFeatureSnapshot | null {
  if (!Number.isFinite(Date.parse(ts))) return null;
  const params = activationBounds(config);
  const inputs = loadActivationInputs(db, scope, {
    recordIds: [recordId],
    maxRecords: 1,
    now: ts,
    expiryGraceDays: params.expiryGraceDays,
  });
  const input = inputs.find((i) => i.recordId === recordId);
  if (input === undefined) return null;
  return snapshotFor(input, ts, params);
}

/**
 * Harvest up to HARVEST_MAX_NEW new labeled examples for a scope, then prune
 * the table to the newest RETENTION_EXAMPLES_MAX rows. Idempotent: existing
 * (recallId, recordId, source) rows are never relabeled.
 */
export function harvestRetentionExamples(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  now: string,
): HarvestResult {
  const empty = (): HarvestResult => {
    const row = db
      .prepare(
        `SELECT COUNT(*) AS n,
                COALESCE(SUM(CASE WHEN label > 0 THEN 1 ELSE 0 END), 0) AS p
           FROM retention_examples`,
      )
      .get() as { n: number; p: number };
    return { harvested: 0, examples: row.n, positives: row.p };
  };
  const nowMs = Date.parse(now);
  if (!Number.isFinite(nowMs)) return empty();
  const learn = retentionLearnBounds(config);
  const cutoff = new Date(nowMs - Math.max(0, learn.labelHorizonMs)).toISOString();

  const candidates: Candidate[] = [];
  const remainingSlots = (): number => HARVEST_MAX_NEW - candidates.length;

  // (a) Exposure outcomes whose label horizon has elapsed.
  const exposures = db
    .prepare(
      `SELECT e.recallId AS recallId, e.recordId AS recordId, MIN(e.ts) AS ts
         FROM exposures e
        WHERE e.scope = ?
          AND e.ts < ?
          AND NOT EXISTS (
            SELECT 1 FROM retention_examples x
             WHERE x.recallId = e.recallId
               AND x.recordId = e.recordId
               AND x.source = '${EXPOSURE_SOURCE}')
        GROUP BY e.recallId, e.recordId
        ORDER BY ts ASC
        LIMIT ?`,
    )
    .all(scope, cutoff, remainingSlots()) as unknown as Array<{
    recallId: string;
    recordId: string;
    ts: string;
  }>;
  const usedStmt = db.prepare(
    `SELECT 1 AS ok FROM usage WHERE scope = ? AND recallId = ? AND recordId = ? LIMIT 1`,
  );
  for (const row of exposures) {
    if (remainingSlots() <= 0) break;
    const used = usedStmt.get(scope, row.recallId, row.recordId) !== undefined;
    candidates.push({
      recallId: row.recallId,
      recordId: row.recordId,
      source: EXPOSURE_SOURCE,
      ts: row.ts,
      label: used ? 1 : 0,
      weight: EXPOSURE_WEIGHT,
    });
  }

  // (b) Explicit user transitions. 'audit:'+rowid is the stable recallId.
  const transitions = db
    .prepare(
      `SELECT a.rowid AS rid, a.targetId AS recordId, a.ts AS ts, a.reasonCode AS reasonCode
         FROM audit a
        WHERE a.scope = ?
          AND a.targetId IS NOT NULL
          AND a.ts <= ?
          AND a.op IN (${TRANSITION_OPS.map(() => "?").join(",")})
          AND a.reasonCode IN ('USER_REQUESTED','NO_LONGER_USEFUL')
          AND NOT EXISTS (
            SELECT 1 FROM retention_examples x
             WHERE x.recallId = 'audit:' || a.rowid
               AND x.recordId = a.targetId)
        ORDER BY a.ts ASC, a.rowid ASC
        LIMIT ?`,
    )
    .all(
      scope,
      now,
      ...TRANSITION_OPS,
      remainingSlots(),
    ) as unknown as Array<{
    rid: number;
    recordId: string;
    ts: string;
    reasonCode: string;
  }>;
  for (const row of transitions) {
    if (remainingSlots() <= 0) break;
    const positive = row.reasonCode === "USER_REQUESTED";
    candidates.push({
      recallId: `audit:${row.rid}`,
      recordId: row.recordId,
      source: positive ? USER_REACTIVATE_SOURCE : USER_RETIRE_SOURCE,
      ts: row.ts,
      label: positive ? 1 : 0,
      weight: USER_TRANSITION_WEIGHT,
    });
  }

  let harvested = 0;
  if (candidates.length > 0) {
    const params = activationBounds(config);
    const ids = [...new Set(candidates.map((c) => c.recordId))];
    const inputs = loadActivationInputs(db, scope, {
      recordIds: ids,
      maxRecords: ids.length,
      now,
      expiryGraceDays: params.expiryGraceDays,
    });
    const byId = new Map(inputs.map((i) => [i.recordId, i]));
    const insert = db.prepare(
      `INSERT OR IGNORE INTO retention_examples(
         recallId, recordId, source, ts, label, weight, features, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const candidate of candidates) {
      const input = byId.get(candidate.recordId);
      if (input === undefined) continue;
      const features = snapshotFor(input, candidate.ts, params);
      const res = insert.run(
        candidate.recallId,
        candidate.recordId,
        candidate.source,
        candidate.ts,
        candidate.label,
        candidate.weight,
        JSON.stringify(features),
        now,
      );
      if (Number(res.changes) > 0) harvested++;
    }
  }

  // Keep only the newest rows globally (derived ledger, safe to prune).
  db.prepare(
    `DELETE FROM retention_examples
      WHERE rowid NOT IN (
        SELECT rowid FROM retention_examples
         ORDER BY ts DESC, rowid DESC
         LIMIT ${RETENTION_EXAMPLES_MAX})`,
  ).run();

  const totals = db
    .prepare(
      `SELECT COUNT(*) AS n,
              COALESCE(SUM(CASE WHEN label > 0 THEN 1 ELSE 0 END), 0) AS p
         FROM retention_examples`,
    )
    .get() as { n: number; p: number };
  return { harvested, examples: totals.n, positives: totals.p };
}

/* ------------------------------------------------------------------ */
/* PART B: MAP logistic model over retention factors                   */
/* ------------------------------------------------------------------ */

/** Adam learning rate for every fit (full-batch, deterministic). */
export const LEARN_LR = 0.05;
/** Adam iterations for every fit. */
export const LEARN_ITERATIONS = 600;
/** Required new examples (createdAt > last attempt) before another fit. */
export const LEARN_MIN_NEW_EXAMPLES = 50;
/** Accept only when the holdout loss improves by more than this margin. */
export const LEARN_ACCEPT_MARGIN = 1e-4;
/** Lower clamp for the logistic scale `a`; the slope never flips sign. */
export const LEARN_MIN_SCALE = 0.05;

/** One labeled, feature-snapshotted training row. */
export interface RetentionTrainingExample {
  /** Leak-free ACT-R base activation; null snapshots are treated as 0. */
  base: number | null;
  kind: ActivationKind;
  nature: NatureLabel | null;
  importance: number | null;
  links: number;
  expired: boolean;
  consolidated: boolean;
  /** 1 = useful, 0 = not useful. */
  label: number;
  /** Sample weight (exposure 1, explicit user transition 5). */
  weight: number;
  /** Example timestamp, used for the time-ordered holdout split. */
  ts: string;
}

export interface RetentionFitBounds {
  /** L2-to-prior coefficient. */
  lambda: number;
  /** Maximum |w - prior| per weight after every projection. */
  maxDrift: number;
}

export interface RetentionFitResult {
  weights: RetentionWeights;
  /** Logistic slope a (clamped >= LEARN_MIN_SCALE). */
  scale: number;
  /** Logistic intercept b. */
  intercept: number;
  /** Weighted log-loss on the training set. */
  logLoss: number;
  /** Training objective: weighted log-loss + L2-to-prior. */
  objective: number;
}

/** Why a learner run was skipped (no retention_weights row in these cases). */
export type LearnSkipReason =
  | "disabled"
  | "interval"
  | "no-new-examples"
  | "min-examples"
  | "min-positives"
  | "deadline"
  | "error";

export interface LearnOutcome {
  attempted: boolean;
  accepted: boolean;
  /** retention_weights.version of the attempt row; null when skipped. */
  version: number | null;
  skipped: LearnSkipReason | null;
  examples: number;
  positives: number;
  train: number;
  holdout: number;
  trainLoss: number | null;
  holdoutLoss: number | null;
  baselineHoldoutLoss: number | null;
}

/** Weights currently used for scoring plus the accepted version (null = prior). */
export interface ActiveRetentionWeights {
  version: number | null;
  weights: RetentionWeights;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

function sigmoid(z: number): number {
  if (z >= 0) {
    const e = Math.exp(-z);
    return 1 / (1 + e);
  }
  const e = Math.exp(z);
  return e / (1 + e);
}

function parseStoredWeights(raw: string): RetentionWeights | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const wKind = o["wKind"];
    const wNature = o["wNature"];
    if (typeof wKind !== "object" || wKind === null) return null;
    if (typeof wNature !== "object" || wNature === null) return null;
    const kindObj = wKind as Record<string, unknown>;
    const natureObj = wNature as Record<string, unknown>;
    for (const kind of KIND_ORDER) {
      if (typeof kindObj[kind] !== "number" || !Number.isFinite(kindObj[kind])) return null;
    }
    for (const label of NATURE_ORDER) {
      if (typeof natureObj[label] !== "number" || !Number.isFinite(natureObj[label])) return null;
    }
    const scalars: number[] = [];
    for (const key of ["wImportance", "wLinks", "wExpired", "wConsolidated"]) {
      const value = o[key];
      if (typeof value !== "number" || !Number.isFinite(value)) return null;
      scalars.push(value);
    }
    return {
      wKind: kindObj as unknown as Record<ActivationKind, number>,
      wNature: natureObj as unknown as Record<NatureLabel, number>,
      wImportance: scalars[0],
      wLinks: scalars[1],
      wExpired: scalars[2],
      wConsolidated: scalars[3],
    };
  } catch {
    return null;
  }
}

interface PreparedExample {
  base: number;
  label: number;
  weight: number;
  idx: number[];
  val: number[];
}

function prepareExample(ex: RetentionTrainingExample): PreparedExample {
  const idx: number[] = [];
  const val: number[] = [];
  const kindIndex = KIND_ORDER.indexOf(ex.kind);
  if (kindIndex >= 0) {
    idx.push(W_KIND + kindIndex);
    val.push(1);
  }
  if (ex.nature !== null) {
    const natureIndex = NATURE_ORDER.indexOf(ex.nature);
    if (natureIndex >= 0) {
      idx.push(W_NATURE + natureIndex);
      val.push(1);
    }
  }
  const importanceValue = clamp01(ex.importance ?? 0.5);
  idx.push(W_IMPORTANCE);
  val.push(importanceValue);
  idx.push(W_LINKS);
  val.push(Math.log(1 + Math.max(0, ex.links)));
  if (ex.expired) {
    idx.push(W_EXPIRED);
    val.push(-1);
  }
  if (ex.consolidated && importanceValue < 2 / 3) {
    idx.push(W_CONSOLIDATED);
    val.push(-1);
  }
  return {
    base: ex.base !== null && Number.isFinite(ex.base) ? ex.base : 0,
    label: ex.label > 0.5 ? 1 : 0,
    weight: Number.isFinite(ex.weight) && ex.weight > 0 ? ex.weight : 1,
    idx,
    val,
  };
}

function dot(w: readonly number[], ex: PreparedExample): number {
  let sum = ex.base;
  for (let i = 0; i < ex.idx.length; i++) sum += w[ex.idx[i]] * ex.val[i];
  return sum;
}

function weightedLogLoss(
  examples: readonly PreparedExample[],
  w: readonly number[],
  scale: number,
  intercept: number,
): number {
  let total = 0;
  let mass = 0;
  for (const ex of examples) {
    const p = sigmoid(scale * dot(w, ex) + intercept);
    const clamped = Math.min(Math.max(p, 1e-12), 1 - 1e-12);
    const loss = ex.label === 1 ? Math.log(clamped) : Math.log(1 - clamped);
    total -= ex.weight * loss;
    mass += ex.weight;
  }
  return mass > 0 ? total / mass : 0;
}

/** Weighted log-loss (no L2) for an arbitrary weight/scale/intercept triple. */
export function retentionLogLoss(
  examples: readonly RetentionTrainingExample[],
  weights: RetentionWeights,
  scale: number,
  intercept: number,
): number {
  return weightedLogLoss(
    examples.map(prepareExample),
    flattenWeights(weights),
    scale,
    intercept,
  );
}

function feasible(prior: readonly number[]): number[] {
  const out = prior.slice();
  for (const i of NON_NEGATIVE_INDICES) out[i] = Math.max(0, out[i]);
  for (const i of NON_POSITIVE_INDICES) out[i] = Math.min(0, out[i]);
  return out;
}

/** Project every weight into the feasible box around the prior. */
function projectWeights(w: number[], prior: readonly number[], maxDrift: number): void {
  const anchor = feasible(prior);
  const drift = Math.max(0, maxDrift);
  for (let i = 0; i < w.length; i++) {
    let lo = anchor[i] - drift;
    let hi = anchor[i] + drift;
    if (NON_NEGATIVE_INDICES.has(i)) lo = Math.max(lo, 0);
    if (NON_POSITIVE_INDICES.has(i)) hi = Math.min(hi, 0);
    if (lo > hi) {
      // Defensive: an infeasible prior (e.g. maxDrift=0 on a positive
      // GREETING weight) yields the nearest feasible anchor rather than an
      // invalid sign.
      w[i] = anchor[i];
    } else {
      w[i] = Math.min(Math.max(w[i], lo), hi);
    }
  }
}

interface GradientHold {
  examples: readonly PreparedExample[];
  prior: readonly number[];
  lambda: number;
}

function fullGradient(theta: readonly number[], hold: GradientHold): number[] {
  const n = RETENTION_WEIGHT_COUNT;
  const w = theta.slice(0, n);
  const scale = theta[n];
  const intercept = theta[n + 1];
  const grad = new Array<number>(n + 2).fill(0);
  let mass = 0;
  for (const ex of hold.examples) mass += ex.weight;
  if (mass <= 0) return grad;
  for (const ex of hold.examples) {
    const p = sigmoid(scale * dot(w, ex) + intercept);
    const dR = (ex.weight * (p - ex.label)) / mass;
    grad[n] += dR * dot(w, ex);
    grad[n + 1] += dR;
    for (let i = 0; i < ex.idx.length; i++) {
      grad[ex.idx[i]] += dR * ex.val[i];
    }
  }
  for (let i = 0; i < n; i++) {
    grad[i] += 2 * hold.lambda * (w[i] - hold.prior[i]);
  }
  return grad;
}

function scaleGradient(
  theta: readonly number[],
  examples: readonly PreparedExample[],
  weights: readonly number[],
): [number, number] {
  const scale = theta[0];
  const intercept = theta[1];
  let mass = 0;
  for (const ex of examples) mass += ex.weight;
  let gA = 0;
  let gB = 0;
  if (mass <= 0) return [0, 0];
  for (const ex of examples) {
    const p = sigmoid(scale * dot(weights, ex) + intercept);
    const dR = (ex.weight * (p - ex.label)) / mass;
    gA += dR * dot(weights, ex);
    gB += dR;
  }
  return [gA, gB];
}

/** Full-batch Adam with the fixed schedule; deterministic and dependency-free. */
function adam(
  initial: readonly number[],
  gradient: (theta: readonly number[]) => number[],
  project: (theta: number[]) => void,
  iterations = LEARN_ITERATIONS,
  lr = LEARN_LR,
): number[] {
  const theta = initial.slice();
  const m = new Array<number>(theta.length).fill(0);
  const v = new Array<number>(theta.length).fill(0);
  const beta1 = 0.9;
  const beta2 = 0.999;
  const eps = 1e-8;
  for (let t = 1; t <= iterations; t++) {
    const g = gradient(theta);
    const bc1 = 1 - Math.pow(beta1, t);
    const bc2 = 1 - Math.pow(beta2, t);
    for (let i = 0; i < theta.length; i++) {
      m[i] = beta1 * m[i] + (1 - beta1) * g[i];
      v[i] = beta2 * v[i] + (1 - beta2) * g[i] * g[i];
      const mHat = m[i] / bc1;
      const vHat = v[i] / bc2;
      theta[i] -= (lr * mHat) / (Math.sqrt(vHat) + eps);
    }
    project(theta);
  }
  return theta;
}

/**
 * MAP fit of the retention weights plus logistic scale/intercept.
 *
 * Objective: weighted log-loss + lambda * sum((w - prior)^2), optimized with
 * deterministic full-batch Adam (lr 0.05, 600 iterations) from w = prior,
 * a = 1, b = 0. After every step the weights are projected onto the guardrail
 * box (non-negative importance/links/expiry/consolidation, non-positive
 * transient nature labels, |w - prior| <= maxDrift) and a is clamped to
 * >= 0.05. Pure: no DB, no clock, no randomness.
 */
export function fitRetentionWeights(
  examples: readonly RetentionTrainingExample[],
  prior: RetentionWeights,
  bounds: RetentionFitBounds,
): RetentionFitResult {
  const priorFlat = flattenWeights(prior);
  const prepared = examples.map(prepareExample);
  const lambda = Number.isFinite(bounds.lambda) && bounds.lambda > 0 ? bounds.lambda : 0;
  const maxDrift = Number.isFinite(bounds.maxDrift) ? bounds.maxDrift : 0;
  const initial = [...priorFlat, 1, 0];
  const theta = adam(
    initial,
    (t) => fullGradient(t, { examples: prepared, prior: priorFlat, lambda }),
    (t) => {
      const w = t.slice(0, RETENTION_WEIGHT_COUNT);
      projectWeights(w, priorFlat, maxDrift);
      for (let i = 0; i < RETENTION_WEIGHT_COUNT; i++) t[i] = w[i];
      t[RETENTION_WEIGHT_COUNT] = Math.max(LEARN_MIN_SCALE, t[RETENTION_WEIGHT_COUNT]);
    },
  );
  const weights = unflattenWeights(theta.slice(0, RETENTION_WEIGHT_COUNT));
  const scale = theta[RETENTION_WEIGHT_COUNT];
  const intercept = theta[RETENTION_WEIGHT_COUNT + 1];
  const logLoss = weightedLogLoss(prepared, flattenWeights(weights), scale, intercept);
  let drift = 0;
  const finalFlat = flattenWeights(weights);
  for (let i = 0; i < RETENTION_WEIGHT_COUNT; i++) {
    drift += (finalFlat[i] - priorFlat[i]) ** 2;
  }
  return {
    weights,
    scale,
    intercept,
    logLoss,
    objective: logLoss + lambda * drift,
  };
}

/**
 * Fit only a,b with the weights frozen (used for the acceptance baseline so
 * the comparison is fair: both models may choose their own slope/intercept).
 */
export function fitRetentionScale(
  examples: readonly RetentionTrainingExample[],
  weights: RetentionWeights,
): { scale: number; intercept: number; logLoss: number } {
  const prepared = examples.map(prepareExample);
  const w = flattenWeights(weights);
  const theta = adam(
    [1, 0],
    (t) => scaleGradient(t, prepared, w),
    (t) => {
      t[0] = Math.max(LEARN_MIN_SCALE, t[0]);
    },
  );
  return {
    scale: theta[0],
    intercept: theta[1],
    logLoss: weightedLogLoss(prepared, w, theta[0], theta[1]),
  };
}

function latestAcceptedRow(db: DatabaseSync): { version: number; weights: RetentionWeights } | null {
  const row = db
    .prepare(
      `SELECT version, weights FROM retention_weights
        WHERE accepted = 1 ORDER BY version DESC LIMIT 1`,
    )
    .get() as { version: number; weights: string } | undefined;
  if (row === undefined) return null;
  const weights = parseStoredWeights(row.weights);
  return weights === null ? null : { version: row.version, weights };
}

/**
 * Weights used by activation decisions and preview. Disabled learning always
 * returns the config/default prior with version null (rollback path); enabled
 * learning prefers the latest accepted row and falls back to the prior.
 */
export function loadActiveRetentionWeights(
  db: DatabaseSync,
  config: AppConfig,
): ActiveRetentionWeights {
  const prior = weightsFromParams(activationBounds(config));
  if (!retentionLearnBounds(config).enabled) return { version: null, weights: prior };
  try {
    const row = latestAcceptedRow(db);
    return row === null ? { version: null, weights: prior } : row;
  } catch {
    return { version: null, weights: prior };
  }
}

interface StoredExampleRow {
  recallId: string;
  recordId: string;
  source: string;
  ts: string;
  label: number;
  weight: number;
  features: string;
}

function parseExampleRow(row: StoredExampleRow): RetentionTrainingExample | null {
  if (!Number.isFinite(Date.parse(row.ts))) return null;
  try {
    const f = JSON.parse(row.features) as unknown;
    if (typeof f !== "object" || f === null || Array.isArray(f)) return null;
    const o = f as Record<string, unknown>;
    const kind = o["kind"];
    if (typeof kind !== "string" || !KIND_ORDER.includes(kind as ActivationKind)) return null;
    const nature = o["nature"];
    if (nature !== null && (typeof nature !== "string" || !NATURE_ORDER.includes(nature as NatureLabel))) {
      return null;
    }
    const base = o["base"];
    if (base !== null && (typeof base !== "number" || !Number.isFinite(base))) return null;
    const importance = o["importance"];
    if (importance !== null && (typeof importance !== "number" || !Number.isFinite(importance))) {
      return null;
    }
    const links = o["links"];
    if (typeof links !== "number" || !Number.isFinite(links)) return null;
    return {
      base: base as number | null,
      kind: kind as ActivationKind,
      nature: nature as NatureLabel | null,
      importance: importance as number | null,
      links,
      expired: o["expired"] === true,
      consolidated: o["consolidated"] === true,
      label: row.label,
      weight: row.weight,
      ts: row.ts,
    };
  } catch {
    return null;
  }
}

function exampleKey(row: StoredExampleRow): string {
  return `${row.ts}\u0000${row.recallId}\u0000${row.recordId}\u0000${row.source}`;
}

function loadExamples(db: DatabaseSync): RetentionTrainingExample[] {
  const rows = db
    .prepare(
      `SELECT recallId, recordId, source, ts, label, weight, features
         FROM retention_examples
        ORDER BY ts ASC, rowid ASC`,
    )
    .all() as unknown as StoredExampleRow[];
  const out: Array<{ key: string; example: RetentionTrainingExample }> = [];
  for (const row of rows) {
    const example = parseExampleRow(row);
    if (example !== null) out.push({ key: exampleKey(row), example });
  }
  // Stable time order with an explicit identity tiebreak (deterministic split).
  out.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return out.map((entry) => entry.example);
}

function skipped(reason: LearnSkipReason, examples = 0, positives = 0): LearnOutcome {
  return {
    attempted: false,
    accepted: false,
    version: null,
    skipped: reason,
    examples,
    positives,
    train: 0,
    holdout: 0,
    trainLoss: null,
    holdoutLoss: null,
    baselineHoldoutLoss: null,
  };
}

/**
 * One gated learner attempt inside maintain.activation (caller holds the
 * cultivation lease and enforces the maintenance deadline).
 *
 * Gates: activation.learn.enabled, learnIntervalMs since the last attempt row,
 * >= LEARN_MIN_NEW_EXAMPLES new rows since that attempt, n >= minExamples, and
 * positives >= minPositives. Gate skips write no row. A real attempt always
 * writes one retention_weights row: accepted=1 only when the time-ordered
 * holdout log-loss beats the current active weights (a,b refit on train for
 * both sides) by more than 1e-4. Accepted weights are then refit on all
 * examples before being stored.
 */
export function maybeLearn(
  db: DatabaseSync,
  config: AppConfig,
  _scope: string,
  now: string,
): LearnOutcome {
  const learn = retentionLearnBounds(config);
  if (!learn.enabled) return skipped("disabled");
  const last = db
    .prepare(
      `SELECT version, createdAt FROM retention_weights
        ORDER BY version DESC LIMIT 1`,
    )
    .get() as { version: number; createdAt: string } | undefined;
  if (last !== undefined) {
    const lastMs = Date.parse(last.createdAt);
    const nowMs = Date.parse(now);
    if (
      Number.isFinite(lastMs) &&
      Number.isFinite(nowMs) &&
      nowMs - lastMs < learn.learnIntervalMs
    ) {
      return skipped("interval");
    }
  }
  const newCountRow = db
    .prepare(
      `SELECT COUNT(*) AS n FROM retention_examples
        WHERE createdAt > ?`,
    )
    .get(last?.createdAt ?? "") as { n: number };
  if (newCountRow.n < LEARN_MIN_NEW_EXAMPLES) return skipped("no-new-examples");

  const examples = loadExamples(db);
  const n = examples.length;
  const positives = examples.filter((e) => e.label > 0.5).length;
  if (n < learn.minExamples) return skipped("min-examples", n, positives);
  if (positives < learn.minPositives) return skipped("min-positives", n, positives);

  const holdoutCount = Math.max(1, Math.floor(n * 0.2));
  const train = examples.slice(0, n - holdoutCount);
  const holdout = examples.slice(n - holdoutCount);
  const prior = weightsFromParams(activationBounds(config));
  const bounds: RetentionFitBounds = { lambda: learn.lambda, maxDrift: learn.maxDrift };
  const candidate = fitRetentionWeights(train, prior, bounds);
  const active = latestAcceptedRow(db);
  const baselineWeights = active?.weights ?? prior;
  const baseline = fitRetentionScale(train, baselineWeights);
  const holdoutLoss = retentionLogLoss(holdout, candidate.weights, candidate.scale, candidate.intercept);
  const baselineHoldoutLoss = retentionLogLoss(
    holdout,
    baselineWeights,
    baseline.scale,
    baseline.intercept,
  );
  const accepted = holdoutLoss < baselineHoldoutLoss - LEARN_ACCEPT_MARGIN;

  let stored = candidate;
  let trainLoss = candidate.logLoss;
  if (accepted) {
    stored = fitRetentionWeights(examples, prior, bounds);
    trainLoss = stored.logLoss;
  }
  const res = db
    .prepare(
      `INSERT INTO retention_weights(
         weights, scale, intercept, nTrain, nPos, trainLoss, holdoutLoss,
         baselineHoldoutLoss, accepted, createdAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      JSON.stringify(stored.weights),
      stored.scale,
      stored.intercept,
      accepted ? n : train.length,
      accepted ? positives : train.filter((e) => e.label > 0.5).length,
      trainLoss,
      holdoutLoss,
      baselineHoldoutLoss,
      accepted ? 1 : 0,
      now,
    );
  return {
    attempted: true,
    accepted,
    version: Number(res.lastInsertRowid),
    skipped: null,
    examples: n,
    positives,
    train: train.length,
    holdout: holdout.length,
    trainLoss,
    holdoutLoss,
    baselineHoldoutLoss,
  };
}
