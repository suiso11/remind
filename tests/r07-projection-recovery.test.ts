/**
 * R07 durable recovery acceptance (projection queue + vault rebuild).
 *
 * Real temp-only SQLite + real vault dir. No rebuild CLI/daemon: the library
 * functions drainProjection/rebuildVault/projectOneRecord are the exercised
 * path. Deterministic: no wall sleeps; due rows are forced via nextAt reset.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { eventAppend, rememberRecord, correctRecord } from "../src/store.js";
import {
  drainProjection,
  projectOneRecord,
  readBacklinks,
  readProjectionRecord,
  rebuildVault,
  renderMarkdown,
} from "../src/projection.js";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";
const PAST = "2000-01-01T00:00:00.000Z";

function makeConfig(dir: string, dbName = "r07.db"): { config: AppConfig; configPath: string } {
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
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  return { config, configPath: path.join(dir, "memory.config.json") };
}

let ctr = 0;

function seedRaw(db: DatabaseSync, config: AppConfig, eventId: string): void {
  const r = eventAppend(
    db,
    config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: "raw context " + eventId + " r07 probe",
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope: SCOPE,
    },
    "r07-seed-ev-" + eventId + "-" + ctr++,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
}

function seedRecord(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  key: string,
  extra: Record<string, unknown> = {},
): string {
  const ref = "r07-auto-" + key;
  seedRaw(db, config, ref);
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope: SCOPE,
      sourceRefs: [ref],
      ...extra,
    },
    "r07-" + key,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function queueRows(db: DatabaseSync): string[] {
  return (
    db.prepare("SELECT recordId FROM projection_queue ORDER BY recordId ASC").all() as Array<{
      recordId: string;
    }>
  ).map((r) => r.recordId);
}

function forceDue(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE projection_queue SET nextAt=? WHERE recordId=?").run(PAST, id);
}

function expectedMarkdown(db: DatabaseSync, id: string): string {
  const rec = readProjectionRecord(db, id);
  assert.ok(rec, "canonical row missing for " + id);
  return renderMarkdown(rec, readBacklinks(db, id, rec.scope));
}

describe("R07 queue persists across close+reopen; links/backlinks only on success", () => {
  it("failed queue survives reopen and drains with restored links/backlinks", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r07-persist-"));
    let db: DatabaseSync | null = null;
    try {
      const { config, configPath } = makeConfig(dir);
      ({ db } = initDb(config, configPath));
      if (db === null) throw new Error("db init failed");
      const a = seedRecord(db, config, "r07 persist alpha lighthouse log", "persist-a", {
        tags: ["harbor"],
      });
      const b = seedRecord(db, config, "r07 persist beta harbor notes", "persist-b", {
        links: [a],
      });
      assert.deepEqual(queueRows(db), [a, b].sort());
      // Fail the drain against a real non-directory vault target: nothing is
      // written, rows survive, canonical memory stays intact.
      const blocker = path.join(dir, "blocker-file");
      fs.writeFileSync(blocker, "not a dir", "utf8");
      const broken = { ...config, vaultPath: blocker };
      const failed = drainProjection(db, broken, configPath);
      assert.equal(failed.projected, 0);
      assert.ok(failed.failed >= 2, JSON.stringify(failed));
      assert.deepEqual(queueRows(db), [a, b].sort());
      assert.ok(!fs.existsSync(path.join(config.vaultPath, a + ".md")));
      assert.ok(!fs.existsSync(path.join(config.vaultPath, b + ".md")));
      // Close with failures pending, reopen the same temp file: rows persist.
      db.close();
      db = null;
      ({ db } = initDb(config, configPath));
      if (db === null) throw new Error("db init failed");
      assert.deepEqual(queueRows(db), [a, b].sort());
      for (const id of [a, b]) forceDue(db, id);
      const done = drainProjection(db, config, configPath);
      assert.equal(done.failed, 0, JSON.stringify(done));
      assert.ok(done.projected >= 2, JSON.stringify(done));
      assert.deepEqual(queueRows(db), []);
      // Links/backlinks are restored only by this successful dequeue.
      const fileA = path.join(config.vaultPath, a + ".md");
      const fileB = path.join(config.vaultPath, b + ".md");
      assert.ok(fs.existsSync(fileA) && fs.existsSync(fileB));
      assert.equal(fs.readFileSync(fileB, "utf8"), expectedMarkdown(db, b));
      assert.equal(fs.readFileSync(fileA, "utf8"), expectedMarkdown(db, a));
      assert.ok(fs.readFileSync(fileB, "utf8").includes("[[" + a + "]]"));
      assert.ok(fs.readFileSync(fileA, "utf8").includes("[[" + b + "]]"));
      assert.ok(fs.readFileSync(fileA, "utf8").includes("r07 persist alpha lighthouse log"));
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R07 rename failure preserves final markdown without partial overwrite", () => {
  it("real rename-stage failure keeps sentinel, then re-drain restores", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r07-rename-"));
    let db: DatabaseSync | null = null;
    try {
      const { config, configPath } = makeConfig(dir);
      ({ db } = initDb(config, configPath));
      if (db === null) throw new Error("db init failed");
      const id = seedRecord(db, config, "r07 rename guard memo", "rename-1");
      assert.equal(drainProjection(db, config, configPath).failed, 0);
      const finalPath = path.join(config.vaultPath, id + ".md");
      const v1 = fs.readFileSync(finalPath, "utf8");
      assert.ok(v1.includes("r07 rename guard memo"));
      // Queue a corrected revision, then sabotage its final path as a
      // non-empty directory: temp+rename hits a real rename-stage failure.
      seedRaw(db, config, "r07-rename-raw-2");
      const corr = correctRecord(
        db,
        config,
        {
          recordId: id,
          body: "r07 rename guard memo revised",
          kind: "correction",
          provenance: { source: "session:s1:turn:9", observedAt: OBS },
          scope: SCOPE,
          sourceRefs: ["r07-rename-raw-2"],
        },
        "r07-rename-corr-1",
      );
      assert.equal(corr.ok, true, JSON.stringify(corr));
      const newId = (corr.data as { record: { id: string } }).record.id;
      const newFinal = path.join(config.vaultPath, newId + ".md");
      fs.mkdirSync(newFinal, { recursive: true });
      const sentinel = path.join(newFinal, "sentinel.txt");
      fs.writeFileSync(sentinel, "prior-final-guard", "utf8");
      const out = drainProjection(db, config, configPath);
      assert.ok(out.failed >= 1, JSON.stringify(out));
      // No partial overwrite: directory + sentinel survive, queue retained,
      // and the prior revision file is intact.
      assert.ok(fs.statSync(newFinal).isDirectory());
      assert.equal(fs.readFileSync(sentinel, "utf8"), "prior-final-guard");
      assert.ok(queueRows(db).includes(newId));
      // The prior revision re-rendered atomically to its canonical
      // superseded state: a complete render, never a partial overwrite.
      assert.equal(fs.readFileSync(finalPath, "utf8"), expectedMarkdown(db, id));
      // Remove sabotage, clear stale tmp files, force due, re-drain.
      fs.rmSync(newFinal, { recursive: true, force: true });
      for (const f of fs.readdirSync(config.vaultPath)) {
        if (f.endsWith(".tmp")) fs.rmSync(path.join(config.vaultPath, f), { force: true });
      }
      forceDue(db, newId);
      const done = drainProjection(db, config, configPath);
      assert.equal(done.failed, 0, JSON.stringify(done));
      assert.ok(!queueRows(db).includes(newId));
      assert.equal(fs.readFileSync(newFinal, "utf8"), expectedMarkdown(db, newId));
      assert.ok(fs.readFileSync(newFinal, "utf8").includes("r07 rename guard memo revised"));
      projectOneRecord(db, config.vaultPath, "rec_does_not_exist_r07");
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R07 rebuild restores full canonical content; canonical rows invariant", () => {
  it("deleted/corrupted vault rebuilds exactly; full row contents unchanged", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r07-rebuild-"));
    let db: DatabaseSync | null = null;
    try {
      const { config, configPath } = makeConfig(dir);
      ({ db } = initDb(config, configPath));
      if (db === null) throw new Error("db init failed");
      const a = seedRecord(db, config, "r07 rebuild alpha orchard log", "rebuild-a", {
        tags: ["orchard", "alpha"],
      });
      const b = seedRecord(db, config, "r07 rebuild beta harbor notes", "rebuild-b", {
        tags: ["harbor"],
        links: [a],
      });
      seedRaw(db, config, "r07-rebuild-raw-c");
      const cRes = rememberRecord(
        db,
        config,
        {
          body: "r07 rebuild gamma summary note",
          kind: "summary",
          provenance: { source: "derived: pruning batch", observedAt: OBS },
          scope: SCOPE,
          sourceRefs: [],
        },
        "r07-rebuild-c",
      );
      assert.equal(cRes.ok, true, JSON.stringify(cRes));
      const c = (cRes.data as { record: { id: string } }).record.id;
      assert.equal(drainProjection(db, config, configPath).failed, 0);
      const theDb = db as DatabaseSync;
      const dumpCanonical = (): Record<string, unknown> => {
        const dump = (sql: string): unknown[] => theDb.prepare(sql).all() as unknown[];
        return {
          raw_events: dump("SELECT eventId, sessionId, turnId, body, bodyNorm, source, observedAt, scope, runId, createdAt FROM raw_events ORDER BY eventId ASC"),
          records: dump("SELECT id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt FROM records ORDER BY id ASC"),
          record_tags: dump("SELECT recordId, tag FROM record_tags ORDER BY recordId ASC, tag ASC"),
          record_links: dump("SELECT fromId, toRef FROM record_links ORDER BY fromId ASC, toRef ASC"),
          record_source_refs: dump("SELECT recordId, eventId FROM record_source_refs ORDER BY recordId ASC, eventId ASC"),
          operations: dump("SELECT idempotencyKey, op, requestHash, responseJson, createdAt FROM operations ORDER BY idempotencyKey ASC"),
          audit: dump("SELECT ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode FROM audit ORDER BY rowid ASC"),
          usage: dump("SELECT ts, recallId, recordId, scope, runId FROM usage ORDER BY rowid ASC"),
          note_heat: dump("SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId ASC"),
          scopes: dump("SELECT scope FROM scopes ORDER BY scope ASC"),
        };
      };
      const before = dumpCanonical();
      const expected = new Map<string, string>([
        [a, expectedMarkdown(theDb, a)],
        [b, expectedMarkdown(theDb, b)],
        [c, expectedMarkdown(theDb, c)],
      ]);
      // Derived-only loss: delete one file, corrupt another, remove the third.
      fs.rmSync(path.join(config.vaultPath, a + ".md"));
      fs.writeFileSync(path.join(config.vaultPath, b + ".md"), "CORRUPTED-DERIVED-CONTENT", "utf8");
      fs.rmSync(path.join(config.vaultPath, c + ".md"));
      const n = rebuildVault(theDb, config, configPath);
      assert.ok(n >= 3, "rebuild count " + n);
      // Full canonical row contents (not counts) are invariant. Derived
      // projection_queue/fts/char-bigram state is excluded from comparison.
      assert.deepEqual(dumpCanonical(), before);
      for (const [rid, md] of expected) {
        assert.equal(fs.readFileSync(path.join(config.vaultPath, rid + ".md"), "utf8"), md);
      }
      assert.ok(fs.readFileSync(path.join(config.vaultPath, b + ".md"), "utf8").includes("[[" + a + "]]"));
      assert.ok(fs.readFileSync(path.join(config.vaultPath, a + ".md"), "utf8").includes("[[" + b + "]]"));
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
