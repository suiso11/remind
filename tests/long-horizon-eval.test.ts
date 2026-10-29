import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as path from "node:path";

const evaluator = path.resolve(__dirname, "..", "..", "dist", "scripts", "evaluate-long-horizon.js");

function run(args: string[]) {
  const r = spawnSync(process.execPath, [evaluator, ...args], { encoding: "utf8", timeout: 300000 });
  const first = (r.stdout ?? "").split("\n")[0] ?? "";
  return { status: r.status, stderr: r.stderr ?? "", report: first ? (JSON.parse(first) as Record<string, unknown>) : null };
}

describe("long-horizon evaluator", () => {
  it("emits a square temporal matrix and finite metrics", () => {
    const { status, stderr, report } = run(["--sessions", "6", "--memories-per-session", "1", "--probes-per-session", "1"]);
    assert.ok(report, stderr);
    assert.equal(status, 0, JSON.stringify(report["invariants"]) + stderr);
    assert.deepEqual(report["invariants"], []);
    const matrix = report["matrix"] as (number | null)[][];
    assert.equal(matrix.length, 6);
    matrix.forEach((row, i) => {
      assert.equal(row.length, 6);
      row.forEach((cell, j) => {
        if (j <= i) assert.ok(typeof cell === "number" && cell >= 0 && cell <= 1);
        else assert.equal(cell, null);
      });
    });
    for (const k of ["finalRetention", "immediateAcquisition", "forgetting"]) {
      assert.ok(Number.isFinite(report[k]), k);
    }
    assert.equal((report["ageRecall"] as number[]).length, 6);
    assert.equal(report["probes"], 21);
  });

  it("rejects malformed arguments with exit 2", () => {
    for (const args of [["--sessions", "0"], ["--sessions", "x"], ["--bogus"], ["--probes-per-session"]]) {
      assert.equal(run(args).status, 2, args.join(" "));
    }
  });
});
