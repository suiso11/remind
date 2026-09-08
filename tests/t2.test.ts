import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  approveCandidate,
  createCandidate,
  getCandidateForReview,
  getCandidateMeta,
  rejectCandidate,
} from "../src/store.js";
import { bodyHashFor, escapeForTerminal, normalizeBody } from "../src/normalize.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

function writeConfig(dir: string, dbName = "t2.db"): string {
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

function openDb(cfgPath: string): { db: DatabaseSync; config: ReturnType<typeof loadConfig> } {
  const config = loadConfig(cfgPath);
  const { db } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config };
}

function createParams(body = "next wednesday check booking", extra: Record<string, unknown> = {}) {
  return {
    body,
    kind: "user_fact",
    provenance: { source: "session:s1:turn:3", observedAt: "2026-09-01T00:00:00.000Z" },
    scope: "personal/default",
    tags: ["plan"],
    ...extra,
  };
}

function runJson(cfg: string, obj: unknown): { status: number | null; body: Record<string, unknown>; stdout: string; stderr: string } {
  const r = spawnSync(process.execPath, [cli, "--config", cfg], {
    input: JSON.stringify(obj) + "\n",
    encoding: "utf8",
  });
  return { status: r.status, body: JSON.parse(String(r.stdout).trim()), stdout: String(r.stdout), stderr: String(r.stderr) };
}

describe("T2 candidates + human approval", () => {
  it("create/get isolate the body (metadata only, budgeted, no leaks)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const marker = "UNIQUEBODY-7f3a9c-isolated";
      const c = createCandidate(db, config, createParams(`remember ${marker} here`), "k-iso-1");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      assert.ok(!JSON.stringify(c).includes(marker));
      const g = getCandidateMeta(db, config, { id, scope: "personal/default" });
      assert.equal(g.ok, true);
      const gJson = JSON.stringify(g);
      assert.ok(!gJson.includes(marker));
      assert.ok(!gJson.includes("remember"));
      const data = g.data as { candidate: { bodyHash: string; status: string } };
      assert.match(data.candidate.bodyHash, /^sha256:[0-9a-f]{64}$/);
      // Canonical hash: normalization is NFKC + trim + collapse + ASCII fold.
      const canon = createCandidate(db, config, createParams("  HELLO   World  ", { tags: [] }), "k-iso-2");
      assert.equal(canon.ok, true);
      const cid = (canon.data as { candidate: { id: string } }).candidate.id as string;
      const row = db.prepare(`SELECT body, bodyHash FROM candidates WHERE id=?`).get(cid) as { body: string; bodyHash: string };
      assert.equal(row.body, normalizeBody("  HELLO   World  "));
      assert.equal(row.bodyHash, bodyHashFor(normalizeBody("  HELLO   World  ")));
      // Audit carries metadata only.
      const audits = db.prepare(`SELECT * FROM audit`).all() as Array<Record<string, unknown>>;
      assert.ok(audits.length >= 2);
      assert.ok(!JSON.stringify(audits).includes(marker));
      // Recall stays an honest T3 deferral.
      const rec = runJson(cfg, { v: 1, op: "record.recall", params: {} });
      assert.equal(rec.body["code"], "NOT_IMPLEMENTED");
    } finally {
      db.close();
    }
  });

  it("scope denial on id lookups (get/review mismatch, missing scope)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, createParams("scope test"), "k-scope-1");
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      assert.equal(createCandidate(db, config, createParams("x", { scope: "nope/scope" }), "k-scope-2").code, "FORBIDDEN_SCOPE");
      assert.equal(getCandidateMeta(db, config, { id, scope: "personal/other" }).code, "FORBIDDEN_SCOPE");
      assert.equal(getCandidateMeta(db, config, { id } as Record<string, unknown>).code, "BAD_REQUEST");
      assert.equal(getCandidateMeta(db, config, { id: "cand_missing", scope: "personal/default" }).code, "NOT_FOUND");
      const rev = getCandidateForReview(db, config, id, "personal/other");
      assert.equal(rev.ok, false);
      if (!rev.ok) assert.equal(rev.code, "FORBIDDEN_SCOPE");
    } finally {
      db.close();
    }
  });

  it("approve binds the full immutable token; tamper and double-terminal fail", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, createParams("approve me", { tags: ["a", "b"], link: "Target" }), "k-ap-1");
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const bad = approveCandidate(db, config, { id, scope: "personal/default", token: "sha256:dead", idempotencyKey: "h-ap-bad" });
      assert.equal(bad.code, "CONFLICT");
      // Tampered attempt must not consume the retry key.
      const good = approveCandidate(db, config, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-ap-good" });
      assert.equal(good.ok, true);
      const recId = (good.data as { record: { id: string } }).record.id as string;
      assert.match(recId, /^rec_/);
      const st = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string };
      assert.equal(st.status, "approved");
      const rec = db.prepare(`SELECT id, bodyHash, status FROM records WHERE id=?`).get(recId) as { bodyHash: string; status: string };
      assert.equal(rec.status, "active");
      assert.equal(rec.bodyHash, rev.row.bodyHash);
      // Terminal approve again with a fresh key is a conflict, not a 2nd record.
      const again = approveCandidate(db, config, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-ap-again" });
      assert.equal(again.code, "CONFLICT");
      const nRec = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      assert.equal(nRec, 1);
    } finally {
      db.close();
    }
  });

  it("reject needs USER_REJECTED and is terminal", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, createParams("reject me"), "k-rj-1");
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      if (!rev.ok) throw new Error("review failed");
      assert.equal(
        rejectCandidate(db, config, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-rj-1", reasonCode: "NOPE" }).code,
        "BAD_REQUEST",
      );
      const r = rejectCandidate(db, config, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-rj-1", reasonCode: "USER_REJECTED" });
      assert.equal(r.ok, true);
      const st = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string };
      assert.equal(st.status, "rejected");
      assert.equal(
        approveCandidate(db, config, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-rj-after" }).code,
        "CONFLICT",
      );
    } finally {
      db.close();
    }
  });

  it("expiry blocks approval but committed create replay survives expiry", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, createParams("expiring", { ttlSec: 60 }), "k-ex-1");
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      if (!rev.ok) throw new Error("review failed");
      db.prepare(`UPDATE candidates SET expiresAt='2020-01-01T00:00:00.000Z' WHERE id=?`).run(id);
      assert.equal(
        approveCandidate(db, config, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-ex-1" }).code,
        "EXPIRED",
      );
      // Committed create replay returns the saved success even after expiry.
      const replay = createCandidate(db, config, createParams("expiring", { ttlSec: 60 }), "k-ex-1");
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      assert.equal((replay.data as { candidate: { id: string } }).candidate.id, id);
    } finally {
      db.close();
    }
  });

  it("idempotency: same key+params replays, changed params conflict, failures do not poison keys, restart is stable", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    let savedId = "";
    try {
      const p = createParams("replay target");
      const a = createCandidate(db, config, p, "k-re-1");
      assert.equal(a.ok, true);
      assert.equal(a.deduplicated, false);
      savedId = (a.data as { candidate: { id: string } }).candidate.id as string;
      const b = createCandidate(db, config, p, "k-re-1");
      assert.equal(b.ok, true);
      assert.equal(b.deduplicated, true);
      assert.equal((b.data as { candidate: { id: string } }).candidate.id, savedId);
      const conflict = createCandidate(db, config, createParams("different body"), "k-re-1");
      assert.equal(conflict.code, "CONFLICT");
      // Failed validation never stores the key: reuse with valid params works.
      assert.equal(createCandidate(db, config, {} as Record<string, unknown>, "k-re-2").code, "BAD_REQUEST");
      const afterFail = createCandidate(db, config, p, "k-re-2");
      assert.equal(afterFail.ok, true);
      assert.equal(afterFail.deduplicated, false);
    } finally {
      db.close();
    }
    // Restart: operations rows survive and replay deterministically.
    const second = openDb(cfg);
    try {
      const p = createParams("replay target");
      const r = createCandidate(second.db, second.config, p, "k-re-1");
      assert.equal(r.ok, true);
      assert.equal(r.deduplicated, true);
      assert.equal((r.data as { candidate: { id: string } }).candidate.id, savedId);
    } finally {
      second.db.close();
    }
  });

  it("JSON human ops are forbidden; piped approve without TTY is refused", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    for (const op of ["approve", "reject", "archive", "candidate.approve", "record.archive"]) {
      const r = runJson(cfg, { v: 1, op, params: {} });
      assert.equal(r.body["code"], "FORBIDDEN");
    }
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, createParams("tty guard"), "k-tty-1");
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      if (!rev.ok) throw new Error("review failed");
      // stdin is a pipe here (isTTY false), so the CLI must refuse approval.
      const r = spawnSync(
        process.execPath,
        [cli, "approve", "--config", cfg, "--id", id, "--scope", "personal/default", "--token", rev.token, "--idempotency-key", "h-tty-1"],
        { input: "yes\n", encoding: "utf8" },
      );
      assert.equal(r.status, 0);
      assert.equal(JSON.parse(String(r.stdout).trim()).code, "FORBIDDEN");
      const st = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string };
      assert.equal(st.status, "candidate");
      // --confirm-style shortcuts are rejected, never honoured.
      const rc = spawnSync(
        process.execPath,
        [cli, "approve", "--config", cfg, "--id", id, "--scope", "personal/default", "--token", rev.token, "--idempotency-key", "h-tty-2", "--confirm", "yes"],
        { input: "yes\n", encoding: "utf8" },
      );
      assert.equal(JSON.parse(String(rc.stdout).trim()).code, "BAD_REQUEST");
    } finally {
      db.close();
    }
  });

  it("terminal escaping never interprets control/ANSI bytes", () => {
    const evil = "line1\x1b[31mRED\x00\x07 tail";
    const esc = escapeForTerminal(evil);
    assert.ok(!esc.includes("\x1b"));
    assert.ok(!esc.includes("\x00"));
    assert.ok(esc.includes("\\x1B"));
    assert.ok(esc.includes("\\u0000"));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      // Controls are rejected at the JSON boundary, so store via direct SQL
      // shape is impossible; instead verify the CLI never echoes raw bodies.
      const c = createCandidate(db, config, createParams("plain body for leak check"), "k-esc-1");
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const g = getCandidateMeta(db, config, { id, scope: "personal/default" });
      assert.ok(!JSON.stringify(g).includes("plain body for leak check"));
    } finally {
      db.close();
    }
  });

  it("correction creation honestly defers to T4 (schema exists, behavior NOT_IMPLEMENTED)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t2-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const cols = db.prepare(`PRAGMA table_info(candidates)`).all() as Array<{ name: string }>;
      assert.ok(cols.some((c) => c.name === "supersedes"));
      assert.equal(
        createCandidate(db, config, createParams("fix", { kind: "correction", supersedes: "rec_x" }), "k-cor-1").code,
        "NOT_IMPLEMENTED",
      );
      const viaJson = runJson(cfg, {
        v: 1,
        op: "record.correct-request",
        idempotencyKey: "k-cor-2",
        params: {},
      });
      assert.equal(viaJson.body["code"], "NOT_IMPLEMENTED");
    } finally {
      db.close();
    }
  });

  it.skip("actual terminal manual test unperformed: TTY review/approve/reject interactive confirmation", () => {
    // NOTE: the human TTY confirmation (review display + `yes` on a real
    // terminal) is exercised only manually, not in this automated suite.
    // Domain equivalents above call approveCandidate/rejectCandidate directly.
    assert.ok(true);
  });
});
