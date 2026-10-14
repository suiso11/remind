/**
 * R08 bin-entry consumer regression: the packaged binary declared in the
 * manifest must execute as a real consumer program (not an in-process import).
 *
 * The test resolves the binary target FROM the manifest bin map, builds an
 * owned platform-appropriate launcher honoring that same target (POSIX
 * symlink on POSIX, .cmd launcher on Windows; no hardcoded dist string
 * asserts, no help-wording asserts, no mock echo), then drives real store behavior through the
 * platform launcher: event.append persists, remember/get returns the same
 * body, same-key replay deduplicates to exactly one canonical effect.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";

function repoRoot(): string {
  return path.resolve(__dirname, "..", "..");
}

function binTargetFromManifest(): string {
  const pkg = JSON.parse(fs.readFileSync(path.join(repoRoot(), "package.json"), "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const rel = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.["memory-cli"] ?? Object.values(pkg.bin ?? {})[0];
  if (typeof rel !== "string" || rel.length === 0) throw new Error("manifest bin missing");
  return path.resolve(repoRoot(), rel);
}

function makeConfig(dir: string): { configPath: string; dbPath: string } {
  const dbPath = path.join(dir, "bin-entry.db");
  const config = {
    dbPath,
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE],
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      linksMax: 10,
      sourceRefsMax: 10,
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 8192,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  const configPath = path.join(dir, "memory.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  return { configPath, dbPath };
}

function buildLauncher(dir: string, target: string): string {
  const binDir = path.join(dir, "owned-bin");
  fs.mkdirSync(binDir, { recursive: true });
  if (process.platform === "win32") {
    const win = path.join(binDir, "memory-cli.cmd");
    fs.writeFileSync(win, `@echo off\r\n"${process.execPath}" "${target}" %*\r\n`, "utf8");
    return win;
  }
  const posix = path.join(binDir, "memory-cli");
  try {
    fs.unlinkSync(posix);
  } catch {
    /* ignore */
  }
  fs.symlinkSync(target, posix);
  return posix;
}

function parseSingle(stdout: string): Record<string, unknown> {
  const lines = stdout.split("\n").filter((l) => l.trim().length > 0);
  assert.equal(lines.length, 1, "expected one JSON line, got: " + JSON.stringify(stdout.slice(0, 300)));
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

function runVia(file: string, configPath: string, line: string): { status: number | null; body: Record<string, unknown>; raw: string; stderr: string } {
  const isCmd = file.endsWith(".cmd");
  const r = isCmd
    ? spawnSync("cmd.exe", ["/c", file, "--config", configPath], { input: line + "\n", encoding: "utf8", timeout: 20000 })
    : spawnSync(file, ["--config", configPath], { input: line + "\n", encoding: "utf8", timeout: 20000 });
  const raw = (r.stdout?.toString() ?? "").trim();
  const stderr = r.stderr?.toString() ?? "";
  assert.equal(r.status, 0, "launcher exit non-zero; stderr=" + stderr.slice(0, 300) + " raw=" + raw.slice(0, 300));
  return { status: r.status, body: parseSingle(r.stdout?.toString() ?? ""), raw, stderr };
}

describe("R08 packaged bin entry executes real store behavior", () => {
  it("owned symlink/cmd launcher persists event, remember/get round-trips, replay dedups", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-binentry-"));
    try {
      const target = binTargetFromManifest();
      assert.ok(fs.existsSync(target), "manifest bin target missing: " + target);
      const { configPath, dbPath } = makeConfig(dir);
      const launcher = buildLauncher(dir, target);
      if (process.platform === "win32") {
        assert.ok(launcher.endsWith(".cmd") && fs.existsSync(launcher));
      } else {
        const st = fs.statSync(target);
        assert.ok((st.mode & 0o111) !== 0, "bin target lacks POSIX exec bit");
      }

      const evLine = JSON.stringify({
        v: 1,
        op: "event.append",
        idempotencyKey: "bin-ev-1",
        params: {
          eventId: "e-bin-1",
          sessionId: "s1",
          turnId: "t1",
          body: "bin entry orchard walk raw note",
          provenance: { source: "session:s1:turn:1", observedAt: OBS },
          scope: SCOPE,
        },
      });
      const ev = runVia(launcher, configPath, evLine);
      assert.equal(ev.body["ok"], true, JSON.stringify(ev.body));
      assert.equal(ev.body["code"], "OK");
      const evId = ((ev.body["data"] as { event?: { eventId?: string } })?.event as { eventId?: string } | undefined)?.eventId;
      assert.equal(evId, "e-bin-1");

      const bodyText = "bin entry persimmon harvest memo";
      const key = "bin-rem-1";
      const remLine = JSON.stringify({
        v: 1,
        op: "record.remember",
        idempotencyKey: key,
        params: {
          body: bodyText,
          kind: "user_fact",
          provenance: { source: "session:s1:turn:1", observedAt: OBS },
          scope: SCOPE,
          sourceRefs: ["e-bin-1"],
        },
      });
      const rem = runVia(launcher, configPath, remLine);
      assert.equal(rem.body["ok"], true, JSON.stringify(rem.body));
      const recordId = ((rem.body["data"] as { record?: { id?: string } })?.record as { id?: string } | undefined)?.id;
      assert.ok(typeof recordId === "string" && recordId.length > 0);

      const getLine = JSON.stringify({ v: 1, op: "record.get", params: { id: recordId, scope: SCOPE } });
      const got = runVia(launcher, configPath, getLine);
      assert.equal(got.body["ok"], true, JSON.stringify(got.body));
      const gotBody = ((got.body["data"] as { record?: { body?: string } })?.record as { body?: string } | undefined)?.body;
      assert.equal(gotBody, bodyText);

      const replay = runVia(launcher, configPath, remLine);
      assert.equal(replay.body["ok"], true, JSON.stringify(replay.body));
      assert.equal(replay.body["deduplicated"], true);
      const replayId = ((replay.body["data"] as { record?: { id?: string } })?.record as { id?: string } | undefined)?.id;
      assert.equal(replayId, recordId);

      const check = new DatabaseSync(dbPath);
      try {
        const nEv = (check.prepare("SELECT COUNT(*) AS n FROM raw_events WHERE eventId=?").get("e-bin-1") as { n: number }).n;
        assert.equal(nEv, 1, "expected exactly one canonical event row");
        const nRec = (check.prepare("SELECT COUNT(*) AS n FROM records WHERE body=?").get(bodyText) as { n: number }).n;
        assert.equal(nRec, 1, "expected exactly one canonical record row");
        const nOps = (check.prepare("SELECT COUNT(*) AS n FROM operations WHERE idempotencyKey=?").get(key) as { n: number }).n;
        assert.equal(nOps, 1, "expected exactly one operations row");
      } finally {
        check.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
