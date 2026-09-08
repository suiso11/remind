import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { createCandidate, recallRecords } from "../src/store.js";
import { validateRequest } from "../src/protocol.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

function writeConfig(dir: string, dbName = "t3fix.db"): string {
  const p = path.join(dir, "memory.config.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      dbPath: `./${dbName}`,
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

function openDb(cfgPath: string) {
  const config = loadConfig(cfgPath);
  const { db } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config };
}

describe("T3 fix: bounded SQL retrieval at scale", () => {
  it("33000 matching active records recall with tag/link filter, limit 25, exact order, no STORE_UNAVAILABLE", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3fix-"));
    const cfg = writeConfig(dir, "scale.db");
    const { db, config } = openDb(cfg);
    try {
      const N = 33000;
      assert.ok(N > 32766);
      const baseMs = Date.parse("2026-09-02T00:00:00.000Z");
      const insR = db.prepare(
        `INSERT INTO records(id, candidateId, body, bodyHash, kind, source, observedAt, scope, status, supersedes, createdAt) VALUES (?, ?, ?, ?, 'user_fact', 'session:s1:turn:1', '2026-09-01T00:00:00.000Z', 'personal/default', 'active', NULL, ?)`,
      );
      const insT = db.prepare(`INSERT INTO record_tags(recordId, tag) VALUES (?, ?)`);
      const insL = db.prepare(`INSERT INTO record_links(fromId, toName) VALUES (?, ?)`);
      db.exec("BEGIN IMMEDIATE");
      try {
        for (let i = 0; i < N; i++) {
          const id = `rec_scale_${String(i).padStart(6, "0")}`;
          const body = `scaleprobe item ${i}`;
          const createdAt = new Date(baseMs + i * 1000).toISOString();
          insR.run(id, `cand_scale_${i}`, body, `sha256:${i}`, createdAt);
          insT.run(id, "scaletag");
          insL.run(id, "ScaleLink");
        }
        db.exec("COMMIT");
      } catch (e) {
        try {
          db.exec("ROLLBACK");
        } catch {
          /* ignore */
        }
        throw e;
      }
      const r = recallRecords(db, config, {
        query: "scaleprobe",
        tags: ["scaletag"],
        link: "ScaleLink",
        scope: "personal/default",
        limit: 25,
      });
      assert.equal(r.ok, true, `expected OK, got ${r.code}`);
      assert.notEqual(r.code, "STORE_UNAVAILABLE");
      const data = r.data as {
        recallId: string;
        items: Array<{ id: string; createdAt: string }>;
      };
      assert.equal(data.items.length, 25);
      const expected: string[] = [];
      for (let i = N - 1; i >= N - 25; i--) expected.push(`rec_scale_${String(i).padStart(6, "0")}`);
      assert.deepEqual(
        data.items.map((x) => x.id),
        expected,
      );
      for (let k = 1; k < data.items.length; k++) {
        assert.ok(data.items[k - 1].createdAt >= data.items[k].createdAt);
      }
      const audits = db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE recallId=?`).get(data.recallId) as { n: number };
      assert.equal(audits.n, 1);
      const exps = db.prepare(`SELECT COUNT(*) AS n FROM exposures WHERE recallId=?`).get(data.recallId) as { n: number };
      assert.equal(exps.n, 25);
    } finally {
      db.close();
    }
  });
});

describe("T3 fix: unpaired surrogate is BAD_REQUEST with no mutation; astral pairs pass", () => {
  it("envelope plus direct create and recall reject lone halves, accept valid emoji", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3fix-"));
    const cfg = writeConfig(dir, "surr.db");
    const { db, config } = openDb(cfg);
    try {
      const lone = String.fromCharCode(0xd800);
      assert.equal(lone.length, 1);
      const v = validateRequest({ v: 1, op: "record.recall", params: { query: lone, scope: "personal/default" } });
      assert.equal(v.ok, false);
      if (!v.ok) assert.equal(v.res.code, "BAD_REQUEST");
      const vEmoji = validateRequest({
        v: 1,
        op: "record.recall",
        params: { query: "ok", scope: "personal/default" },
      });
      assert.equal(vEmoji.ok, true);

      const auditBefore = (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;
      const candBefore = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      const badQ = recallRecords(db, config, { query: lone, scope: "personal/default" });
      assert.equal(badQ.code, "BAD_REQUEST");
      const badTag = recallRecords(db, config, { query: "x", tags: [lone], scope: "personal/default" });
      assert.equal(badTag.code, "BAD_REQUEST");
      const badLink = recallRecords(db, config, { query: "x", link: lone, scope: "personal/default" });
      assert.equal(badLink.code, "BAD_REQUEST");
      const badBody = createCandidate(
        db,
        config,
        {
          body: "hello " + lone + " world",
          kind: "user_fact",
          provenance: { source: "session:s1:turn:1", observedAt: "2026-09-01T00:00:00.000Z" },
          scope: "personal/default",
        },
        "surr-key-1",
      );
      assert.equal(badBody.code, "BAD_REQUEST");
      const badProv = createCandidate(
        db,
        config,
        {
          body: "valid body",
          kind: "user_fact",
          provenance: { source: lone, observedAt: "2026-09-01T00:00:00.000Z" },
          scope: "personal/default",
        },
        "surr-key-2",
      );
      assert.equal(badProv.code, "BAD_REQUEST");
      const auditAfter = (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;
      const candAfter = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      assert.equal(auditAfter, auditBefore);
      assert.equal(candAfter, candBefore);
      const astral = String.fromCodePoint(0x1f600);
      const good = createCandidate(
        db,
        config,
        {
          body: "emoji body ok " + astral,
          kind: "user_fact",
          provenance: { source: "session:s1:turn:1", observedAt: "2026-09-01T00:00:00.000Z" },
          scope: "personal/default",
        },
        "surr-key-3",
      );
      assert.equal(good.ok, true);
      const trail = String.fromCharCode(0xdc00);
      assert.equal(recallRecords(db, config, { query: trail, scope: "personal/default" }).code, "BAD_REQUEST");
    } finally {
      db.close();
    }
  });

  it("CLI escaped lone surrogate is BAD_REQUEST with no audit row", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-t3fix-"));
    const cfg = writeConfig(dir, "surrcli.db");
    const opened = openDb(cfg);
    opened.db.close();
    const auditCount = (): number => {
      const { db } = openDb(cfg);
      try {
        return (db.prepare(`SELECT COUNT(*) AS n FROM audit`).get() as { n: number }).n;
      } finally {
        db.close();
      }
    };
    const before = auditCount();
    const lone = String.fromCharCode(0xd800);
    const raw = JSON.stringify({ v: 1, op: "record.recall", params: { query: lone, scope: "personal/default" } }) + "\n";
    assert.ok(raw.indexOf("ud800") >= 0 || raw.indexOf("U") >= 0);
    const r = spawnSync(process.execPath, [cli, "--config", cfg], { input: raw, encoding: "utf8" });
    assert.equal(r.status, 0);
    const body = JSON.parse(String(r.stdout).trim()) as { ok: boolean; code: string };
    assert.equal(body.code, "BAD_REQUEST");
    assert.equal(body.ok, false);
    assert.equal(auditCount(), before);
  });
});
