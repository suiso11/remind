import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const evaluator = path.join(repoRoot, "dist", "scripts", "evaluate-operations.js");

let cachedStatus: number | null | undefined;
let cachedReport: Record<string, unknown> | null = null;
let cachedStderr = "";
let cachedStdoutHead = "";

before(() => {
  const r = spawnSync(process.execPath, [evaluator], {
    encoding: "buffer",
    timeout: 300000,
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
  // Diagnostics on failure only (never on green runs): the evaluator's report
  // JSON and fixed stderr lines are the only way to attribute a platform-only
  // harness failure from CI logs. Bounded so a broken child cannot flood logs.
  cachedStdoutHead = out.subarray(0, 4096).toString("utf8");
  cachedStderr = (Buffer.isBuffer(r.stderr) ? r.stderr : Buffer.from(String(r.stderr ?? "")))
    .subarray(0, 2048).toString("utf8");
  if (cachedStatus !== 0 || cachedReport === null) {
    process.stderr.write(
      `[operations-eval] evaluator exit=${String(cachedStatus)} ` +
      `error=${r.error ? String((r.error as Error).name) : "none"}\n` +
      `[operations-eval] stdout(first 4096 bytes): ${cachedStdoutHead}\n` +
      `[operations-eval] stderr(first 2048 bytes): ${cachedStderr}\n`,
    );
  }
});

/** Assertion-message diagnostics: status, invariant failures, stderr excerpt. */
function diag(): string {
  const failures = (cachedReport?.["invariants"] as { failures?: unknown[] } | null)?.failures;
  const parts = [
    `evaluator exit=${String(cachedStatus)}`,
    `invariantFailures=${JSON.stringify(failures ?? "no-report")}`,
    `stderr=${JSON.stringify(cachedStderr.slice(0, 1024))}`,
  ];
  return parts.join(" ");
}

function report(): Record<string, unknown> {
  assert.ok(cachedReport !== null, `evaluator must emit JSON report (${diag()})`);
  return cachedReport as Record<string, unknown>;
}

interface ScaleReport {
  scale: number;
  seedWritesOk: boolean;
  lifecycle: {
    correction: Record<string, unknown>;
    retirement: Record<string, unknown>;
    feedback: Record<string, unknown>;
  };
  retrieval: {
    denominators: { plannedNormal: number; executedNormal: number; normalFailures: number };
    positive: { count: number; failed: number };
    negative: { total: number };
  };
  indexFallback: Record<string, unknown>;
  queue: Record<string, unknown>;
  latency: { all: { count: number } | null; success: { count: number } | null; cliCalls: number };
  storage: { dbBytes: number; records: number };
}

function scales(): ScaleReport[] {
  const rep = report();
  assert.equal(rep["fixture"], "operations-v1");
  assert.equal(rep["syntheticOnly"], true);
  assert.deepEqual(rep["scales"], [10, 30, 60]);
  const mode = rep["mode"] as { acceptanceThresholds?: unknown; semanticClaim?: unknown };
  assert.equal(mode?.acceptanceThresholds, null);
  assert.equal(mode?.semanticClaim, false);
  return rep["scaleReports"] as ScaleReport[];
}

describe("operations evaluator single-run lifecycle proof", () => {
  it("actual process exits 0 with ok setup and no invariant failures", () => {
    assert.equal(cachedStatus, 0, diag());
    const rep = report();
    assert.equal((rep["setup"] as { status?: string })?.status, "ok", diag());
    assert.deepEqual((rep["invariants"] as { failures?: unknown })?.failures, []);
  });

  it("correction excludes superseded and retirement round-trips at every scale", () => {
    for (const s of scales()) {
      assert.equal(s.seedWritesOk, true, `scale ${s.scale} seedWritesOk: ${diag()}`);
      const c = s.lifecycle.correction;
      assert.equal(c["status"], "ok");
      assert.equal(c["oldStatus"], "superseded");
      assert.equal(c["newStatus"], "active");
      assert.equal(c["supersedesMatchesOld"], true);
      assert.equal(c["recallExcludesSuperseded"], true);
      assert.equal(c["recallNewHitsLatest"], true);
      const r = s.lifecycle.retirement;
      assert.equal(r["status"], "ok");
      assert.equal(r["recallBeforeIncludes"], true);
      assert.equal(r["recallExcludesRetired"], true);
      assert.equal(r["searchRecoversRetired"], true);
      assert.equal(r["reactivationRestoresRecall"], true);
      const f = s.lifecycle.feedback;
      assert.equal(f["status"], "ok");
      for (const k of ["validFeedbackAccepted", "selectedHeatPlusOne", "unselectedUnchanged", "invalidRejectedWhole", "invalidHeatUnchanged"]) {
        assert.equal(f[k], true, `scale ${s.scale} ${k}`);
      }
    }
  });

  it("denominators honest, index fallback and queue cap hold at every scale", () => {
    for (const s of scales()) {
      const d = s.retrieval.denominators;
      assert.equal(d.executedNormal, d.plannedNormal);
      assert.equal(d.normalFailures, 0);
      assert.ok(s.retrieval.positive.count > 0 && s.retrieval.positive.failed === 0);
      assert.ok(s.retrieval.negative.total > 0);
      assert.equal(s.indexFallback["status"], "ok");
      assert.equal(s.indexFallback["corruptFtsRowStillHits"], true);
      // Post-recall DB proof: the corrupted derived row was still corrupted
      // when recall ran (no startup repair touched it), so the hit proves
      // the canonical bodyNorm fallback for real.
      assert.equal(s.indexFallback["ftsRowStillCorruptedAfterRecall"], true);
      // With the canonical substitute-rank fix, the damaged canonical hit
      // receives the lexical signal a healthy index would have given it, so
      // the conversation-shaped query at small top-k (limit 3) is asserted.
      assert.equal(s.indexFallback["conversationShapedQueryStillHits"], true);
      assert.equal(s.queue["status"], "ok");
      assert.equal(s.queue["queueMax"], 8);
      assert.ok((s.queue["openReviews"] as number) <= 8);
      assert.equal(s.queue["bounded"], true);
      assert.ok(s.latency.cliCalls > 0 && (s.latency.all?.count ?? 0) === s.latency.cliCalls);
      assert.ok(s.storage.dbBytes > 0 && s.storage.records > s.scale);
    }
    const ordered = scales();
    assert.ok(ordered[0]!.storage.dbBytes < ordered[1]!.storage.dbBytes);
    assert.ok(ordered[1]!.storage.dbBytes < ordered[2]!.storage.dbBytes);
  });
});
