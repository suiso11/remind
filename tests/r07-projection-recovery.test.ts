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
import { createRequire } from "node:module";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  archiveRecord,
  eventAppend,
  feedbackRecords,
  recallRecords,
  rememberRecord,
} from "../src/store.js";
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

function queueMeta(db: DatabaseSync, id: string): { attempts: number; nextAt: string } | undefined {
  return db
    .prepare("SELECT attempts, nextAt FROM projection_queue WHERE recordId = ?")
    .get(id) as { attempts: number; nextAt: string } | undefined;
}

function forceDue(db: DatabaseSync, id: string): void {
  db.prepare("UPDATE projection_queue SET nextAt=? WHERE recordId=?").run(PAST, id);
}

function expectedMarkdown(db: DatabaseSync, id: string): string {
  const rec = readProjectionRecord(db, id);
  assert.ok(rec, "canonical row missing for " + id);
  return renderMarkdown(rec, readBacklinks(db, id, rec.scope));
}

function heatOf(db: DatabaseSync, id: string): number {
  const row = db.prepare("SELECT usedCount FROM note_heat WHERE recordId = ?").get(id) as
    | { usedCount: number }
    | undefined;
  return row?.usedCount ?? 0;
}

describe("R07 queue persists across close+reopen; future retry row untouched then recovers", () => {
  it("failed queue survives reopen; one future row stays intact while other drains, then recovers", () => {
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
      // written, rows survive with backoff, canonical memory stays intact.
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
      // Keep b as an independent future retry row; only a is due.
      forceDue(db, a);
      const bMetaBefore = queueMeta(db, b);
      assert.ok(bMetaBefore, "future retry row missing");
      assert.ok((bMetaBefore as { nextAt: string }).nextAt > new Date().toISOString());
      const partial = drainProjection(db, config, configPath);
      assert.equal(partial.failed, 0, JSON.stringify(partial));
      assert.equal(partial.projected, 1, JSON.stringify(partial));
      // Future row metadata is byte-identical, no markdown was written for it.
      assert.deepEqual(queueMeta(db, b), bMetaBefore);
      assert.deepEqual(queueRows(db), [b]);
      assert.ok(!fs.existsSync(path.join(config.vaultPath, b + ".md")));
      assert.equal(fs.readFileSync(path.join(config.vaultPath, a + ".md"), "utf8"), expectedMarkdown(db, a));
      // Now make the future row due separately: eventual recovery, no sleeps.
      forceDue(db, b);
      const done = drainProjection(db, config, configPath);
      assert.equal(done.failed, 0, JSON.stringify(done));
      assert.ok(done.projected >= 1, JSON.stringify(done));
      assert.deepEqual(queueRows(db), []);
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

describe("R07 rename-stage fault preserves SAME regular final markdown", () => {
  it("primitive fs.renameSync fault at exact dest keeps old bytes, retry renders canonical", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r07-rename-"));
    let db: DatabaseSync | null = null;
    // Patch the live underlying node:fs export (not the frozen import-star
    // view): projection.js reads the same live binding via its getter.
    const rawFs = createRequire(__filename)("node:fs") as typeof fs;
    const origRename = rawFs.renameSync;
    try {
      const { config, configPath } = makeConfig(dir);
      ({ db } = initDb(config, configPath));
      if (db === null) throw new Error("db init failed");
      const id = seedRecord(db, config, "r07 rename guard memo", "rename-1");
      assert.equal(drainProjection(db, config, configPath).failed, 0);
      const finalPath = path.join(config.vaultPath, id + ".md");
      assert.ok(fs.statSync(finalPath).isFile(), "prior final must be a regular file");
      const oldBytes = fs.readFileSync(finalPath, "utf8");
      assert.ok(oldBytes.includes("r07 rename guard memo"));
      // Real status change on the SAME destination: archiving re-enqueues id.
      const arc = archiveRecord(
        db,
        config,
        { id, scope: SCOPE, reasonCode: "USER_ARCHIVED" },
        "r07-rename-arc-1",
      );
      assert.equal(arc.ok, true, JSON.stringify(arc));
      assert.ok(queueRows(db).includes(id));
      const tmpPath = path.join(config.vaultPath, `.${id}.${process.pid}.tmp`);
      try {
        fs.rmSync(tmpPath, { force: true });
      } catch {
        /* ignore */
      }
      // Scoped primitive fault: tmp write proceeds, only the exact-dest
      // rename throws. Platform-independent (no dir-vs-file OS semantics).
      rawFs.renameSync = ((tmp: fs.PathLike, dest: fs.PathLike): void => {
        if (String(dest) === finalPath) {
          assert.ok(fs.existsSync(tmp as string), "tmp must exist before rename-stage fault");
          throw new Error("injected rename-stage fault at exact dest");
        }
        (origRename as (a: fs.PathLike, b: fs.PathLike) => void)(tmp, dest);
      }) as typeof rawFs.renameSync;
      const out = drainProjection(db, config, configPath);
      assert.ok(out.failed >= 1, JSON.stringify(out));
      assert.ok(queueRows(db).includes(id));
      // SAME regular file preserved byte-for-byte; no partial overwrite.
      assert.ok(fs.statSync(finalPath).isFile());
      assert.equal(fs.readFileSync(finalPath, "utf8"), oldBytes);
      assert.ok(fs.existsSync(tmpPath), "tmp write must have happened before fault");
      rawFs.renameSync = origRename;
      // Force the retained row due and retry with the real primitive.
      forceDue(db, id);
      const done = drainProjection(db, config, configPath);
      assert.equal(done.failed, 0, JSON.stringify(done));
      assert.deepEqual(queueRows(db), []);
      // New canonical render (archived status) replaced the preserved bytes.
      assert.ok(fs.statSync(finalPath).isFile());
      assert.equal(fs.readFileSync(finalPath, "utf8"), expectedMarkdown(db, id));
      assert.ok(fs.readFileSync(finalPath, "utf8").includes("r07 rename guard memo"));
      assert.ok(fs.readFileSync(finalPath, "utf8").includes("archived"));
      assert.notEqual(fs.readFileSync(finalPath, "utf8"), oldBytes);
      projectOneRecord(db, config.vaultPath, "rec_does_not_exist_r07");
    } finally {
      try {
        rawFs.renameSync = origRename;
      } catch {
        /* ignore */
      }
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("R07 rebuild restores full canonical content with populated ledgers invariant", () => {
  it("recall+feedback ledgers survive derived delete/corrupt+rebuild; exposure stays valid without double heat", () => {
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
      // Populate exposures/usage/heat with real recall+feedback BEFORE the snapshot.
      const rec = recallRecords(db, config, { query: "r07 rebuild", scope: SCOPE, limit: 10 });
      assert.equal(rec.ok, true, JSON.stringify(rec));
      const recallId = (rec.data as { recallId: string }).recallId;
      const exposed = ((rec.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      assert.ok(exposed.includes(a) && exposed.includes(b), "recall must expose a+b: " + JSON.stringify(exposed));
      const fb = feedbackRecords(db, config, { recallId, recordIds: [a, b], scope: SCOPE }, "r07-rebuild-fb-1");
      assert.equal(fb.ok, true, JSON.stringify(fb));
      assert.equal((fb.data as { feedback: { counted: number } }).feedback.counted, 2);
      assert.equal(heatOf(db, a), 1);
      assert.equal(heatOf(db, b), 1);
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
          exposures: dump("SELECT ts, recallId, runId, scope, recordId, snippetBytes, truncated, limitN FROM exposures ORDER BY recallId ASC, recordId ASC"),
          usage: dump("SELECT ts, recallId, recordId, scope, runId FROM usage ORDER BY recallId ASC, recordId ASC"),
          note_heat: dump("SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId ASC"),
          scopes: dump("SELECT scope FROM scopes ORDER BY scope ASC"),
        };
      };
      const before = dumpCanonical();
      assert.ok((before["exposures"] as unknown[]).length >= 2, "exposures must be populated");
      assert.ok((before["usage"] as unknown[]).length === 2, "usage must have 2 rows");
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
      // Full canonical row contents (not counts) are invariant, including the
      // populated 8-column exposures, usage, and heat. Derived
      // projection_queue/fts/char-bigram state is excluded from comparison.
      assert.deepEqual(dumpCanonical(), before);
      for (const [rid, md] of expected) {
        assert.equal(fs.readFileSync(path.join(config.vaultPath, rid + ".md"), "utf8"), md);
      }
      assert.ok(fs.readFileSync(path.join(config.vaultPath, b + ".md"), "utf8").includes("[[" + a + "]]"));
      assert.ok(fs.readFileSync(path.join(config.vaultPath, a + ".md"), "utf8").includes("[[" + b + "]]"));
      // Existing exposure is still valid but does not double-heat the same recall.
      const heatA = heatOf(theDb, a);
      const heatB = heatOf(theDb, b);
      const usageN = (theDb.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n;
      const fb2 = feedbackRecords(theDb, config, { recallId, recordIds: [a, b], scope: SCOPE }, "r07-rebuild-fb-2");
      assert.equal(fb2.ok, true, JSON.stringify(fb2));
      assert.equal(heatOf(theDb, a), heatA);
      assert.equal(heatOf(theDb, b), heatB);
      assert.equal((theDb.prepare("SELECT COUNT(*) AS n FROM usage").get() as { n: number }).n, usageN);
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
