import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const evaluator = path.join(repoRoot, "dist", "scripts", "evaluate-baseline.js");

function runEvaluator(): { status: number | null; report: Record<string, unknown> | null; stderr: string } {
  const r = spawnSync(process.execPath, [evaluator], {
    encoding: "buffer",
    timeout: 120000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  const out: Buffer = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? ""));
  const first = out.toString("utf8").split("\n")[0] ?? "";
  let report: Record<string, unknown> | null = null;
  try {
    report = first ? (JSON.parse(first) as Record<string, unknown>) : null;
  } catch {
    report = null;
  }
  const errBuf: Buffer = Buffer.isBuffer(r.stderr) ? r.stderr : Buffer.alloc(0);
  return { status: r.status, report, stderr: errBuf.toString("utf8") };
}

describe("baseline evaluator compiled integration", () => {
  it("seeded lifecycle resolves 8 active P and real ID mapping", () => {
    const { status, report } = runEvaluator();
    assert.ok(report !== null, `evaluator must emit JSON report (status=${String(status)})`);
    const setup = report?.["setup"] as { status?: string } | undefined;
    assert.equal(setup?.status, "ok");
    const aliasToId = report?.["aliasToId"] as Record<string, string> | undefined;
    assert.ok(aliasToId && typeof aliasToId === "object");
    // 11 retained aliases: 10 seeds + corrected new (orphan has no record).
    for (const a of ["orchard", "tea", "delivery", "beacon", "chart", "lens", "bicycle", "foreign", "retired", "old", "new"]) {
      assert.ok(typeof aliasToId?.[a] === "string" && (aliasToId?.[a] as string).length > 0, a);
    }
    // Distinct IDs, real record IDs (not alias strings).
    const ids = Object.values(aliasToId as Record<string, string>);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.ok(!["orchard", "tea", "delivery", "new", "old"].includes(id));
    }
    // Gold IDs are actual IDs, not aliases.
    const queries = report?.["queries"] as Array<{ goldAliases: string[]; goldIds: Array<string | null> }> | undefined;
    assert.ok(Array.isArray(queries) && queries.length === 12);
    for (const q of queries as Array<{ goldAliases: string[]; goldIds: Array<string | null> }>) {
      assert.equal(q.goldIds.length, q.goldAliases.length);
      for (let i = 0; i < q.goldAliases.length; i++) {
        const alias = q.goldAliases[i] as string;
        const gid = q.goldIds[i] as string | null;
        assert.ok(typeof gid === "string" && gid.length > 0);
        assert.notEqual(gid, alias);
        assert.equal(gid, (aliasToId as Record<string, string>)[alias]);
      }
    }
  });

  it("scope isolation and raw-snippet privacy hold on real CLI results", () => {
    const { report } = runEvaluator();
    assert.ok(report !== null);
    const aliasToId = report?.["aliasToId"] as Record<string, string>;
    const attempts = report?.["attempts"] as Array<{
      queryId: string; returnedIds: string[]; snippets: string[]; goldIds: string[]; ok: boolean; code: string;
    }>;
    assert.equal(attempts.length, 36);
    const foreignId = aliasToId["foreign"] as string;
    // Scope-isolation query must never expose the W record through P recalls.
    for (const a of attempts.filter((x) => x.queryId === "q08-scope-isolation")) {
      assert.ok(!a.returnedIds.includes(foreignId), JSON.stringify(a));
    }
    // Raw-descent: query is raw-only; returned snippet is the normalized body prefix.
    for (const a of attempts.filter((x) => x.queryId === "q03-raw-descent")) {
      for (const sn of a.snippets) {
        assert.ok(!sn.includes("xylophone"), sn);
        assert.ok(!sn.includes("User:"), sn);
        assert.ok(!sn.includes("Assistant:"), sn);
      }
    }
  });

  it("numerical artifact keeps honest denominators and separate probes", () => {
    const { report } = runEvaluator();
    assert.ok(report !== null);
    const denom = report?.["denominators"] as { plannedPositive?: number; plannedNegative?: number; plannedNormal?: number; executedNormal?: number } | undefined;
    assert.equal(denom?.plannedPositive, 21);
    assert.equal(denom?.plannedNegative, 15);
    assert.equal(denom?.plannedNormal, 36);
    assert.equal(denom?.executedNormal, 36);
    const agg = report?.["aggregation"] as {
      positive?: { count?: number };
      negative?: { total?: number };
      latencySuccess?: { count?: number } | null;
    } | undefined;
    assert.equal(agg?.positive?.count, 21);
    assert.equal(agg?.negative?.total, 15);
    // Probes are reported separately and excluded from quality denominators.
    const probes = report?.["probes"] as { direct?: { kind?: string }; adapter?: { code?: string; degraded?: boolean } } | undefined;
    assert.ok(probes?.direct && probes?.adapter);
    assert.equal(probes?.adapter?.code, "STORE_UNAVAILABLE");
    assert.equal(probes?.adapter?.degraded, true);
    // Feedback reports unavailable-or-reported without inventing IDs.
    const fb = report?.["feedback"] as { status?: string; recallId?: string; recordIds?: string[] } | undefined;
    assert.ok(fb && (fb.status === "reported" || fb.status === "unavailable" || fb.status === "failed"));
    if (fb.status === "reported") {
      assert.ok(typeof fb.recallId === "string" && Array.isArray(fb.recordIds) && (fb.recordIds as string[]).length > 0);
    }
  });
});
