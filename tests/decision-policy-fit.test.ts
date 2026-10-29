import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "scripts", "decision-policy-fit.js");

const ACTIONS = ["keep", "retire", "correct"] as const;

// Separable: hasConflict -> correct, high heat -> retire, else keep.
function separableRow(stream: string, i: number): string {
  const cls = i % 3; // 0 keep, 1 retire, 2 correct
  return line(stream, i, cls, {
    hasConflict: cls === 2,
    heat: cls === 1 ? 0.9 : 0.1,
    ageHours: 10 + (i % 5),
    links: i % 4,
    exposures: i % 6,
    kind: i % 2 === 0 ? "user_fact" : "summary",
  });
}

// Noise: features are uninformative (constant), labels are arbitrary, so the fit cannot beat a fixed action.
function noiseRow(stream: string, i: number): string {
  const cls = (i + Math.floor(i / 3)) % 3;
  return line(stream, i, cls, { hasConflict: false, heat: 0.5, ageHours: 10, links: 1, exposures: 2, kind: "user_fact" });
}

function line(stream: string, i: number, cls: number, features: Record<string, unknown>): string {
  const utility: Record<string, number> = {};
  ACTIONS.forEach((a, c) => (utility[a] = c === cls ? 1 : 0));
  // Prevalence spans all three buckets independent of class.
  const prevalence = ((i * 7) % 10) / 10 + 0.05;
  return JSON.stringify({ stream, features, utility, prevalence });
}

function threeStreams(make: (stream: string, i: number) => string): string[] {
  return ["s1", "s2", "s3"].flatMap((s) => Array.from({ length: 30 }, (_, i) => make(s, i)));
}

function run(lines: string[]): { status: number | null; report: any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-fit-"));
  const input = path.join(dir, "in.jsonl");
  fs.writeFileSync(input, lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--input", input], { encoding: "utf8" });
  return { status: r.status, report: r.status === 0 ? JSON.parse(r.stdout) : null };
}

describe("decision-policy-fit", () => {
  it("accepts a separable 3-stream 90-row fixture and holds out whole streams", () => {
    const { status, report } = run(threeStreams(separableRow));
    assert.equal(status, 0);
    assert.equal(report.accepted, true, report.reason);
    assert.equal(report.autoApply, false);
    assert.equal(report.holdoutStreams, 1);
    assert.equal(report.trainStreams, 2);
    assert.equal(report.holdoutN, 30);
    assert.ok(report.holdoutUtility > report.bestFixedUtility);
    assert.equal(report.holdoutAccuracy, 1);
    assert.equal(report.loso.length, 3);
    for (const f of report.loso) {
      assert.equal(f.trainN, 60);
      assert.equal(f.holdoutN, 30);
      assert.ok(f.policyUtility > f.bestFixedUtility, f.stream);
      assert.ok(f.holdoutLoss < f.baselineLoss, f.stream);
    }
    assert.ok(report.losoMeanPolicyUtility > report.losoMeanBestFixedUtility);
    assert.ok(report.losoMeanLossImprovement > 1e-4);
  });

  it("rejects a label-noise fixture", () => {
    const { status, report } = run(threeStreams(noiseRow));
    assert.equal(status, 0);
    assert.equal(report.accepted, false);
    assert.match(report.reason, /^rejected/);
  });

  it("skips when n < 30", () => {
    const { status, report } = run(Array.from({ length: 12 }, (_, i) => separableRow(`s${i % 2}`, i)));
    assert.equal(status, 0);
    assert.equal(report.accepted, false);
    assert.match(report.reason, /^skipped: n=12/);
  });

  it("skips a single stream and reports prevalence-unverified without prevalence evidence", () => {
    const single = run(Array.from({ length: 40 }, (_, i) => separableRow("only", i)));
    assert.equal(single.report.reason, "skipped: <3 streams");
    const two = run(["s1", "s2"].flatMap((s) => Array.from({ length: 30 }, (_, i) => separableRow(s, i))));
    assert.equal(two.report.accepted, false);
    assert.equal(two.report.reason, "skipped: <3 streams");
    assert.deepEqual(two.report.loso, []);
    const noPrev = threeStreams(separableRow).map((l) => {
      const o = JSON.parse(l);
      delete o.prevalence;
      return JSON.stringify(o);
    });
    const r = run(noPrev);
    assert.equal(r.report.accepted, false);
    assert.equal(r.report.reason, "prevalence-unverified");
  });

  it("exits 2 on malformed JSONL and on the removed feature schema", () => {
    assert.equal(run([separableRow("s1", 0), "{not json"]).status, 2);
    const legacy = JSON.stringify({
      stream: "s1",
      features: { hasShortProbe: true, hasDelayedReuse: false, hasNoProbe: false, kind: "user_fact", ageHours: 1, links: 0 },
      utility: { keep: 1, retire: 0, correct: 0 },
    });
    assert.equal(run([legacy]).status, 2);
  });
});
