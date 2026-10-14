/**
 * R06 atomic exposure-cap: strict global 1000-row exposures bound with
 * fail-closed prune rollback.
 *
 * Real temp-only SQLite + real store API only. No mocks/copies. Timestamp
 * override only via the supported store nowOverride param; every exposure
 * row comes from real returned recallIds (multi-item, both scopes, equal
 * timestamps so prune tie-breaks on rowid).
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
  EXPOSURES_CAP,
  eventAppend,
  feedbackRecords,
  recallRecords,
  rememberRecord,
} from "../src/store.js";

const OBS = "2026-09-01T00:00:00.000Z";
const FIXED_TS = "2026-10-01T00:00:00.000Z";
const SCOPE_A = "personal/default";
const SCOPE_B = "work/default";
let ctr = 0;

function makeConfig(dir: string): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE_A, SCOPE_B],
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      linksMax: 10,
      sourceRefsMax: 10,
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 16384,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  return { config, configPath: path.join(dir, "memory.config.json") };
}

function setup(): { dir: string; config: AppConfig; configPath: string; db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r06-cap-"));
  const { config, configPath } = makeConfig(dir);
  const { db } = initDb(config, configPath);
  return {
    dir, config, configPath, db,
    cleanup: () => {
      try { db.setAuthorizer(null); } catch { /* ignore */ }
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function seedOne(db: DatabaseSync, config: AppConfig, body: string, scope: string, key: string): string {
  const ev = `r06-ev-${key}-${ctr++}`;
  const r = eventAppend(db, config, {
    eventId: ev, sessionId: "s1", turnId: "t1",
    body: `raw context ${ev} capbeacon seed`,
    provenance: { source: "session:s1:turn:3", observedAt: OBS },
    scope,
  }, `r06-evk-${ev}`);
  assert.equal(r.ok, true, JSON.stringify(r));
  const res = rememberRecord(db, config, {
    body, kind: "user_fact",
    provenance: { source: "session:s1:turn:3", observedAt: OBS },
    scope, sourceRefs: [ev],
  }, `r06-rem-${key}-${ctr++}`);
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function seedScopes(db: DatabaseSync, config: AppConfig): { a: string[]; b: string[] } {
  const a: string[] = [];
  const b: string[] = [];
  for (let i = 0; i < 25; i++) {
    a.push(seedOne(db, config, `capbeacon shared memo alpha orchard ${i} harbor lantern`, SCOPE_A, `a${i}`));
    b.push(seedOne(db, config, `capbeacon shared memo beta orchard ${i} harbor lantern`, SCOPE_B, `b${i}`));
  }
  return { a, b };
}

function doRecall(db: DatabaseSync, config: AppConfig, scope: string, limit: number, ts: string): { recallId: string; items: Array<{ id: string }> } {
  const res = recallRecords(db, config, { query: "capbeacon shared memo orchard", scope, limit }, ts);
  assert.equal(res.ok, true, JSON.stringify(res));
  const data = res.data as { recallId: string; items: Array<{ id: string }> };
  assert.equal(typeof data.recallId, "string");
  assert.equal(data.items.length, limit, `expected ${limit} items: ${JSON.stringify(data.items.map((i) => i.id))}`);
  return { recallId: data.recallId, items: data.items };
}

function exposureCount(db: DatabaseSync): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM exposures`).get() as { n: number }).n;
}

function scopeCount(db: DatabaseSync, scope: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM exposures WHERE scope = ?`).get(scope) as { n: number }).n;
}

type ExpRow = { ts: string; recallId: string; runId: string | null; scope: string | null; recordId: string; snippetBytes: number | null; truncated: number | null; limitN: number | null; rowid: number };

function dumpExposures(db: DatabaseSync): ExpRow[] {
  return db.prepare(`SELECT ts, recallId, runId, scope, recordId, snippetBytes, truncated, limitN, rowid FROM exposures ORDER BY rowid ASC`).all() as ExpRow[];
}

function exposureRecordIds(db: DatabaseSync, recallId: string): string[] {
  return (db.prepare(`SELECT recordId FROM exposures WHERE recallId = ? ORDER BY recordId ASC`).all(recallId) as Array<{ recordId: string }>).map((r) => r.recordId);
}

function heatOf(db: DatabaseSync, id: string): number {
  const row = db.prepare(`SELECT usedCount FROM note_heat WHERE recordId = ?`).get(id) as { usedCount: number } | undefined;
  return row?.usedCount ?? -1;
}

function dumpRows(db: DatabaseSync, sql: string, ...args: unknown[]): unknown[] {
  return db.prepare(sql).all(...(args as [])) as unknown[];
}

function ledgerSnapshot(db: DatabaseSync): Record<string, unknown> {
  return {
    exposures: dumpRows(db, `SELECT ts, recallId, runId, scope, recordId, snippetBytes, truncated, limitN FROM exposures ORDER BY recallId ASC, recordId ASC`),
    audit: dumpRows(db, `SELECT ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode FROM audit ORDER BY rowid ASC`),
    operations: dumpRows(db, `SELECT idempotencyKey, op, requestHash, responseJson, createdAt FROM operations ORDER BY idempotencyKey ASC`),
    usage: dumpRows(db, `SELECT ts, recallId, recordId, scope, runId FROM usage ORDER BY recallId ASC, recordId ASC`),
    note_heat: dumpRows(db, `SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId ASC`),
  };
}

function canonicalSnapshot(db: DatabaseSync): Record<string, unknown> {
  return {
    raw_events: dumpRows(db, `SELECT eventId, sessionId, turnId, body, bodyNorm, source, observedAt, scope, runId, createdAt FROM raw_events ORDER BY eventId ASC`),
    records: dumpRows(db, `SELECT id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt FROM records ORDER BY id ASC`),
    record_tags: dumpRows(db, `SELECT recordId, tag FROM record_tags ORDER BY recordId ASC, tag ASC`),
    record_links: dumpRows(db, `SELECT fromId, toRef FROM record_links ORDER BY fromId ASC, toRef ASC`),
    record_source_refs: dumpRows(db, `SELECT recordId, eventId FROM record_source_refs ORDER BY recordId ASC, eventId ASC`),
    note_heat: dumpRows(db, `SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId ASC`),
  };
}

describe("R06 strict global exposure cap with atomic prune", () => {
  it("real recallIds fill exactly 1000 global rows; overflow evicts oldest with exact tuples; feedback matrix holds", () => {
    const ctx = setup();
    try {
      assert.equal(EXPOSURES_CAP, 1000);
      seedScopes(ctx.db, ctx.config);
      // Fill: 40 real recalls x 25 items = 1000 rows, alternating scopes,
      // all with the identical ts so prune tie-breaks purely on rowid.
      const recallIds: string[] = [];
      const recallScope: string[] = [];
      for (let i = 0; i < 40; i++) {
        const scope = i % 2 === 0 ? SCOPE_A : SCOPE_B;
        const { recallId } = doRecall(ctx.db, ctx.config, scope, 25, FIXED_TS);
        recallIds.push(recallId);
        recallScope.push(scope);
        assert.equal(exposureCount(ctx.db), (i + 1) * 25);
      }
      assert.equal(exposureCount(ctx.db), 1000);
      // Global cap: both scopes share the single 1000-row budget.
      assert.equal(scopeCount(ctx.db, SCOPE_A), 500);
      assert.equal(scopeCount(ctx.db, SCOPE_B), 500);
      const before = dumpExposures(ctx.db);
      assert.equal(before.length, 1000);
      for (const r of before) assert.equal(r.ts, FIXED_TS);
      // Every real recallId owns exactly 25 rows (multi-item proof).
      for (const rid of recallIds) {
        assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM exposures WHERE recallId = ?`).get(rid) as { n: number }).n, 25);
      }

      // Saved feedback BEFORE eviction: will be replayable after its
      // exposures are pruned.
      const oldest = recallIds[0] as string;
      const oldestScope = recallScope[0] as string;
      const oldestIds = exposureRecordIds(ctx.db, oldest);
      assert.equal(oldestIds.length, 25);
      const savedTarget = oldestIds[0] as string;
      const heat0 = heatOf(ctx.db, savedTarget);
      const saved = feedbackRecords(ctx.db, ctx.config, { recallId: oldest, recordIds: [savedTarget], scope: oldestScope }, "r06-saved-key-1");
      assert.equal(saved.ok, true, JSON.stringify(saved));
      assert.equal(heatOf(ctx.db, savedTarget), heat0 + 1);
      const usageN1 = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM usage WHERE recallId = ? AND recordId = ?`).get(oldest, savedTarget) as { n: number }).n;
      assert.equal(usageN1, 1);

      // Overflow A: +25 rows with the same ts; oldest 25 (entire oldest
      // recall) must be evicted, cap stays exactly 1000.
      const beforeA = dumpExposures(ctx.db);
      const { recallId: newA } = doRecall(ctx.db, ctx.config, SCOPE_A, 25, FIXED_TS);
      assert.equal(exposureCount(ctx.db), 1000);
      const afterA = dumpExposures(ctx.db);
      assert.equal(afterA.length, 1000);
      const newARows = afterA.filter((r) => r.recallId === newA);
      assert.equal(newARows.length, 25);
      assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM exposures WHERE recallId = ?`).get(oldest) as { n: number }).n, 0);
      // Precise retained tuples: prior rows minus oldest 25, plus the 25 new ones.
      const evictedKeys = new Set(beforeA.slice(0, 25).map((r) => `${r.recallId}|${r.recordId}`));
      for (const k of evictedKeys) {
        assert.equal(afterA.some((r) => `${r.recallId}|${r.recordId}` === k), false, k);
      }
      const strip = (r: ExpRow): unknown[] => [r.ts, r.recallId, r.runId, r.scope, r.recordId, r.snippetBytes, r.truncated, r.limitN];
      assert.deepEqual(afterA.slice(0, 975).map(strip), beforeA.slice(25).map(strip));
      assert.deepEqual(afterA.slice(975).map((r) => r.recallId), Array(25).fill(newA));

      // Fully-evicted fresh feedback fails closed with ledgers unchanged.
      {
        const snap = ledgerSnapshot(ctx.db);
        const fresh = feedbackRecords(ctx.db, ctx.config, { recallId: oldest, recordIds: [savedTarget], scope: oldestScope }, "r06-fresh-after-evict-1");
        assert.equal(fresh.ok, false, JSON.stringify(fresh));
        assert.equal(fresh.code, "NOT_FOUND", JSON.stringify(fresh));
        assert.deepEqual(ledgerSnapshot(ctx.db), snap);
        assert.deepEqual(dumpExposures(ctx.db).map(strip), afterA.map(strip));
      }
      // Saved key+params still deduplicates after eviction: same success,
      // no new heat/usage/audit/operations/exposures.
      {
        const snap = ledgerSnapshot(ctx.db);
        const heatBefore = heatOf(ctx.db, savedTarget);
        const replay = feedbackRecords(ctx.db, ctx.config, { recallId: oldest, recordIds: [savedTarget], scope: oldestScope }, "r06-saved-key-1");
        assert.equal(replay.ok, true, JSON.stringify(replay));
        assert.equal(replay.deduplicated, true);
        assert.deepEqual((replay.data as { feedback: { counted: number } }).feedback, (saved.data as { feedback: { counted: number } }).feedback);
        assert.equal(heatOf(ctx.db, savedTarget), heatBefore);
        assert.deepEqual(ledgerSnapshot(ctx.db), snap);
      }

      // Overflow B: +1 row; second-oldest recall becomes partly evicted.
      const second = recallIds[1] as string;
      const secondScope = recallScope[1] as string;
      const secondBefore = exposureRecordIds(ctx.db, second);
      assert.equal(secondBefore.length, 25);
      const { recallId: newB } = doRecall(ctx.db, ctx.config, SCOPE_B, 1, FIXED_TS);
      assert.equal(exposureCount(ctx.db), 1000);
      const secondAfter = exposureRecordIds(ctx.db, second);
      assert.equal(secondAfter.length, 24);
      const evictedOne = secondBefore.find((id) => !secondAfter.includes(id)) as string;
      const retainedOne = secondAfter[0] as string;
      assert.ok(evictedOne && retainedOne && evictedOne !== retainedOne);
      // Fresh feedback on the evicted id alone -> NOT_FOUND, ledgers unchanged.
      {
        const snap = ledgerSnapshot(ctx.db);
        const r = feedbackRecords(ctx.db, ctx.config, { recallId: second, recordIds: [evictedOne], scope: secondScope }, "r06-fresh-part-1");
        assert.equal(r.code, "NOT_FOUND", JSON.stringify(r));
        assert.deepEqual(ledgerSnapshot(ctx.db), snap);
      }
      // Mixed retained+evicted -> NOT_FOUND, ledgers unchanged.
      {
        const snap = ledgerSnapshot(ctx.db);
        const r = feedbackRecords(ctx.db, ctx.config, { recallId: second, recordIds: [retainedOne, evictedOne].sort(), scope: secondScope }, "r06-fresh-part-2");
        assert.equal(r.code, "NOT_FOUND", JSON.stringify(r));
        assert.deepEqual(ledgerSnapshot(ctx.db), snap);
      }
      // Valid retained feedback heats exactly once; a different key never heats twice.
      {
        const newBIds = exposureRecordIds(ctx.db, newB);
        assert.equal(newBIds.length, 1);
        const target = newBIds[0] as string;
        const h0 = heatOf(ctx.db, target);
        const first = feedbackRecords(ctx.db, ctx.config, { recallId: newB, recordIds: [target], scope: SCOPE_B }, "r06-retain-k1");
        assert.equal(first.ok, true, JSON.stringify(first));
        assert.equal(heatOf(ctx.db, target), h0 + 1);
        assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM usage WHERE recallId = ? AND recordId = ?`).get(newB, target) as { n: number }).n, 1);
        const secondFb = feedbackRecords(ctx.db, ctx.config, { recallId: newB, recordIds: [target], scope: SCOPE_B }, "r06-retain-k2");
        assert.equal(secondFb.ok, true, JSON.stringify(secondFb));
        assert.equal(heatOf(ctx.db, target), h0 + 1);
        assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM usage WHERE recallId = ? AND recordId = ?`).get(newB, target) as { n: number }).n, 1);
        // Same-key replay stays deduplicated with no extra heat.
        const replay = feedbackRecords(ctx.db, ctx.config, { recallId: newB, recordIds: [target], scope: SCOPE_B }, "r06-retain-k1");
        assert.equal(replay.ok, true);
        assert.equal(replay.deduplicated, true);
        assert.equal(heatOf(ctx.db, target), h0 + 1);
      }
    } finally { ctx.cleanup(); }
  });

  it("exposures DELETE denial at full cap fails closed with full rollback; retry restores cap with no heat", () => {
    const ctx = setup();
    try {
      seedScopes(ctx.db, ctx.config);
      for (let i = 0; i < 40; i++) {
        const scope = i % 2 === 0 ? SCOPE_A : SCOPE_B;
        doRecall(ctx.db, ctx.config, scope, 25, FIXED_TS);
      }
      assert.equal(exposureCount(ctx.db), 1000);
      const heatProbe = exposureRecordIds(ctx.db, dumpExposures(ctx.db)[999]?.recallId as string)[0] as string;
      const heatBefore = heatOf(ctx.db, heatProbe);
      const fullSnap: Record<string, unknown> = {
        ...ledgerSnapshot(ctx.db),
        canonical: canonicalSnapshot(ctx.db),
        exposuresCount: exposureCount(ctx.db),
      };
      // Real authorizer denial of the prune DELETE only.
      ctx.db.setAuthorizer((action: number, name: unknown) =>
        action === constants.SQLITE_DELETE && name === "exposures" ? constants.SQLITE_DENY : constants.SQLITE_OK,
      );
      let failed: ReturnType<typeof recallRecords>;
      try {
        failed = recallRecords(ctx.db, ctx.config, { query: "capbeacon shared memo orchard", scope: SCOPE_A, limit: 5 }, FIXED_TS);
      } finally {
        ctx.db.setAuthorizer(null);
      }
      assert.equal(failed.ok, false, JSON.stringify(failed));
      assert.equal(failed.code, "STORE_UNAVAILABLE", JSON.stringify(failed));
      // Complete table-row state unchanged: exposures/audit/operations/usage/heat + canonical.
      assert.equal(exposureCount(ctx.db), 1000);
      assert.deepEqual(ledgerSnapshot(ctx.db), { exposures: fullSnap["exposures"], audit: fullSnap["audit"], operations: fullSnap["operations"], usage: fullSnap["usage"], note_heat: fullSnap["note_heat"] });
      assert.deepEqual(canonicalSnapshot(ctx.db), fullSnap["canonical"]);
      assert.equal(heatOf(ctx.db, heatProbe), heatBefore);
      // Transaction is closed: a new write transaction starts cleanly.
      ctx.db.exec("BEGIN IMMEDIATE; ROLLBACK;");
      // Retry after clearing the fault commits with the cap intact and no heat:
      // the retry returns SCOPE_A rows, so compare the COMPLETE note_heat
      // table (ids, counters, and timestamps) before vs after the retry.
      const heatSnapBefore = dumpRows(ctx.db, `SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId ASC`);
      const retry = recallRecords(ctx.db, ctx.config, { query: "capbeacon shared memo orchard", scope: SCOPE_A, limit: 5 }, FIXED_TS);
      assert.equal(retry.ok, true, JSON.stringify(retry));
      assert.equal(exposureCount(ctx.db), 1000);
      assert.deepEqual(
        dumpRows(ctx.db, `SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId ASC`),
        heatSnapBefore,
      );
      const items = (retry.data as { items: Array<{ id: string }> }).items;
      assert.equal(items.length, 5);
      for (const it of items) {
        assert.ok(
          (heatSnapBefore as Array<{ recordId: string }>).some((r) => r.recordId === it.id),
          `retry item missing from pre-retry heat snapshot: ${it.id}`,
        );
      }
    } finally { ctx.cleanup(); }
  });
});
