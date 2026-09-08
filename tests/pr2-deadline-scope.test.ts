import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { applyEffectiveBusyTimeout, initDb } from "../src/db.js";
import { effectiveBusyMs, runStoreOpWithDeadline } from "../src/deadline.js";
import {
  approveCandidate,
  createCandidate,
  getCandidateForReview,
  getCandidateMeta,
  isScopeAuthorized,
  recallRecords,
} from "../src/store.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

function writeConfig(
  dir: string,
  dbName = "pr2.db",
  overrides: Record<string, unknown> = {},
): string {
  const p = path.join(dir, "memory.config.json");
  const base = {
    dbPath: `./${dbName}`,
    allowedScopes: ["personal/default", "personal/other"],
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
  const merged = { ...base, ...overrides } as Record<string, unknown>;
  if (overrides["limits"]) {
    merged["limits"] = { ...(base.limits as object), ...(overrides["limits"] as object) };
  }
  if (overrides["timeouts"]) {
    merged["timeouts"] = { ...(base.timeouts as object), ...(overrides["timeouts"] as object) };
  }
  fs.writeFileSync(p, JSON.stringify(merged));
  return p;
}

function openDb(cfgPath: string) {
  const config = loadConfig(cfgPath);
  const { db, dbFile } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config, dbFile };
}

describe("PR2 P2: scope I/O failures are STORE_UNAVAILABLE, denials stay FORBIDDEN_SCOPE", () => {
  it("closed DB maps to STORE_UNAVAILABLE (never FORBIDDEN_SCOPE)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-scope-"));
    const cfg = writeConfig(dir, "s1.db");
    const { db, config } = openDb(cfg);
    db.close();
    assert.throws(() => isScopeAuthorized(db, config, "personal/default"), /scope check unavailable/);
    assert.equal(
      getCandidateMeta(db, config, { id: "cand_x", scope: "personal/default" }).code,
      "STORE_UNAVAILABLE",
    );
    assert.equal(
      recallRecords(db, config, { query: "hello", scope: "personal/default" }).code,
      "STORE_UNAVAILABLE",
    );
    assert.equal(
      createCandidate(
        db,
        config,
        {
          body: "hello world",
          kind: "user_fact",
          provenance: { source: "s", observedAt: "2026-09-01T00:00:00.000Z" },
          scope: "personal/default",
        },
        "k-closed-1",
      ).code,
      "STORE_UNAVAILABLE",
    );
    const forReview = getCandidateForReview(db, config, "cand_x", "personal/default");
    assert.equal(forReview.ok, false);
    if (!forReview.ok) assert.equal(forReview.code, "STORE_UNAVAILABLE");
  });

  it("missing scopes table maps to STORE_UNAVAILABLE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-scope-"));
    const cfg = writeConfig(dir, "s2.db");
    const { db, config } = openDb(cfg);
    db.exec("DROP TABLE scopes");
    assert.throws(() => isScopeAuthorized(db, config, "personal/default"), /scope check unavailable/);
    assert.equal(
      recallRecords(db, config, { query: "hello", scope: "personal/default" }).code,
      "STORE_UNAVAILABLE",
    );
    assert.equal(
      getCandidateMeta(db, config, { id: "cand_x", scope: "personal/default" }).code,
      "STORE_UNAVAILABLE",
    );
    db.close();
  });

  it("genuine denials stay FORBIDDEN_SCOPE (config-absent and revoked row)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-scope-"));
    const cfg = writeConfig(dir, "s3.db");
    const { db, config } = openDb(cfg);
    // Config-absent scope: never touches the table path for denial.
    assert.equal(isScopeAuthorized(db, config, "nope/scope"), false);
    assert.equal(
      recallRecords(db, config, { query: "hello", scope: "nope/scope" }).code,
      "FORBIDDEN_SCOPE",
    );
    assert.equal(
      getCandidateMeta(db, config, { id: "cand_x", scope: "nope/scope" }).code,
      "FORBIDDEN_SCOPE",
    );
    // Revoked DB row (in config, gone from table): still denial, not unavailable.
    db.prepare("DELETE FROM scopes WHERE scope = ?").run("personal/other");
    assert.equal(isScopeAuthorized(db, config, "personal/other"), false);
    assert.equal(
      recallRecords(db, config, { query: "hello", scope: "personal/other" }).code,
      "FORBIDDEN_SCOPE",
    );
    db.close();
  });
});

describe("PR2 P1: effective remaining deadline (bounded busy wait + worker termination)", () => {
  it("effectiveBusyMs clamps busyMs by the remaining cliMs", () => {
    assert.equal(effectiveBusyMs(2000, 1000), 1000);
    assert.equal(effectiveBusyMs(2000, 5000), 2000);
    assert.equal(effectiveBusyMs(2000, 0), 0);
    assert.equal(effectiveBusyMs(2000, -50), 0);
    assert.equal(effectiveBusyMs(5000, 1000), 1000);
  });

  it("applyEffectiveBusyTimeout enforces the clamp on the handle", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-busy-"));
    const cfg = writeConfig(dir, "b1.db");
    const { db } = openDb(cfg);
    assert.equal(applyEffectiveBusyTimeout(db, 2000, 300), 300);
    const row = db.prepare("PRAGMA busy_timeout").get() as { timeout?: number; busy_timeout?: number };
    const cur = (row?.timeout ?? row?.busy_timeout ?? -1) as number;
    assert.equal(cur, 300);
    db.close();
  });

  it("worker with injected long scan hits the independent deadline (no late OK)", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-worker-"));
    const cfg = writeConfig(dir, "w1.db");
    const { db, config, dbFile } = openDb(cfg);
    db.close();
    // Test-only controlled worker (no production env backdoor): blocks past
    // the deadline, then posts a late envelope the parent must ignore.
    const slowPath = path.join(dir, "slow-worker.cjs");
    fs.writeFileSync(
      slowPath,
      `const { parentPort, workerData } = require('node:worker_threads');\n` +
        `const end = Date.now() + 4000;\nwhile (Date.now() < end) {}\n` +
        `parentPort.postMessage({ res: { v: 1, ok: false, code: 'NOT_FOUND', message: 'late', data: null, deduplicated: false } });\n`,
    );
    const t0 = Date.now();
    const out = await runStoreOpWithDeadline(
      {
        dbFile,
        config,
        op: "record.recall",
        params: { query: "hello", scope: "personal/default" },
        effectiveBusyMs: effectiveBusyMs(config.timeouts.busyMs, 300),
      },
      300,
      slowPath,
    );
    const elapsed = Date.now() - t0;
    assert.equal(out.timedOut, true);
    // Bounded by the parent timer + process-level exit path, far below the
    // 4000ms injected scan. No claim of native interruption is made.
    assert.ok(elapsed < 2500, `bounded elapsed, got ${elapsed}ms`);
  });

  it("worker construction/error/exit-without-message resolve STORE_UNAVAILABLE, not false TIMEOUT", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-worker-"));
    const cfg = writeConfig(dir, "wfail.db");
    const { db, config, dbFile } = openDb(cfg);
    db.close();
    // Bad worker path => construction failure => immediate STORE_UNAVAILABLE.
    const bad = await runStoreOpWithDeadline(
      {
        dbFile,
        config,
        op: "record.recall",
        params: { query: "hello", scope: "personal/default" },
        effectiveBusyMs: 0,
      },
      2000,
      path.join(dir, "does-not-exist.cjs"),
    );
    assert.equal(bad.timedOut, false);
    if (!bad.timedOut) assert.equal(bad.res.code, "STORE_UNAVAILABLE");
    // Worker that exits without a message => immediate STORE_UNAVAILABLE.
    const silentPath = path.join(dir, "silent-worker.cjs");
    fs.writeFileSync(silentPath, `/* exits 0 with no message */\n`);
    const t0 = Date.now();
    const silent = await runStoreOpWithDeadline(
      {
        dbFile,
        config,
        op: "record.recall",
        params: { query: "hello", scope: "personal/default" },
        effectiveBusyMs: 0,
      },
      5000,
      silentPath,
    );
    const elapsed = Date.now() - t0;
    assert.equal(silent.timedOut, false);
    if (!silent.timedOut) assert.equal(silent.res.code, "STORE_UNAVAILABLE");
    assert.ok(elapsed < 4000, `immediate failure, got ${elapsed}ms`);
    // Zero/negative budget => genuine deadline TIMEOUT.
    const expired = await runStoreOpWithDeadline(
      {
        dbFile,
        config,
        op: "record.recall",
        params: { query: "hello", scope: "personal/default" },
        effectiveBusyMs: 0,
      },
      0,
    );
    assert.equal(expired.timedOut, true);
  });

  it("readOperation I/O failure fails closed (missing operations table)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-readop-"));
    const cfg = writeConfig(dir, "rop.db");
    const { db, config } = openDb(cfg);
    db.exec("DROP TABLE operations");
    assert.equal(
      createCandidate(
        db,
        config,
        {
          body: "hello world",
          kind: "user_fact",
          provenance: { source: "s", observedAt: "2026-09-01T00:00:00.000Z" },
          scope: "personal/default",
        },
        "k-rop-1",
      ).code,
      "STORE_UNAVAILABLE",
    );
    db.close();
  });

  it("fast worker op completes before the deadline with its real envelope", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-worker-"));
    const cfg = writeConfig(dir, "w2.db");
    const { db, config, dbFile } = openDb(cfg);
    db.close();
    const out = await runStoreOpWithDeadline(
      {
        dbFile,
        config,
        op: "candidate.get",
        params: { id: "cand_missing", scope: "personal/default" },
        effectiveBusyMs: effectiveBusyMs(config.timeouts.busyMs, 5000),
      },
      5000,
    );
    assert.equal(out.timedOut, false);
    if (!out.timedOut) assert.equal(out.res.code, "NOT_FOUND");
  });

  it("child CLI with held write lock and busyMs>cliMs stays bounded with no late OK", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-lock-"));
    const cfg = writeConfig(dir, "lock.db", { timeouts: { cliMs: 1000, busyMs: 5000 } });
    // Seed one record first (unlocked).
    {
      const { db, config } = openDb(cfg);
      const c = createCandidate(
        db,
        config,
        {
          body: "booking reference alpha",
          kind: "user_fact",
          provenance: { source: "s", observedAt: "2026-09-01T00:00:00.000Z" },
          scope: "personal/default",
        },
        "k-seed-lock-1",
      );
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const ap = approveCandidate(
        db,
        config,
        { id, scope: "personal/default", token: rev.token, idempotencyKey: "k-seed-lock-2" },
        "2026-09-02T00:00:00.000Z",
      );
      assert.equal(ap.ok, true);
      db.close();
    }
    const config = loadConfig(cfg);
    const dbFile = path.join(dir, "lock.db");
    const holder = new DatabaseSync(dbFile);
    holder.exec("BEGIN IMMEDIATE");
    try {
      const req = { v: 1, op: "record.recall", params: { query: "booking", scope: "personal/default", limit: 5 } };
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [cli, "--config", cfg], {
        input: JSON.stringify(req) + "\n",
        encoding: "utf8",
        timeout: 20000,
      });
      const elapsed = Date.now() - t0;
      const body = JSON.parse(String(r.stdout).trim()) as { ok: boolean; code: string };
      // Bounded: well under the 5000ms configured busy wait; never a late ok:true.
      assert.ok(elapsed < 4000, `bounded elapsed, got ${elapsed}ms`);
      assert.equal(body.ok, false);
      assert.ok(
        body.code === "TIMEOUT" || body.code === "STORE_UNAVAILABLE",
        `bounded code, got ${body.code}`,
      );
      void config;
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      try {
        holder.close();
      } catch {
        /* ignore */
      }
    }
    // After the lock is released there is no orphan txn: recall succeeds.
    const after = spawnSync(process.execPath, [cli, "--config", cfg], {
      input: JSON.stringify({ v: 1, op: "record.recall", params: { query: "booking", scope: "personal/default", limit: 5 } }) + "\n",
      encoding: "utf8",
      timeout: 20000,
    });
    const afterBody = JSON.parse(String(after.stdout).trim()) as { ok: boolean; code: string };
    assert.equal(afterBody.ok, true);
    assert.equal(afterBody.code, "OK");
  });

  it("unknown-outcome WRITE under lock is atomic and retryable with no duplicate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr2-wlock-"));
    const cfg = writeConfig(dir, "wlock.db", { timeouts: { cliMs: 1000, busyMs: 5000 } });
    // Ensure the DB exists first (unlocked).
    {
      const { db } = openDb(cfg);
      db.close();
    }
    const dbFile = path.join(dir, "wlock.db");
    const holder = new DatabaseSync(dbFile);
    holder.exec("BEGIN IMMEDIATE");
    const params = {
      body: "unknown outcome write probe",
      kind: "user_fact",
      provenance: { source: "s", observedAt: "2026-09-01T00:00:00.000Z" },
      scope: "personal/default",
    };
    const req = { v: 1, op: "candidate.create", idempotencyKey: "k-unknown-1", params };
    let first: { ok: boolean; code: string };
    try {
      const t0 = Date.now();
      const r = spawnSync(process.execPath, [cli, "--config", cfg], {
        input: JSON.stringify(req) + "\n",
        encoding: "utf8",
        timeout: 20000,
      });
      const elapsed = Date.now() - t0;
      assert.ok(elapsed < 4000, `bounded write elapsed, got ${elapsed}ms`);
      first = JSON.parse(String(r.stdout).trim()) as { ok: boolean; code: string };
      // Killed/timed-out write: never a late ok:true while the lock is held.
      assert.equal(first.ok, false);
      assert.ok(
        first.code === "TIMEOUT" || first.code === "STORE_UNAVAILABLE",
        `bounded write code, got ${first.code}`,
      );
    } finally {
      try {
        holder.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      try {
        holder.close();
      } catch {
        /* ignore */
      }
    }
    // Atomicity: candidate row and operations row are both-or-neither.
    {
      const { db } = openDb(cfg);
      try {
        const cands = db
          .prepare(`SELECT id, idempotencyKey FROM candidates WHERE idempotencyKey = ?`)
          .all("k-unknown-1") as Array<{ id: string; idempotencyKey: string }>;
        const ops = db
          .prepare(`SELECT idempotencyKey FROM operations WHERE idempotencyKey = ?`)
          .all("k-unknown-1") as Array<{ idempotencyKey: string }>;
        assert.ok(
          (cands.length === 0 && ops.length === 0) || (cands.length === 1 && ops.length === 1),
          `both-or-neither, got cands=${cands.length} ops=${ops.length}`,
        );
      } finally {
        db.close();
      }
    }
    // Retry with the same key + params after reopening: succeeds, no duplicate.
    const retry = spawnSync(process.execPath, [cli, "--config", cfg], {
      input: JSON.stringify(req) + "\n",
      encoding: "utf8",
      timeout: 20000,
    });
    const retryBody = JSON.parse(String(retry.stdout).trim()) as {
      ok: boolean;
      code: string;
      deduplicated: boolean;
    };
    assert.equal(retryBody.ok, true);
    assert.equal(retryBody.code, "OK");
    {
      const { db } = openDb(cfg);
      try {
        const cands = db
          .prepare(`SELECT id FROM candidates WHERE idempotencyKey = ?`)
          .all("k-unknown-1") as Array<{ id: string }>;
        const ops = db
          .prepare(`SELECT idempotencyKey FROM operations WHERE idempotencyKey = ?`)
          .all("k-unknown-1") as Array<{ idempotencyKey: string }>;
        assert.equal(cands.length, 1);
        assert.equal(ops.length, 1);
      } finally {
        db.close();
      }
    }
  });
});
