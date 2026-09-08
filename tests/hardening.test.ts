import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

function writeConfig(dir: string, overrides?: Record<string, unknown>): string {
  const p = path.join(dir, "memory.config.json");
  const base: Record<string, unknown> = {
    dbPath: "./hardening.db",
    allowedScopes: ["personal/default"],
    candidateTtlSec: 259200,
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 8192,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  if (overrides?.["timeouts"]) {
    base["timeouts"] = overrides["timeouts"];
  }
  fs.writeFileSync(p, JSON.stringify(base));
  return p;
}

function parseSingleJsonLine(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((l) => l.length > 0);
  assert.equal(lines.length, 1);
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

describe("hardened stdin bounds (T1)", () => {
  it("raw overflow without newline returns LIMIT_EXCEEDED", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const cfg = writeConfig(dir);
    // No LF at all; pipe closes via spawnSync EOF.
    const r = spawnSync(process.execPath, [cli, "--config", cfg], {
      input: "x".repeat(32769),
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const res = parseSingleJsonLine(r.stdout);
    assert.equal(res["ok"], false);
    assert.equal(res["code"], "LIMIT_EXCEEDED");
  });

  it("deadline with held-open pipe returns TIMEOUT", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const cfg = writeConfig(dir, { timeouts: { cliMs: 400, busyMs: 200 } });
    const child = spawn(process.execPath, [cli, "--config", cfg], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    // Partial frame, no LF, and the pipe stays open (no end()).
    child.stdin.write('{"v":1,"op":"record.recall"');
    const started = Date.now();
    const res = await new Promise<{ status: number | null }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("child did not exit on deadline")), 8000);
      child.once("exit", (code) => {
        clearTimeout(t);
        resolve({ status: code });
      });
      child.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    const elapsed = Date.now() - started;
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    assert.equal(res.status, 0);
    assert.ok(elapsed < 8000, `elapsed ${elapsed}ms`);
    const body = parseSingleJsonLine(stdout);
    assert.equal(body["code"], "TIMEOUT");
    assert.equal(body["ok"], false);
    // node:sqlite prints an ExperimentalWarning on stderr; that is the only
    // non-fixed text allowed. It must never carry request bytes or secrets.
    assert.ok(!stderr.includes('"ok"'));
    assert.ok(!stderr.includes("record.recall"));
  });

  it("invalid UTF8 is a fatal BAD_REQUEST without echo or crash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const cfg = writeConfig(dir);
    const raw = Buffer.concat([Buffer.from([0xff, 0xfe, 0x41]), Buffer.from("\n")]);
    const r = spawnSync(process.execPath, [cli, "--config", cfg], { input: raw });
    assert.equal(r.status, 0);
    const out = (r.stdout as Buffer).toString("utf8");
    const body = parseSingleJsonLine(out);
    assert.equal(body["code"], "BAD_REQUEST");
    assert.equal(body["ok"], false);
    assert.ok(!out.includes("SECRET"));
  });

  it("responds to one LF without waiting for EOF", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const cfg = writeConfig(dir);
    const child = spawn(process.execPath, [cli, "--config", cfg], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d) => (stdout += d));
    const req = JSON.stringify({ v: 1, op: "record.recall", params: {} }) + "\n";
    child.stdin.write(req);
    // Deliberately keep stdin open: the CLI must answer on LF alone.
    const res = await new Promise<{ status: number | null }>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("no LF-framed response without EOF")), 8000);
      child.once("exit", (code) => {
        clearTimeout(t);
        resolve({ status: code });
      });
      child.once("error", (e) => {
        clearTimeout(t);
        reject(e);
      });
    });
    try {
      child.kill();
    } catch {
      /* ignore */
    }
    assert.equal(res.status, 0);
    const body = parseSingleJsonLine(stdout);
    assert.equal(body["ok"], false);
    // T3 implements record.recall: empty params are strict BAD_REQUEST
    // (still proving the LF-framed response arrives without EOF).
    assert.equal(body["code"], "BAD_REQUEST");
  });

  it("never echoes secrets in envelopes or fixed stderr", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const cfg = writeConfig(dir);
    const secret = "SUPERSECRET-9f8a7b6c5d";
    const bad = spawnSync(
      process.execPath,
      [cli, "--config", cfg],
      {
        input: JSON.stringify({ v: 1, op: "record.recall", params: {}, extra: secret }) + "\n",
        encoding: "utf8",
      },
    );
    assert.equal(bad.status, 0);
    assert.ok(!String(bad.stdout).includes(secret));
    assert.ok(!String(bad.stderr).includes(secret));

    const badArg = spawnSync(
      process.execPath,
      [cli, "--config", cfg, `--bogus=${secret}`],
      { input: "\n", encoding: "utf8" },
    );
    assert.notEqual(badArg.status, 0);
    assert.equal(badArg.stdout, "");
    assert.ok(!String(badArg.stderr).includes(secret));
    assert.equal(String(badArg.stderr), "error: bad arguments\n");

    const badCfgDir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const badCfg = path.join(badCfgDir, "c.json");
    fs.writeFileSync(badCfg, JSON.stringify({ bogus: secret }));
    const badCfgRun = spawnSync(process.execPath, [cli, "--config", badCfg], {
      input: "{}\n",
      encoding: "utf8",
    });
    assert.notEqual(badCfgRun.status, 0);
    assert.equal(badCfgRun.stdout, "");
    assert.ok(!String(badCfgRun.stderr).includes(secret));
    assert.equal(String(badCfgRun.stderr), "error: invalid config\n");
  });

  it("domain validation never returns ok:true on bad input (T4: no NOT_IMPLEMENTED)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const cfg = writeConfig(dir);
    // T3 implements record.recall: empty params are strict BAD_REQUEST.
    const recall = spawnSync(process.execPath, [cli, "--config", cfg], {
      input: JSON.stringify({ v: 1, op: "record.recall", params: {} }) + "\n",
      encoding: "utf8",
    });
    assert.equal(recall.status, 0);
    const rBody = parseSingleJsonLine(recall.stdout);
    assert.equal(rBody["ok"], false);
    assert.equal(rBody["code"], "BAD_REQUEST");

    // T2 implements candidate.create/get, T4 implements record.correct-request:
    // empty params are validation failures (BAD_REQUEST) on every domain op.
    const create = spawnSync(process.execPath, [cli, "--config", cfg], {
      input:
        JSON.stringify({ v: 1, op: "candidate.create", idempotencyKey: "c-001", params: {} }) + "\n",
      encoding: "utf8",
    });
    assert.equal(create.status, 0);
    const cBody = parseSingleJsonLine(create.stdout);
    assert.equal(cBody["ok"], false);
    assert.equal(cBody["code"], "BAD_REQUEST");

    const correct = spawnSync(process.execPath, [cli, "--config", cfg], {
      input:
        JSON.stringify({ v: 1, op: "record.correct-request", idempotencyKey: "c-002", params: {} }) + "\n",
      encoding: "utf8",
    });
    assert.equal(JSON.parse(String(correct.stdout).trim()).code, "BAD_REQUEST");
  });

  it("multiline input already buffered is BAD_REQUEST", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-hard-"));
    const cfg = writeConfig(dir);
    const line1 = JSON.stringify({ v: 1, op: "record.recall", params: {} });
    const line2 = JSON.stringify({ v: 1, op: "candidate.get", params: {} });
    const r = spawnSync(process.execPath, [cli, "--config", cfg], {
      input: line1 + "\n" + line2 + "\n",
      encoding: "utf8",
    });
    assert.equal(r.status, 0);
    const body = parseSingleJsonLine(r.stdout);
    assert.equal(body["code"], "BAD_REQUEST");
  });
});
