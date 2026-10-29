import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "scripts", "decision-policy-fit.js");

function row(i: number, cls: number, noisy = false): string {
  const rnd = (i * 7919 + 13) % 97; // deterministic pseudo-noise
  const f = noisy
    ? { hasShortProbe: rnd % 2 === 0, hasDelayedReuse: rnd % 3 === 0, hasNoProbe: rnd % 5 === 0 }
    : { hasShortProbe: cls === 0, hasDelayedReuse: cls === 2, hasNoProbe: cls === 1 };
  const utility = [0, 0, 0];
  utility[cls] = 1;
  return JSON.stringify({
    stream: `s${String(i).padStart(3, "0")}`,
    features: { ...f, kind: "user_fact", ageHours: noisy ? rnd : 5, links: noisy ? rnd % 4 : 0 },
    utility: { keep: utility[0], retire: utility[1], correct: utility[2] },
  });
}

function run(lines: string[]): { status: number | null; report: any } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "policy-fit-"));
  const input = path.join(dir, "in.jsonl");
  fs.writeFileSync(input, lines.join("\n") + "\n");
  const r = spawnSync(process.execPath, [cli, "--input", input], { encoding: "utf8" });
  return { status: r.status, report: r.status === 0 ? JSON.parse(r.stdout) : null };
}

describe("decision-policy-fit", () => {
  it("accepts a separable 90-row fixture", () => {
    const { status, report } = run(Array.from({ length: 90 }, (_, i) => row(i, i % 3)));
    assert.equal(status, 0);
    assert.equal(report.accepted, true, report.reason);
    assert.equal(report.autoApply, false);
    assert.equal(report.holdoutN, 18);
    assert.equal(report.holdoutAccuracy, 1);
  });

  it("rejects label-noise fixture", () => {
    const { status, report } = run(Array.from({ length: 90 }, (_, i) => row(i, (i * i * 31 + i * 17 + 5) % 7 % 3, true)));
    assert.equal(status, 0);
    assert.equal(report.accepted, false);
    assert.match(report.reason, /^rejected|^skipped/);
  });

  it("skips when n < 30", () => {
    const { status, report } = run(Array.from({ length: 12 }, (_, i) => row(i, i % 3)));
    assert.equal(status, 0);
    assert.equal(report.accepted, false);
    assert.match(report.reason, /^skipped: n=12/);
  });

  it("exits 2 on malformed JSONL", () => {
    const { status } = run([row(0, 0), "{not json"]);
    assert.equal(status, 2);
  });
});
