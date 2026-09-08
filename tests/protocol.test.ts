import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  applyResponseBudget,
  checkRawSize,
  fail,
  ok,
  validateRequest,
} from "../src/protocol.js";

describe("protocol envelopes", () => {
  it("accepts a minimal valid read request", () => {
    const r = validateRequest({
      v: 1,
      op: "record.recall",
      params: {},
    });
    assert.equal(r.ok, true);
  });

  it("rejects unknown fields, bad version, unknown op", () => {
    assert.equal(
      (validateRequest({ v: 1, op: "record.recall", params: {}, actor: "x" }) as { ok: boolean }).ok,
      false,
    );
    assert.equal(
      (validateRequest({ v: 2, op: "record.recall", params: {} }) as { ok: boolean }).ok,
      false,
    );
    const unk = validateRequest({ v: 1, op: "nope.nope", params: {} });
    assert.equal(unk.ok, false);
    if (!unk.ok) assert.equal(unk.res.code, "BAD_REQUEST");
  });

  it("requires idempotency keys on writes, forbids them on reads", () => {
    const missing = validateRequest({ v: 1, op: "candidate.create", params: {} });
    assert.equal(missing.ok, false);
    const bad = validateRequest({
      v: 1,
      op: "candidate.create",
      idempotencyKey: "bad key!",
      params: {},
    });
    assert.equal(bad.ok, false);
    const good = validateRequest({
      v: 1,
      op: "candidate.create",
      idempotencyKey: "c-001_ABC",
      params: {},
    });
    assert.equal(good.ok, true);
    const readWithKey = validateRequest({
      v: 1,
      op: "record.recall",
      idempotencyKey: "c-001",
      params: {},
    });
    assert.equal(readWithKey.ok, false);
  });

  it("rejects human-only ops on the JSON path with FORBIDDEN", () => {
    for (const op of ["approve", "reject", "archive", "record.archive"]) {
      const r = validateRequest({ v: 1, op, params: {} });
      assert.equal(r.ok, false);
      if (!r.ok) assert.equal(r.res.code, "FORBIDDEN");
    }
  });

  it("bounds raw requests at 32768 bytes", () => {
    assert.equal(checkRawSize("x".repeat(32768)), null);
    const over = checkRawSize("x".repeat(32769));
    assert.ok(over && over.code === "LIMIT_EXCEEDED");
  });

  it("bounds responses instead of truncating", () => {
    const big = ok({ blob: "y".repeat(9000) });
    const capped = applyResponseBudget(big, 8192);
    assert.equal(capped.code, "LIMIT_EXCEEDED");
    assert.equal(capped.data, null);
    const small = applyResponseBudget(ok(null), 8192);
    assert.equal(small.code, "OK");
  });

  it("uses fixed messages with no input echo", () => {
    const r = fail("BAD_REQUEST");
    assert.equal(r.message, "bad request");
    assert.ok(!JSON.stringify(r).includes("c-001"));
  });

  it("reserves NOT_IMPLEMENTED as the honest T1-only domain failure", () => {
    const r = fail("NOT_IMPLEMENTED");
    assert.equal(r.ok, false);
    assert.equal(r.code, "NOT_IMPLEMENTED");
    assert.equal(r.message, "not implemented");
    assert.equal(r.data, null);
  });
});
