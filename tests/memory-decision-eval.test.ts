import { describe, it, before } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const evaluator = path.join(repoRoot, "dist", "scripts", "evaluate-memory-decisions.js");
const fitScript = path.join(repoRoot, "dist", "scripts", "decision-policy-fit.js");
const labelsPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "decision-labels-")), "labels.jsonl");

// The evaluator performs ~320 real CLI spawns; the single-call budget is 30 s.
// This outer budget only needs headroom for process startup on loaded runners.
const EVALUATOR_TIMEOUT_MS = 900000;

let cachedStatus: number | null | undefined;
let cachedReport: Record<string, unknown> | null = null;
let cachedStderr = "";
let cachedStdoutHead = "";

before(() => {
  const r = spawnSync(process.execPath, [evaluator, "--labels", labelsPath], {
    encoding: "buffer",
    timeout: EVALUATOR_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 4 * 1024 * 1024,
    shell: false,
  });
  cachedStatus = r.status;
  const out: Buffer = Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(String(r.stdout ?? ""));
  cachedStdoutHead = out.subarray(0, 4096).toString("utf8");
  cachedStderr = (Buffer.isBuffer(r.stderr) ? r.stderr : Buffer.from(String(r.stderr ?? "")))
    .subarray(0, 2048)
    .toString("utf8");
  const first = out.toString("utf8").split("\n")[0] ?? "";
  try {
    cachedReport = first ? (JSON.parse(first) as Record<string, unknown>) : null;
  } catch {
    cachedReport = null;
  }
  if (cachedStatus !== 0 || cachedReport === null) {
    const invariants = cachedReport?.["invariants"];
    process.stderr.write(
      `[memory-decisions] evaluator exit=${String(cachedStatus)} ` +
        `invariants=${JSON.stringify(invariants)} ` +
        `stdout(first 4096 bytes): ${cachedStdoutHead} ` +
        `stderr(first 2048 bytes): ${cachedStderr}\n`,
    );
  }
});

function report(): Record<string, unknown> {
  assert.ok(
    cachedReport !== null,
    `evaluator must emit JSON (exit=${String(cachedStatus)} stderr=${JSON.stringify(cachedStderr.slice(0, 1024))})`,
  );
  return cachedReport as Record<string, unknown>;
}

function objectAt(value: unknown, label: string): Record<string, unknown> {
  assert.ok(typeof value === "object" && value !== null && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

describe("memory decision evaluator", () => {
  it("exits zero with no harness invariants", () => {
    assert.equal(cachedStatus, 0, `stderr=${JSON.stringify(cachedStderr.slice(0, 1024))}`);
    const r = report();
    assert.equal(r["ok"], true);
    assert.deepEqual(r["invariants"], []);
  });

  it("runs all four MemProbe paradigms and preserves the core behavior", () => {
    const memprobe = objectAt(report()["memprobe"], "memprobe");
    const scenarios = memprobe["scenarios"];
    assert.ok(Array.isArray(scenarios));
    assert.deepEqual(
      (scenarios as Array<Record<string, unknown>>).map((s) => s["name"]),
      ["interference", "misinformation", "consolidation", "reconsolidation"],
    );
    const overall = objectAt(memprobe["overall"], "memprobe.overall");
    assert.equal(overall["stability"], 1);
    assert.equal(overall["plasticity"], 1);
    assert.equal(overall["currentAccuracy"], 1);
    assert.ok(typeof overall["probes"] === "number" && overall["probes"] >= 25);
  });

  it("reports retrieval support without inventing coverage", () => {
    const support = objectAt(report()["support"], "support");
    assert.ok(typeof support["required"] === "number" && support["required"] > 0);
    assert.equal(support["requiredSupported"], support["required"]);
    assert.equal(support["supportFailureRate"], 0);
    assert.ok(typeof support["zeroExposureRate"] === "number");
  });

  it("produces counterfactual lifecycle decisions with headroom and reversal", () => {
    const lifecycle = objectAt(report()["lifecycle"], "lifecycle");
    const headroom = objectAt(lifecycle["headroom"], "lifecycle.headroom");
    assert.ok(typeof headroom["2"] === "number" && (headroom["2"] as number) > 0);
    assert.ok(typeof headroom["4"] === "number" && (headroom["4"] as number) > 0);
    assert.ok(typeof lifecycle["horizonReversal"] === "number" && (lifecycle["horizonReversal"] as number) > 0);
    const diversity = objectAt(lifecycle["oracleDiversity"], "lifecycle.oracleDiversity");
    assert.ok(Object.values(diversity).filter((n) => typeof n === "number" && n > 0).length >= 2);
  });

  it("passes every governance gate", () => {
    const governance = objectAt(report()["governance"], "governance");
    assert.equal(governance["ok"], true);
    const gates = objectAt(governance["gates"], "governance.gates");
    for (const [name, gate] of Object.entries(gates)) {
      assert.ok(typeof gate === "object" && gate !== null && !Array.isArray(gate), `${name} gate shape`);
      assert.equal((gate as Record<string, unknown>)["pass"], true, name);
    }
  });

  it("skips the model leg without a config and exports diagnostic labels", () => {
    const consolidate = objectAt(report()["consolidate"], "consolidate");
    assert.equal(consolidate["status"], "skipped");
    const lines = fs.readFileSync(labelsPath, "utf8").trim().split("\n");
    assert.equal(lines.length, 4);
    const row = JSON.parse(lines[0]!) as Record<string, unknown>;
    assert.equal(row["stream"], "lifecycle");
    const features = objectAt(row["features"], "labels.features");
    for (const key of ["kind", "ageHours", "links", "heat", "exposures", "hasConflict"]) {
      assert.ok(key in features, `missing label feature ${key}`);
    }
    objectAt(row["utility"], "labels.utility");
  });

  it("rejects fitting the four-state lifecycle labels", () => {
    const r = spawnSync(process.execPath, [fitScript, "--input", labelsPath], {
      encoding: "utf8",
      timeout: 60000,
      maxBuffer: 1024 * 1024,
      shell: false,
    });
    assert.equal(r.status, 0, `fit stderr=${String(r.stderr).slice(0, 1024)}`);
    const fit = JSON.parse(String(r.stdout)) as Record<string, unknown>;
    assert.equal(fit["accepted"], false);
    assert.ok(typeof fit["reason"] === "string" && fit["reason"].startsWith("skipped:"), String(fit["reason"]));
    assert.equal(fit["autoApply"], false);
  });
});
