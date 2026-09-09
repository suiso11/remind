import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

function writeConfig(dir: string): string {
  const p = path.join(dir, "memory.config.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      dbPath: "./smoke.db",
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
    }),
  );
  return p;
}

function runCli(configPath: string, stdin: string) {
  return spawnSync(process.execPath, [cli, "--config", configPath], {
    input: stdin,
    encoding: "utf8",
  });
}

describe("cli smoke (T1 foundation)", () => {
  it("boots, seeds scopes, and honestly reports unimplemented domain", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-smoke-"));
    const cfg = writeConfig(dir);
    // T4 stays deferred; T3 implements record.recall (empty params are BAD_REQUEST).
    const req =
      JSON.stringify({ v: 1, op: "record.correct-request", idempotencyKey: "k-smoke-1", params: {} }) + "\n";
    const r = runCli(cfg, req);
    assert.equal(r.status, 0);
    const res = JSON.parse(r.stdout.trim());
    assert.equal(res.v, 1);
    assert.equal(res.ok, false);
    assert.equal(res.code, "NOT_IMPLEMENTED");
    const db = new DatabaseSync(path.join(dir, "smoke.db"));
    const rows = db
      .prepare("SELECT scope FROM scopes ORDER BY scope")
      .all() as Array<{ scope: string }>;
    db.close();
    assert.deepEqual(
      rows.map((x) => x.scope),
      ["personal/default"],
    );
  });

  it("rejects bad envelopes with ok:false (exit 0), bad startup with non-zero", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-smoke-"));
    const cfg = writeConfig(dir);
    const bad = runCli(cfg, JSON.stringify({ v: 1, op: "nope", params: {} }) + "\n");
    assert.equal(bad.status, 0);
    assert.equal(JSON.parse(bad.stdout.trim()).code, "BAD_REQUEST");

    const oversize = runCli(cfg, "x".repeat(32769));
    assert.equal(oversize.status, 0);
    assert.equal(JSON.parse(oversize.stdout.trim()).code, "LIMIT_EXCEEDED");

    const missingArg = spawnSync(process.execPath, [cli], { encoding: "utf8" });
    assert.notEqual(missingArg.status, 0);
    assert.equal(missingArg.stdout, "");

    const badCfg = spawnSync(
      process.execPath,
      [cli, "--config", path.join(dir, "missing.json")],
      { input: "{}\n", encoding: "utf8" },
    );
    assert.notEqual(badCfg.status, 0);
    assert.equal(badCfg.stdout, "");
  });
});
