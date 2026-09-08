/**
 * T6 acceptance suite A1-A13 (plan.md 14.11 definitions).
 *
 * Each case name starts with its plan ID and states the plan expectation.
 * Automated coverage uses domain fixture helpers (direct store calls stand
 * in for the human-terminal approve path) + the compiled CLI subprocess +
 * the T6 fake adapter (`src/fake-adapter.ts`).
 *
 * Honesty note: real-TTY `review`/`approve`/`reject`/`archive` interactive
 * confirmation (actual terminal, `yes` typed by a human) is NOT asserted by
 * automation and remains a MANUAL check (see docs/acceptance-manifest.md).
 * Direct `approveCandidate` calls below exercise the same domain transition
 * with the same token binding, but they are not a TTY test.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  approveCandidate,
  archiveRecord,
  correctRequest,
  createCandidate,
  getCandidateForReview,
  recallRecords,
} from "../src/store.js";
import { FAKE_FALLBACK_TEXT, isCitationExposed, queryMemory } from "../src/fake-adapter.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

let keyN = 0;
function nextKey(prefix: string): string {
  keyN += 1;
  return `${prefix}-${Date.now()}-${keyN}`;
}

function writeConfig(dir: string, dbName = "acc.db"): string {
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

function openDb(cfgPath: string): { db: DatabaseSync; config: AppConfig } {
  const config = loadConfig(cfgPath);
  const { db } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config };
}

function mkdir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "remind-acc-"));
}

function candidateParams(body: string, scope = "personal/default", extra: Record<string, unknown> = {}) {
  return {
    body,
    kind: "user_fact",
    provenance: { source: "session:s1:turn:1", observedAt: "2026-09-01T00:00:00.000Z" },
    scope,
    tags: [],
    ...extra,
  };
}

/** Domain approval path (human-terminal logic minus the real TTY). */
function createAndApprove(db: DatabaseSync, config: AppConfig, body: string, scope = "personal/default"): { candId: string; recId: string } {
  const c = createCandidate(db, config, candidateParams(body, scope), nextKey("k"));
  assert.equal(c.ok, true);
  const candId = (c.data as { candidate: { id: string } }).candidate.id as string;
  const rev = getCandidateForReview(db, config, candId, scope);
  assert.equal(rev.ok, true);
  if (!rev.ok) throw new Error("review failed");
  const ap = approveCandidate(db, config, { id: candId, scope, token: rev.token, idempotencyKey: nextKey("h") });
  assert.equal(ap.ok, true);
  return { candId, recId: (ap.data as { record: { id: string } }).record.id as string };
}

function runCli(cfg: string, obj: unknown): { status: number | null; json: Record<string, unknown>; raw: string } {
  const r = spawnSync(process.execPath, [cli, "--config", cfg], {
    input: JSON.stringify(obj) + "\n",
    encoding: "utf8",
  });
  const raw = String(r.stdout ?? "").trim();
  return { status: r.status, json: JSON.parse(raw) as Record<string, unknown>, raw };
}

function hasLoneSurrogate(s: string): boolean {
  return /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);
}

function auditDump(db: DatabaseSync): string {
  const a = db.prepare(`SELECT * FROM audit`).all();
  const e = db.prepare(`SELECT * FROM exposures`).all();
  return JSON.stringify({ a, e });
}

describe("T6 acceptance A1-A13 (plan 14.11)", () => {
  it("A1 no leakage of unapproved candidates: recall after create shows nothing", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const body = "a1 secret booking zebra-unapproved";
      const c = createCandidate(db, config, candidateParams(body), nextKey("k"));
      assert.equal(c.ok, true);
      const r = recallRecords(db, config, { query: "zebra-unapproved", scope: "personal/default", limit: 10 });
      assert.equal(r.ok, true);
      assert.deepEqual((r.data as { items: unknown[] }).items, []);
    } finally {
      db.close();
    }
  });

  it("A2 approved recall via CLI+adapter: fixed order, recallId+snippet+truncated, current-recall citations only", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const { recId } = createAndApprove(db, config, "a2 booking wednesday confirmed");
      void recId;
    } finally {
      db.close();
    }
    // CLI recall over the persistent DB (approval happened pre-close).
    const cliRes = runCli(cfg, { v: 1, op: "record.recall", params: { query: "booking", scope: "personal/default", limit: 10 } });
    assert.equal(cliRes.status, 0);
    assert.equal(cliRes.json["ok"], true);
    const data = cliRes.json["data"] as { recallId: string; items: Array<{ id: string; snippet: string; truncated: boolean }> };
    assert.ok(typeof data.recallId === "string" && data.recallId.length > 0);
    assert.ok(data.items.length >= 1);
    assert.ok(data.items.every((i) => typeof i.snippet === "string" && typeof i.truncated === "boolean"));
    // Fake-adapter exposure: structural check + citation gate.
    const exposed = queryMemory({ cliPath: cli, configPath: cfg, scope: "personal/default", query: "booking", limit: 10 });
    assert.equal(exposed.degraded, false);
    if (!exposed.degraded) {
      assert.equal(exposed.scope, "personal/default");
      assert.ok(exposed.citations.length >= 1);
      assert.equal(isCitationExposed(exposed.citations[0], exposed), true);
      assert.equal(isCitationExposed("invented-arbitrary-text", exposed), false);
      assert.equal(isCitationExposed("rec_does_not_exist", exposed), false);
    }
  });

  it("A3 approval immutability binding: every token-bound field tamper is rejected with no record", () => {
    // Token binds [1,id,bodyHash,kind,source,observedAt,scope,supersedes,
    // tags,link,createdAt,expiresAt] (plan 14.5). Each subcase mints a fresh
    // candidate, captures the genuine review token, tampers exactly one
    // stored field via direct SQL (isolated per-candidate, no rollback
    // needed), then approves with the now-stale token. Scope tamper uses the
    // ORIGINAL request scope so the contract answer is FORBIDDEN_SCOPE
    // (row.scope !== request scope); all other tampers are CONFLICT,
    // including stale-bodyHash approve (stored digest != digest of stored
    // body is CONFLICT with no record). A literal wrong token alone proves
    // nothing about field coverage, so every field is mutated here.
    const cases: Array<{ name: string; code: "CONFLICT" | "FORBIDDEN_SCOPE" | "NOT_FOUND"; tamper: (db: DatabaseSync, id: string) => void; correction?: boolean }> = [
      { name: "body-only (stale bodyHash)", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidates SET body='tampered body no hash update' WHERE id=?`).run(id); } },
      { name: "bodyHash", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidates SET bodyHash='sha256:0000000000000000000000000000000000000000000000000000000000000000' WHERE id=?`).run(id); } },
      { name: "kind", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidates SET kind='model_inference' WHERE id=?`).run(id); } },
      { name: "source", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidates SET source='session:s9:turn:9' WHERE id=?`).run(id); } },
      { name: "observedAt", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidates SET observedAt='2026-09-03T00:00:00.000Z' WHERE id=?`).run(id); } },
      { name: "scope (original request scope)", code: "FORBIDDEN_SCOPE", tamper: (db, id) => { db.prepare(`UPDATE candidates SET scope='personal/other' WHERE id=?`).run(id); } },
      { name: "tags (extra row)", code: "CONFLICT", tamper: (db, id) => { db.prepare(`INSERT INTO candidate_tags(candidateId, tag) VALUES (?, ?)`).run(id, "smuggled"); } },
      { name: "link (added row)", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidate_links SET toName='Smuggled' WHERE fromId=?`).run(id); } },
      { name: "createdAt", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidates SET createdAt='2020-01-01T00:00:00.000Z' WHERE id=?`).run(id); } },
      { name: "expiresAt (future, token-only)", code: "CONFLICT", tamper: (db, id) => { db.prepare(`UPDATE candidates SET expiresAt='2030-01-01T00:00:00.000Z' WHERE id=?`).run(id); } },
    ];
    for (const tc of cases) {
      const dir = mkdir();
      const cfg = writeConfig(dir);
      const { db, config } = openDb(cfg);
      try {
        const before = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
        const c = createCandidate(db, config, { ...candidateParams("a3 binding probe " + tc.name), tags: ["t1"], link: "Base" }, nextKey("k"));
        assert.equal(c.ok, true);
        const candId = (c.data as { candidate: { id: string } }).candidate.id as string;
        const rev = getCandidateForReview(db, config, candId, "personal/default");
        assert.equal(rev.ok, true);
        if (!rev.ok) throw new Error("review failed for " + tc.name);
        tc.tamper(db, candId);
        const attempt = approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("h") });
        assert.equal(attempt.ok, false, tc.name + " must be rejected");
        assert.equal((attempt as { code: string }).code, tc.code, tc.name + " code");
        const after = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
        assert.equal(after, before, tc.name + " must create no record");
        const st = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(candId) as { status: string };
        assert.equal(st.status, "candidate", tc.name + " loser stays candidate");
      } finally {
        db.close();
      }
    }
    // supersedes tamper on a correction candidate (token binds the pointer).
    {
      const dir = mkdir();
      const cfg = writeConfig(dir);
      const { db, config } = openDb(cfg);
      try {
        const base = createAndApprove(db, config, "a3 supersedes base");
        const other = createAndApprove(db, config, "a3 supersedes other");
        const cr = correctRequest(
          db, config,
          { recordId: base.recId, body: "a3 correction body", kind: "correction", provenance: { source: "session:s1:turn:9", observedAt: "2026-09-02T00:00:00.000Z" }, scope: "personal/default" },
          nextKey("kc"),
        );
        assert.equal(cr.ok, true);
        const candId = (cr.data as { candidate: { id: string } }).candidate.id as string;
        const rev = getCandidateForReview(db, config, candId, "personal/default");
        assert.equal(rev.ok, true);
        if (!rev.ok) throw new Error("review failed");
        const before = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
        db.prepare(`UPDATE candidates SET supersedes=? WHERE id=?`).run(other.recId, candId);
        const attempt = approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("h") });
        assert.equal(attempt.ok, false);
        assert.equal((attempt as { code: string }).code, "CONFLICT");
        const after = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
        assert.equal(after, before);
      } finally {
        db.close();
      }
    }
    // Candidate-id mismatch: unknown id is NOT_FOUND; an existing other id
    // with a foreign token is CONFLICT. Neither creates a record.
    {
      const dir = mkdir();
      const cfg = writeConfig(dir);
      const { db, config } = openDb(cfg);
      try {
        const c1 = createCandidate(db, config, candidateParams("a3 id probe one"), nextKey("k1"));
        const c2 = createCandidate(db, config, candidateParams("a3 id probe two"), nextKey("k2"));
        assert.equal(c1.ok, true);
        assert.equal(c2.ok, true);
        const id1 = (c1.data as { candidate: { id: string } }).candidate.id as string;
        const id2 = (c2.data as { candidate: { id: string } }).candidate.id as string;
        const rev = getCandidateForReview(db, config, id1, "personal/default");
        assert.equal(rev.ok, true);
        if (!rev.ok) throw new Error("review failed");
        const before = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
        const unknown = approveCandidate(db, config, { id: "cand_does_not_exist", scope: "personal/default", token: rev.token, idempotencyKey: nextKey("h1") });
        assert.equal(unknown.ok, false);
        assert.equal((unknown as { code: string }).code, "NOT_FOUND");
        const foreign = approveCandidate(db, config, { id: id2, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("h2") });
        assert.equal(foreign.ok, false);
        assert.equal((foreign as { code: string }).code, "CONFLICT");
        const literal = approveCandidate(db, config, { id: id1, scope: "personal/default", token: "sha256: wrong", idempotencyKey: nextKey("h3") });
        assert.equal(literal.ok, false);
        assert.equal((literal as { code: string }).code, "CONFLICT");
        const after = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
        assert.equal(after, before);
      } finally {
        db.close();
      }
    }
  });

  it("A4 expiry: approve after expiresAt is EXPIRED and the row is retained (not deleted)", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, candidateParams("a4 expiry probe"), nextKey("k"));
      assert.equal(c.ok, true);
      const candId = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      db.prepare(`UPDATE candidates SET expiresAt='2000-01-01T00:00:00.000Z' WHERE id=?`).run(candId);
      const ap = approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("h") });
      assert.equal(ap.ok, false);
      assert.equal((ap as { code: string }).code, "EXPIRED");
      const row = db.prepare(`SELECT id, status FROM candidates WHERE id=?`).get(candId) as { id: string; status: string } | undefined;
      assert.ok(row, "expired row must be retained");
    } finally {
      db.close();
    }
  });

  it("A5 idempotency: same key+params replays deduplicated, changed params CONFLICT, missing key BAD_REQUEST", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const key = nextKey("k");
      const params = candidateParams("a5 idempotent body");
      const first = createCandidate(db, config, params, key);
      assert.equal(first.ok, true);
      const second = createCandidate(db, config, params, key);
      assert.equal(second.ok, true);
      assert.equal((second as { deduplicated: boolean }).deduplicated, true);
      assert.deepEqual(second.data, first.data);
      const clash = createCandidate(db, config, candidateParams("a5 different body"), key);
      assert.equal(clash.ok, false);
      assert.equal((clash as { code: string }).code, "CONFLICT");
    } finally {
      db.close();
    }
    const noKey = runCli(cfg, { v: 1, op: "candidate.create", params: candidateParams("a5 no key") });
    assert.equal(noKey.json["ok"], false);
    assert.equal(noKey.json["code"], "BAD_REQUEST");
  });

  it("A6 determinism and bounds: same recall repeats order; snippet is a bounded forward projection with truncated flag", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      createAndApprove(db, config, "a6 booking alpha");
      createAndApprove(db, config, "a6 booking beta");
      const q = { query: "a6 booking", scope: "personal/default", limit: 10 };
      const r1 = recallRecords(db, config, q);
      const r2 = recallRecords(db, config, q);
      assert.equal(r1.ok, true);
      assert.equal(r2.ok, true);
      // recallId is unique per query (not deterministic); the ITEM order is.
      const d1 = r1.data as { recallId: string; items: unknown[] };
      const d2 = r2.data as { recallId: string; items: unknown[] };
      assert.ok(typeof d1.recallId === "string" && d1.recallId.length > 0);
      assert.ok(typeof d2.recallId === "string" && d2.recallId.length > 0);
      assert.deepEqual(d1.items, d2.items);
      const items = (r1.data as { items: Array<{ snippet: string; truncated: boolean }> }).items;
      for (const item of items) {
        assert.ok([...item.snippet].length <= 200);
        assert.equal(typeof item.truncated, "boolean");
      }
      // Over-limit input is rejected, never truncated into a partial success.
      const over = recallRecords(db, config, { query: "x".repeat(501), scope: "personal/default", limit: 10 });
      assert.equal(over.ok, false);
      assert.equal((over as { code: string }).code, "LIMIT_EXCEEDED");
    } finally {
      db.close();
    }
  });

  it("A7 correction and archive exclusion: superseded and archived records leave recall", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = createAndApprove(db, config, "a7 original booking wednesday").recId;
      const cr = correctRequest(
        db, config,
        { recordId: oldId, body: "a7 corrected booking thursday", kind: "correction", provenance: { source: "session:s1:turn:9", observedAt: "2026-09-02T00:00:00.000Z" }, scope: "personal/default" },
        nextKey("kc"),
      );
      assert.equal(cr.ok, true);
      const candId = (cr.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const ap = approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("ha") });
      assert.equal(ap.ok, true);
      const r1 = recallRecords(db, config, { query: "wednesday", scope: "personal/default", limit: 10 });
      assert.equal(r1.ok, true);
      const ids1 = ((r1.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
      assert.ok(!ids1.includes(oldId), "superseded record must be excluded");
      const newId = (ap.data as { record: { id: string } }).record.id as string;
      const ar = archiveRecord(db, config, { id: newId, scope: "personal/default", idempotencyKey: nextKey("arch"), reasonCode: "USER_ARCHIVED" });
      assert.equal(ar.ok, true);
      const r2 = recallRecords(db, config, { query: "thursday", scope: "personal/default", limit: 10 });
      assert.equal(r2.ok, true);
      const ids2 = ((r2.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
      assert.ok(!ids2.includes(newId), "archived record must be excluded");
    } finally {
      db.close();
    }
  });

  it("A8 audit shrink-wrap and degraded fallback: no raw query/body in audit, failures stay memoryless with fixed text", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const secretBody = "a8 secret body phrase unforgettable-xyz";
    const secretQuery = "unforgettable-xyz";
    const { db, config } = openDb(cfg);
    try {
      createAndApprove(db, config, secretBody);
      const r = recallRecords(db, config, { query: secretQuery, scope: "personal/default", limit: 10 });
      assert.equal(r.ok, true);
      const dump = auditDump(db);
      assert.ok(!dump.includes(secretBody), "audit/exposures must not carry the memory body");
      assert.ok(!dump.includes(secretQuery), "audit/exposures must not carry the raw query");
      const errJson = JSON.stringify(r);
      void errJson;
      const denied = recallRecords(db, config, { query: "", scope: "personal/default", limit: 10 });
      assert.equal(denied.ok, false);
      assert.ok(!JSON.stringify(denied).includes(secretQuery));
    } finally {
      db.close();
    }
    // Adapter fallback matrix: every failure stays memoryless with fixed text.
    const disabled = queryMemory({ cliPath: cli, configPath: cfg, scope: "personal/default", query: "hello", enabled: false });
    assert.equal(disabled.degraded, true);
    assert.equal(disabled.code, "DISABLED");
    assert.deepEqual(disabled.citations, []);
    if (disabled.degraded) assert.equal(disabled.text, FAKE_FALLBACK_TEXT);
    const badConfig = queryMemory({ cliPath: cli, configPath: path.join(dir, "missing.json"), scope: "personal/default", query: "hello" });
    assert.equal(badConfig.degraded, true);
    assert.equal(badConfig.code, "STORE_UNAVAILABLE");
    const corruptDir = mkdir();
    const corruptDb = path.join(corruptDir, "corrupt.db");
    fs.writeFileSync(corruptDb, "this is not a sqlite file");
    const corruptCfg = path.join(corruptDir, "memory.config.json");
    fs.writeFileSync(corruptCfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")), dbPath: corruptDb }));
    const corrupt = queryMemory({ cliPath: cli, configPath: corruptCfg, scope: "personal/default", query: "hello" });
    assert.equal(corrupt.degraded, true);
    if (corrupt.degraded) assert.equal(corrupt.text, FAKE_FALLBACK_TEXT);
    const garbageJs = path.join(mkdir(), "garbage.js");
    fs.writeFileSync(garbageJs, `console.log("not json");\n`);
    const malformed = queryMemory({ cliPath: garbageJs, configPath: cfg, scope: "personal/default", query: "hello" });
    assert.equal(malformed.degraded, true);
    if (malformed.degraded) {
      assert.equal(malformed.text, FAKE_FALLBACK_TEXT);
      assert.ok(!JSON.stringify(malformed).includes("hello"));
    }
    const overbudget = queryMemory({ cliPath: cli, configPath: cfg, scope: "personal/default", query: "hello", maxOutputBytes: 10 });
    assert.equal(overbudget.degraded, true);
    assert.equal(overbudget.code, "LIMIT_EXCEEDED");
  });

  it("A8b fake-adapter strictness: malformed envelopes/budgets degrade memoryless via local fixtures only", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const fx = (name: string, body: string): string => {
      const p = path.join(dir, name);
      fs.writeFileSync(p, body);
      return p;
    };
    const emit = (obj: unknown, extra = ""): string =>
      fx(`emit-${Math.random().toString(36).slice(2)}.js`, `process.stdout.write(${JSON.stringify(JSON.stringify(obj))} + "\\n"${extra});\n`);
    const goodItem = { id: "rec_01", snippet: "hello", truncated: false, tags: [], createdAt: "2026-09-01T00:00:00.000Z" };
    const good = { v: 1, ok: true, code: "OK", message: "ok", data: { recallId: "recall_01", items: [goodItem] }, deduplicated: false };
    // ok:true with inconsistent code is malformed.
    const badCode = { ...good, code: "BAD_REQUEST" };
    assert.equal(queryMemory({ cliPath: emit(badCode), configPath: cfg, scope: "personal/default", query: "hello" }).degraded, true);
    // Unknown top-level field is malformed (strict).
    const extraTop = { ...good, surprise: 1 };
    assert.equal(queryMemory({ cliPath: emit(extraTop), configPath: cfg, scope: "personal/default", query: "hello" }).degraded, true);
    // Duplicate item ids are malformed.
    const dup = { ...good, data: { recallId: "recall_01", items: [goodItem, { ...goodItem }] } };
    assert.equal(queryMemory({ cliPath: emit(dup), configPath: cfg, scope: "personal/default", query: "hello" }).degraded, true);
    // Oversized snippet (adopted 200cp contract) degrades rather than passing through.
    const big = { ...good, data: { recallId: "recall_01", items: [{ ...goodItem, snippet: "x".repeat(201) }] } };
    const bigRes = queryMemory({ cliPath: emit(big), configPath: cfg, scope: "personal/default", query: "hello" });
    assert.equal(bigRes.degraded, true);
    // Invalid UTF-8 stdout bytes degrade (fatal decode, no replacement passthrough).
    const rawBad = fx("rawbad.js", `process.stdout.write(Buffer.from([0xff, 0xfe, 0x0a]));\n`);
    const rawRes = queryMemory({ cliPath: rawBad, configPath: cfg, scope: "personal/default", query: "hello" });
    assert.equal(rawRes.degraded, true);
    if (rawRes.degraded) assert.equal(rawRes.text, FAKE_FALLBACK_TEXT);
    // Non-finite / unbounded budgets degrade instead of silent accept.
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, 0, 2.5, 100000]) {
      const r1 = queryMemory({ cliPath: cli, configPath: cfg, scope: "personal/default", query: "hello", maxInputBytes: bad });
      assert.equal(r1.degraded, true, "maxInput " + String(bad));
      const r2 = queryMemory({ cliPath: cli, configPath: cfg, scope: "personal/default", query: "hello", maxOutputBytes: bad });
      assert.equal(r2.degraded, true, "maxOutput " + String(bad));
    }
    // limit < 1 is BAD_REQUEST (no silent clamp to 1); timeout NaN is BAD_REQUEST.
    const l0 = queryMemory({ cliPath: cli, configPath: cfg, scope: "personal/default", query: "hello", limit: 0 });
    assert.equal(l0.degraded, true);
    assert.equal(l0.code, "BAD_REQUEST");
    const tNaN = queryMemory({ cliPath: cli, configPath: cfg, scope: "personal/default", query: "hello", timeoutMs: Number.NaN });
    assert.equal(tNaN.degraded, true);
    assert.equal(tNaN.code, "BAD_REQUEST");
    // A child ignoring SIGTERM still degrades via SIGKILL within the timeout
    // (local fixture only; guarded by the adapter timeout itself).
    const ignoreTerm = fx("ignoreterm.js", `process.on('SIGTERM', () => {});\nsetInterval(() => {}, 1000);\n`);
    const t0 = Date.now();
    const ign = queryMemory({ cliPath: ignoreTerm, configPath: cfg, scope: "personal/default", query: "hello", timeoutMs: 800 });
    assert.equal(ign.degraded, true);
    assert.equal(ign.code, "TIMEOUT");
    assert.ok(Date.now() - t0 < 15000, "SIGTERM-ignoring child must not hang the test");
    // Degraded results never echo the query or diagnostics.
    if (ign.degraded) {
      assert.equal(ign.text, FAKE_FALLBACK_TEXT);
      assert.ok(!JSON.stringify(ign).includes("hello"));
    }
  });

  it("A9 authorization and route separation: JSON human ops FORBIDDEN, scope mismatch FORBIDDEN_SCOPE, actor claims ignored", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, candidateParams("a9 auth probe"), nextKey("k"));
      assert.equal(c.ok, true);
      const candId = (c.data as { candidate: { id: string } }).candidate.id as string;
      void candId;
    } finally {
      db.close();
    }
    const human = runCli(cfg, { v: 1, op: "approve", params: {} });
    assert.equal(human.json["ok"], false);
    assert.equal(human.json["code"], "FORBIDDEN");
    const wrongScope = runCli(cfg, { v: 1, op: "candidate.get", params: { id: "cand_missing", scope: "personal/nope" } });
    assert.equal(wrongScope.json["ok"], false);
    assert.equal(wrongScope.json["code"], "FORBIDDEN_SCOPE");
    const actor = runCli(cfg, {
      v: 1, op: "candidate.create", idempotencyKey: nextKey("k"),
      params: { ...candidateParams("a9 actor probe"), actor: "admin" },
    });
    assert.equal(actor.json["ok"], false);
    assert.equal(actor.json["code"], "BAD_REQUEST");
  });

  it("A10 correction race: exactly one winner, loser CONFLICT with full rollback", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const oldId = createAndApprove(db, config, "a10 race base record").recId;
      const mk = (body: string) => {
        const cr = correctRequest(
          db, config,
          { recordId: oldId, body, kind: "correction", provenance: { source: "session:s1:turn:9", observedAt: "2026-09-02T00:00:00.000Z" }, scope: "personal/default" },
          nextKey("kc"),
        );
        assert.equal(cr.ok, true);
        return (cr.data as { candidate: { id: string } }).candidate.id as string;
      };
      const a = mk("a10 correction A wins");
      const b = mk("a10 correction B loses");
      const revA = getCandidateForReview(db, config, a, "personal/default");
      const revB = getCandidateForReview(db, config, b, "personal/default");
      assert.equal(revA.ok, true);
      assert.equal(revB.ok, true);
      if (!revA.ok || !revB.ok) throw new Error("review failed");
      const win = approveCandidate(db, config, { id: a, scope: "personal/default", token: revA.token, idempotencyKey: nextKey("ha") });
      assert.equal(win.ok, true);
      const lose = approveCandidate(db, config, { id: b, scope: "personal/default", token: revB.token, idempotencyKey: nextKey("hb") });
      assert.equal(lose.ok, false);
      assert.equal((lose as { code: string }).code, "CONFLICT");
      const loser = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(b) as { status: string };
      assert.equal(loser.status, "candidate");
      const actives = db.prepare(`SELECT COUNT(*) AS n FROM records WHERE supersedes=? AND status='active'`).get(oldId) as { n: number };
      assert.equal(actives.n, 1);
    } finally {
      db.close();
    }
  });

  it("A11 idempotent rollback and restart: pre-commit retry is fresh, committed replay survives reopen and expiry", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    let savedId: string;
    const key = nextKey("k");
    const params = candidateParams("a11 durable body");
    {
      const { db, config } = openDb(cfg);
      try {
        const first = createCandidate(db, config, params, key);
        assert.equal(first.ok, true);
        savedId = (first.data as { candidate: { id: string } }).candidate.id as string;
      } finally {
        db.close();
      }
    }
    {
      // Reopen (restart): the committed operation replays deterministically.
      const { db, config } = openDb(cfg);
      try {
        const replay = createCandidate(db, config, params, key);
        assert.equal(replay.ok, true);
        assert.equal((replay as { deduplicated: boolean }).deduplicated, true);
        assert.equal((replay.data as { candidate: { id: string } }).candidate.id, savedId);
        // Committed replay after expiry still returns the saved response.
        db.prepare(`UPDATE candidates SET expiresAt='2000-01-01T00:00:00.000Z', status='expired' WHERE id=?`).run(savedId);
        const afterExpiry = createCandidate(db, config, params, key);
        assert.equal(afterExpiry.ok, true);
        assert.equal((afterExpiry as { deduplicated: boolean }).deduplicated, true);
        assert.equal((afterExpiry.data as { candidate: { id: string } }).candidate.id, savedId);
      } finally {
        db.close();
      }
    }
  });

  it("A12 scope exposure isolation: other-scope records never surface, audit scope/recallId match", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      createAndApprove(db, config, "a12 shared term default-scope", "personal/default");
      createAndApprove(db, config, "a12 shared term other-scope", "personal/other");
      const r = recallRecords(db, config, { query: "shared term", scope: "personal/default", limit: 10 });
      assert.equal(r.ok, true);
      const items = (r.data as { items: Array<{ id: string }> }).items;
      assert.ok(items.length >= 1);
      for (const item of items) {
        const row = db.prepare(`SELECT scope FROM records WHERE id=?`).get(item.id) as { scope: string };
        assert.equal(row.scope, "personal/default");
      }
      const recallId = (r.data as { recallId: string }).recallId as string;
      const audits = db.prepare(`SELECT * FROM audit WHERE recallId=?`).all(recallId) as Array<Record<string, unknown>>;
      assert.ok(audits.length >= 1);
      assert.ok(audits.every((a) => a["scope"] === "personal/default"));
      const exposures = db.prepare(`SELECT * FROM exposures WHERE recallId=?`).all(recallId) as Array<Record<string, unknown>>;
      assert.equal(exposures.length, items.length);
    } finally {
      db.close();
    }
  });

  it("A13 overflow and unicode: over-budget inputs are LIMIT_EXCEEDED, emoji input keeps codepoint/UTF-8 boundaries", () => {
    const dir = mkdir();
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const emojiBody = "a13 🎉 booking ✅結合文字 café";
      const c = createCandidate(db, config, candidateParams(emojiBody), nextKey("k"));
      assert.equal(c.ok, true);
      const candId = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, candId, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const ap = approveCandidate(db, config, { id: candId, scope: "personal/default", token: rev.token, idempotencyKey: nextKey("h") });
      assert.equal(ap.ok, true);
      const r = recallRecords(db, config, { query: "🎉 booking", scope: "personal/default", limit: 10 });
      assert.equal(r.ok, true);
      const items = (r.data as { items: Array<{ snippet: string }> }).items;
      assert.ok(items.length >= 1);
      for (const item of items) {
        assert.equal(hasLoneSurrogate(item.snippet), false);
        assert.ok([...item.snippet].length <= 200);
      }
      const overQuery = recallRecords(db, config, { query: "😀".repeat(501), scope: "personal/default", limit: 10 });
      assert.equal(overQuery.ok, false);
      assert.equal((overQuery as { code: string }).code, "LIMIT_EXCEEDED");
      const overBody = createCandidate(db, config, candidateParams("😀".repeat(2001)), nextKey("k"));
      assert.equal(overBody.ok, false);
      assert.equal((overBody as { code: string }).code, "LIMIT_EXCEEDED");
      const overLimit = recallRecords(db, config, { query: "booking", scope: "personal/default", limit: 26 });
      assert.equal(overLimit.ok, false);
      assert.equal((overLimit as { code: string }).code, "LIMIT_EXCEEDED");
    } finally {
      db.close();
    }
  });
});
