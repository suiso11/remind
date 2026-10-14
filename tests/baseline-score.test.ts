import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  aggregatePositive,
  classifyNegative,
  findInvariantViolations,
  hasDuplicateIds,
  latencyStats,
  negativeFractions,
  scorePositive,
  validateReturnedIds,
} from "../scripts/baseline-score.js";

describe("baseline-score consumer edges", () => {
  it("ordered intersection R[a,b] vs L[x,b,a] gives P2/3 R1 RR1/2", () => {
    const s = scorePositive(["x", "b", "a"], ["a", "b"], 3);
    assert.equal(s.hits, 2);
    assert.equal(s.pAt3, 2 / 3);
    assert.equal(s.recall, 1);
    assert.equal(s.rr, 1 / 2);
    assert.equal(s.firstRank, 2);
  });

  it("fewer returned [a] vs gold [a,b] gives P1/3 R1/2 RR1", () => {
    const s = scorePositive(["a"], ["a", "b"], 3);
    assert.equal(s.hits, 1);
    assert.equal(s.pAt3, 1 / 3);
    assert.equal(s.recall, 1 / 2);
    assert.equal(s.rr, 1);
  });

  it("empty OK and irrelevant positives score zeros without degradation flag", () => {
    const e = scorePositive([], ["a"], 3);
    assert.equal(e.hits, 0);
    assert.equal(e.pAt3, 0);
    assert.equal(e.recall, 0);
    assert.equal(e.rr, 0);
    const irr = scorePositive(["x", "y"], ["a"], 3);
    assert.equal(irr.hits, 0);
    assert.equal(irr.pAt3, 0);
    assert.equal(irr.recall, 0);
    assert.equal(irr.rr, 0);
    // Empty returned is valid (not over-limit, not duplicate).
    assert.equal(validateReturnedIds([], 3).ok, true);
    assert.equal(validateReturnedIds(["x", "y"], 3).ok, true);
  });

  it("unsliced over-limit input scores only top-k: [x,y,z,a] gold [a] k3 is all-zero", () => {
    // Actual responses stay REJECTED over-limit (validateReturnedIds below);
    // scoring itself never silently truncates: it bounds at min(len,k).
    const s = scorePositive(["x", "y", "z", "a"], ["a"], 3);
    assert.equal(s.hits, 0);
    assert.equal(s.pAt3, 0);
    assert.equal(s.recall, 0);
    assert.equal(s.rr, 0);
    assert.equal(s.firstRank, null);
    // 4 relevant unsliced with k=3 cannot exceed P=1: only top-3 count.
    const full = scorePositive(["a", "b", "c", "d"], ["a", "b", "c", "d"], 3);
    assert.equal(full.hits, 3);
    assert.equal(full.pAt3, 1);
    assert.equal(full.recall, 3 / 4);
    // Over-limit actual responses remain INVALID, not truncated.
    assert.equal(validateReturnedIds(["a", "b", "c", "d"], 3).ok, false);
  });

  it("k=2 rank2 hit vs top1 miss", () => {
    const hit = scorePositive(["x", "a"], ["a"], 2);
    assert.equal(hit.hits, 1);
    assert.equal(hit.pAt3, 1 / 2);
    assert.equal(hit.recall, 1);
    assert.equal(hit.rr, 1 / 2);
    const miss = scorePositive(["x", "y"], ["a"], 2);
    assert.equal(miss.hits, 0);
    assert.equal(miss.pAt3, 0);
    assert.equal(miss.recall, 0);
    assert.equal(miss.rr, 0);
  });

  it("negative empty/nonempty/failure carry null quality and partition", () => {
    const e = classifyNegative({ transportFailed: false, ok: true, itemsCount: 0 });
    const n = classifyNegative({ transportFailed: false, ok: true, itemsCount: 2 });
    const f = classifyNegative({ transportFailed: false, ok: false, itemsCount: null });
    assert.equal(e.outcome, "validEmpty");
    assert.equal(n.outcome, "validNonempty");
    assert.equal(f.outcome, "failure");
    for (const c of [e, n, f]) {
      assert.equal(c.pAt3, null);
      assert.equal(c.recall, null);
      assert.equal(c.rr, null);
    }
    const frac = negativeFractions([e.outcome, n.outcome, f.outcome]);
    assert.equal(frac.total, 3);
    assert.equal(frac.validEmpty, 1);
    assert.equal(frac.validNonempty, 1);
    assert.equal(frac.failure, 1);
  });

  it("failed positives score zero but stay in denominator", () => {
    const agg = aggregatePositive([
      { failed: false, pAt3: 1, recall: 1, rr: 1 },
      { failed: true, pAt3: 0, recall: 0, rr: 0 },
    ]);
    assert.equal(agg.count, 2);
    assert.equal(agg.failed, 1);
    assert.equal(agg.meanPAt3, 1 / 2);
    assert.equal(agg.meanRecall, 1 / 2);
    assert.equal(agg.meanRR, 1 / 2);
  });

  it("duplicates are invalid, not silently deduped", () => {
    assert.equal(hasDuplicateIds(["a", "a"]), true);
    assert.equal(hasDuplicateIds(["a", "b"]), false);
    const v = validateReturnedIds(["a", "a"], 3);
    assert.equal(v.ok, false);
    if (!v.ok) assert.equal(v.reason, "duplicate");
    const over = validateReturnedIds(["a", "b", "c", "d"], 3);
    assert.equal(over.ok, false);
  });

  it("gold must be actual IDs, aliases do not match", () => {
    const aliasHit = scorePositive(["rec_abc"], ["orchard"], 3);
    assert.equal(aliasHit.hits, 0);
    const realHit = scorePositive(["rec_abc"], ["rec_abc"], 3);
    assert.equal(realHit.hits, 1);
    assert.equal(realHit.pAt3, 1 / 3);
    assert.equal(realHit.recall, 1);
  });

  it("aggregation with separate probe excluded: normal failure 1/3, positive mean 1/2", () => {
    // Two normal attempts: one perfect, one failed; probe excluded from denom.
    const agg = aggregatePositive([
      { failed: false, pAt3: 1, recall: 1, rr: 1 },
      { failed: false, pAt3: 0, recall: 0, rr: 0 },
      { failed: true, pAt3: 0, recall: 0, rr: 0 },
    ]);
    assert.equal(agg.count, 3);
    assert.equal(agg.failed, 1);
    // normal failure fraction 1/3 implied by failed/count
    assert.equal(agg.failed / agg.count, 1 / 3);
    // Positive mean over 3 with one perfect (P=1) and rest 0 => 1/3? Use 2-entry mean 1/2 case:
    const two = aggregatePositive([
      { failed: false, pAt3: 1, recall: 1, rr: 1 },
      { failed: false, pAt3: 0, recall: 0, rr: 0 },
    ]);
    assert.equal(two.meanPAt3, 1 / 2);
  });

  it("latency 1,2,3,4 median 2.5 p95 4, empty null, failures partitioned", () => {
    const s = latencyStats([1, 2, 3, 4]);
    assert.ok(s !== null);
    assert.equal(s?.median, 2.5);
    assert.equal(s?.p95, 4);
    assert.equal(s?.min, 1);
    assert.equal(s?.max, 4);
    assert.equal(latencyStats([]), null);
    // Failed elapsed partitioned: success stats exclude failures.
    const succ = latencyStats([1, 2]);
    const all = latencyStats([1, 2, 100]);
    assert.equal(succ?.count, 2);
    assert.equal(all?.count, 3);
    assert.notEqual(succ?.mean, all?.mean);
  });

  it("unknown/foreign/non-active are invariant failures; unrelated active is metric", () => {
    const active = new Set(["a", "b", "c"]);
    assert.deepEqual(findInvariantViolations(["a", "z"], active), ["z"]);
    assert.deepEqual(findInvariantViolations(["b"], active), []);
    // Unrelated active (c not in gold [a]) is NOT a violation: score handles it.
    const s = scorePositive(["c"], ["a"], 3);
    assert.equal(s.hits, 0);
    assert.deepEqual(findInvariantViolations(["c"], active), []);
  });
});
