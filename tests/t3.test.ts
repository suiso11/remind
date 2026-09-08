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
  recallRecords,
} from "../src/store.js";
import { countCp } from "../src/normalize.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

let keyN = 0;
function nextKey(prefix: string): string {
  keyN += 1;
  return `${prefix}-${Date.now()}-${keyN}`;
}

function writeConfig(
  dir: string,
  dbName = "t3.db",
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
  fs.writeFileSync(p, JSON.stringify(merged));
  return p;
}

function openDb(cfgPath: string) {
  const config = loadConfig(cfgPath);
  const { db } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config };
}

function seedRecord(
  db: DatabaseSync,
  config: ReturnType<typeof loadConfig>,
  opts: {
    body: string;
    tags?: string[];
    link?: string;
    scope?: string;
    createdAt: string;
  },
): string {
  const params: Record<string, unknown> = {
    body: opts.body,
    kind: "user_fact",
    provenance: { source: "session:s1:turn:1", observedAt: "2026-09-01T00:00:00.000Z" },
    scope: opts.scope ?? "personal/default",
    tags: opts.tags ?? [],
  };
  if (opts.link !== undefined) params["link"] = opts.link;
  const c = createCandidate(db, config, params, nextKey("k"));
  assert.equal(c.ok, true);
  const id = (c.data as { candidate: { id: string } }).candidate.id as string;
  const rev = getCandidateForReview(db, config, id, opts.scope ?? "personal/default");
  assert.equal(rev.ok, true);
  if (!rev.ok) throw new Error("review failed");
  const ap = approveCandidate(
    db,
    config,
    { id, scope: opts.scope ?? "personal/default", token: rev.token, idempotencyKey: nextKey("h") },
    opts.createdAt,
  );
  assert.equal(ap.ok, true);
  return (ap.data as { record: { id: string } }).record.id as string;
}

function runJson(cfg: string, obj: unknown) {
  const r = spawnSync(process.execPath, [cli, "--config", cfg], {
    input: JSON.stringify(obj) + "\n",
    encoding: "utf8",
  });
  return {
    status: r.status,
    body: JSON.parse(String(r.stdout).trim()) as Record<string, unknown>,
    stdout: String(r.stdout),
    stderr: String(r.stderr),
  };
}

describe("T3 deterministic recall", () => {
  it("approval-only: unapproved candidates never recall; revoked scope is FORBIDDEN_SCOPE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const marker = "UNAPPROVED-9q2w-leakcheck";
      const c = createCandidate(
        db,
        config,
        {
          body: `candidate only ${marker}`,
          kind: "user_fact",
          provenance: { source: "session:s1:turn:1", observedAt: "2026-09-01T00:00:00.000Z" },
          scope: "personal/default",
          tags: [],
        },
        nextKey("k"),
      );
      assert.equal(c.ok, true);
      const r0 = recallRecords(db, config, { query: marker, scope: "personal/default" });
      assert.equal(r0.ok, true);
      assert.deepEqual((r0.data as { items: unknown[] }).items, []);
      // Approve one record in another scope; same-scope recall must not see it.
      seedRecord(db, config, {
        body: "other scope secret body",
        scope: "personal/other",
        createdAt: "2026-09-02T00:00:00.000Z",
      });
      const cross = recallRecords(db, config, { query: "other scope", scope: "personal/default" });
      assert.equal(cross.ok, true);
      assert.deepEqual((cross.data as { items: unknown[] }).items, []);
      // Revoked scope: delete the DB row, keep startup config -> denied.
      db.prepare(`DELETE FROM scopes WHERE scope='personal/default'`).run();
      assert.equal(
        recallRecords(db, config, { query: "anything", scope: "personal/default" }).code,
        "FORBIDDEN_SCOPE",
      );
    } finally {
      db.close();
    }
  });

  it("normalization is literal: case/space fold matches, %_ and quotes have no wildcards", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      seedRecord(db, config, {
        body: "  HELLO   World booking  ",
        createdAt: "2026-09-02T00:00:00.000Z",
      });
      seedRecord(db, config, {
        body: 'literal 100%_sure "quoted" body',
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      seedRecord(db, config, {
        body: "plain unrelated text",
        createdAt: "2026-09-04T00:00:00.000Z",
      });
      const folded = recallRecords(db, config, { query: "hello world", scope: "personal/default" });
      assert.equal(folded.ok, true);
      const fItems = (folded.data as { items: Array<{ id: string }> }).items;
      assert.equal(fItems.length, 1);
      const pct = recallRecords(db, config, { query: "100%_sure", scope: "personal/default" });
      const pItems = (pct.data as { items: Array<{ snippet: string }> }).items;
      assert.equal(pItems.length, 1);
      assert.ok(pItems[0].snippet.includes("100%_sure"));
      // A bare % must NOT wildcard-match every row: only literal containment.
      const bare = recallRecords(db, config, { query: "%", scope: "personal/default" });
      const bItems = (bare.data as { items: Array<{ snippet: string }> }).items;
      assert.equal(bItems.length, 1);
      assert.ok(bItems[0].snippet.includes("%"));
      const quote = recallRecords(db, config, { query: '"quoted"', scope: "personal/default" });
      assert.equal((quote.data as { items: unknown[] }).items.length, 1);
      // Empty-after-normalization query is BAD_REQUEST.
      assert.equal(recallRecords(db, config, { query: "   ", scope: "personal/default" }).code, "BAD_REQUEST");
    } finally {
      db.close();
    }
  });

  it("tag ALL + link exact + since/until + order/ties + limit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const idAB = seedRecord(db, config, {
        body: "recall target alpha beta",
        tags: ["Alpha", "Beta"],
        link: "Target",
        createdAt: "2026-09-02T00:00:00.000Z",
      });
      seedRecord(db, config, {
        body: "recall target alpha only",
        tags: ["alpha"],
        createdAt: "2026-09-03T00:00:00.000Z",
      });
      seedRecord(db, config, {
        body: "recall target beta only",
        tags: ["beta"],
        link: "Target",
        createdAt: "2026-09-04T00:00:00.000Z",
      });
      // ALL: both tags required.
      const all = recallRecords(db, config, {
        query: "recall target",
        tags: ["ALPHA", "beta"],
        scope: "personal/default",
      });
      const allItems = (all.data as { items: Array<{ id: string }> }).items;
      assert.equal(allItems.length, 1);
      assert.equal(allItems[0].id, idAB);
      // Single tag matches two rows, newest first.
      const one = recallRecords(db, config, { query: "recall target", tags: ["alpha"], scope: "personal/default" });
      const oneItems = (one.data as { items: Array<{ id: string; createdAt: string }> }).items;
      assert.equal(oneItems.length, 2);
      assert.ok(oneItems[0].createdAt >= oneItems[1].createdAt);
      // Link exact (case-sensitive: link norm has no casefold).
      const linkOk = recallRecords(db, config, {
        query: "recall target",
        tags: ["alpha", "beta"],
        link: "Target",
        scope: "personal/default",
      });
      assert.equal((linkOk.data as { items: unknown[] }).items.length, 1);
      const linkMiss = recallRecords(db, config, {
        query: "recall target",
        link: "target",
        scope: "personal/default",
      });
      assert.deepEqual((linkMiss.data as { items: unknown[] }).items, []);
      // Time window: since inclusive, until exclusive.
      const win = recallRecords(db, config, {
        query: "recall target",
        scope: "personal/default",
        since: "2026-09-03T00:00:00.000Z",
        until: "2026-09-04T00:00:00.000Z",
      });
      const wItems = (win.data as { items: Array<{ createdAt: string }> }).items;
      assert.equal(wItems.length, 1);
      assert.equal(wItems[0].createdAt, "2026-09-03T00:00:00.000Z");
      // Ties on createdAt order by id ASC; limit selects the deterministic top.
      const t = "2026-09-05T00:00:00.000Z";
      const tieA = seedRecord(db, config, { body: "tie breaker body", createdAt: t });
      const tieB = seedRecord(db, config, { body: "tie breaker body", createdAt: t });
      const tied = recallRecords(db, config, { query: "tie breaker", scope: "personal/default", limit: 10 });
      const tItems = (tied.data as { items: Array<{ id: string }> }).items;
      assert.equal(tItems.length, 2);
      assert.deepEqual(
        tItems.map((x) => x.id),
        [tieA, tieB].sort(),
      );
      const top1 = recallRecords(db, config, { query: "tie breaker", scope: "personal/default", limit: 1 });
      assert.equal((top1.data as { items: unknown[] }).items.length, 1);
      assert.equal((top1.data as { items: Array<{ id: string }> }).items[0].id, [tieA, tieB].sort()[0]);
      void idAB;
    } finally {
      db.close();
    }
  });

  it("unicode truncation is codepoint-prefix, bytes exact, budget covers the full response", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir, "t3uni.db", { limits: { snippetMaxCp: 8 } });
    const { db, config } = openDb(cfg);
    try {
      const body = "😀😃😄😁😆😅😂🤣☺️ experiment body tail";
      const recId = seedRecord(db, config, { body, tags: ["emoji"], createdAt: "2026-09-02T00:00:00.000Z" });
      const r = recallRecords(db, config, { query: "experiment", scope: "personal/default" });
      assert.equal(r.ok, true);
      const items = (r.data as { items: Array<{ id: string; snippet: string; truncated: boolean; tags: string[]; createdAt: string }> }).items;
      assert.equal(items.length, 1);
      assert.equal(items[0].id, recId);
      assert.equal(countCp(items[0].snippet), 8);
      assert.equal(items[0].truncated, true);
      assert.ok(!items[0].snippet.includes("experiment"));
      const fullBytes = Buffer.byteLength(JSON.stringify(r), "utf8");
      assert.ok(fullBytes <= config.limits.responseMaxBytes);
      // Short body (<= snippetMaxCp) is returned whole with truncated=false and no fake ellipsis.
      const shortId = seedRecord(db, config, { body: "tiny", createdAt: "2026-09-03T00:00:00.000Z" });
      const rs = recallRecords(db, config, { query: "tiny", scope: "personal/default" });
      const sItems = (rs.data as { items: Array<{ id: string; snippet: string; truncated: boolean }> }).items;
      assert.equal(sItems.length, 1);
      assert.equal(sItems[0].id, shortId);
      assert.equal(sItems[0].snippet, "tiny");
      assert.equal(sItems[0].truncated, false);
    } finally {
      db.close();
    }
  });

  it("empty recall audits with bytes+limit, unique recallIds, no query/body in audit or errors", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const secret = "SECRET-qq-body-4f8d2c";
      const qsecret = "SECRET-qq-query-9a1b7e";
      seedRecord(db, config, { body: `unrelated ${secret} content`, createdAt: "2026-09-02T00:00:00.000Z" });
      const beforeAudit = (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;
      const beforeExp = (db.prepare(`SELECT COUNT(*) AS n FROM exposures`).get() as { n: number }).n;
      const r = recallRecords(db, config, { query: qsecret, scope: "personal/default", runId: "run-empty-1" });
      assert.equal(r.ok, true);
      assert.deepEqual((r.data as { items: unknown[] }).items, []);
      const recallId = (r.data as { recallId: string }).recallId as string;
      assert.match(recallId, /^recall_/);
      const audits = db.prepare(`SELECT * FROM audit ORDER BY rowid DESC LIMIT 1`).all() as Array<Record<string, unknown>>;
      assert.equal(audits.length, 1);
      assert.equal(audits[0]["op"], "record.recall");
      assert.equal(audits[0]["recallId"], recallId);
      assert.equal(audits[0]["targetId"], recallId);
      assert.equal(audits[0]["runId"], "run-empty-1");
      assert.equal(audits[0]["scope"], "personal/default");
      assert.equal(audits[0]["code"], "OK");
      const storedBytes = Buffer.byteLength(JSON.stringify(r), "utf8");
      assert.equal(audits[0]["bytes"], storedBytes);
      assert.ok(typeof audits[0]["limitN"] === "number");
      assert.ok(!JSON.stringify(audits).includes(secret));
      assert.ok(!JSON.stringify(audits).includes(qsecret));
      const exps = db.prepare(`SELECT * FROM exposures WHERE recallId=?`).all(recallId) as Array<Record<string, unknown>>;
      assert.equal(exps.length, 0);
      // Second empty recall gets a distinct recallId and its own audit row.
      const r2 = recallRecords(db, config, { query: qsecret, scope: "personal/default", runId: "run-empty-1" });
      const rid2 = (r2.data as { recallId: string }).recallId as string;
      assert.notEqual(rid2, recallId);
      const afterAudit = (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;
      const afterExp = (db.prepare(`SELECT COUNT(*) AS n FROM exposures`).get() as { n: number }).n;
      assert.equal(afterAudit, beforeAudit + 2);
      assert.equal(afterExp, beforeExp);
      // Error envelopes never echo the query either.
      const bad = recallRecords(db, config, { query: qsecret, scope: "personal/default", bogus: 1 } as unknown as Record<string, unknown>);
      assert.equal(bad.code, "BAD_REQUEST");
      assert.ok(!JSON.stringify(bad).includes(qsecret));
    } finally {
      db.close();
    }
  });

  it("non-empty recall writes one audit row plus one exposure per returned id with byte counts", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      seedRecord(db, config, { body: "exposure one body", tags: ["t"], createdAt: "2026-09-02T00:00:00.000Z" });
      seedRecord(db, config, { body: "exposure two body", tags: ["t"], createdAt: "2026-09-03T00:00:00.000Z" });
      const r = recallRecords(db, config, { query: "exposure", scope: "personal/default", runId: "run-exp-1", limit: 2 });
      assert.equal(r.ok, true);
      const data = r.data as { recallId: string; items: Array<{ id: string; snippet: string; truncated: boolean }> };
      assert.equal(data.items.length, 2);
      const audits = db.prepare(`SELECT * FROM audit WHERE recallId=?`).all(data.recallId) as Array<Record<string, unknown>>;
      assert.equal(audits.length, 1);
      const exps = db.prepare(`SELECT * FROM exposures WHERE recallId=? ORDER BY recordId ASC`).all(data.recallId) as Array<{
        recordId: string;
        snippetBytes: number;
        truncated: number;
        runId: string;
        scope: string;
        limitN: number;
      }>;
      assert.equal(exps.length, 2);
      assert.deepEqual(
        exps.map((e) => e.recordId).sort(),
        data.items.map((x) => x.id).sort(),
      );
      for (const e of exps) {
        const item = data.items.find((x) => x.id === e.recordId);
        assert.ok(item);
        assert.equal(e.snippetBytes, Buffer.byteLength(item!.snippet, "utf8"));
        assert.equal(e.truncated, item!.truncated ? 1 : 0);
        assert.equal(e.runId, "run-exp-1");
        assert.equal(e.scope, "personal/default");
        assert.equal(e.limitN, 2);
      }
    } finally {
      db.close();
    }
  });

  it("strict params: unknown fields, bounds, times, control chars, limit and idempotency rejection", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      seedRecord(db, config, { body: "strict params body", createdAt: "2026-09-02T00:00:00.000Z" });
      const good = { query: "strict", scope: "personal/default" };
      assert.equal(recallRecords(db, config, { ...good, extra: 1 }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { scope: "personal/default" }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { query: "strict" }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, tags: "x" }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, tags: ["a", "b", "c", "d", "e", "f"] }).code, "LIMIT_EXCEEDED");
      assert.equal(recallRecords(db, config, { ...good, query: "x".repeat(501) }).code, "LIMIT_EXCEEDED");
      assert.equal(recallRecords(db, config, { ...good, limit: 0 }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, limit: 1.5 }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, limit: 26 }).code, "LIMIT_EXCEEDED");
      assert.equal(recallRecords(db, config, { ...good, since: "not-a-time" }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, until: "2026-09-02 00:00:00" }).code, "BAD_REQUEST");
      const ctl = "a" + String.fromCharCode(1) + "b";
      assert.equal(recallRecords(db, config, { ...good, scope: ctl }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, runId: ctl }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, link: ctl }).code, "BAD_REQUEST");
      assert.equal(recallRecords(db, config, { ...good, tags: [ctl] }).code, "BAD_REQUEST");
      // Read ops must not carry an idempotency key over JSON.
      const via = runJson(cfg, { v: 1, op: "record.recall", idempotencyKey: "k-x", params: good });
      assert.equal(via.body["code"], "BAD_REQUEST");
    } finally {
      db.close();
    }
  });

  it("forced audit failure rolls back to STORE_UNAVAILABLE with no success and no exposures", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      seedRecord(db, config, { body: "rollback body", createdAt: "2026-09-02T00:00:00.000Z" });
      const expBefore = (db.prepare(`SELECT COUNT(*) AS n FROM exposures`).get() as { n: number }).n;
      db.exec(`DROP TABLE audit`);
      const r = recallRecords(db, config, { query: "rollback", scope: "personal/default" });
      assert.equal(r.ok, false);
      assert.equal(r.code, "STORE_UNAVAILABLE");
      const expAfter = (db.prepare(`SELECT COUNT(*) AS n FROM exposures`).get() as { n: number }).n;
      assert.equal(expAfter, expBefore);
    } finally {
      db.close();
    }
  });

  it("budget overflow returns LIMIT_EXCEEDED with no audit or exposure rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir, "t3over.db", {
      limits: { snippetMaxCp: 1000, responseMaxBytes: 1024 },
    });
    const { db, config } = openDb(cfg);
    try {
      seedRecord(db, config, { body: "x".repeat(1000), createdAt: "2026-09-02T00:00:00.000Z" });
      const auditBefore = (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;
      const expBefore = (db.prepare(`SELECT COUNT(*) AS n FROM exposures`).get() as { n: number }).n;
      const r = recallRecords(db, config, { query: "x".repeat(10), scope: "personal/default" });
      assert.equal(r.ok, false);
      assert.equal(r.code, "LIMIT_EXCEEDED");
      const auditAfter = (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;
      const expAfter = (db.prepare(`SELECT COUNT(*) AS n FROM exposures`).get() as { n: number }).n;
      assert.equal(auditAfter, auditBefore);
      assert.equal(expAfter, expBefore);
    } finally {
      db.close();
    }
  });

  it("CLI JSON end-to-end over persistent seeded SQLite returns budgeted recall and persists audit", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3-"));
    const cfg = writeConfig(dir, "t3cli.db");
    const opened = openDb(cfg);
    let recId = "";
    try {
      recId = seedRecord(opened.db, opened.config, {
        body: "cli end to end booking note",
        tags: ["plan"],
        createdAt: "2026-09-02T00:00:00.000Z",
      });
    } finally {
      opened.db.close();
    }
    const r = runJson(cfg, {
      v: 1,
      op: "record.recall",
      params: { query: "booking", scope: "personal/default", runId: "run-cli-1" },
    });
    assert.equal(r.status, 0);
    assert.equal(r.body["ok"], true);
    const data = r.body["data"] as { recallId: string; items: Array<{ id: string; snippet: string; truncated: boolean }> };
    assert.match(data.recallId, /^recall_/);
    assert.equal(data.items.length, 1);
    assert.equal(data.items[0].id, recId);
    assert.equal(data.items[0].snippet, "cli end to end booking note");
    assert.equal(data.items[0].truncated, false);
    assert.ok(Buffer.byteLength(r.stdout.trim(), "utf8") <= 8192);
    const { db } = openDb(cfg);
    try {
      const audits = db.prepare(`SELECT * FROM audit WHERE recallId=?`).all(data.recallId) as Array<Record<string, unknown>>;
      assert.equal(audits.length, 1);
      const exps = db.prepare(`SELECT * FROM exposures WHERE recallId=?`).all(data.recallId) as Array<Record<string, unknown>>;
      assert.equal(exps.length, 1);
      assert.equal(exps[0]["recordId"], recId);
    } finally {
      db.close();
    }
  });
});
