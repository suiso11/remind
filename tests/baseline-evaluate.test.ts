import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const evaluator = path.join(repoRoot, "dist", "scripts", "evaluate-baseline.js");

interface Attempt {
  queryId: string;
  round: number;
  ok: boolean;
  code: string;
  returnedIds: string[];
  snippets: string[];
  recallId: string | null;
  goldIds: string[];
  hits: number;
  pAt3: number | null;
  recall: number | null;
  rr: number | null;
  firstRank: number | null;
  failed: boolean;
  invalid: boolean;
  kind: string;
}

let cachedStatus: number | null | undefined;
let cachedReport: Record<string, unknown> | null = null;
let cachedStderr = "";
let cachedStdoutHead = "";

before(() => {
  const r = spawnSync(process.execPath, [evaluator], {
    encoding: "buffer",
    timeout: 180000,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  cachedStatus = r.status;
  const out: Buffer = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? ""));
  const first = out.toString("utf8").split("\n")[0] ?? "";
  try {
    cachedReport = first ? (JSON.parse(first) as Record<string, unknown>) : null;
  } catch {
    cachedReport = null;
  }
  // Diagnostics only when the child failed: the report carries setup.reason
  // and the evaluator's own stderr, which are the only way to attribute a
  // platform-only subprocess failure from CI logs (bounded, never floods).
  cachedStdoutHead = out.subarray(0, 4096).toString("utf8");
  cachedStderr = (Buffer.isBuffer(r.stderr) ? r.stderr : Buffer.from(String(r.stderr ?? "")))
    .subarray(0, 2048).toString("utf8");
  if (cachedStatus !== 0 || cachedReport === null) {
    process.stderr.write(
      `[baseline-eval] evaluator exit=${String(cachedStatus)}\n` +
      `[baseline-eval] stdout(first 4096 bytes): ${cachedStdoutHead}\n` +
      `[baseline-eval] stderr(first 2048 bytes): ${cachedStderr}\n`,
    );
  }
});

function report(): Record<string, unknown> {
  assert.ok(cachedReport !== null, `evaluator must emit JSON report (status=${String(cachedStatus)})`);
  return cachedReport as Record<string, unknown>;
}

// Independent oracle: local top-k scoring, never the production scorer.
function indieScore(returnedIds: string[], goldIds: string[], k: number): { hits: number; pAt3: number; recall: number; rr: number; firstRank: number | null } {
  const gold = new Set(goldIds);
  let hits = 0;
  let firstRank: number | null = null;
  const bound = Math.min(returnedIds.length, k);
  for (let i = 0; i < bound; i++) {
    if (gold.has(returnedIds[i] as string)) {
      hits += 1;
      if (firstRank === null) firstRank = i + 1;
    }
  }
  return { hits, pAt3: hits / k, recall: goldIds.length === 0 ? 0 : hits / goldIds.length, rr: firstRank === null ? 0 : 1 / firstRank, firstRank };
}

function close(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

describe("baseline evaluator single-run consumer proof", () => {
  it("actual process exits 0 with ok setup and honest denominators", () => {
    const rep = report();
    assert.equal(
      cachedStatus,
      0,
      `evaluator exited ${String(cachedStatus)}: setup=${JSON.stringify(rep["setup"])} invariants=${JSON.stringify(rep["invariants"])}`,
    );
    const setup = rep["setup"] as { status?: string };
    assert.equal(setup?.status, "ok");
    const denom = rep["denominators"] as { plannedPositive?: number; plannedNegative?: number; plannedNormal?: number; executedNormal?: number; normalFailures?: number };
    assert.equal(denom?.plannedPositive, 21);
    assert.equal(denom?.plannedNegative, 15);
    assert.equal(denom?.plannedNormal, 36);
    assert.equal(denom?.executedNormal, 36);
    assert.equal(denom?.normalFailures, 0);
    const attempts = rep["attempts"] as Attempt[];
    assert.equal(attempts.length, 36);
    assert.equal(attempts.filter((a) => a.kind === "positive").length, 21);
    assert.equal(attempts.filter((a) => a.kind === "negative").length, 15);
    // Quality rows preserved; every normal attempt executed without transport/invariant failure.
    for (const a of attempts) {
      assert.equal(a.failed, false);
      assert.equal(a.invalid, false);
      assert.equal(a.ok, true);
      assert.equal(a.code, "OK");
    }
  });

  it("observation identities stay in active P roles; gold IDs are resolved not aliases", () => {
    const rep = report();
    const aliasToId = rep["aliasToId"] as Record<string, string>;
    const activeAliases = ["orchard", "tea", "delivery", "beacon", "chart", "lens", "bicycle", "new"];
    const activeSet = new Set(activeAliases.map((a) => aliasToId[a] as string));
    assert.equal(activeSet.size, 8);
    const foreignId = aliasToId["foreign"] as string;
    const oldId = aliasToId["old"] as string;
    const retiredId = aliasToId["retired"] as string;
    const attempts = rep["attempts"] as Attempt[];
    for (const a of attempts) {
      assert.ok(a.returnedIds.length <= 3, JSON.stringify(a));
      assert.equal(new Set(a.returnedIds).size, a.returnedIds.length);
      for (const id of a.returnedIds) {
        assert.ok(activeSet.has(id), `unknown/non-active id ${id} in ${a.queryId}`);
        assert.notEqual(id, foreignId);
        assert.notEqual(id, oldId);
        assert.notEqual(id, retiredId);
      }
    }
    const queries = rep["queries"] as Array<{ goldAliases: string[]; goldIds: Array<string | null> }>;
    assert.equal(queries.length, 12);
    for (const q of queries) {
      assert.equal(q.goldIds.length, q.goldAliases.length);
      for (let i = 0; i < q.goldAliases.length; i++) {
        const alias = q.goldAliases[i] as string;
        const gid = q.goldIds[i] as string | null;
        assert.ok(typeof gid === "string" && gid.length > 0);
        assert.notEqual(gid, alias);
        assert.equal(gid, aliasToId[alias]);
        assert.ok(activeSet.has(gid as string) || (gid !== foreignId && gid !== oldId && gid !== retiredId));
      }
    }
    // Scope isolation holds on the actual isolation probe rows.
    for (const a of attempts.filter((x) => x.queryId === "q08-scope-isolation")) {
      assert.ok(!a.returnedIds.includes(foreignId));
      assert.equal(a.returnedIds.length, 0);
    }
  });

  it("positive scores and aggregation independently recomputed from actual observations", () => {
    const rep = report();
    const k = rep["k"] as number;
    assert.equal(k, 3);
    const attempts = rep["attempts"] as Attempt[];
    const positives = attempts.filter((a) => a.kind === "positive");
    assert.equal(positives.length, 21);
    let sP = 0;
    let sR = 0;
    let sRR = 0;
    for (const a of positives) {
      const exp = indieScore(a.returnedIds, a.goldIds, k);
      assert.equal(a.hits, exp.hits, a.queryId);
      assert.ok(close(a.pAt3 as number, exp.pAt3), `${a.queryId} pAt3`);
      assert.ok(close(a.recall as number, exp.recall), `${a.queryId} recall`);
      assert.ok(close(a.rr as number, exp.rr), `${a.queryId} rr`);
      assert.equal(a.firstRank, exp.firstRank);
      sP += exp.pAt3;
      sR += exp.recall;
      sRR += exp.rr;
    }
    const agg = rep["aggregation"] as { positive?: { count?: number; failed?: number; meanPAt3?: number; meanRecall?: number; meanRR?: number } };
    assert.equal(agg?.positive?.count, 21);
    assert.equal(agg?.positive?.failed, 0);
    assert.ok(close(agg?.positive?.meanPAt3 as number, sP / 21));
    assert.ok(close(agg?.positive?.meanRecall as number, sR / 21));
    assert.ok(close(agg?.positive?.meanRR as number, sRR / 21));
    // Negative fractions match the observed negative rows; probes excluded (36 rows only).
    const negatives = attempts.filter((a) => a.kind === "negative");
    assert.equal(negatives.length, 15);
    let validEmpty = 0;
    let validNonempty = 0;
    let failure = 0;
    for (const a of negatives) {
      if (!a.ok || a.failed || a.invalid) failure += 1;
      else if (a.returnedIds.length === 0) validEmpty += 1;
      else validNonempty += 1;
    }
    const neg = (rep["aggregation"] as { negative?: { total?: number; validEmpty?: number; validNonempty?: number; failure?: number; fracValidEmpty?: number } }).negative;
    assert.equal(neg?.total, 15);
    assert.equal(neg?.validEmpty, validEmpty);
    assert.equal(neg?.validNonempty, validNonempty);
    assert.equal(neg?.failure, failure);
    assert.ok(close(neg?.fracValidEmpty as number, validEmpty / 15));
    const probes = rep["probes"] as { excludedFromQuality?: boolean; excludedFromDegradation?: boolean };
    assert.equal(probes?.excludedFromQuality, true);
    assert.equal(probes?.excludedFromDegradation, true);
  });

  it("corrupt probe degrades honestly without stderr wording pins", () => {
    const rep = report();
    const probes = rep["probes"] as { direct?: { status?: number; stdoutBytes?: number; stdoutEmpty?: boolean }; adapter?: { degraded?: boolean; code?: string; citations?: unknown }; contract?: { status?: string } };
    assert.equal(probes?.direct?.status, 3);
    assert.equal(probes?.direct?.stdoutEmpty, true);
    assert.equal(probes?.direct?.stdoutBytes, 0);
    assert.equal(probes?.adapter?.degraded, true);
    assert.equal(probes?.adapter?.code, "STORE_UNAVAILABLE");
    assert.deepEqual(probes?.adapter?.citations, []);
    assert.equal(probes?.contract?.status, "ok");
  });

  it("feedback follows the actual eligible exposure, failed never passes", () => {
    const rep = report();
    const attempts = rep["attempts"] as Attempt[];
    const eligible = attempts.find((a) => a.kind === "positive" && a.ok && !a.failed && !a.invalid && (a.hits ?? 0) > 0 && a.recallId && a.returnedIds.length > 0 && a.goldIds.length > 0);
    const fb = rep["feedback"] as { status?: string; recallId?: string; recordIds?: string[] };
    assert.notEqual(fb?.status, "failed", "invoked feedback failure must not pass integration");
    if (eligible) {
      assert.equal(fb?.status, "reported");
      assert.equal(fb?.recallId, eligible.recallId);
      assert.ok(Array.isArray(fb?.recordIds) && (fb?.recordIds as string[]).length > 0);
      const expected = eligible.returnedIds.filter((id) => eligible.goldIds.includes(id));
      assert.deepEqual([...(fb?.recordIds as string[])].sort(), [...expected].sort());
    } else {
      assert.equal(fb?.status, "unavailable");
    }
  });

  it("raw-snippet privacy holds case-insensitively on actual snippets", () => {
    const rep = report();
    const attempts = rep["attempts"] as Attempt[];
    for (const a of attempts.filter((x) => x.queryId === "q03-raw-descent")) {
      for (const sn of a.snippets) {
        const low = sn.toLowerCase();
        assert.ok(!low.includes("xylophone"), sn);
        assert.ok(!low.includes("user:"), sn);
        assert.ok(!low.includes("assistant:"), sn);
      }
    }
  });
});
