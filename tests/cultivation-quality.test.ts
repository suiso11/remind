import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { scoreLinks, scoreSummary } from "../scripts/cultivation-quality.js";

describe("scoreLinks", () => {
  it("perfect links", () => {
    const s = scoreLinks(["a", "b"], { required: ["a", "b"], forbidden: ["z"] });
    assert.equal(s.precision, 1);
    assert.equal(s.recall, 1);
    assert.deepEqual(s.falseLinks, []);
    assert.deepEqual(s.misses, []);
    assert.equal(s.predicted, 2);
    assert.equal(s.required, 2);
  });

  it("false link lowers precision only", () => {
    const s = scoreLinks(["a", "z"], { required: ["a"], forbidden: ["z"] });
    assert.equal(s.precision, 1 / 2);
    assert.equal(s.recall, 1);
    assert.deepEqual(s.falseLinks, ["z"]);
  });

  it("miss lowers recall only; dedupes", () => {
    const s = scoreLinks(["a", "a"], { required: ["a", "b", "b"] });
    assert.equal(s.precision, 1);
    assert.equal(s.recall, 1 / 2);
    assert.deepEqual(s.misses, ["b"]);
    assert.equal(s.predicted, 1);
    assert.equal(s.required, 2);
  });

  it("empty predictions: precision null, all required missed", () => {
    const s = scoreLinks([], { required: ["a", "b"] });
    assert.equal(s.precision, null);
    assert.equal(s.recall, 0);
    assert.deepEqual(s.misses, ["a", "b"]);
  });

  it("empty truth: recall null", () => {
    const s = scoreLinks(["a"], { required: [] });
    assert.equal(s.recall, null);
    assert.equal(s.precision, 1);
    assert.deepEqual(scoreLinks([], { required: [] }), {
      precision: null, recall: null, falseLinks: [], misses: [], predicted: 0, required: 0,
    });
  });
});

describe("scoreSummary", () => {
  const exp = { mustInclude: ["Blue Heron", "Tuesday"], mustExclude: ["Green Owl"], requiredSourceIds: ["s1", "s2"] };

  it("all facts, no decoy, full coverage (NFKC + case-insensitive)", () => {
    const s = scoreSummary("ＢLUE heron ships on TUESDAY.", [], [], ["s2", "s1", "s3"], exp);
    assert.deepEqual(s.factHits, ["Blue Heron", "Tuesday"]);
    assert.deepEqual(s.factMisses, []);
    assert.deepEqual(s.unsupported, []);
    assert.equal(s.factFidelity, 1);
    assert.equal(s.unsupportedRate, 0);
    assert.equal(s.sourceCoverage, 1);
  });

  it("missing fact", () => {
    const s = scoreSummary("Blue Heron ships.", [], [], ["s1", "s2"], exp);
    assert.deepEqual(s.factMisses, ["Tuesday"]);
    assert.equal(s.factFidelity, 1 / 2);
  });

  it("forbidden decoy", () => {
    const s = scoreSummary("Blue Heron and Green Owl on Tuesday", [], [], ["s1", "s2"], exp);
    assert.deepEqual(s.unsupported, ["Green Owl"]);
    assert.equal(s.unsupportedRate, 1);
  });

  it("source coverage", () => {
    const s = scoreSummary("Blue Heron Tuesday", [], [], ["s1", "x"], exp);
    assert.deepEqual(s.sourceHits, ["s1"]);
    assert.deepEqual(s.sourceMisses, ["s2"]);
    assert.equal(s.sourceCoverage, 1 / 2);
  });

  it("empty inputs", () => {
    const s = scoreSummary("", [], [], [], { mustInclude: [], mustExclude: [], requiredSourceIds: [] });
    assert.equal(s.factFidelity, 1);
    assert.equal(s.unsupportedRate, 0);
    assert.equal(s.sourceCoverage, 1);
    const t = scoreSummary("", [], [], [], exp);
    assert.equal(t.factFidelity, 0);
    assert.equal(t.sourceCoverage, 0);
  });
});
