import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { MESSAGES } from "../src/protocol.js";
import {
  aggregatePositive,
  findInvariantViolations,
  scorePositive,
  validateEnvelopeValues,
  validateRecallData,
  validateReturnedIds,
} from "../scripts/baseline-score.js";

function goodItem(id: string): Record<string, unknown> {
  return {
    id,
    snippet: "Lantern lens cleaning procedure.",
    truncated: false,
    tags: ["harbor"],
    createdAt: "2026-09-01T00:00:00.000Z",
  };
}

function successEnv(data: Record<string, unknown>): Record<string, unknown> {
  return { v: 1, ok: true, code: "OK", message: MESSAGES.OK, data, deduplicated: false };
}

describe("baseline consumer validators on parsed data", () => {
  it("strict envelope values reject malformed v/ok/code/message/deduplicated", () => {
    const data = { recallId: "recall_1", items: [] };
    assert.equal(validateEnvelopeValues(successEnv(data)).ok, true);
    // v2 wrong version.
    assert.equal(
      validateEnvelopeValues({ v: 2, ok: true, code: "OK", message: MESSAGES.OK, data, deduplicated: false }).ok,
      false,
    );
    // ok as truthy string is invalid.
    assert.equal(
      validateEnvelopeValues({ v: 1, ok: "false", code: "STORE_UNAVAILABLE", message: MESSAGES.STORE_UNAVAILABLE, data: null, deduplicated: false }).ok,
      false,
    );
    // deduplicated null is invalid.
    assert.equal(
      validateEnvelopeValues({ v: 1, ok: true, code: "OK", message: MESSAGES.OK, data, deduplicated: null }).ok,
      false,
    );
    // STORE_UNAVAILABLE code with ok:true is inconsistent.
    assert.equal(
      validateEnvelopeValues({ v: 1, ok: true, code: "STORE_UNAVAILABLE", message: MESSAGES.STORE_UNAVAILABLE, data, deduplicated: false }).ok,
      false,
    );
    // Fixed message must match the code table (existing MESSAGES fixture).
    assert.equal(
      validateEnvelopeValues({ v: 1, ok: false, code: "STORE_UNAVAILABLE", message: MESSAGES.OK, data: null, deduplicated: false }).ok,
      false,
    );
    // Unknown code rejected.
    assert.equal(
      validateEnvelopeValues({ v: 1, ok: false, code: "NOPE", message: "nope", data: null, deduplicated: false }).ok,
      false,
    );
    // Success with null data rejected; error with object data rejected.
    assert.equal(
      validateEnvelopeValues({ v: 1, ok: true, code: "OK", message: MESSAGES.OK, data: null, deduplicated: false }).ok,
      false,
    );
    assert.equal(
      validateEnvelopeValues({ v: 1, ok: false, code: "STORE_UNAVAILABLE", message: MESSAGES.STORE_UNAVAILABLE, data, deduplicated: false }).ok,
      false,
    );
    // Valid error envelope accepted.
    const err = validateEnvelopeValues({ v: 1, ok: false, code: "STORE_UNAVAILABLE", message: MESSAGES.STORE_UNAVAILABLE, data: null, deduplicated: false });
    assert.equal(err.ok, true);
  });

  it("recall data requires actual recallId/items array/item shapes, never fake empty", () => {
    assert.equal(validateRecallData(null).ok, false);
    assert.equal(validateRecallData({}).ok, false);
    assert.equal(validateRecallData({ recallId: "recall_1", items: null }).ok, false);
    assert.equal(validateRecallData({ recallId: "recall_1", items: {} }).ok, false);
    assert.equal(validateRecallData({ recallId: "recall_1", items: [null] }).ok, false);
    assert.equal(validateRecallData({ recallId: "", items: [] }).ok, false);
    // Item missing createdAt is malformed.
    const { createdAt: _drop, ...short } = goodItem("rec_a");
    assert.equal(validateRecallData({ recallId: "recall_1", items: [short] }).ok, false);
    // Valid empty stays valid (empty OK, not a failure).
    const empty = validateRecallData({ recallId: "recall_1", items: [] });
    assert.equal(empty.ok, true);
    if (empty.ok) assert.equal(empty.items.length, 0);
    const one = validateRecallData({ recallId: "recall_1", items: [goodItem("rec_a")] });
    assert.equal(one.ok, true);
  });

  it("duplicate/over-limit/invariant real IDs remain fail, denoms retained", () => {
    const dup = validateRecallData({ recallId: "recall_1", items: [goodItem("rec_a"), goodItem("rec_a")] });
    assert.equal(dup.ok, true); // shape-valid here; ID-level rules below must fail it
    if (dup.ok) {
      const ids = dup.items.map((i) => i.id);
      assert.equal(validateReturnedIds(ids, 3).ok, false);
    }
    const over = validateRecallData({
      recallId: "recall_1",
      items: [goodItem("a"), goodItem("b"), goodItem("c"), goodItem("d")],
    });
    assert.equal(over.ok, true);
    if (over.ok) {
      assert.equal(validateReturnedIds(over.items.map((i) => i.id), 3).ok, false);
    }
    // Unknown/foreign real IDs are invariant failures, not metrics.
    assert.deepEqual(findInvariantViolations(["rec_a", "rec_zzz"], new Set(["rec_a"])), ["rec_zzz"]);
    // Prior attempts stay in the denominator even when failed.
    const agg = aggregatePositive([
      { failed: false, pAt3: 1, recall: 1, rr: 1 },
      { failed: true, pAt3: 0, recall: 0, rr: 0 },
    ]);
    assert.equal(agg.count, 2);
    assert.equal(agg.failed, 1);
    assert.equal(agg.meanPAt3, 1 / 2);
    // Unsliced scoring bound retained: 4th-position gold hit is out of top-3.
    const s = scorePositive(["x", "y", "z", "a"], ["a"], 3);
    assert.equal(s.hits, 0);
    assert.equal(s.pAt3, 0);
  });
});
