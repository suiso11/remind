/**
 * M3 state-core regressions: transition / rollback / isolation / idempotency.
 *
 * Permanent behavior tests only (no model, no builds). Uses temp-only SQLite
 * via initDb; deterministic fixed timestamps; no network.
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
  ensureM1Schema,
  eventAppend,
  feedbackRecords,
  getRecord,
  listRecords,
  reactivateRecord,
  recallRecords,
  rememberRecord,
  retireRecord,
  searchRecords,
} from "../src/store.js";
import {
  acquireCultivationLease,
  applyCultivationBatch,
  cancelCultivationReview,
  completeCultivationReview,
  countOpenCultivationReviews,
  dequeueCultivationBatch,
  encodeCultivationCursor,
  enqueueCultivationReview,
  isCultivationLeaseHeldBy,
  peekCultivationQueue,
  reclaimExpiredCultivationLeases,
  releaseCultivationLease,
} from "../src/cultivation.js";
import {
  buildConfirmPrompt,
  buildMergePrompt,
  buildRetireGatePrompt,
  buildSummaryPrompt,
  parseMergeChoice,
  parseRetireGate,
  parseSummaryBody,
} from "../src/llm.js";
import { maintainDistill, DISTILL_SUMMARY_SOURCE } from "../src/distill.js";

const OBS = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:00:01.000Z";
const T2 = "2026-09-01T00:00:02.000Z";
const T3 = "2026-09-01T00:00:03.000Z";
let ctr = 0;

function baseConfig(dir: string): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: ["personal/default", "work/x"],
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m3-state-"));
  const { config, configPath } = baseConfig(dir);
  const { db } = initDb(config, configPath);
  return {
    dir,
    config,
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

function prov(source = "session:s1:turn:3"): { source: string; observedAt: string } {
  return { source, observedAt: OBS };
}

function raw(db: DatabaseSync, config: AppConfig, eventId: string, scope = "personal/default"): void {
  const r = eventAppend(
    db,
    config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: `raw context ${eventId}`,
      provenance: prov(),
      scope,
    },
    `m3-ev-${eventId}-${ctr++}`,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
}

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  key: string,
  extra: Record<string, unknown> = {},
): string {
  const ref = `m3-auto-${key}`;
  raw(db, config, ref);
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: prov(),
      scope: "personal/default",
      sourceRefs: [ref],
      ...extra,
    },
    key,
    T1,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function heatOf(db: DatabaseSync, id: string): number {
  const row = db.prepare(`SELECT usedCount FROM note_heat WHERE recordId = ?`).get(id) as
    | { usedCount: number }
    | undefined;
  return row?.usedCount ?? 0;
}

describe("m3 retire/reactivate transitions", () => {
  it("active->retired leaves normal recall/list but stays get/list(retired)/search visible", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "orchard persimmon harvest memo", "m3-t1");
      const ret = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "NO_LONGER_USEFUL" },
        "m3-retire-1",
        T2,
      );
      assert.equal(ret.ok, true, JSON.stringify(ret));
      assert.equal((ret.data as { record: { status: string } }).record.status, "retired");

      const rec = recallRecords(ctx.db, ctx.config, { query: "persimmon harvest", scope: "personal/default" });
      assert.equal(rec.ok, true);
      const recIds = ((rec.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      assert.ok(!recIds.includes(id), "retired must leave normal recall");

      const list = listRecords(ctx.db, ctx.config, { scope: "personal/default" });
      const listIds = ((list.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      assert.ok(!listIds.includes(id), "retired must leave default list");

      const listR = listRecords(ctx.db, ctx.config, { scope: "personal/default", status: "retired" });
      assert.equal(listR.ok, true);
      const rIds = ((listR.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      assert.ok(rIds.includes(id), "retired visible via explicit list");

      const get = getRecord(ctx.db, ctx.config, { id, scope: "personal/default" });
      assert.equal(get.ok, true);
      assert.equal((get.data as { record: { status: string } }).record.status, "retired");

      const back = reactivateRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "STILL_USEFUL" },
        "m3-react-1",
        T3,
      );
      assert.equal(back.ok, true, JSON.stringify(back));
      const rec2 = recallRecords(ctx.db, ctx.config, { query: "persimmon harvest", scope: "personal/default" });
      const rec2Ids = ((rec2.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      assert.ok(rec2Ids.includes(id), "reactivated returns to normal recall");
    } finally {
      ctx.cleanup();
    }
  });

  it("terminal/history states are not reversible here; bad reason codes rejected", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "m3 terminal probe note", "m3-t2");
      assert.equal(
        retireRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "BOGUS" }, "m3-bad-1").code,
        "BAD_REQUEST",
      );
      const arc = archiveRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "OBSOLETE" },
        "m3-arc-1",
      );
      assert.equal(arc.ok, true);
      assert.equal(
        retireRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "OUTDATED" }, "m3-arc-ret").code,
        "CONFLICT",
      );
      assert.equal(
        reactivateRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "STILL_USEFUL" }, "m3-arc-re").code,
        "CONFLICT",
      );
      const id2 = remember(ctx.db, ctx.config, "m3 supersede probe", "m3-t2b");
      const corr = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: id2,
          body: "m3 supersede probe revised",
          kind: "correction",
          provenance: prov(),
          scope: "personal/default",
        },
        "m3-corr-1",
      );
      assert.equal(corr.ok, true);
      assert.equal(
        reactivateRecord(ctx.db, ctx.config, { id: id2, scope: "personal/default", reasonCode: "STILL_USEFUL" }, "m3-sup-re").code,
        "CONFLICT",
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 retire/reactivate idempotency", () => {
  it("same key replays deduplicated; re-transition with a fresh key is a no-op OK", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "m3 idempotent retire note", "m3-idem");
      const r1 = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "LOW_SIGNAL" },
        "m3-idem-k1",
        T2,
      );
      assert.equal(r1.ok, true);
      assert.equal(r1.deduplicated, false);
      const r2 = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "LOW_SIGNAL" },
        "m3-idem-k1",
        T2,
      );
      assert.equal(r2.ok, true);
      assert.equal(r2.deduplicated, true);
      const r3 = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "OUTDATED" },
        "m3-idem-k2",
        T3,
      );
      assert.equal(r3.ok, true, "re-retire with a fresh key stays OK (no-op)");
      assert.equal(
        retireRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "OUTDATED" }, "m3-idem-k1").code,
        "CONFLICT",
        "same key with changed params conflicts",
      );
      const a1 = reactivateRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "USER_REQUESTED" },
        "m3-idem-a1",
      );
      assert.equal(a1.ok, true);
      const a2 = reactivateRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "USER_REQUESTED" },
        "m3-idem-a2",
      );
      assert.equal(a2.ok, true, "re-reactivate of an active row is an OK no-op");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 record.search isolation", () => {
  it("returns active+retired, excludes archived/superseded, adds no heat, never reactivates", () => {
    const ctx = setup();
    try {
      const activeId = remember(ctx.db, ctx.config, "searchable lighthouse keeper log", "m3-s1");
      const retiredId = remember(ctx.db, ctx.config, "searchable lighthouse lamp oil note", "m3-s2");
      assert.equal(
        retireRecord(ctx.db, ctx.config, { id: retiredId, scope: "personal/default", reasonCode: "CONSOLIDATED" }, "m3-s-ret").ok,
        true,
      );
      const archId = remember(ctx.db, ctx.config, "searchable lighthouse foghorn note", "m3-s3");
      assert.equal(
        archiveRecord(ctx.db, ctx.config, { id: archId, scope: "personal/default", reasonCode: "DUPLICATE" }, "m3-s-arc").ok,
        true,
      );
      const supOld = remember(ctx.db, ctx.config, "searchable lighthouse tide table", "m3-s4");
      const corrRes = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: supOld,
          body: "searchable lighthouse tide table revised",
          kind: "correction",
          provenance: prov(),
          scope: "personal/default",
        },
        "m3-s-corr",
      );
      assert.equal(corrRes.ok, true, JSON.stringify(corrRes));
      const supNew = (corrRes.data as { record: { id: string } }).record.id;
      const before = heatOf(ctx.db, retiredId);
      const res = searchRecords(ctx.db, ctx.config, { query: "lighthouse", scope: "personal/default", limit: 25 });
      assert.equal(res.ok, true, JSON.stringify(res));
      const items = (res.data as { items: Array<{ id: string; status: string }> }).items;
      const byId = new Map(items.map((i) => [i.id, i.status]));
      assert.equal(byId.get(activeId), "active");
      assert.equal(byId.get(retiredId), "retired");
      assert.ok(!byId.has(archId), "archived excluded from search");
      assert.ok(!byId.has(supOld), "superseded excluded from search");
      // Every search item carries the same revision as record.get for that id.
      for (const it of items as unknown as Array<{ id: string; revision: number }>) {
        const got = getRecord(ctx.db, ctx.config, { id: it.id, scope: "personal/default" });
        assert.equal(got.ok, true);
        const rec = (got.data as { record: { revision: number } }).record;
        assert.equal(it.revision, rec.revision, `revision mismatch for ${it.id}`);
      }
      // Corrected record case: search excludes the superseded original and
      // surfaces the active successor, whose revision is > 1.
      assert.ok(byId.has(supNew), "corrected successor searchable");
      const supNewItem = (items as unknown as Array<{ id: string; revision: number }>).find((i) => i.id === supNew);
      assert.ok(supNewItem && supNewItem.revision > 1, "successor revision > 1");
      assert.equal(heatOf(ctx.db, retiredId), before, "search adds no heat");
      const still = getRecord(ctx.db, ctx.config, { id: retiredId, scope: "personal/default" });
      assert.equal((still.data as { record: { status: string } }).record.status, "retired");
      const searchId = (res.data as { searchId: string }).searchId;
      assert.equal(typeof searchId, "string");
      const fb = feedbackRecords(
        ctx.db,
        ctx.config,
        { recallId: searchId, recordIds: [retiredId], scope: "personal/default" },
        "m3-s-fb",
      );
      assert.equal(fb.code, "NOT_FOUND", "search exposures must not validate feedback");
      assert.equal(heatOf(ctx.db, retiredId), before);
    } finally {
      ctx.cleanup();
    }
  });

  it("scope isolation holds across search/list/retire", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config, "m3-x-raw", "work/x");
      const wres = rememberRecord(
        ctx.db,
        ctx.config,
        {
          body: "isolated lighthouse work note",
          kind: "user_fact",
          provenance: prov(),
          scope: "work/x",
          sourceRefs: ["m3-x-raw"],
        },
        "m3-x-rem",
        T1,
      );
      assert.equal(wres.ok, true);
      const wid = (wres.data as { record: { id: string } }).record.id;
      const s = searchRecords(ctx.db, ctx.config, { query: "lighthouse", scope: "personal/default" });
      assert.equal(s.ok, true);
      const ids = ((s.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      assert.ok(!ids.includes(wid));
      assert.equal(
        retireRecord(ctx.db, ctx.config, { id: wid, scope: "personal/default", reasonCode: "OUTDATED" }, "m3-x-ret").code,
        "FORBIDDEN_SCOPE",
      );
      assert.equal(
        searchRecords(ctx.db, ctx.config, { query: "lighthouse", scope: "nope/missing" }).code,
        "FORBIDDEN_SCOPE",
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 retire rollback", () => {
  it("audit failure rolls back the transition with no partial state", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "m3 rollback probe note", "m3-rb");
      ctx.db.setAuthorizer((action: number, name: unknown) =>
        action === constants.SQLITE_INSERT && name === "audit" ? constants.SQLITE_DENY : constants.SQLITE_OK,
      );
      let res;
      try {
        res = retireRecord(
          ctx.db,
          ctx.config,
          { id, scope: "personal/default", reasonCode: "OUTDATED" },
          "m3-rb-k",
        );
      } finally {
        try {
          ctx.db.setAuthorizer(null);
        } catch {
          /* ignore */
        }
      }
      assert.equal(res.code, "STORE_UNAVAILABLE");
      const view = getRecord(ctx.db, ctx.config, { id, scope: "personal/default" });
      assert.equal((view.data as { record: { status: string } }).record.status, "active");
      const ok2 = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: "personal/default", reasonCode: "OUTDATED" },
        "m3-rb-k2",
      );
      assert.equal(ok2.ok, true, "retry after the failure commits exactly once");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 cultivation queue triggers", () => {
  it("remember/correct/validated-feedback queue; mere recall does not; open dedups", () => {
    const ctx = setup();
    try {
      assert.equal(countOpenCultivationReviews(ctx.db), 0);
      const id = remember(ctx.db, ctx.config, "queued orchard review note", "m3-q1");
      assert.equal(countOpenCultivationReviews(ctx.db), 1);
      const peek1 = peekCultivationQueue(ctx.db, "personal/default", 10);
      assert.equal(peek1.length, 1);
      assert.equal(peek1[0]?.trigger, "remember");
      // Mere recall adds no review.
      const rec = recallRecords(ctx.db, ctx.config, { query: "orchard review", scope: "personal/default" });
      assert.equal(rec.ok, true);
      assert.equal(countOpenCultivationReviews(ctx.db), 1);
      // Correct queues the new revision.
      const corr = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: id,
          body: "queued orchard review note revised",
          kind: "correction",
          provenance: prov(),
          scope: "personal/default",
        },
        "m3-q-corr",
      );
      assert.equal(corr.ok, true);
      assert.equal(countOpenCultivationReviews(ctx.db), 2);
      // Validated actual feedback queues (open dedup keeps one per record).
      const recallId = (rec.data as { recallId: string }).recallId;
      const fb = feedbackRecords(
        ctx.db,
        ctx.config,
        { recallId, recordIds: [id], scope: "personal/default" },
        "m3-q-fb",
      );
      assert.equal(fb.ok, true);
      assert.ok(countOpenCultivationReviews(ctx.db) <= 3);
      // Outside-exposure feedback is rejected whole and queues nothing new.
      const before = countOpenCultivationReviews(ctx.db);
      const badFb = feedbackRecords(
        ctx.db,
        ctx.config,
        { recallId, recordIds: ["rec_missing_xyz"], scope: "personal/default" },
        "m3-q-fb-bad",
      );
      assert.equal(badFb.ok, false);
      assert.equal(countOpenCultivationReviews(ctx.db), before);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 lease single-flight + cancel + reclaim", () => {
  it("one holder at a time; owner-only release; expiry steal; cancel; crash reclaim", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "leased orchard review note", "m3-l1");
      void id;
      const a = acquireCultivationLease(ctx.db, ctx.config, { owner: "worker-A", now: T1 });
      assert.equal(a.acquired, true);
      const b = acquireCultivationLease(ctx.db, ctx.config, { owner: "worker-B", now: T1 });
      assert.equal(b.acquired, false);
      assert.equal(releaseCultivationLease(ctx.db, "worker-B"), false);
      assert.equal(releaseCultivationLease(ctx.db, "worker-A"), true);
      // TTL expiry steal (leaseTtlMs default 120000; T1 + 1h is past expiry).
      const c = acquireCultivationLease(ctx.db, ctx.config, { owner: "worker-C", now: T1 });
      assert.equal(c.acquired, true);
      const d = acquireCultivationLease(ctx.db, ctx.config, { owner: "worker-D", now: "2026-09-01T02:00:00.000Z" });
      assert.equal(d.acquired, true, "expired lease is stealable (crash support)");
      // Dequeue requires the live lease holder.
      const wrong = dequeueCultivationBatch(ctx.db, ctx.config, { owner: "worker-C", scope: "personal/default" });
      assert.equal(wrong.items.length, 0);
      const batch = dequeueCultivationBatch(ctx.db, ctx.config, {
        owner: "worker-D",
        scope: "personal/default",
        now: "2026-09-01T02:00:00.000Z",
      });
      assert.ok(batch.batchId !== null && batch.items.length >= 1);
      assert.equal(batch.items[0]?.status, "leased");
      // Cancel one leased review explicitly.
      assert.equal(cancelCultivationReview(ctx.db, batch.items[0]?.queueId as string), true);
      // Crash reclaim: drop the lease row, leased rows return to pending.
      ctx.db.prepare(`DELETE FROM cultivation_lease WHERE leaseId='m3'`).run();
      const reclaimed = reclaimExpiredCultivationLeases(ctx.db, ctx.config, "2026-09-01T03:00:00.000Z");
      assert.ok(reclaimed >= 0);
      assert.equal(completeCultivationReview(ctx.db, ctx.config, "cq_missing", "done"), false);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 applyCultivationBatch", () => {
  it("validates ids/revisions/status/scope/refs/links; stale+invalid are no-change; summaries keep history", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "cultivation apply target note", "m3-a1");
      raw(ctx.db, ctx.config, "m3-a-raw2");
      // Stale expectedRevision => conservative no-change.
      const stale = applyCultivationBatch(
        ctx.db,
        ctx.config,
        {
          scope: "personal/default",
          idempotencyKey: "m3-apply-1",
          actions: [{ recordId: id, action: "retire", expectedRevision: 999, reasonCode: "OUTDATED" }],
        },
        T2,
      );
      assert.equal(stale.ok, true);
      const r0 = (stale.data as { cultivation: { applied: number; results: Array<{ code: string }> } }).cultivation;
      assert.equal(r0.applied, 0);
      assert.equal(r0.results[0]?.code, "CONFLICT");
      assert.equal(
        (getRecord(ctx.db, ctx.config, { id, scope: "personal/default" }).data as { record: { status: string } }).record.status,
        "active",
      );
      // Real retire + consolidate with a cross-scope link (rejected) + valid summary.
      const other = remember(ctx.db, ctx.config, "cultivation source note", "m3-a2");
      const batch = applyCultivationBatch(
        ctx.db,
        ctx.config,
        {
          scope: "personal/default",
          idempotencyKey: "m3-apply-2",
          actions: [
            { recordId: id, action: "retire", reasonCode: "CONSOLIDATED" },
            {
              recordId: other,
              action: "consolidate",
              summary: {
                body: "consolidated orchard summary",
                provenance: { source: "cultivation:derived-batch", observedAt: OBS },
                sourceRefs: ["m3-a-raw2"],
                links: ["rec_missing_dangling"],
              },
            },
            {
              recordId: other,
              action: "consolidate",
              summary: {
                body: "consolidated orchard summary v2",
                provenance: { source: "cultivation:derived-batch", observedAt: OBS },
                sourceRefs: ["m3-a-raw2"],
                links: [other],
              },
            },
          ],
        },
        T3,
      );
      assert.equal(batch.ok, true, JSON.stringify(batch));
      const cult = (batch.data as {
        cultivation: { applied: number; results: Array<{ applied: boolean; code: string; summaryId?: string }> };
      }).cultivation;
      assert.equal(cult.results[0]?.applied, true, "retire applied");
      assert.equal(cult.results[1]?.applied, false, "dangling link => no-change");
      assert.equal(cult.results[2]?.applied, true, "valid summary inserted");
      const summaryId = cult.results[2]?.summaryId as string;
      const sview = getRecord(ctx.db, ctx.config, { id: summaryId, scope: "personal/default" });
      assert.equal((sview.data as { record: { kind: string; status: string } }).record.kind, "summary");
      // Sources keep history: consolidation never auto-retires.
      assert.equal(
        (getRecord(ctx.db, ctx.config, { id: other, scope: "personal/default" }).data as { record: { status: string } }).record.status,
        "active",
      );
      // Batch idempotency replay (identical params => deduplicated).
      const replay = applyCultivationBatch(
        ctx.db,
        ctx.config,
        {
          scope: "personal/default",
          idempotencyKey: "m3-apply-2",
          actions: [
            { recordId: id, action: "retire", reasonCode: "CONSOLIDATED" },
            {
              recordId: other,
              action: "consolidate",
              summary: {
                body: "consolidated orchard summary",
                provenance: { source: "cultivation:derived-batch", observedAt: OBS },
                sourceRefs: ["m3-a-raw2"],
                links: ["rec_missing_dangling"],
              },
            },
            {
              recordId: other,
              action: "consolidate",
              summary: {
                body: "consolidated orchard summary v2",
                provenance: { source: "cultivation:derived-batch", observedAt: OBS },
                sourceRefs: ["m3-a-raw2"],
                links: [other],
              },
            },
          ],
        },
        T3,
      );
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      // Same key with changed params => CONFLICT (no silent overwrite).
      const clash = applyCultivationBatch(
        ctx.db,
        ctx.config,
        {
          scope: "personal/default",
          idempotencyKey: "m3-apply-2",
          actions: [{ recordId: other, action: "keep" }],
        },
        T3,
      );
      assert.equal(clash.code, "CONFLICT");
      // Unknown id is per-action NOT_FOUND, batch still commits the valid rest.
      const mixed = applyCultivationBatch(
        ctx.db,
        ctx.config,
        {
          scope: "personal/default",
          idempotencyKey: "m3-apply-3",
          actions: [
            { recordId: "rec_missing_xyz", action: "retire", reasonCode: "OUTDATED" },
            { recordId: other, action: "keep" },
          ],
        },
      );
      assert.equal(mixed.ok, true);
      const m = (mixed.data as { cultivation: { applied: number; results: Array<{ code: string }> } }).cultivation;
      assert.equal(m.results[0]?.code, "NOT_FOUND");
      assert.equal(m.results[1]?.code, "OK");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 pre-M3 migration preserves rows", () => {
  it("old CHECK databases keep canonical rows and gain reversible retired", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m3-mig-"));
    const config: AppConfig = {
      dbPath: path.join(dir, "old.db"),
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
    const configPath = path.join(dir, "memory.config.json");
    const db = new DatabaseSync(path.join(dir, "old.db"));
    try {
      db.exec(`CREATE TABLE scopes(scope TEXT PRIMARY KEY)`);
      db.prepare(`INSERT INTO scopes(scope) VALUES (?)`).run("personal/default");
      db.exec(`CREATE TABLE records(
        id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
        kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
        source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
        status TEXT NOT NULL CHECK(status IN ('active','superseded','archived')),
        supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL)`);
      db.prepare(
        `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
         VALUES ('rec_legacy1', 'legacy body', 'legacy body', 'sha256:x', 'user_fact', 's', ?, 'personal/default', 'active', NULL, 1, ?)`,
      ).run(OBS, OBS);
      ensureM1Schema(db); // runs the M3 additive migration
      const row = db.prepare(`SELECT status FROM records WHERE id='rec_legacy1'`).get() as { status: string };
      assert.equal(row.status, "active", "canonical row preserved");
      const ret = retireRecord(
        db,
        config,
        { id: "rec_legacy1", scope: "personal/default", reasonCode: "OUTDATED" },
        "m3-mig-k",
      );
      assert.equal(ret.ok, true, JSON.stringify(ret));
    } finally {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
    void configPath;
  });
});

describe("m3 two-stage gate safeguards (deterministic, no model)", () => {
  it("retire gate: only strict NONE retires; facts/uncertain/empty keep state unchanged", () => {
    // Explicit resolved transient mood: model states NONE => retire candidate.
    assert.deepEqual(parseRetireGate("NONE"), { kind: "retire" });
    assert.deepEqual(parseRetireGate("  none  "), { kind: "retire" });
    // Durable facts, uncertain notes, plans, events: model states content
    // => continue (never a retire). Generic safeguard, no fixture rules.
    assert.deepEqual(parseRetireGate("The cabin key is on the blue hook."), { kind: "continue" });
    assert.deepEqual(parseRetireGate("Maybe the meeting is on Thursday."), { kind: "continue" });
    assert.deepEqual(parseRetireGate("I feel sad but the rent is due Friday."), { kind: "continue" });
    assert.deepEqual(parseRetireGate("NONE of the above apply here"), { kind: "continue" });
    // Unknown/invalid/uncertain => uncertain (caller keeps, no mutation).
    assert.deepEqual(parseRetireGate(""), { kind: "uncertain" });
    assert.deepEqual(parseRetireGate(null), { kind: "uncertain" });
    assert.deepEqual(parseRetireGate(42), { kind: "uncertain" });
    assert.deepEqual(parseRetireGate("NONE\nEXTRA LINE"), { kind: "continue" });
  });

  it("positional merge: numbers map to shown peers; ids/out-of-range/conflicts never merge", () => {
    assert.deepEqual(parseMergeChoice("MERGE 2", 4), { kind: "merge", index: 1 });
    assert.deepEqual(parseMergeChoice("keep", 4), { kind: "keep" });
    assert.deepEqual(parseMergeChoice("KEEP", 1), { kind: "keep" });
    // Out-of-range positions cannot invent a target.
    assert.deepEqual(parseMergeChoice("MERGE 9", 4), { kind: "uncertain" });
    assert.deepEqual(parseMergeChoice("MERGE 0", 4), { kind: "uncertain" });
    // The old copy-the-id form is rejected: the model never names ids.
    assert.deepEqual(parseMergeChoice("MERGE rec_abc123", 4), { kind: "uncertain" });
    // Conflicting or empty signals are uncertain (caller keeps).
    assert.deepEqual(parseMergeChoice("MERGE 1 KEEP", 4), { kind: "uncertain" });
    assert.deepEqual(parseMergeChoice("", 4), { kind: "uncertain" });
    assert.deepEqual(parseMergeChoice("MERGE 1", 0), { kind: "uncertain" });
  });

  it("prompts are positional and bounded: no record ids leak into the merge prompt", () => {
    const peers = [
      { id: "rec_alpha_1", body: "the cabin spare key hangs inside the woodshed on a blue hook" },
      { id: "rec_beta_2", body: "maybe the meeting is on thursday, not sure" },
    ];
    const prompt = buildMergePrompt("the cabin spare key is on the blue hook", peers, 2000);
    assert.ok(prompt.includes("1.") && prompt.includes("2."), "peers shown as numbers");
    assert.ok(!prompt.includes("rec_alpha_1") && !prompt.includes("rec_beta_2"), "no raw ids shown");
    assert.ok(prompt.length <= 2000, "bounded prompt");
    const gate = buildRetireGatePrompt("I feel sad and low tonight", 2000);
    assert.ok(gate.includes("NONE"), "gate explains the NONE contract");
    assert.ok(gate.length <= 2000, "bounded gate prompt");
    const confirm = buildConfirmPrompt("fact a", "fact b", 2000);
    assert.ok(confirm.includes("NONE"), "confirmation explains the NONE contract");
    // Summary validation stays strict: empty/oversize/control rejected.
    assert.equal(parseSummaryBody("", 2000), null);
    assert.equal(parseSummaryBody("   ", 2000), null);
    assert.ok(typeof parseSummaryBody("the key is on the blue hook", 2000) === "string");
  });
});

describe("m3 distill reciprocal pair dedup", () => {
  it("reciprocal proposals create one summary (not two), union refs/links, both queues done", async () => {
    // Mechanics regression with a deterministic hand-supplied decideOverride
    // (prompt-shaped answers only: gate/positional-merge/confirm/summary).
    // This proves the same-batch unordered-pair invariant; genuine
    // model judgment is proven separately by the real-model smoke-m3 drain.
    const ctx = setup();
    try {
      const modelDir = path.join(ctx.dir, "fake-llm");
      fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
      for (const f of [
        "config.json",
        "generation_config.json",
        "tokenizer.json",
        "tokenizer_config.json",
        "special_tokens_map.json",
        "onnx/model_q4.onnx",
      ]) {
        fs.writeFileSync(path.join(modelDir, f), "{}");
      }
      ctx.config.llm = { modelDir, timeoutMs: 5000, enabled: true, maxNewTokens: 48, maxPromptChars: 2000 };
      const configPath = path.join(ctx.dir, "memory.config.json");
      const idA = remember(ctx.db, ctx.config, "the cabin spare key hangs inside the woodshed on a blue hook", "m3-dd-a");
      const idB = remember(ctx.db, ctx.config, "the cabin spare key is on the blue hook in the woodshed", "m3-dd-b");
      const idC = remember(ctx.db, ctx.config, "the boathouse oar rests against the north wall", "m3-dd-c");
      const decide = async (prompt: string): Promise<string | null> => {
        if (prompt.includes("What lasting fact")) return "the cabin spare key is a lasting fact";
        if (prompt.includes("Other memories in the same scope")) {
          const head = prompt.split("Other memories")[0] ?? "";
          if (!/cabin|blue hook|woodshed/i.test(head)) return "KEEP";
          const peerRe = /^\s*(\d+)\.\s+"""(.*)"""\s*$/gm;
          let m: RegExpExecArray | null;
          while ((m = peerRe.exec(prompt)) !== null) {
            if (/cabin|blue hook|woodshed/i.test(m[2] ?? "")) return `MERGE ${m[1]}`;
          }
          return "KEEP";
        }
        if (prompt.includes("What single fact do both memories")) {
          return "the cabin spare key is on the blue hook in the woodshed";
        }
        if (prompt.includes("Merge these related memories")) {
          return "the cabin spare key hangs on the blue hook in the woodshed";
        }
        return "KEEP";
      };
      const res = await maintainDistill(
        ctx.db,
        ctx.config,
        configPath,
        { scope: "personal/default", limit: 10 },
        "m3-dedup-k1",
        decide,
        T3,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const d = (res.data as { distill: { applied: number; reviewed: number; failed: number } }).distill;
      assert.equal(d.reviewed, 3);
      assert.equal(d.failed, 0);
      // Consumer-visible: exactly one summary row (not twin summaries).
      const sums = ctx.db.prepare(`SELECT id, body, source FROM records WHERE kind='summary'`).all() as Array<{
        id: string; body: string; source: string;
      }>;
      assert.equal(sums.length, 1, `expected one summary, got ${sums.length}`);
      const sum = sums[0]!;
      assert.equal(sum.body, "the cabin spare key hangs on the blue hook in the woodshed");
      assert.equal(sum.source, DISTILL_SUMMARY_SOURCE);
      const links = (
        ctx.db.prepare(`SELECT toRef FROM record_links WHERE fromId=? ORDER BY toRef`).all(sum.id) as Array<{ toRef: string }>
      ).map((r) => r.toRef);
      assert.deepEqual(links, [idA, idB].sort());
      const refs = (
        ctx.db.prepare(`SELECT eventId FROM record_source_refs WHERE recordId=? ORDER BY eventId`).all(sum.id) as Array<{ eventId: string }>
      ).map((r) => r.eventId);
      const refsA = (
        ctx.db.prepare(`SELECT eventId FROM record_source_refs WHERE recordId=?`).all(idA) as Array<{ eventId: string }>
      ).map((r) => r.eventId);
      const refsB = (
        ctx.db.prepare(`SELECT eventId FROM record_source_refs WHERE recordId=?`).all(idB) as Array<{ eventId: string }>
      ).map((r) => r.eventId);
      for (const e of [...refsA, ...refsB]) assert.ok(refs.includes(e), `union refs must include ${e}`);
      // Sources kept (no auto-retire), control untouched, queue fully drained.
      for (const id of [idA, idB, idC]) {
        const v = getRecord(ctx.db, ctx.config, { id, scope: "personal/default" });
        assert.equal((v.data as { record: { status: string } }).record.status, "active");
      }
      assert.equal(countOpenCultivationReviews(ctx.db), 0);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("m3 review fixes (orphan/degraded/singleflight/cursor/cancel/dup/search/prompts)", () => {
  function fakeLlmDir(dir: string): string {
    const modelDir = path.join(dir, "fake-llm");
    fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
    for (const f of [
      "config.json",
      "generation_config.json",
      "tokenizer.json",
      "tokenizer_config.json",
      "special_tokens_map.json",
      "onnx/model_q4.onnx",
    ]) {
      fs.writeFileSync(path.join(modelDir, f), "{}");
    }
    return modelDir;
  }

  function enableFakeLlm(ctx: { config: AppConfig }, modelDir: string): void {
    ctx.config.llm = { modelDir, timeoutMs: 5000, enabled: true, maxNewTokens: 48, maxPromptChars: 2000 };
  }

  const keepDecide = async (prompt: string): Promise<string | null> => {
    if (prompt.includes("What lasting fact")) return "a lasting fact is recorded here";
    return "KEEP";
  };

  it("stealing an expired lease reclaims crashed orphans to pending (not stranded leased)", () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "orphan reclaim probe note", "m3-rf-1");
      const q = (ctx.db.prepare(`SELECT queueId FROM cultivation_queue`).all() as Array<{ queueId: string }>)[0]!;
      ctx.db.prepare(`UPDATE cultivation_queue SET status='leased', batchId='old-batch' WHERE queueId=?`).run(q.queueId);
      ctx.db.prepare(`DELETE FROM cultivation_lease WHERE leaseId='m3'`).run(); // crash: orphan, no lease
      const a = acquireCultivationLease(ctx.db, ctx.config, { owner: "worker-new", now: "2026-09-01T03:00:00.000Z" });
      assert.equal(a.acquired, true);
      const row = ctx.db.prepare(`SELECT status, attempts FROM cultivation_queue WHERE queueId=?`).get(q.queueId) as {
        status: string;
        attempts: number;
      };
      assert.equal(row.status, "pending", "steal must reclaim the orphan to pending");
      assert.equal(row.attempts, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("degraded (model-unavailable) distill dequeues nothing and leaks no leased rows", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "degraded probe note", "m3-rf-2");
      ctx.config.llm = { modelDir: path.join(ctx.dir, "no-model"), timeoutMs: 1000, enabled: true, maxNewTokens: 8, maxPromptChars: 2000 };
      const before = countOpenCultivationReviews(ctx.db);
      assert.ok(before >= 1);
      const res = await maintainDistill(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: "personal/default", limit: 5 },
        "m3-rf-deg",
        async () => null,
        "2026-09-01T04:00:00.000Z",
      );
      assert.equal(res.ok, true);
      assert.equal((res.data as { distill: { degraded: boolean; applied: number; batchId: null } }).distill.degraded, true);
      assert.equal((res.data as { distill: { applied: number } }).distill.applied, 0);
      const leased = ctx.db.prepare(`SELECT COUNT(*) AS n FROM cultivation_queue WHERE status='leased'`).get() as { n: number };
      assert.equal(leased.n, 0, "degraded drain must not leave leased rows");
      assert.equal(countOpenCultivationReviews(ctx.db), before, "degraded drain changes no queue state");
    } finally {
      ctx.cleanup();
    }
  });

  it("distill lease owners are unique per execution; same-key replay deduplicates", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "singleflight probe note", "m3-rf-3");
      const modelDir = fakeLlmDir(ctx.dir);
      enableFakeLlm(ctx, modelDir);
      const configPath = path.join(ctx.dir, "memory.config.json");
      let seenOwner: string | null = null;
      const decide = async (prompt: string): Promise<string | null> => {
        try {
          const r = ctx.db.prepare(`SELECT owner FROM cultivation_lease WHERE leaseId='m3'`).get() as { owner: string } | undefined;
          seenOwner = r?.owner ?? null;
        } catch {
          /* ignore */
        }
        return keepDecide(prompt);
      };
      const r1 = await maintainDistill(ctx.db, ctx.config, configPath, { scope: "personal/default", limit: 5 }, "m3-rf-sf", decide, T3);
      assert.equal(r1.ok, true);
      assert.ok(seenOwner !== null && seenOwner !== "m3-rf-sf", `owner must be unique per execution, got ${seenOwner}`);
      assert.ok((seenOwner as string).startsWith("m3-rf-sf#"), `owner must derive from the caller key, got ${seenOwner}`);
      const r2 = await maintainDistill(ctx.db, ctx.config, configPath, { scope: "personal/default", limit: 5 }, "m3-rf-sf", decide, T3);
      assert.equal(r2.ok, true);
      assert.equal(r2.deduplicated, true, "same key + same params replays deduplicated");
      // A concurrent same-key drain while a lease is live gets CONFLICT, never a second drain.
      const held = acquireCultivationLease(ctx.db, ctx.config, { owner: "foreign-holder", now: T3 });
      assert.equal(held.acquired, true);
      const contended = await maintainDistill(ctx.db, ctx.config, configPath, { scope: "personal/default", limit: 5 }, "m3-rf-sf2", decide, T3);
      assert.equal(contended.code, "CONFLICT");
      assert.equal(releaseCultivationLease(ctx.db, "foreign-holder"), true);
    } finally {
      ctx.cleanup();
    }
  });

  it("composite cursors page without skipping rows whose nextAt is newer but id is smaller", async () => {
    const ctx = setup();
    try {
      const now = "2026-09-01T00:00:00.000Z";
      ctx.db.prepare(
        `INSERT INTO cultivation_queue(queueId, recordId, scope, trigger, status, attempts, nextAt, createdAt, runId, batchId)
         VALUES ('cq_00small', 'rec_a', 'personal/default', 'remember', 'pending', 0, ?, ?, NULL, NULL)`,
      ).run("2026-09-01T05:00:00.000Z", now);
      ctx.db.prepare(
        `INSERT INTO cultivation_queue(queueId, recordId, scope, trigger, status, attempts, nextAt, createdAt, runId, batchId)
         VALUES ('cq_zzlarge', 'rec_b', 'personal/default', 'remember', 'pending', 0, ?, ?, NULL, NULL)`,
      ).run("2026-09-01T01:00:00.000Z", now);
      assert.equal(acquireCultivationLease(ctx.db, ctx.config, { owner: "o-cur", now: "2026-09-01T06:00:00.000Z" }).acquired, true);
      const b1 = dequeueCultivationBatch(ctx.db, ctx.config, { owner: "o-cur", scope: "personal/default", limit: 1, now: "2026-09-01T06:00:00.000Z" });
      assert.deepEqual(b1.items.map((i) => i.queueId), ["cq_zzlarge"], "due order is (nextAt, queueId)");
      assert.equal(completeCultivationReview(ctx.db, ctx.config, "cq_zzlarge", "done", "2026-09-01T06:00:00.000Z"), true);
      // Legacy bare-queueId cursor resolves through the same keyset (no skip).
      const b2 = dequeueCultivationBatch(ctx.db, ctx.config, {
        owner: "o-cur", scope: "personal/default", limit: 10, now: "2026-09-01T06:00:00.000Z", cursor: "cq_zzlarge",
      });
      assert.deepEqual(b2.items.map((i) => i.queueId), ["cq_00small"], "legacy cursor must not skip the newer row");
      // Composite cursor round-trips the (nextAt, queueId) position.
      const cursor = encodeCultivationCursor(b2.items[0]!.nextAt, b2.items[0]!.queueId);
      assert.ok(cursor.includes("|"));
      assert.equal(completeCultivationReview(ctx.db, ctx.config, "cq_00small", "done", "2026-09-01T06:00:00.000Z"), true);
      const b3 = dequeueCultivationBatch(ctx.db, ctx.config, {
        owner: "o-cur", scope: "personal/default", limit: 10, now: "2026-09-01T06:00:00.000Z", cursor,
      });
      assert.equal(b3.items.length, 0, "paged past the end finds nothing, not the prefix again");
    } finally {
      ctx.cleanup();
    }
  });

  it("a review cancelled after dequeue becomes an audited no-change, never a mutation", async () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "cancel race probe note", "m3-rf-5");
      const modelDir = fakeLlmDir(ctx.dir);
      enableFakeLlm(ctx, modelDir);
      const decide = async (prompt: string): Promise<string | null> => {
        if (prompt.includes("What lasting fact")) {
          // Race: an external cancel lands after dequeue but before the apply commit.
          try {
            const rows = ctx.db.prepare(`SELECT queueId FROM cultivation_queue WHERE recordId=?`).all(id) as Array<{ queueId: string }>;
            for (const r of rows) cancelCultivationReview(ctx.db, r.queueId);
          } catch {
            /* ignore */
          }
          return "NONE"; // would retire the record without the fence
        }
        return "KEEP";
      };
      const res = await maintainDistill(ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: "personal/default", limit: 5 }, "m3-rf-cancel", decide, T3);
      assert.equal(res.ok, true);
      assert.equal((res.data as { distill: { applied: number } }).distill.applied, 0);
      assert.equal(
        (getRecord(ctx.db, ctx.config, { id, scope: "personal/default" }).data as { record: { status: string } }).record.status,
        "active",
        "cancelled-before-commit must not mutate the record",
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("fenced apply rejects a stolen lease with CONFLICT and no mutation", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "lease fence probe note", "m3-rf-6");
      const q = (ctx.db.prepare(`SELECT queueId FROM cultivation_queue WHERE recordId=?`).all(id) as Array<{ queueId: string }>)[0]!;
      assert.equal(acquireCultivationLease(ctx.db, ctx.config, { owner: "exec-1", now: T1 }).acquired, true);
      const batch = dequeueCultivationBatch(ctx.db, ctx.config, { owner: "exec-1", scope: "personal/default", now: T1 });
      assert.ok(batch.batchId !== null);
      // Lease stolen by a newer generation before the commit.
      ctx.db.prepare(`DELETE FROM cultivation_lease WHERE leaseId='m3'`).run();
      assert.equal(acquireCultivationLease(ctx.db, ctx.config, { owner: "exec-2", now: T2 }).acquired, true);
      const res = applyCultivationBatch(
        ctx.db,
        ctx.config,
        {
          scope: "personal/default",
          idempotencyKey: "m3-rf-fence",
          actions: [{ recordId: id, action: "retire", reasonCode: "OUTDATED" }],
          fence: { owner: "exec-1", batchId: batch.batchId ?? undefined, guards: [{ queueId: q.queueId, recordId: id }] },
        },
        T2,
      );
      assert.equal(res.code, "CONFLICT");
      assert.equal(
        (getRecord(ctx.db, ctx.config, { id, scope: "personal/default" }).data as { record: { status: string } }).record.status,
        "active",
      );
      assert.equal(isCultivationLeaseHeldBy(ctx.db, "exec-2", T2), true, "stealing generation keeps its lease");
    } finally {
      ctx.cleanup();
    }
  });

  it("enqueue reports open-per-record duplicates instead of double-enqueueing", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "enqueue dup probe note", "m3-rf-7");
      ctx.db.prepare(`DELETE FROM cultivation_queue`).run();
      assert.equal(enqueueCultivationReview(ctx.db, ctx.config, { recordId: id, scope: "personal/default", trigger: "remember" }), "enqueued");
      assert.equal(enqueueCultivationReview(ctx.db, ctx.config, { recordId: id, scope: "personal/default", trigger: "remember" }), "duplicate");
      assert.equal(countOpenCultivationReviews(ctx.db), 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("explicit search finds multiword matches with both derived lexical indexes lost", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "lighthouse keeper shines lamp oil at dusk", "m3-rf-8");
      ctx.db.exec(`DELETE FROM fts_notes`);
      ctx.db.exec(`DELETE FROM char_bigrams`);
      const res = searchRecords(ctx.db, ctx.config, { query: "keeper dusk", scope: "personal/default", limit: 10 });
      assert.equal(res.ok, true, JSON.stringify(res));
      const ids = ((res.data as { items: Array<{ id: string }> }).items ?? []).map((i) => i.id);
      assert.ok(ids.includes(id), "canonical active+retired fallback must cover lost indexes for multiword queries");
    } finally {
      ctx.cleanup();
    }
  });

  it("prompts preserve structure within the documented 500..8000 code-point bound", () => {
    for (const max of [500, 2000]) {
      const gate = buildRetireGatePrompt("x".repeat(2000), max);
      assert.ok([...gate].length <= max, `gate fits ${max}`);
      assert.ok(gate.endsWith("<|im_start|>assistant\n"), "gate keeps the assistant cue");
      assert.ok(gate.includes("NONE"), "gate keeps the NONE contract");
      const merge = buildMergePrompt("x".repeat(2000), [{ id: "rec_y", body: "y".repeat(2000) }, { id: "rec_z", body: "z".repeat(2000) }], max);
      assert.ok([...merge].length <= max, `merge fits ${max}`);
      assert.ok(merge.endsWith("<|im_start|>assistant\n"), "merge keeps the assistant cue");
      const confirm = buildConfirmPrompt("a".repeat(2000), "b".repeat(2000), max);
      assert.ok([...confirm].length <= max, `confirm fits ${max}`);
      assert.ok(confirm.endsWith("<|im_start|>assistant\n"), "confirm keeps the assistant cue");
      const summary = buildSummaryPrompt("a".repeat(2000), "b".repeat(2000), max);
      assert.ok([...summary].length <= max, `summary fits ${max}`);
      assert.ok(summary.endsWith("<|im_start|>assistant\n"), "summary keeps the assistant cue");
    }
  });
});
