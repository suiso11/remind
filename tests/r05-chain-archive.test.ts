/**
 * R05: supersede chain A→B→C (multi-hop corrections) and record.archive
 * with an unknown reasonCode. Supplements tests/m1-recall.test.ts, which
 * covers single-step corrections (A→B) and terminal archives.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { ARCHIVE_REASONS } from "../src/store.js";
import { initDb } from "../src/db.js";
import {
  archiveRecord,
  correctRecord,
  eventAppend,
  getRecord,
  listRecords,
  recallRecords,
  rememberRecord,
} from "../src/store.js";

const OBS = "2026-09-01T00:00:00.000Z";
let evCounter = 0;

function setup(extraScopes: string[] = []): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r05-chain-"));
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: ["personal/default", ...extraScopes],
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
  const configPath = path.join(dir, "memory.config.json");
  const { db } = initDb(config, configPath);
  return {
    dir,
    config,
    configPath,
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function raw(db: DatabaseSync, config: AppConfig, eventId: string, scope = "personal/default"): void {
  const r = eventAppend(
    db,
    config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: `raw context ${eventId} padding words`,
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope,
    },
    `evk-${eventId}-${evCounter++}`,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
}

function remember(db: DatabaseSync, config: AppConfig, body: string, key: string): string {
  const refs = [`auto-${key}`];
  for (const e of refs) {
    const exists = db.prepare(`SELECT eventId FROM raw_events WHERE eventId=?`).get(e) as
      | { eventId: string }
      | undefined;
    if (!exists) raw(db, config, e);
  }
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope: "personal/default",
      sourceRefs: [`auto-${key}`],
    },
    key,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function correct(
  db: DatabaseSync,
  config: AppConfig,
  recordId: string,
  body: string,
  key: string,
): ReturnType<typeof correctRecord> {
  return correctRecord(
    db,
    config,
    {
      recordId,
      body,
      kind: "correction",
      provenance: { source: "session:s1:turn:9", observedAt: OBS },
      scope: "personal/default",
    },
    key,
  );
}

function idsOf(res: { ok?: boolean; data?: unknown }): string[] {
  assert.equal(res.ok, true);
  return ((res.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
}

function statusOf(db: DatabaseSync, config: AppConfig, id: string): string {
  const view = getRecord(db, config, { id, scope: "personal/default" });
  assert.equal(view.ok, true, `get(${id}) failed`);
  return (view.data as { record: { status: string } }).record.status;
}

describe("r05 supersede chain A→B→C", () => {
  it("excludes A and B from recall/list, marks both superseded, chain traversable C→B→A, re-correction of A/B rejected", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "quokka habitat dusk patrol log", "r05-a");
      const b1 = correct(ctx.db, ctx.config, a, "quokka habitat dusk patrol log revised once", "r05-c1");
      assert.equal(b1.ok, true, JSON.stringify(b1));
      const b = (b1.data as { record: { id: string } }).record.id;
      const c1 = correct(ctx.db, ctx.config, b, "quokka habitat dusk patrol log revised twice", "r05-c2");
      assert.equal(c1.ok, true, JSON.stringify(c1));
      const c = (c1.data as { record: { id: string } }).record.id;
      assert.notEqual(a, b);
      assert.notEqual(b, c);

      // Statuses: A and B superseded, C active.
      assert.equal(statusOf(ctx.db, ctx.config, a), "superseded");
      assert.equal(statusOf(ctx.db, ctx.config, b), "superseded");
      assert.equal(statusOf(ctx.db, ctx.config, c), "active");

      // List excludes A and B, includes C.
      const list = listRecords(ctx.db, ctx.config, { scope: "personal/default" });
      const listIds = idsOf(list);
      assert.ok(!listIds.includes(a), "A must be excluded from list");
      assert.ok(!listIds.includes(b), "B must be excluded from list");
      assert.ok(listIds.includes(c), "C must be listed");

      // Recall excludes A and B, includes C.
      const rec = recallRecords(ctx.db, ctx.config, { query: "quokka habitat", scope: "personal/default" });
      const recIds = idsOf(rec);
      assert.ok(!recIds.includes(a), "A must be excluded from recall");
      assert.ok(!recIds.includes(b), "B must be excluded from recall");
      assert.ok(recIds.includes(c), "C must be recalled");

      // Chain traversable C→B→A via supersedes.
      const rows = ctx.db
        .prepare(`SELECT id, id AS self, supersedes, status FROM records`)
        .all() as Array<{ id: string; supersedes: string | null }>;
      const byId = new Map(rows.map((r) => [r.id, r]));
      assert.equal(byId.get(c)?.supersedes, b);
      assert.equal(byId.get(b)?.supersedes, a);
      let cursor: string | undefined = c;
      const walked: string[] = [];
      while (cursor) {
        walked.push(cursor);
        cursor = byId.get(cursor)?.supersedes ?? undefined;
      }
      assert.deepEqual(walked, [c, b, a]);

      // Re-correcting A or B is rejected.
      const redoA = correct(ctx.db, ctx.config, a, "quokka habitat dusk patrol log redo a", "r05-re-a");
      assert.equal(redoA.ok, false);
      assert.equal(redoA.code, "CONFLICT");
      const redoB = correct(ctx.db, ctx.config, b, "quokka habitat dusk patrol log redo b", "r05-re-b");
      assert.equal(redoB.ok, false);
      assert.equal(redoB.code, "CONFLICT");
      // C remains active and no rogue revision was written.
      assert.equal(statusOf(ctx.db, ctx.config, c), "active");
      const rowsAll = ctx.db.prepare(`SELECT id FROM records`).all() as Array<{ id: string }>;
      assert.equal(rowsAll.length, 3, "only the three chain rows exist");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("r05 record.archive unknown reasonCode", () => {
  it("unknown reasonCode → BAD_REQUEST, record stays active with no archive rows written; valid code archives and hides from recall/list", () => {
    const ctx = setup();
    try {
      assert.ok(!(ARCHIVE_REASONS as readonly string[]).includes("BOGUS"));
      const id = remember(ctx.db, ctx.config, "akoya pearl preference note", "r05-arc-a");
      const bad = archiveRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "BOGUS" },
        "r05-arc-bad-1",
      );
      assert.equal(bad.ok, false);
      assert.equal(bad.code, "BAD_REQUEST");

      // Record unchanged and still active/visible.
      assert.equal(statusOf(ctx.db, ctx.config, id), "active");
      const listed = idsOf(listRecords(ctx.db, ctx.config, { scope: "personal/default" }));
      assert.ok(listed.includes(id), "record still listed after rejected archive");
      const recIds = idsOf(recallRecords(ctx.db, ctx.config, { query: "akoya pearl", scope: "personal/default" }));
      assert.ok(recIds.includes(id), "record still recalled after rejected archive");

      // No archive-related rows were persisted.
      const opRow = ctx.db.prepare(`SELECT COUNT(*) AS n FROM operations WHERE op='record.archive'`).get() as
        | { n: number }
        | undefined;
      assert.notEqual(opRow, undefined);
      assert.equal(opRow?.n, 0, "no archive operation rows");
      const audit = ctx.db.prepare(
        `SELECT COUNT(*) AS n FROM audit WHERE op='record.archive' AND code='OK'`,
      ).get() as { n: number };
      assert.equal(audit.n, 0, "no successful archive audit entries");

      // A valid reasonCode archives terminally.
      const good = archiveRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "OBSOLETE" },
        "r05-arc-good-1",
      );
      assert.equal(good.ok, true, JSON.stringify(good));
      assert.equal((good.data as { record: { status: string } }).record.status, "archived");
      assert.equal(statusOf(ctx.db, ctx.config, id), "archived");

      const afterList = idsOf(listRecords(ctx.db, ctx.config, { scope: "personal/default" }));
      assert.ok(!afterList.includes(id), "archived record excluded from list");
      const afterRec = idsOf(recallRecords(ctx.db, ctx.config, { query: "akoya pearl", scope: "personal/default" }));
      assert.ok(!afterRec.includes(id), "archived record excluded from recall");

      // get still returns the archived row.
      const view = getRecord(ctx.db, ctx.config, { id, scope: "personal/default" });
      assert.equal(view.ok, true);
      assert.equal((view.data as { record: { id: string; status: string } }).record.id, id);
      assert.equal((view.data as { record: { status: string } }).record.status, "archived");
    } finally {
      ctx.cleanup();
    }
  });
});
