/**
 * R08 CLI boundary + replay acceptance over the real async child CLI.
 *
 * Every case spawns dist/src/cli.js as a real child process (no in-process
 * wiring echoes). Deterministic gates: stdout/exit are awaited with deadline
 * polling, never fixed wall sleeps. Termination caveat (see deadline.ts):
 * worker.terminate() is best-effort only; the reliable bound is the parent's
 * timely TIMEOUT response plus whole-process exit, with SQLite recovery
 * deciding the commit outcome. TIMEOUT therefore never asserts rollback:
 * callers replay with the same idempotency key + params.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { eventAppend } from "../src/store.js";
import { RAW_MAX_BYTES } from "../src/protocol.js";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";

function makeConfig(
  dir: string,
  dbName: string,
  cliMs = 5000,
  busyMs = 2000,
): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, dbName),
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
    timeouts: { cliMs, busyMs },
    dbMaxBytes: 104857600,
  };
  const configPath = path.join(dir, "memory.config.json");
  fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
  return { config, configPath };
}

function cliPath(): string {
  return path.resolve(__dirname, "..", "src", "cli.js");
}

function nonEmptyLines(s: string): string[] {
  return s.split("\n").filter((l) => l.trim().length > 0);
}

function parseSingleJson(stdout: string): Record<string, unknown> {
  const lines = nonEmptyLines(stdout);
  assert.equal(lines.length, 1, "expected exactly one JSON line, got: " + JSON.stringify(stdout.slice(0, 300)));
  return JSON.parse(lines[0]) as Record<string, unknown>;
}

function waitFor(cond: () => boolean, timeoutMs: number, pollMs = 15): Promise<boolean> {
  const start = Date.now();
  return new Promise((resolve) => {
    const tick = (): void => {
      let v = false;
      try {
        v = cond();
      } catch {
        v = false;
      }
      if (v) {
        resolve(true);
        return;
      }
      if (Date.now() - start >= timeoutMs) {
        resolve(false);
        return;
      }
      setTimeout(tick, pollMs);
    };
    tick();
  });
}

function waitExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  // A child that already reaped before this call never re-fires 'exit'.
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) {
        done = true;
        resolve(false);
      }
    }, timeoutMs);
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* ignore */
    }
    child.once("exit", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
    child.once("error", () => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(true);
      }
    });
  });
}

function recallLine(query = "hello boundary"): string {
  return JSON.stringify({ v: 1, op: "record.recall", params: { query, scope: SCOPE, limit: 5 } });
}

function syncRun(cfgPath: string, input: string | Buffer): { status: number | null; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath(), "--config", cfgPath], {
    input,
    encoding: "utf8",
    timeout: 20000,
  });
  return { status: r.status, stdout: r.stdout?.toString() ?? "", stderr: r.stderr?.toString() ?? "" };
}

describe("R08 first LF answers before stdin closes; EOF without LF terminates", () => {
  it("single bounded JSON arrives while stdin stays open; close adds no second line", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-firstlf-"));
    try {
      const { config, configPath } = makeConfig(dir, "firstlf.db");
      const child = spawn(process.execPath, [cliPath(), "--config", configPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      child.stdin?.write(recallLine() + "\n");
      // The response must arrive WITHOUT closing stdin (held-open pipe).
      const arrived = await waitFor(() => nonEmptyLines(stdout).length >= 1, 30000);
      assert.equal(arrived, true, "no JSON response before stdin close; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      const body = parseSingleJson(stdout);
      assert.equal(body["ok"], true);
      assert.equal(body["code"], "OK");
      assert.ok(Buffer.byteLength(nonEmptyLines(stdout)[0], "utf8") <= config.limits.responseMaxBytes);
      // Closing stdin afterwards must not produce a second response line.
      child.stdin?.end();
      assert.equal(await waitExit(child, 30000), true, "CLI did not exit after stdin close");
      assert.equal(child.exitCode, 0, "stderr=" + stderr.slice(0, 300));
      assert.equal(nonEmptyLines(stdout).length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("EOF without trailing LF still terminates the single request line", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-eof-"));
    try {
      const { configPath } = makeConfig(dir, "eof.db");
      const r = syncRun(configPath, recallLine());
      assert.equal(r.status, 0, "stderr=" + r.stderr.slice(0, 300));
      const body = parseSingleJson(r.stdout);
      assert.equal(body["ok"], true);
      assert.equal(body["code"], "OK");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("already-buffered extra non-whitespace after first LF is BAD_REQUEST", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-multi-"));
    try {
      const { configPath } = makeConfig(dir, "multi.db");
      const input = recallLine() + "\n" + JSON.stringify({ v: 1, op: "record.recall", params: { query: "second", scope: SCOPE } }) + "\n";
      const r = syncRun(configPath, input);
      assert.equal(r.status, 0, "stderr=" + r.stderr.slice(0, 300));
      const body = parseSingleJson(r.stdout);
      assert.equal(body["ok"], false);
      assert.equal(body["code"], "BAD_REQUEST");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R08 held-open stdin without LF times out, exits, leaves no orphan", () => {
  it("TIMEOUT envelope, exit 0, single line, pid reaped", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-hold-"));
    try {
      const { configPath } = makeConfig(dir, "hold.db", 700, 200);
      const child = spawn(process.execPath, [cliPath(), "--config", configPath], {
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      // Partial input, no LF, stdin held open: the cliMs deadline must fire.
      child.stdin?.write('{"v":1,"op":"record.recall","params":{"query":"held open');
      const exited = await waitExit(child, 15000);
      assert.equal(exited, true, "CLI did not exit on held-open stdin; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      assert.equal(child.exitCode, 0, "stderr=" + stderr.slice(0, 300));
      const body = parseSingleJson(stdout);
      assert.equal(body["ok"], false);
      assert.equal(body["code"], "TIMEOUT");
      // No orphan: the pid is reaped and cannot be signalled.
      assert.ok(typeof child.pid === "number");
      let alive = true;
      try {
        process.kill(child.pid as number, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, "child pid still alive after exit");
      try {
        child.stdin?.destroy();
      } catch {
        /* ignore */
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fatal UTF-8 bytes are BAD_REQUEST, not a crash", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-utf8-"));
    try {
      const { configPath } = makeConfig(dir, "utf8.db");
      const bad = Buffer.concat([Buffer.from([0xff, 0xfe, 0xfd]), Buffer.from("\n")]);
      const r = spawnSync(process.execPath, [cliPath(), "--config", configPath], {
        input: bad,
        timeout: 20000,
      });
      assert.equal(r.status, 0, "stderr=" + (r.stderr?.toString() ?? "").slice(0, 300));
      const body = parseSingleJson((r.stdout?.toString() ?? "") as string);
      assert.equal(body["ok"], false);
      assert.equal(body["code"], "BAD_REQUEST");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("exactly 32768 raw bytes is the boundary; 32769 is LIMIT_EXCEEDED", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-rawmax-"));
    try {
      const { configPath } = makeConfig(dir, "rawmax.db");
      assert.equal(RAW_MAX_BYTES, 32768);
      const at = "a".repeat(RAW_MAX_BYTES);
      assert.equal(Buffer.byteLength(at, "utf8"), RAW_MAX_BYTES);
      const rAt = syncRun(configPath, at);
      assert.equal(rAt.status, 0, "stderr=" + rAt.stderr.slice(0, 200));
      const bAt = parseSingleJson(rAt.stdout);
      // At the boundary the streaming cap does not trip: invalid JSON fails
      // as BAD_REQUEST, never LIMIT_EXCEEDED.
      assert.equal(bAt["code"], "BAD_REQUEST");
      const over = "a".repeat(RAW_MAX_BYTES + 1);
      const rOver = syncRun(configPath, over);
      assert.equal(rOver.status, 0, "stderr=" + rOver.stderr.slice(0, 200));
      const bOver = parseSingleJson(rOver.stdout);
      assert.equal(bOver["ok"], false);
      assert.equal(bOver["code"], "LIMIT_EXCEEDED");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R08 genuine SQLite lock fails closed; same-key retry effects exactly one row then dedups", () => {
  it("busy/deadline failure, then retry resolves one canonical effect + replay", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-lock-"));
    let seedDb: DatabaseSync | null = null;
    let locker: DatabaseSync | null = null;
    try {
      const { config, configPath } = makeConfig(dir, "lock.db", 8000, 300);
      ({ db: seedDb } = initDb(config, configPath));
      if (seedDb === null) throw new Error("db init failed");
      const ev = eventAppend(
        seedDb,
        config,
        {
          eventId: "e-r08-lock-1",
          sessionId: "s1",
          turnId: "t1",
          body: "r08 lock probe raw context",
          provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: SCOPE,
        },
        "r08-lock-seed-ev-1",
      );
      assert.equal(ev.ok, true, JSON.stringify(ev));
      seedDb.close();
      seedDb = null;
      // Genuine write lock: a second connection holds BEGIN IMMEDIATE so the
      // CLI worker's writes hit SQLITE_BUSY within its bounded busy wait.
      locker = new DatabaseSync(config.dbPath);
      locker.exec("BEGIN IMMEDIATE");
      const key = "r08-lock-key-1";
      const params = {
        body: "r08 lock retry memo harbor",
        kind: "user_fact",
        provenance: { source: "session:s1:turn:3", observedAt: OBS },
        scope: SCOPE,
        sourceRefs: ["e-r08-lock-1"],
      };
      const line = JSON.stringify({ v: 1, op: "record.remember", idempotencyKey: key, params });
      // The CLI must exit (never hang) while the lock is held.
      const blocked = syncRun(configPath, line + "\n");
      assert.equal(blocked.status, 0, "stderr=" + blocked.stderr.slice(0, 300));
      const blockedBody = parseSingleJson(blocked.stdout);
      assert.equal(blockedBody["ok"], false);
      assert.ok(
        blockedBody["code"] === "STORE_UNAVAILABLE" || blockedBody["code"] === "TIMEOUT",
        "expected busy/deadline failure, got " + JSON.stringify(blockedBody),
      );
      // Release the lock only after the CLI has fully exited (syncRun reaped it).
      try {
        locker.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      locker.close();
      locker = null;
      // Same key + params retry resolves the single canonical effect.
      const first = syncRun(configPath, line + "\n");
      assert.equal(first.status, 0, "stderr=" + first.stderr.slice(0, 300));
      const firstBody = parseSingleJson(first.stdout);
      assert.equal(firstBody["ok"], true, JSON.stringify(firstBody));
      assert.equal(firstBody["code"], "OK");
      const firstId = ((firstBody["data"] as { record: { id: string } }).record as { id: string }).id;
      // Immediate replay deduplicates without a second effect.
      const replay = syncRun(configPath, line + "\n");
      assert.equal(replay.status, 0);
      const replayBody = parseSingleJson(replay.stdout);
      assert.equal(replayBody["ok"], true, JSON.stringify(replayBody));
      assert.equal(replayBody["deduplicated"], true);
      const replayId = ((replayBody["data"] as { record: { id: string } }).record as { id: string }).id;
      assert.equal(replayId, firstId);
      // Exactly one canonical effect for this body + one operations row.
      const check = new DatabaseSync(config.dbPath);
      try {
        const n = (check.prepare("SELECT COUNT(*) AS n FROM records WHERE body=?").get(params.body) as { n: number }).n;
        assert.equal(n, 1, "expected exactly one canonical record row");
        const ops = (check.prepare("SELECT COUNT(*) AS n FROM operations WHERE idempotencyKey=?").get(key) as { n: number }).n;
        assert.equal(ops, 1, "expected exactly one operations row");
      } finally {
        check.close();
      }
    } finally {
      try {
        try {
          locker?.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        locker?.close();
      } catch {
        /* ignore */
      }
      try {
        seedDb?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
