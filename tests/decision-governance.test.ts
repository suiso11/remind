import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  runGovernanceSuite,
  type GovernanceAuditRow,
  type GovernanceStore,
  type GovernanceStoreRecord,
} from "../scripts/decision-governance.js";

interface Opts {
  noopRetire?: boolean;
  columns?: string[];
  searchMissesRetired?: boolean;
}

/** In-memory fake: recall hides non-active rows, search finds all, audit is metadata-only. */
function fakeStore(o: Opts = {}): GovernanceStore {
  const rows = new Map<string, GovernanceStoreRecord>();
  const audit: GovernanceAuditRow[] = [];
  let n = 0;
  const add = (body: string, status: string, kind: string, source: string): string => {
    const id = `rec-${++n}`;
    rows.set(id, { id, body, status, kind, source });
    return id;
  };
  const match = (q: string, r: GovernanceStoreRecord): boolean => r.body.toLowerCase().includes(q.toLowerCase());
  const log = (op: string, targetId: string, reasonCode: string | null): void => {
    audit.push({ op, code: "ok", targetId, reasonCode });
  };
  const must = (id: string): GovernanceStoreRecord => {
    const r = rows.get(id);
    if (!r) throw new Error(`unknown ${id}`);
    return r;
  };
  return {
    dbPath: ":memory:",
    seed: (_k, body, source, kind = "user_fact") => ({ id: add(body, "active", kind, source), eventId: `ev-${n}` }),
    rememberDerived: (_k, body) => ({ id: add(body, "active", "summary", "derived"), eventId: `ev-${n}` }),
    recall: (q) => ({ recallId: "rc", ids: [...rows.values()].filter((r) => r.status === "active" && match(q, r)).map((r) => r.id) }),
    searchIds: (q) =>
      [...rows.values()].filter((r) => match(q, r) && !(o.searchMissesRetired && r.status === "retired")).map((r) => r.id),
    get: (id) => ({ ...must(id) }),
    correct: (id, body, source) => {
      must(id).status = "superseded";
      log("correct", id, null);
      return add(body, "active", "user_fact", source);
    },
    retire: (id) => {
      if (o.noopRetire) return;
      must(id).status = "retired";
      log("retire", id, "user_retire");
    },
    reactivate: (id) => {
      must(id).status = "active";
      log("reactivate", id, "user_reactivate");
    },
    auditFor: (id) => audit.filter((a) => a.targetId === id),
    auditColumns: () => o.columns ?? ["op", "code", "target_id", "reason_code"],
  };
}

describe("runGovernanceSuite", () => {
  it("passes every gate on a faithful store", () => {
    const r = runGovernanceSuite(fakeStore());
    assert.deepEqual(r.invariants, []);
    assert.equal(r.ok, true);
    assert.equal(r.gates.G1_poison!.skipped, true);
    assert.match(r.gates.G1_poison!.detail, /skipped: model-free; no automatic durable write path/);
    assert.match(r.gates.G4_quality!.detail, /governanceByInaction: false/);
    assert.equal(r.gates.leak_count_matched!.skipped, true);
    assert.match(r.gates.leak_count_matched!.detail, /n\/a: deterministic suite; no sampled arms/);
  });

  it("fails reversibility and the quality gate when retire is a no-op", () => {
    const r = runGovernanceSuite(fakeStore({ noopRetire: true }));
    assert.equal(r.gates.G2_reversibility!.pass, false);
    assert.equal(r.gates.G4_quality!.pass, false);
    assert.equal(r.ok, false);
  });

  it("fails auditability when the audit table stores a body column", () => {
    for (const col of ["body", "text", "content", "raw"]) {
      const r = runGovernanceSuite(fakeStore({ columns: ["op", col] }));
      assert.equal(r.gates.G3_auditability!.pass, false, col);
      assert.equal(r.ok, false);
    }
  });

  it("fails reversibility when search misses a retired row", () => {
    const r = runGovernanceSuite(fakeStore({ searchMissesRetired: true }));
    assert.equal(r.gates.G2_reversibility!.pass, false);
    assert.match(r.gates.G2_reversibility!.detail, /search misses retired/);
  });

  it("rejects the no-op adversary and records an adapter error as an invariant", () => {
    const ok = runGovernanceSuite(fakeStore());
    assert.equal(ok.gates.G4_quality!.pass, true);
    const broken = fakeStore();
    const r = runGovernanceSuite({ ...broken, recall: () => { throw new Error("cli down"); } });
    assert.equal(r.ok, false);
    assert.ok(r.invariants.some((i) => /adapter error: cli down/.test(i)));
  });

  it("passes provenance and probe leakage checks on the suite fixtures", () => {
    const r = runGovernanceSuite(fakeStore());
    assert.equal(r.gates.leak_provenance!.pass, true);
    assert.equal(r.gates.leak_probe!.pass, true);
  });
});
