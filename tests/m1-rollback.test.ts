/**
 * M1 rollback matrix: persistence failures on audit/operations tables roll back
 * every write op atomically (no success, no partial canonical rows).
 *
 * Real temp-only SQLite authorizer (SQLITE_DENY on INSERT into audit or
 * operations). Temp DB/vault only, removed on cleanup. Does not duplicate
 * event/remember idempotency semantics or the shared-file correction race.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { constants, DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  archiveRecord,
  correctRecord,
  eventAppend,
  feedbackRecords,
  recallRecords,
  rememberRecord,
} from "../src/store.js";

const OBS = "2026-09-01T00:00:00.000Z";
let ctr = 0;

function baseConfig(dir: string): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: ["personal/default"],
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

function setup(): { dir: string; config: AppConfig; db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-rollback-"));
  const { config, configPath } = baseConfig(dir);
  const { db } = initDb(config, configPath);
  return {
    dir, config, db,
    cleanup: () => {
      try { db.setAuthorizer(null); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function raw(db: DatabaseSync, config: AppConfig, eventId: string): void {
  const r = eventAppend(db, config, {
    eventId, sessionId: "s1", turnId: "t1",
    body: `raw context ${eventId} rollback probe`,
    provenance: { source: "session:s1:turn:3", observedAt: OBS },
    scope: "personal/default",
  }, `rb-seed-ev-${eventId}-${ctr++}`);
  assert.equal(r.ok, true, JSON.stringify(r));
}

function remember(db: DatabaseSync, config: AppConfig, body: string, key: string, extra: Record<string, unknown> = {}): string {
  const ref = `rb-auto-${key}`;
  const exists = db.prepare(`SELECT eventId FROM raw_events WHERE eventId=?`).get(ref) as unknown;
  if (!exists) raw(db, config, ref);
  const res = rememberRecord(db, config, {
    body, kind: "user_fact",
    provenance: { source: "session:s1:turn:3", observedAt: OBS },
    scope: "personal/default", tags: ["rb"], links: [], sourceRefs: [ref], ...extra,
  }, key);
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function snapshot(db: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of ["raw_events","records","record_tags","record_links","record_source_refs","operations","audit","usage","note_heat","projection_queue"]) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
  }
  return out;
}

function denyInserts(db: DatabaseSync, table: string): void {
  db.setAuthorizer((action: number, name: unknown) =>
    action === constants.SQLITE_INSERT && name === table ? constants.SQLITE_DENY : constants.SQLITE_OK,
  );
}

function clearDeny(db: DatabaseSync): void {
  db.setAuthorizer(null);
}

function opRow(db: DatabaseSync, key: string): unknown {
  return db.prepare(`SELECT idempotencyKey FROM operations WHERE idempotencyKey=?`).get(key) as unknown;
}

function heatOf(db: DatabaseSync, id: string): number {
  const row = db.prepare(`SELECT usedCount FROM note_heat WHERE recordId=?`).get(id) as { usedCount: number } | undefined;
  return row?.usedCount ?? -1;
}

function statusOf(db: DatabaseSync, id: string): string {
  return (db.prepare(`SELECT status FROM records WHERE id=?`).get(id) as { status: string }).status;
}

describe("rollback matrix: audit/operations persistence failure", () => {
  it("event.append rolls back on audit or operations INSERT denial", () => {
    const ctx = setup();
    try {
      for (const table of ["audit", "operations"]) {
        const key = `rb-ev-${table}-${ctr++}`;
        const eid = `rb-e-${table}-${ctr++}`;
        const before = snapshot(ctx.db);
        denyInserts(ctx.db, table);
        let res;
        try {
          res = eventAppend(ctx.db, ctx.config, {
            eventId: eid, sessionId: "s1", turnId: "t1",
            body: "rollback probe raw body", provenance: { source: "session:s1:turn:3", observedAt: OBS },
            scope: "personal/default",
          }, key);
        } finally { clearDeny(ctx.db); }
        assert.equal(res.ok, false, JSON.stringify(res));
        assert.equal(res.code, "STORE_UNAVAILABLE", JSON.stringify(res));
        assert.deepEqual(snapshot(ctx.db), before);
        assert.equal(ctx.db.prepare(`SELECT eventId FROM raw_events WHERE eventId=?`).get(eid), undefined);
        assert.equal(opRow(ctx.db, key), undefined);
        // Retry after clearing the fault commits exactly once.
        const retry = eventAppend(ctx.db, ctx.config, {
          eventId: eid, sessionId: "s1", turnId: "t1",
          body: "rollback probe raw body", provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: "personal/default",
        }, key);
        assert.equal(retry.ok, true, JSON.stringify(retry));
        assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE eventId=?`).get(eid) as { n: number }).n, 1);
        const replay = eventAppend(ctx.db, ctx.config, {
          eventId: eid, sessionId: "s1", turnId: "t1",
          body: "rollback probe raw body", provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: "personal/default",
        }, key);
        assert.equal(replay.ok, true);
        assert.equal(replay.deduplicated, true);
        assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE eventId=?`).get(eid) as { n: number }).n, 1);
      }
    } finally { ctx.cleanup(); }
  });

  it("record.remember rolls back canonical/links/refs/heat on audit or operations denial", () => {
    const ctx = setup();
    try {
      for (const table of ["audit", "operations"]) {
        const key = `rb-rem-${table}-${ctr++}`;
        const ref = `rb-ref-${table}-${ctr++}`;
        raw(ctx.db, ctx.config, ref);
        const before = snapshot(ctx.db);
        denyInserts(ctx.db, table);
        let res;
        try {
          res = rememberRecord(ctx.db, ctx.config, {
            body: `rollback remember probe ${table}`, kind: "user_fact",
            provenance: { source: "session:s1:turn:3", observedAt: OBS },
            scope: "personal/default", tags: ["rb"], links: ["dangling-ref"], sourceRefs: [ref],
          }, key);
        } finally { clearDeny(ctx.db); }
        assert.equal(res.ok, false, JSON.stringify(res));
        assert.equal(res.code, "STORE_UNAVAILABLE", JSON.stringify(res));
        assert.deepEqual(snapshot(ctx.db), before);
        assert.equal(opRow(ctx.db, key), undefined);
        // Retry proves exactly one canonical write.
        const ref2 = `rb-ref-retry-${table}-${ctr++}`;
        raw(ctx.db, ctx.config, ref2);
        const retry = rememberRecord(ctx.db, ctx.config, {
          body: `rollback remember probe ${table} retry`, kind: "user_fact",
          provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: "personal/default", tags: ["rb"], links: [], sourceRefs: [ref2],
        }, key);
        assert.equal(retry.ok, true, JSON.stringify(retry));
        const id = (retry.data as { record: { id: string } }).record.id;
        assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE id=?`).get(id) as { n: number }).n, 1);
        assert.equal(heatOf(ctx.db, id), 0);
      }
    } finally { ctx.cleanup(); }
  });

  it("record.feedback rolls back usage/heat on audit or operations denial", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "rollback feedback target persimmon", "rb-fb-seed");
      const rec = recallRecords(ctx.db, ctx.config, { query: "persimmon", scope: "personal/default", limit: 10 });
      assert.equal(rec.ok, true, JSON.stringify(rec));
      const recallId = (rec.data as { recallId: string }).recallId;
      const heatBefore = heatOf(ctx.db, id);
      for (const table of ["audit", "operations"]) {
        const key = `rb-fb-${table}-${ctr++}`;
        const before = snapshot(ctx.db);
        denyInserts(ctx.db, table);
        let res;
        try {
          res = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "personal/default" }, key);
        } finally { clearDeny(ctx.db); }
        assert.equal(res.ok, false, JSON.stringify(res));
        assert.equal(res.code, "STORE_UNAVAILABLE", JSON.stringify(res));
        assert.deepEqual(snapshot(ctx.db), before);
        assert.equal(heatOf(ctx.db, id), heatBefore);
        assert.equal(opRow(ctx.db, key), undefined);
      }
      // Retry proves one counted write with heat +1 only.
      const retry = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "personal/default" }, "rb-fb-retry");
      assert.equal(retry.ok, true, JSON.stringify(retry));
      assert.equal(heatOf(ctx.db, id), heatBefore + 1);
      assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM usage WHERE recallId=? AND recordId=?`).get(recallId, id) as { n: number }).n, 1);
    } finally { ctx.cleanup(); }
  });

  it("record.correct rolls back revision/status/links/refs on audit or operations denial", () => {
    const ctx = setup();
    try {
      const orig = remember(ctx.db, ctx.config, "rollback correct original noon", "rb-corr-seed");
      for (const table of ["audit", "operations"]) {
        const key = `rb-corr-${table}-${ctr++}`;
        const ev = `rb-corr-ev-${table}-${ctr++}`;
        raw(ctx.db, ctx.config, ev);
        const before = snapshot(ctx.db);
        const revBefore = (ctx.db.prepare(`SELECT revision FROM records WHERE id=?`).get(orig) as { revision: number }).revision;
        denyInserts(ctx.db, table);
        let res;
        try {
          res = correctRecord(ctx.db, ctx.config, {
            recordId: orig, body: `rollback correction probe ${table}`, kind: "correction",
            provenance: { source: "session:s1:turn:9", observedAt: OBS },
            scope: "personal/default", links: [], sourceRefs: [ev],
          }, key);
        } finally { clearDeny(ctx.db); }
        assert.equal(res.ok, false, JSON.stringify(res));
        assert.equal(res.code, "STORE_UNAVAILABLE", JSON.stringify(res));
        assert.deepEqual(snapshot(ctx.db), before);
        assert.equal(statusOf(ctx.db, orig), "active");
        assert.equal((ctx.db.prepare(`SELECT revision FROM records WHERE id=?`).get(orig) as { revision: number }).revision, revBefore);
        assert.equal(opRow(ctx.db, key), undefined);
      }
      // Retry proves one new active revision, old superseded.
      const ev = `rb-corr-ev-retry-${ctr++}`;
      raw(ctx.db, ctx.config, ev);
      const done = correctRecord(ctx.db, ctx.config, {
        recordId: orig, body: "rollback correction retry body", kind: "correction",
        provenance: { source: "session:s1:turn:9", observedAt: OBS },
        scope: "personal/default", links: [], sourceRefs: [ev],
      }, "rb-corr-retry");
      assert.equal(done.ok, true, JSON.stringify(done));
      const newId = (done.data as { record: { id: string } }).record.id;
      assert.equal(statusOf(ctx.db, orig), "superseded");
      assert.equal(statusOf(ctx.db, newId), "active");
    } finally { ctx.cleanup(); }
  });

  it("record.archive rolls back terminal status on audit or operations denial", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "rollback archivable fern note", "rb-arc-seed");
      for (const table of ["audit", "operations"]) {
        const key = `rb-arc-${table}-${ctr++}`;
        const before = snapshot(ctx.db);
        denyInserts(ctx.db, table);
        let res;
        try {
          res = archiveRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "USER_ARCHIVED" }, key);
        } finally { clearDeny(ctx.db); }
        assert.equal(res.ok, false, JSON.stringify(res));
        assert.equal(res.code, "STORE_UNAVAILABLE", JSON.stringify(res));
        assert.deepEqual(snapshot(ctx.db), before);
        assert.equal(statusOf(ctx.db, id), "active");
        assert.equal(opRow(ctx.db, key), undefined);
      }
      const done = archiveRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "USER_ARCHIVED" }, "rb-arc-retry");
      assert.equal(done.ok, true, JSON.stringify(done));
      assert.equal(statusOf(ctx.db, id), "archived");
    } finally { ctx.cleanup(); }
  });
});
