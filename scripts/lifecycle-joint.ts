/**
 * Joint (simultaneous) lifecycle scoring over per-thread KEEP/RETIRE/CORRECT
 * plans. Pure and deterministic: consumes plan utilities, touches no store.
 * Ties always resolve to the earliest of keep < retire < correct, and to the
 * earliest plan in enumeration order (first key most significant).
 */

export type LifecycleAction = "keep" | "retire" | "correct";
export type LifecyclePlan = Record<string, LifecycleAction>;
/** planId -> horizon -> utility */
export type PlanUtilities = Record<string, Record<number, number>>;

export const LIFECYCLE_ACTIONS: readonly LifecycleAction[] = ["keep", "retire", "correct"];

export interface JointScore {
  jointOracle: LifecyclePlan;
  jointOracleUtility: number;
  /** max over all plans minus max over the three uniform plans (>= 0). */
  jointHeadroom: number;
  /** U(joint oracle) - U(vector of per-thread marginal oracles) (>= 0). */
  independentRegret: number;
  marginalOracle: LifecyclePlan;
  /** Fraction of plans whose utility differs from the additive prediction. */
  interactionRate: number;
  jointDiversity: Record<LifecycleAction, number>;
}

export function planId(plan: LifecyclePlan, keys: readonly string[]): string {
  return keys.map((k) => plan[k] ?? "keep").join("|");
}

const uniform = (keys: readonly string[], a: LifecycleAction): LifecyclePlan =>
  Object.fromEntries(keys.map((k) => [k, a]));

/** All-keep plus every single deviation (default), or all 3^n plans. */
export function enumeratePlans(keys: readonly string[], joint: boolean): LifecyclePlan[] {
  if (joint) {
    let plans: LifecyclePlan[] = [{}];
    for (const k of keys) plans = plans.flatMap((p) => LIFECYCLE_ACTIONS.map((a) => ({ ...p, [k]: a })));
    return plans;
  }
  const plans = [uniform(keys, "keep")];
  for (const k of keys) {
    for (const a of LIFECYCLE_ACTIONS) if (a !== "keep") plans.push({ ...uniform(keys, "keep"), [k]: a });
  }
  return plans;
}

function utilityOf(u: PlanUtilities, plan: LifecyclePlan, keys: readonly string[], horizon: number): number {
  const v = u[planId(plan, keys)]?.[horizon];
  if (v === undefined) throw new Error(`missing utility for plan ${planId(plan, keys)} at horizon ${horizon}`);
  return v;
}

/** Strict-greater argmax, so the first candidate wins ties. */
function argmax<T>(items: readonly T[], score: (t: T) => number): T {
  return items.reduce((best, x) => (score(x) > score(best) ? x : best), items[0]!);
}

export function scoreJoint(utilByPlan: PlanUtilities, keys: readonly string[], horizon: number): JointScore {
  const u = (p: LifecyclePlan): number => utilityOf(utilByPlan, p, keys, horizon);
  const plans = enumeratePlans(keys, true);
  const jointOracle = argmax(plans, u);
  const jointOracleUtility = u(jointOracle);
  const bestUniform = Math.max(...LIFECYCLE_ACTIONS.map((a) => u(uniform(keys, a))));

  const keepAll = uniform(keys, "keep");
  const base = u(keepAll);
  const single = (k: string, a: LifecycleAction): LifecyclePlan => ({ ...keepAll, [k]: a });
  const marginalOracle: LifecyclePlan = {};
  for (const k of keys) marginalOracle[k] = argmax(LIFECYCLE_ACTIONS, (a) => u(single(k, a)));

  let interacting = 0;
  for (const p of plans) {
    const additive = keys.reduce((sum, k) => sum + u(single(k, p[k]!)) - base, base);
    if (Math.abs(u(p) - additive) > 1e-9) interacting += 1;
  }

  const jointDiversity: Record<LifecycleAction, number> = { keep: 0, retire: 0, correct: 0 };
  for (const k of keys) jointDiversity[jointOracle[k]!] += 1;

  return {
    jointOracle,
    jointOracleUtility,
    jointHeadroom: jointOracleUtility - bestUniform,
    independentRegret: jointOracleUtility - u(marginalOracle),
    marginalOracle,
    interactionRate: interacting / plans.length,
    jointDiversity,
  };
}

/** Fraction of threads whose joint-oracle action differs between the first and last horizon. */
export function jointReversal(utilByPlan: PlanUtilities, keys: readonly string[], horizons: readonly number[]): number {
  if (keys.length === 0 || horizons.length < 2) return 0;
  const first = scoreJoint(utilByPlan, keys, horizons[0]!).jointOracle;
  const last = scoreJoint(utilByPlan, keys, horizons[horizons.length - 1]!).jointOracle;
  return keys.filter((k) => first[k] !== last[k]).length / keys.length;
}
