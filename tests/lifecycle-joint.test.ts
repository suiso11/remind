import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  enumeratePlans,
  jointReversal,
  planId,
  scoreJoint,
  type LifecyclePlan,
  type PlanUtilities,
} from "../scripts/lifecycle-joint.js";

const keys = ["a", "b", "c", "d"];
const gain = { keep: 0, retire: 0.1, correct: 0.2 } as const;

/** Build utilities for all 81 plans at the given horizons from a plan->utility function. */
function table(f: (p: LifecyclePlan, h: number) => number, horizons = [2, 4]): PlanUtilities {
  const out: PlanUtilities = {};
  for (const p of enumeratePlans(keys, true)) {
    out[planId(p, keys)] = Object.fromEntries(horizons.map((h) => [h, f(p, h)]));
  }
  return out;
}

const additive = (p: LifecyclePlan): number => keys.reduce((s, k) => s + gain[p[k]!], 0);

describe("lifecycle joint scoring", () => {
  it("enumerates 9 default plans and 81 joint plans", () => {
    assert.equal(new Set(enumeratePlans(keys, false).map((p) => planId(p, keys))).size, 9);
    assert.equal(new Set(enumeratePlans(keys, true).map((p) => planId(p, keys))).size, 81);
  });

  it("separable utilities have zero interaction and zero regret", () => {
    const s = scoreJoint(table(additive), keys, 2);
    assert.equal(s.interactionRate, 0);
    assert.ok(Math.abs(s.independentRegret) < 1e-12);
    assert.deepEqual(s.jointOracle, { a: "correct", b: "correct", c: "correct", d: "correct" });
    // The best uniform plan is already the joint oracle.
    assert.ok(Math.abs(s.jointHeadroom) < 1e-12);
  });

  it("a cross-thread interaction yields positive interaction rate and regret", () => {
    // Retiring a alone or b alone is harmful, retiring both together is a large win.
    const u = table((p) => additive(p) + (p["a"] === "retire" && p["b"] === "retire" ? 1 : 0) -
      (p["a"] === "retire" && p["b"] !== "retire" ? 0.5 : 0) - (p["b"] === "retire" && p["a"] !== "retire" ? 0.5 : 0));
    const s = scoreJoint(u, keys, 2);
    assert.ok(s.interactionRate > 0);
    assert.ok(s.independentRegret > 0);
    assert.equal(s.jointOracle["a"], "retire");
    assert.equal(s.jointOracle["b"], "retire");
    assert.ok(s.jointHeadroom >= 0);
  });

  it("breaks ties deterministically toward keep and earlier plans", () => {
    const s = scoreJoint(table(() => 1), keys, 2);
    assert.deepEqual(s.jointOracle, { a: "keep", b: "keep", c: "keep", d: "keep" });
    assert.deepEqual(s.marginalOracle, s.jointOracle);
    assert.equal(s.jointHeadroom, 0);
    assert.equal(s.independentRegret, 0);
    assert.deepEqual(s.jointDiversity, { keep: 4, retire: 0, correct: 0 });
    assert.deepEqual(scoreJoint(table(() => 1), keys, 2), s);
  });

  it("jointHeadroom is never negative and marginal oracles reconstruct from single deviations", () => {
    const u = table((p) => additive(p) - (p["c"] === "correct" && p["d"] === "retire" ? 0.7 : 0));
    const s = scoreJoint(u, keys, 4);
    assert.ok(s.jointHeadroom >= 0);
    assert.ok(s.independentRegret >= 0);
    for (const k of keys) {
      const best = (["keep", "retire", "correct"] as const).reduce((x, y) =>
        u[planId({ [k]: y }, keys)]![4]! > u[planId({ [k]: x }, keys)]![4]! ? y : x);
      assert.equal(s.marginalOracle[k], best);
    }
  });

  it("jointReversal compares the first and last horizon", () => {
    // Horizon 2 favours retiring a; horizon 8 favours keeping it; 4 is ignored.
    const u = table((p, h) => (h === 2 && p["a"] === "retire" ? 1 : 0) + (h === 4 && p["b"] === "retire" ? 5 : 0), [2, 4, 8]);
    assert.equal(jointReversal(u, keys, [2, 4, 8]), 0.25);
    assert.equal(jointReversal(u, keys, [2]), 0);
  });
});
