import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Worker } from "node:worker_threads";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  approveCandidate,
  archiveRecord,
  correctRequest,
  createCandidate,
  getCandidateForReview,
  recallRecords,
} from "../src/store.js";
import { validateRequest } from "../src/protocol.js";
import { isHumanTty } from "../src/cli.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

let keyN = 0;
function nextKey(prefix: string): string {
  keyN += 1;
  return `${prefix}-${Date.now()}-${keyN}`;
}

function writeConfig(dir: string, dbName = "t4.db"): string {
  const p = path.join(dir, "memory.config.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
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
    }),
  );
  return p;
}

function openDb(cfgPath: string) {
  const config = loadConfig(cfgPath);
  const { db } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config };
}

function seedActive(
  db: DatabaseSync,
  config: ReturnType<typeof loadConfig>,
  body: string,
  scope = "personal/default",
): string {
  const c = createCandidate(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: "2026-09-01T00:00:00.000Z" },
      scope,
      tags: [],
    },
    nextKey("k"),
  );
  assert.equal(c.ok, true);
  const id = (c.data as { candidate: { id: string } }).candidate.id as string;
  const rev = getCandidateForReview(db, config, id, scope);
  assert.equal(rev.ok, true);
  if (!rev.ok) throw new Error("review failed");
  const ap = approveCandidate(db, config, { id, scope, token: rev.token, idempotencyKey: nextKey("h") });
  assert.equal(ap.ok, true);
  return (ap.data as { record: { id: string } }).record.id as string;
}

function correctionParams(recordId: string, body: string, scope = "personal/default") {
  return {
    recordId,
    body,
    kind: "correction",
    provenance: { source: "session:s1:turn:9", observedAt: "2026-09-02T00:00:00.000Z" },
    scope,
  };
}

function runJson(cfg: string, obj: unknown) {
  const r = spawnSync(process.execPath, [cli, "--config", cfg], {
    input: JSON.stringify(obj) + "\n",
    encoding: "utf8",
  });
  return { status: r.status, body: JSON.parse(String(r.stdout).trim()) as Record<string, unknown> };
}

describe("T4 correction + archive", () => {
  it("correct-request then approval atomically supersedes (old out, new in)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = seedActive(db, config, "original booking wednesday");
      const cr = correctRequest(db, config, correctionParams(oldId, "corrected booking thursday"), nextKey("kc"));
      assert.equal(cr.ok, true);
      const candId = (cr.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const ap = approveCandidate(
        db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("ha") },
      );
      assert.equal(ap.ok, true);
      const newId = (ap.data as { record: { id: string } }).record.id as string;
      const old = db.prepare(`SELECT status FROM records WHERE id=?`).get(oldId) as { status: string };
      const cur = db.prepare(`SELECT status, supersedes FROM records WHERE id=?`).get(newId) as {
        status: string;
        supersedes: string;
      };
      assert.equal(old.status, "superseded");
      assert.equal(cur.status, "active");
      assert.equal(cur.supersedes, oldId);
      const cand = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(candId) as { status: string };
      assert.equal(cand.status, "approved");
      const audits = db.prepare(`SELECT * FROM audit`).all() as Array<Record<string, unknown>>;
      assert.ok(!JSON.stringify(audits).includes("corrected booking thursday"));
    } finally {
      db.close();
    }
  });

  it("competing correction approvals: exactly one winner, loser CONFLICT with rollback", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = seedActive(db, config, "race base record");
      const mk = (body: string) => {
        const cr = correctRequest(db, config, correctionParams(oldId, body), nextKey("kc"));
        assert.equal(cr.ok, true);
        return (cr.data as { candidate: { id: string } }).candidate.id as string;
      };
      const a = mk("race correction alpha");
      const b = mk("race correction beta");
      const ra = getCandidateForReview(db, config, a, "personal/default");
      const rb = getCandidateForReview(db, config, b, "personal/default");
      assert.equal(ra.ok && rb.ok, true);
      if (!ra.ok || !rb.ok) throw new Error("review failed");
      const recBefore = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      const win = approveCandidate(db, config, { id: a, scope: "personal/default", token: ra.token, idempotencyKey: nextKey("ha") });
      assert.equal(win.ok, true);
      const lose = approveCandidate(db, config, { id: b, scope: "personal/default", token: rb.token, idempotencyKey: nextKey("hb") });
      assert.equal(lose.ok, false);
      assert.equal(lose.code, "CONFLICT");
      const recAfter = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      assert.equal(recAfter, recBefore + 1);
      const loser = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(b) as { status: string };
      assert.equal(loser.status, "candidate");
      const audits = db.prepare(`SELECT * FROM audit`).all() as Array<Record<string, unknown>>;
      assert.ok(!JSON.stringify(audits).includes("race correction beta"));
    } finally {
      db.close();
    }
  });

  it("archive races correction: archived target blocks approval; superseded blocks archive", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = seedActive(db, config, "archive race base");
      const cr = correctRequest(db, config, correctionParams(oldId, "archive race fix"), nextKey("kc"));
      assert.equal(cr.ok, true);
      const candId = (cr.data as { candidate: { id: string } }).candidate.id as string;
      const arch = archiveRecord(
        db, config, { id: oldId, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" },
      );
      assert.equal(arch.ok, true);
      const rev = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const late = approveCandidate(
        db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("ha") },
      );
      assert.equal(late.ok, false);
      assert.equal(late.code, "CONFLICT");
      const again = archiveRecord(
        db, config, { id: oldId, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" },
      );
      assert.equal(again.code, "CONFLICT");
      // Winner path on a fresh record: approve correction, then archiving the
      // superseded old row is CONFLICT while archiving the new row succeeds.
      const fresh = seedActive(db, config, "second archive base");
      const cr2 = correctRequest(db, config, correctionParams(fresh, "second fix"), nextKey("kc"));
      assert.equal(cr2.ok, true);
      const c2 = (cr2.data as { candidate: { id: string } }).candidate.id as string;
      const r2 = getCandidateForReview(db, config, c2, "personal/default");
      assert.equal(r2.ok, true);
      if (!r2.ok) throw new Error("review failed");
      const ap2 = approveCandidate(db, config, { id: c2, scope: "personal/default", token: r2.token, idempotencyKey: nextKey("ha") });
      assert.equal(ap2.ok, true);
      const newId = (ap2.data as { record: { id: string } }).record.id as string;
      assert.equal(
        archiveRecord(db, config, { id: fresh, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" }).code,
        "CONFLICT",
      );
      assert.equal(
        archiveRecord(db, config, { id: newId, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" }).ok,
        true,
      );
    } finally {
      db.close();
    }
  });

  it("scope isolation: cross-scope correction/archive/recall are denied or invisible", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = seedActive(db, config, "scope fenced record", "personal/default");
      assert.equal(correctRequest(db, config, correctionParams(oldId, "x", "personal/other"), nextKey("kc")).code, "FORBIDDEN_SCOPE");
      assert.equal(
        archiveRecord(db, config, { id: oldId, scope: "personal/other", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" }).code,
        "FORBIDDEN_SCOPE",
      );
      const rec = recallRecords(db, config, { query: "fenced", scope: "personal/other", limit: 10 });
      assert.equal(rec.ok, true);
      assert.deepEqual((rec.data as { items: unknown[] }).items, []);
      assert.equal(
        correctRequest(db, config, correctionParams(oldId, "x", "nope/scope"), nextKey("kc")).code,
        "FORBIDDEN_SCOPE",
      );
    } finally {
      db.close();
    }
  });

  it("idempotent replay: same key+params deduplicate, changed params conflict", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = seedActive(db, config, "replay base record");
      const params = correctionParams(oldId, "replay fix body");
      const key = nextKey("kc");
      const first = correctRequest(db, config, params, key);
      assert.equal(first.ok, true);
      const second = correctRequest(db, config, params, key);
      assert.equal(second.ok, true);
      assert.equal((second as { deduplicated?: boolean }).deduplicated, true);
      assert.deepEqual(second.data, first.data);
      assert.equal(correctRequest(db, config, correctionParams(oldId, "different body"), key).code, "CONFLICT");
      const archKey = nextKey("ar");
      const a1 = archiveRecord(db, config, { id: oldId, scope: "personal/default", idempotencyKey: archKey, reasonCode: "USER_ARCHIVED" });
      assert.equal(a1.ok, true);
      const a2 = archiveRecord(db, config, { id: oldId, scope: "personal/default", idempotencyKey: archKey, reasonCode: "USER_ARCHIVED" });
      assert.equal((a2 as { deduplicated?: boolean }).deduplicated, true);
      assert.deepEqual(a2.data, a1.data);
      assert.equal(
        archiveRecord(db, config, { id: oldId, scope: "personal/other", idempotencyKey: archKey, reasonCode: "USER_ARCHIVED" }).code,
        "CONFLICT",
      );
    } finally {
      db.close();
    }
  });

  it("failed correction leaves no orphan candidate or operation row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const candBefore = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      const res = correctRequest(db, config, correctionParams("rec_missing", "orphan check"), nextKey("kc"));
      assert.equal(res.code, "NOT_FOUND");
      const candAfter = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      assert.equal(candAfter, candBefore);
      const oldId = seedActive(db, config, "rollback audit base");
      const arch = archiveRecord(db, config, { id: oldId, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" });
      assert.equal(arch.ok, true);
      const n2 = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      assert.equal(correctRequest(db, config, correctionParams(oldId, "too late fix"), nextKey("kc")).code, "CONFLICT");
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n, n2);
    } finally {
      db.close();
    }
  });

  it("recall excludes superseded and archived records", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const marker = "t4recallmarker";
      const oldId = seedActive(db, config, `${marker} original wording`);
      let rec = recallRecords(db, config, { query: marker, scope: "personal/default", limit: 10 });
      assert.equal(rec.ok, true);
      assert.equal((rec.data as { items: Array<{ id: string }> }).items.map((i) => i.id).includes(oldId), true);
      const cr = correctRequest(db, config, correctionParams(oldId, `${marker} revised wording`), nextKey("kc"));
      assert.equal(cr.ok, true);
      const candId = (cr.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const ap = approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("ha") });
      assert.equal(ap.ok, true);
      const newId = (ap.data as { record: { id: string } }).record.id as string;
      rec = recallRecords(db, config, { query: marker, scope: "personal/default", limit: 10 });
      assert.equal(rec.ok, true);
      const ids = (rec.data as { items: Array<{ id: string }> }).items.map((i) => i.id);
      assert.equal(ids.includes(oldId), false);
      assert.equal(ids.includes(newId), true);
      assert.equal(
        archiveRecord(db, config, { id: newId, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" }).ok,
        true,
      );
      rec = recallRecords(db, config, { query: marker, scope: "personal/default", limit: 10 });
      assert.equal(rec.ok, true);
      assert.deepEqual((rec.data as { items: unknown[] }).items, []);
    } finally {
      db.close();
    }
  });

  it("archive is human-terminal-only: JSON denied, non-TTY refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    for (const op of ["archive", "record.archive", "approve", "reject"]) {
      const v = validateRequest({ v: 1, op, params: {} });
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.res.code, "FORBIDDEN");
    }
    assert.equal(isHumanTty(true, true), true);
    assert.equal(isHumanTty(true, false), false);
    assert.equal(isHumanTty(false, true), false);
    assert.equal(isHumanTty(false, false), false);
    assert.equal(isHumanTty(undefined, true), false);
    const denied = runJson(cfg, { v: 1, op: "record.archive", params: { id: "rec_x", scope: "personal/default" } });
    assert.equal(denied.status, 0);
    assert.equal(denied.body["code"], "FORBIDDEN");
    const { db, config } = openDb(cfg);
    try {
      assert.equal(
        archiveRecord(db, config, { id: "rec_x", scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "WRONG_CODE" }).code,
        "BAD_REQUEST",
      );
    } finally {
      db.close();
    }
  });
});

function dbFileFor(dir: string, dbName = "t4.db"): string {
  return path.join(dir, dbName);
}

function writeRaceWorker(storePath: string, file: string): void {
  fs.writeFileSync(
    file,
    [
      `const { parentPort, workerData } = require("node:worker_threads");`,
      `const { DatabaseSync } = require("node:sqlite");`,
      `const sab = new Int32Array(workerData.sab);`,
      `Atomics.wait(sab, 0, 0);`,
      `function isBusyOpenError(e) {`,
      `  const msg = String((e && e.message) || e || "");`,
      `  const code = String((e && e.code) || "");`,
      `  return /SQLITE_BUSY/i.test(code) || /SQLITE_BUSY/i.test(msg) || /database is locked/i.test(msg);`,
      `}`,
      `let db;`,
      `const openStart = Date.now();`,
      `for (;;) {`,
      `  try { db = new DatabaseSync(workerData.dbFile); break; }`,
      `  catch (e) {`,
      `    if (!isBusyOpenError(e)) throw e;`,
      `    if (Date.now() - openStart >= 8000) throw e;`,
      `    try { Atomics.wait(sab, 0, 1, 10); } catch {}`,
      `  }`,
      `}`,
      `for (;;) {`,
      `  try { db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 8000;"); break; }`,
      `  catch (e) {`,
      `    if (!isBusyOpenError(e)) throw e;`,
      `    if (Date.now() - openStart >= 8000) throw e;`,
      `    try { Atomics.wait(sab, 0, 1, 10); } catch {}`,
      `  }`,
      `}`,
      `const store = require(workerData.storePath);`,
      `let res;`,
      `try {`,
      `  if (workerData.kind === "approve") res = store.approveCandidate(db, workerData.config, workerData.args);`,
      `  else res = store.archiveRecord(db, workerData.config, workerData.args);`,
      `} catch (e) { res = { ok: false, code: "STORE_UNAVAILABLE" }; }`,
      `try { db.close(); } catch {}`,
      `parentPort.postMessage(res);`,
      ``,
    ].join("\n"),
  );
}

function runTwoJobs(
  dbFile: string,
  config: ReturnType<typeof loadConfig>,
  storePath: string,
  workerFile: string,
  jobs: Array<{ kind: string; args: Record<string, unknown> }>,
): Promise<unknown[]> {
  const sab = new SharedArrayBuffer(4);
  const view = new Int32Array(sab);
  view[0] = 0;
  const workers = jobs.map(
    (j) =>
      new Worker(workerFile, {
        workerData: { sab, dbFile, config, storePath, kind: j.kind, args: j.args },
      }),
  );
  const results = workers.map(
    (w) =>
      new Promise<unknown>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("race worker timeout")), 20000);
        w.once("message", (m) => {
          clearTimeout(timer);
          resolve(m);
        });
        w.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      }),
  );
  Atomics.store(view, 0, 1);
  Atomics.notify(view, 0, 2);
  return Promise.all(results).finally(() => {
    for (const w of workers) void w.terminate();
  });
}

describe("T4 real concurrency + rollback + reopen", () => {
  it("concurrent correction approvals on shared file DB: one winner, loser CONFLICT atomic", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4race-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    const dbFile = dbFileFor(dir);
    const oldId = seedActive(db, config, "concurrent race base");
    const mk = (body: string) => {
      const cr = correctRequest(db, config, correctionParams(oldId, body), nextKey("kc"));
      assert.equal(cr.ok, true);
      return (cr.data as { candidate: { id: string } }).candidate.id as string;
    };
    const a = mk("concurrent alpha body");
    const b = mk("concurrent beta body");
    const ra = getCandidateForReview(db, config, a, "personal/default");
    const rb = getCandidateForReview(db, config, b, "personal/default");
    assert.equal(ra.ok && rb.ok, true);
    if (!ra.ok || !rb.ok) throw new Error("review failed");
    const recBefore = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
    const keyA = nextKey("ha");
    const keyB = nextKey("hb");
    db.close();
    const storePath = path.join(repoRoot, "dist", "src", "store.js");
    const workerFile = path.join(dir, "race-worker.cjs");
    writeRaceWorker(storePath, workerFile);
    const [resa, resb] = (await runTwoJobs(dbFile, config, storePath, workerFile, [
      { kind: "approve", args: { id: a, scope: "personal/default", token: ra.token, idempotencyKey: keyA } },
      { kind: "approve", args: { id: b, scope: "personal/default", token: rb.token, idempotencyKey: keyB } },
    ])) as Array<{ ok: boolean; code: string }>;
    assert.equal(Number(resa.ok) + Number(resb.ok), 1);
    const loser = resa.ok ? resb : resa;
    assert.equal(loser.ok, false);
    assert.equal(loser.code, "CONFLICT");
    const winnerId = resa.ok ? a : b;
    const loserId = resa.ok ? b : a;
    const winnerKey = resa.ok ? keyA : keyB;
    const loserKey = resa.ok ? keyB : keyA;
    const loserBody = resa.ok ? "concurrent beta body" : "concurrent alpha body";
    const { db: db2 } = openDb(cfg);
    try {
      const recAfter = (db2.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      assert.equal(recAfter, recBefore + 1);
      const lrow = db2.prepare(`SELECT status FROM candidates WHERE id=?`).get(loserId) as { status: string };
      assert.equal(lrow.status, "candidate");
      const wrow = db2.prepare(`SELECT status FROM candidates WHERE id=?`).get(winnerId) as { status: string };
      assert.equal(wrow.status, "approved");
      const ops = db2.prepare(`SELECT idempotencyKey FROM operations`).all() as Array<{ idempotencyKey: string }>;
      assert.equal(ops.map((o) => o.idempotencyKey).includes(winnerKey), true);
      assert.equal(ops.map((o) => o.idempotencyKey).includes(loserKey), false);
      const audits = db2.prepare(`SELECT * FROM audit`).all() as Array<Record<string, unknown>>;
      assert.ok(!JSON.stringify(audits).includes(loserBody));
      const old = db2.prepare(`SELECT status FROM records WHERE id=?`).get(oldId) as { status: string };
      assert.equal(old.status, "superseded");
    } finally {
      db2.close();
    }
  });

  it("concurrent approve vs archive on shared file DB: exactly one winner", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4race-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    const dbFile = dbFileFor(dir);
    const oldId = seedActive(db, config, "approve vs archive base");
    const cr = correctRequest(db, config, correctionParams(oldId, "approve vs archive fix"), nextKey("kc"));
    assert.equal(cr.ok, true);
    const candId = (cr.data as { candidate: { id: string } }).candidate.id as string;
    const rev = getCandidateForReview(db, config, candId, "personal/default");
    assert.equal(rev.ok, true);
    if (!rev.ok) throw new Error("review failed");
    const keyA = nextKey("ha");
    const keyR = nextKey("ar");
    const recBefore = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
    db.close();
    const storePath = path.join(repoRoot, "dist", "src", "store.js");
    const workerFile = path.join(dir, "race-worker2.cjs");
    writeRaceWorker(storePath, workerFile);
    const [apRes, arRes] = (await runTwoJobs(dbFile, config, storePath, workerFile, [
      { kind: "approve", args: { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: keyA } },
      { kind: "archive", args: { id: oldId, scope: "personal/default", idempotencyKey: keyR, reasonCode: "USER_ARCHIVED" } },
    ])) as Array<{ ok: boolean; code: string }>;
    assert.equal(Number(apRes.ok) + Number(arRes.ok), 1);
    assert.equal((apRes.ok ? arRes : apRes).code, "CONFLICT");
    const { db: db2 } = openDb(cfg);
    try {
      const recAfter = (db2.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      if (apRes.ok) {
        assert.equal(recAfter, recBefore + 1);
        assert.equal((db2.prepare(`SELECT status FROM records WHERE id=?`).get(oldId) as { status: string }).status, "superseded");
        assert.equal((db2.prepare(`SELECT status FROM candidates WHERE id=?`).get(candId) as { status: string }).status, "approved");
      } else {
        assert.equal(recAfter, recBefore);
        assert.equal((db2.prepare(`SELECT status FROM records WHERE id=?`).get(oldId) as { status: string }).status, "archived");
        assert.equal((db2.prepare(`SELECT status FROM candidates WHERE id=?`).get(candId) as { status: string }).status, "candidate");
        assert.ok(!JSON.stringify(db2.prepare(`SELECT * FROM audit`).all()).includes("approve vs archive fix"));
      }
    } finally {
      db2.close();
    }
  });

  it("direct candidate.create(kind correction) parity: inactive target denied, in-txn gate", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = seedActive(db, config, "direct correction base");
      const base = {
        body: "direct correction body",
        kind: "correction",
        provenance: { source: "session:s1:turn:9", observedAt: "2026-09-02T00:00:00.000Z" },
        scope: "personal/default",
        supersedes: oldId,
      };
      const okFirst = createCandidate(db, config, base, nextKey("kd"));
      assert.equal(okFirst.ok, true);
      assert.equal(
        archiveRecord(db, config, { id: oldId, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" }).ok,
        true,
      );
      const nBefore = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      // Parity: both entry points deny a correction naming an inactive target.
      assert.equal(createCandidate(db, config, { ...base, body: "direct late body" }, nextKey("kd")).code, "CONFLICT");
      assert.equal(correctRequest(db, config, correctionParams(oldId, "late via short form"), nextKey("kc")).code, "CONFLICT");
      const nAfter = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      assert.equal(nAfter, nBefore);
      // Missing target stays NOT_FOUND on both paths (no policy change).
      assert.equal(createCandidate(db, config, { ...base, body: "x-missing", supersedes: "rec_missing" }, nextKey("kd")).code, "NOT_FOUND");
      assert.equal(correctRequest(db, config, correctionParams("rec_missing", "x-missing"), nextKey("kc")).code, "NOT_FOUND");
    } finally {
      db.close();
    }
  });

  it("audit failure rolls back approve-correction and archive atomically", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = seedActive(db, config, "rollback base record");
      const cr = correctRequest(db, config, correctionParams(oldId, "rollback fix body"), nextKey("kc"));
      assert.equal(cr.ok, true);
      const candId = (cr.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const snap = {
        records: (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n,
        candidates: JSON.stringify(db.prepare(`SELECT id, status FROM candidates ORDER BY id`).all()),
        ops: (db.prepare(`SELECT COUNT(*) AS n FROM operations`).get() as { n: number }).n,
        audit: (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n,
      };
      db.exec(`CREATE TRIGGER t4_audit_fail BEFORE INSERT ON audit WHEN NEW.op='approve' BEGIN SELECT RAISE(ABORT, 'audit boom'); END;`);
      const boom = approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("ha") });
      assert.equal(boom.code, "STORE_UNAVAILABLE");
      db.exec(`DROP TRIGGER t4_audit_fail;`);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n, snap.records);
      assert.equal(JSON.stringify(db.prepare(`SELECT id, status FROM candidates ORDER BY id`).all()), snap.candidates);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM operations`).get() as { n: number }).n, snap.ops);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n, snap.audit);
      assert.equal((db.prepare(`SELECT status FROM records WHERE id=?`).get(oldId) as { status: string }).status, "active");
      // Approve succeeds once the trigger is gone (rollback left no partial state).
      const rev2 = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev2.ok, true);
      if (!rev2.ok) throw new Error("review failed");
      assert.equal(approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev2.token, idempotencyKey: nextKey("ha") }).ok, true);
      const fresh = seedActive(db, config, "rollback archive base");
      const snap2 = {
        status: (db.prepare(`SELECT status FROM records WHERE id=?`).get(fresh) as { status: string }).status,
        ops: (db.prepare(`SELECT COUNT(*) AS n FROM operations`).get() as { n: number }).n,
        audit: (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n,
      };
      db.exec(`CREATE TRIGGER t4_audit_fail2 BEFORE INSERT ON audit WHEN NEW.op='archive' BEGIN SELECT RAISE(ABORT, 'audit boom'); END;`);
      const boom2 = archiveRecord(db, config, { id: fresh, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" });
      assert.equal(boom2.code, "STORE_UNAVAILABLE");
      db.exec(`DROP TRIGGER t4_audit_fail2;`);
      assert.equal((db.prepare(`SELECT status FROM records WHERE id=?`).get(fresh) as { status: string }).status, snap2.status);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM operations`).get() as { n: number }).n, snap2.ops);
      assert.equal((db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n, snap2.audit);
    } finally {
      db.close();
    }
  });

  it("replay survives DB reopen and target/expiry moves (same-process replay already covered)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t4-"));
    const cfg = writeConfig(dir);
    const first = openDb(cfg);
    const oldId = seedActive(first.db, first.config, "reopen replay base");
    const params = correctionParams(oldId, "reopen replay fix");
    const key = nextKey("kc");
    const r1 = correctRequest(first.db, first.config, params, key);
    assert.equal(r1.ok, true);
    first.db.close();
    const second = openDb(cfg);
    try {
      const r2 = correctRequest(second.db, second.config, params, key);
      assert.equal((r2 as { deduplicated?: boolean }).deduplicated, true);
      assert.deepEqual(r2.data, r1.data);
      assert.equal(correctRequest(second.db, second.config, correctionParams(oldId, "changed body"), key).code, "CONFLICT");
      // Archive the target after commit: the committed replay still replays
      // stably (bypass), while a fresh key on the moved target is CONFLICT.
      assert.equal(
        archiveRecord(second.db, second.config, { id: oldId, scope: "personal/default", idempotencyKey: nextKey("ar"), reasonCode: "USER_ARCHIVED" }).ok,
        true,
      );
      const r3 = correctRequest(second.db, second.config, params, key);
      assert.equal((r3 as { deduplicated?: boolean }).deduplicated, true);
      assert.deepEqual(r3.data, r1.data);
      assert.equal(correctRequest(second.db, second.config, correctionParams(oldId, "fresh after archive"), nextKey("kc")).code, "CONFLICT");
      // Expire the committed candidate row manually: committed replay still
      // returns the stored envelope (EXPIRED is for fresh executions only).
      const candId = (r1.data as { candidate: { id: string } }).candidate.id as string;
      second.db.prepare(`UPDATE candidates SET expiresAt='2000-01-01T00:00:00.000Z' WHERE id=?`).run(candId);
      const r4 = correctRequest(second.db, second.config, params, key);
      assert.equal((r4 as { deduplicated?: boolean }).deduplicated, true);
      assert.deepEqual(r4.data, r1.data);
    } finally {
      second.db.close();
    }
  });
});
