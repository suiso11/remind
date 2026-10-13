/**
 * R08 CLI boundary + replay acceptance over the real async child CLI.
 *
 * Every case spawns dist/src/cli.js as a real child process (no in-process
 * wiring echoes). Deterministic gates: stdout/exit/markers are awaited with
 * deadline polling, never fixed wall sleeps. Deadline assertions are bounded
 * against the CONFIGURED cliMs plus an explicit CI startup/scheduling
 * allowance (long 15s waits survive only as failure-cleanup watchdogs, never
 * as proof bounds, so a 10s wrong default cannot pass). Termination caveat
 * (see deadline.ts): worker.terminate() is best-effort only; the reliable
 * bound is the parent's timely TIMEOUT response plus whole-process exit,
 * with SQLite recovery deciding the commit outcome. TIMEOUT therefore never
 * asserts rollback: callers replay with the same idempotency key + params,
 * and the suite asserts exactly one canonical effect after replay.
 *
 * Lock coverage is split honestly:
 * - the renamed startup case holds the write lock BEFORE spawn, so it only
 *   exercises parent initDb (scopes INSERT) under the 300ms busy wait, never
 *   the worker parent deadline;
 * - the genuine worker case waits for the test-only preload observer's
 *   startup-ready marker (stdin 'data' listener installed after initDb),
 *   THEN acquires a real SQLite write lock, THEN sends a real request with
 *   busyMs >= remaining cliMs so the actual worker blocks on the native
 *   boundary. It asserts the real worker BEGIN marker (positive worker
 *   threadId), the bounded parent TIMEOUT + process exit with the lock held,
 *   and exactly one canonical effect after same-key retry + dedup replay.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync, type ChildProcess, type SpawnOptions } from "node:child_process";
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
/** Explicit bounded CI startup/scheduling allowance for deadline asserts. */
const ALLOW_MS = 4000;
/** Long watchdog used ONLY for failure cleanup waits, never as proof. */
const WATCHDOG_MS = 15000;

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

function observerPath(): string {
  return path.resolve(__dirname, "fixtures", "r08-observer.js");
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

function waitClose(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  // 'exit' reaps the pid (no orphan); 'close' is stdio teardown. If the
  // child already reaped, close has fired or is imminent: settle quickly
  // instead of hanging on a listener that may never re-fire.
  if (child.exitCode !== null || child.signalCode !== null) {
    return new Promise((resolve) => {
      const t = setTimeout(() => resolve(true), 50);
      try {
        (t as unknown as { unref?: () => void }).unref?.();
      } catch {
        /* ignore */
      }
    });
  }
  return new Promise((resolve) => {
    let done = false;
    const finish = (v: boolean): void => {
      if (!done) {
        done = true;
        clearTimeout(timer);
        resolve(v);
      }
    };
    const timer = setTimeout(() => finish(child.exitCode !== null || child.signalCode !== null), timeoutMs);
    try {
      (timer as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* ignore */
    }
    child.once("close", () => finish(true));
    child.once("exit", () => finish(true));
    child.once("error", () => finish(true));
  });
}

/**
 * Owned child lifecycle: every async case registers its children here so
 * the finally block (which alone can see failures) destroys stdin, SIGKILLs
 * only own still-alive pids, and awaits exit+close REAP before temp removal.
 */
class ChildScope {
  private kids: ChildProcess[] = [];
  spawn(file: string, args: string[], opts: SpawnOptions): ChildProcess {
    const c = spawn(file, args, opts);
    this.kids.push(c);
    return c;
  }
  async cleanup(): Promise<void> {
    for (const c of this.kids) {
      try {
        c.stdin?.destroy();
      } catch {
        /* ignore */
      }
      try {
        const pid = c.pid;
        if (typeof pid === "number" && c.exitCode === null && c.signalCode === null) {
          try {
            process.kill(pid, "SIGKILL");
          } catch {
            /* already gone */
          }
        }
      } catch {
        /* ignore */
      }
    }
    for (const c of this.kids) {
      await waitExit(c, 8000);
    }
    for (const c of this.kids) {
      try {
        c.stdout?.destroy();
      } catch {
        /* ignore */
      }
      try {
        c.stderr?.destroy();
      } catch {
        /* ignore */
      }
      await waitClose(c, 8000);
    }
  }
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
    const scope = new ChildScope();
    try {
      const { config, configPath } = makeConfig(dir, "firstlf.db");
      const child = scope.spawn(process.execPath, [cliPath(), "--config", configPath], {
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
      const arrived = await waitFor(() => nonEmptyLines(stdout).length >= 1, WATCHDOG_MS);
      assert.equal(arrived, true, "no JSON response before stdin close; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      const body = parseSingleJson(stdout);
      assert.equal(body["ok"], true);
      assert.equal(body["code"], "OK");
      assert.ok(Buffer.byteLength(nonEmptyLines(stdout)[0], "utf8") <= config.limits.responseMaxBytes);
      // Closing stdin afterwards must not produce a second response line.
      child.stdin?.end();
      assert.equal(await waitExit(child, WATCHDOG_MS), true, "CLI did not exit after stdin close");
      assert.equal(child.exitCode, 0, "stderr=" + stderr.slice(0, 300));
      assert.equal(nonEmptyLines(stdout).length, 1);
    } finally {
      await scope.cleanup();
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
  it("TIMEOUT envelope, exit 0, single line, pid reaped, elapsed bounded by cliMs", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-hold-"));
    const scope = new ChildScope();
    const cliMs = 700;
    try {
      const { config, configPath } = makeConfig(dir, "hold.db", cliMs, 200);
      const t0 = Date.now();
      const child = scope.spawn(process.execPath, [cliPath(), "--config", configPath], {
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
      const exited = await waitExit(child, WATCHDOG_MS);
      const exitElapsed = Date.now() - t0;
      assert.equal(exited, true, "CLI did not exit on held-open stdin; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      assert.equal(child.exitCode, 0, "stderr=" + stderr.slice(0, 300));
      const body = parseSingleJson(stdout);
      assert.equal(body["ok"], false);
      assert.equal(body["code"], "TIMEOUT");
      assert.ok(Buffer.byteLength(nonEmptyLines(stdout)[0], "utf8") <= config.limits.responseMaxBytes);
      // Bounded proof: exit must land near the CONFIGURED deadline, not a
      // 10s wrong default (700 + 4000 = 4700 << 10000). The 15s watchdog
      // above is failure cleanup only, never the assert bound.
      assert.ok(exitElapsed <= cliMs + ALLOW_MS, `exit took ${exitElapsed}ms, beyond ${cliMs}ms + ${ALLOW_MS}ms allowance`);
      assert.ok(exitElapsed >= cliMs - 250, `exit took ${exitElapsed}ms, before the ${cliMs}ms deadline could fire`);
      // No orphan: the pid is reaped and cannot be signalled.
      assert.ok(typeof child.pid === "number");
      let alive = true;
      try {
        process.kill(child.pid as number, 0);
      } catch {
        alive = false;
      }
      assert.equal(alive, false, "child pid still alive after exit");
    } finally {
      await scope.cleanup();
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

  it("held-open multibyte UTF-8 over 32768 bytes trips the streaming byte cap without LF/EOF", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-utf8cap-"));
    const scope = new ChildScope();
    try {
      const { config, configPath } = makeConfig(dir, "utf8cap.db");
      // é is 2 bytes in UTF-8: 20000 chars (< 32768 chars) but 40000 bytes
      // (> 32768 bytes). A char-counting cap would miss it; the byte cap
      // must trip while streaming, with no LF and no EOF.
      const payload = "é".repeat(20000);
      assert.ok([...payload].length < RAW_MAX_BYTES, "need chars under the cap");
      assert.ok(Buffer.byteLength(payload, "utf8") > RAW_MAX_BYTES, "need bytes over the cap");
      const child = scope.spawn(process.execPath, [cliPath(), "--config", configPath], {
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
      const buf = Buffer.from(payload, "utf8");
      for (let off = 0; off < buf.length; off += 8192) {
        child.stdin?.write(buf.subarray(off, Math.min(off + 8192, buf.length)));
      }
      // stdin stays held open: no LF, no end. The streaming byte cap must
      // answer LIMIT_EXCEEDED on its own (EOF checkRawSize cannot save a
      // broken streaming cap here because EOF never arrives first).
      const arrived = await waitFor(() => nonEmptyLines(stdout).length >= 1, WATCHDOG_MS);
      assert.equal(arrived, true, "no LIMIT_EXCEEDED while stdin held open; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      const body = parseSingleJson(stdout);
      assert.equal(body["ok"], false);
      assert.equal(body["code"], "LIMIT_EXCEEDED");
      assert.ok(Buffer.byteLength(nonEmptyLines(stdout)[0], "utf8") <= config.limits.responseMaxBytes);
      assert.equal(await waitExit(child, WATCHDOG_MS), true, "CLI did not exit after streaming cap");
      assert.equal(child.exitCode, 0, "stderr=" + stderr.slice(0, 300));
      assert.equal(nonEmptyLines(stdout).length, 1);
    } finally {
      await scope.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R08 genuine SQLite lock fails closed; same-key retry effects exactly one row then dedups", () => {
  it("startup initDb busy (lock held before spawn) fails closed, then retry resolves one effect + replay", () => {
    // NOTE: the write lock is acquired BEFORE the child spawns, so the only
    // contended path is parent initDb (scopes INSERT) under the 300ms busy
    // wait. This case does NOT cover the worker parent deadline; the genuine
    // worker TIMEOUT under a post-startup lock is the next case.
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
      // CLI startup's writes hit SQLITE_BUSY within its bounded busy wait.
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

  it("genuine worker parent TIMEOUT under a post-startup write lock, then retry resolves one effect + replay", async () => {
    // Real worker deadline proof: the lock is acquired only AFTER the
    // observer's startup-ready marker (stdin 'data' listener installed past
    // initDb), so the contended path is the actual store worker, not
    // startup. busyMs (10000) >= remaining cliMs (2500) so the real worker
    // blocks on the native SQLite boundary; the independent parent timer
    // must answer TIMEOUT first, followed by whole-process exit, with the
    // lock held throughout. No stubbed store op, Worker, success, or timer:
    // the only test hook is the pass-through preload observer (always-OK
    // semantics) that records the ready barrier and the real worker BEGIN.
    // TIMEOUT outcome is unknown: no rollback is inferred; the suite only
    // asserts exactly one canonical effect after same-key retry + dedup.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r08-workertimeout-"));
    const scope = new ChildScope();
    const cliMs = 2500;
    let seedDb: DatabaseSync | null = null;
    let locker: DatabaseSync | null = null;
    try {
      const { config, configPath } = makeConfig(dir, "workertimeout.db", cliMs, 10000);
      ({ db: seedDb } = initDb(config, configPath));
      if (seedDb === null) throw new Error("db init failed");
      const ev = eventAppend(
        seedDb,
        config,
        {
          eventId: "e-r08-wt-1",
          sessionId: "s1",
          turnId: "t1",
          body: "r08 worker timeout probe raw context",
          provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: SCOPE,
        },
        "r08-wt-seed-ev-1",
      );
      assert.equal(ev.ok, true, JSON.stringify(ev));
      seedDb.close();
      seedDb = null;
      const readyFile = path.join(dir, "r08-child-ready");
      const workerFile = path.join(dir, "r08-worker-begin");
      const t0 = Date.now();
      const child = scope.spawn(
        process.execPath,
        ["--require", observerPath(), cliPath(), "--config", configPath],
        { stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, R08_OBS_DIR: dir } },
      );
      let stdout = "";
      child.stdout?.on("data", (d: Buffer) => {
        stdout += d.toString("utf8");
      });
      let stderr = "";
      child.stderr?.on("data", (d: Buffer) => {
        stderr += d.toString("utf8");
      });
      // Barrier 1: child startup is past initDb (stdin reader installed).
      const ready = await waitFor(() => fs.existsSync(readyFile), WATCHDOG_MS);
      assert.equal(ready, true, "child never reached post-initDb startup; stderr=" + stderr.slice(0, 200));
      // Barrier 2: hold a genuine SQLite write lock BEFORE the request, so
      // the real worker's BEGIN blocks on the native boundary.
      locker = new DatabaseSync(config.dbPath);
      locker.exec("BEGIN IMMEDIATE");
      const key = "r08-wt-key-1";
      const params = {
        body: "r08 worker timeout retry memo harbor",
        kind: "user_fact",
        provenance: { source: "session:s1:turn:3", observedAt: OBS },
        scope: SCOPE,
        sourceRefs: ["e-r08-wt-1"],
      };
      const line = JSON.stringify({ v: 1, op: "record.remember", idempotencyKey: key, params });
      child.stdin?.write(line + "\n");
      // The REAL worker must reach the native SQLite boundary on its own
      // thread: positive worker threadId in the observer marker.
      const wseen = await waitFor(() => fs.existsSync(workerFile), WATCHDOG_MS);
      assert.equal(wseen, true, "real worker never reached SQLite BEGIN; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      const wtext = fs.readFileSync(workerFile, "utf8");
      const wm = /threadId=(\d+)/.exec(wtext);
      assert.ok(wm !== null && Number(wm[1]) > 0, "expected positive worker threadId, got " + JSON.stringify(wtext));
      // The independent parent timer must answer TIMEOUT while the lock is
      // still held (bounded by the CONFIGURED deadline, not the watchdog).
      const arrived = await waitFor(() => nonEmptyLines(stdout).length >= 1, WATCHDOG_MS);
      const responseElapsed = Date.now() - t0;
      assert.equal(arrived, true, "no TIMEOUT response under held write lock; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      const body = parseSingleJson(stdout);
      assert.equal(body["ok"], false);
      assert.equal(body["code"], "TIMEOUT");
      assert.ok(Buffer.byteLength(nonEmptyLines(stdout)[0], "utf8") <= config.limits.responseMaxBytes);
      assert.ok(responseElapsed <= cliMs + ALLOW_MS, `TIMEOUT took ${responseElapsed}ms, beyond ${cliMs}ms + ${ALLOW_MS}ms allowance`);
      // Whole-process exit follows with the lock STILL held (released only
      // after the reap below): bounded the same way.
      const exited = await waitExit(child, WATCHDOG_MS);
      const exitElapsed = Date.now() - t0;
      assert.equal(exited, true, "CLI did not exit on worker deadline; stdout=" + JSON.stringify(stdout.slice(0, 200)));
      assert.equal(child.exitCode, 0, "stderr=" + stderr.slice(0, 300));
      assert.equal(nonEmptyLines(stdout).length, 1);
      assert.ok(exitElapsed <= cliMs + ALLOW_MS, `exit took ${exitElapsed}ms, beyond ${cliMs}ms + ${ALLOW_MS}ms allowance`);
      assert.ok(exitElapsed >= cliMs - 250, `exit took ${exitElapsed}ms, before the ${cliMs}ms deadline could fire`);
      // Release the lock only after the CLI has fully exited (reaped).
      try {
        locker.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      locker.close();
      locker = null;
      // Same key + params retry resolves the single canonical effect; the
      // TIMEOUT attempt's outcome stays unknown and is never inferred.
      const first = syncRun(configPath, line + "\n");
      assert.equal(first.status, 0, "stderr=" + first.stderr.slice(0, 300));
      const firstBody = parseSingleJson(first.stdout);
      assert.equal(firstBody["ok"], true, JSON.stringify(firstBody));
      assert.equal(firstBody["code"], "OK");
      const firstId = ((firstBody["data"] as { record: { id: string } }).record as { id: string }).id;
      const replay = syncRun(configPath, line + "\n");
      assert.equal(replay.status, 0);
      const replayBody = parseSingleJson(replay.stdout);
      assert.equal(replayBody["ok"], true, JSON.stringify(replayBody));
      assert.equal(replayBody["deduplicated"], true);
      const replayId = ((replayBody["data"] as { record: { id: string } }).record as { id: string }).id;
      assert.equal(replayId, firstId);
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
      await scope.cleanup();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
