/**
 * M1 recall/graph tests: multiple links, backlinks, dangling refs, bounded
 * graph expansion, raw lexical descent to records, correction/archive
 * atomicity + idempotency, and feedback exposure/scope validation with
 * heat applied only on feedback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type {
  CorrectionRaceReady,
  CorrectionRaceRequest,
  CorrectionRaceResult,
} from "./fixtures/correction-race-worker.js";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { bodyHashFor, normalizeBody } from "../src/normalize.js";
import {
  archiveRecord,
  correctRecord,
  eventAppend,
  feedbackRecords,
  getRecord,
  listRecords,
  recallRecords,
  rememberRecord,
} from "../src/store.js";

function setup(extraScopes: string[] = []): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-recall-"));
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

const OBS = "2026-09-01T00:00:00.000Z";
let evCounter = 0;

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

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  key: string,
  opts: { links?: string[]; tags?: string[]; refs?: string[]; scope?: string; now?: string } = {},
): string {
  const scope = opts.scope ?? "personal/default";
  const refs = opts.refs ?? [`auto-${key}`];
  for (const e of refs) {
    const exists = db.prepare(`SELECT eventId FROM raw_events WHERE eventId=?`).get(e) as
      | { eventId: string }
      | undefined;
    if (!exists) raw(db, config, e, scope);
  }
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope,
      tags: opts.tags,
      links: opts.links,
      sourceRefs: refs,
    },
    key,
    opts.now,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function recallIds(db: DatabaseSync, config: AppConfig, query: string, extra: Record<string, unknown> = {}): string[] {
  const res = recallRecords(db, config, { query, scope: "personal/default", limit: 10, ...extra });
  assert.equal(res.ok, true, JSON.stringify(res));
  return ((res.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
}

function get(db: DatabaseSync, config: AppConfig, id: string): Record<string, unknown> {
  const res = getRecord(db, config, { id, scope: "personal/default" });
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: Record<string, unknown> }).record;
}

/** Recall items must carry revision/kind from the source record (F-I01-01). */
function assert_equal_record_view(
  item: { revision: number; kind: string },
  record: Record<string, unknown>,
): void {
  assert.ok(typeof item.revision === "number");
  assert.equal(item.revision, record.revision);
  assert.equal(item.kind, record.kind);
}

function list(db: DatabaseSync, config: AppConfig): string[] {
  const res = listRecords(db, config, { scope: "personal/default", limit: 25 });
  assert.equal(res.ok, true, JSON.stringify(res));
  return ((res.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
}

function heatOf(db: DatabaseSync, id: string): number {
  const row = db.prepare(`SELECT usedCount FROM note_heat WHERE recordId=?`).get(id) as
    | { usedCount: number }
    | undefined;
  return row?.usedCount ?? -1;
}

function insertRecord(
  db: DatabaseSync,
  id: string,
  body: string,
  createdAt: string,
  links: string[] = [],
): void {
  const bodyNorm = normalizeBody(body);
  db.prepare(
    `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
     VALUES (?, ?, ?, ?, 'user_fact', 'test', ?, 'personal/default', 'active', NULL, 1, ?)`,
  ).run(id, body, bodyNorm, bodyHashFor(bodyNorm), OBS, createdAt);
  for (const link of links) db.prepare(`INSERT INTO record_links(fromId, toRef) VALUES (?, ?)`).run(id, link);
}

describe("links, backlinks, dangling refs, graph recall", () => {
  it("stores multiple links sorted and recalls graph neighbors", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "lighthouse keeper evening log", "lnk-a");
      const b = remember(ctx.db, ctx.config, "harbor manifest morning notes", "lnk-b", { links: [a] });
      const got = getRecord(ctx.db, ctx.config, { id: b, scope: "personal/default" });
      assert.equal(got.ok, true);
      assert.deepEqual((got.data as { record: { links: string[] } }).record.links, [a]);
      const c = remember(ctx.db, ctx.config, "tide chart harbor copy", "lnk-c", { links: [b, a] });
      const gotC = getRecord(ctx.db, ctx.config, { id: c, scope: "personal/default" });
      assert.deepEqual((gotC.data as { record: { links: string[] } }).record.links, [...[a, b]].sort());
      // "lighthouse" matches A lexically; B links to A so graph expansion surfaces it.
      const ids = recallIds(ctx.db, ctx.config, "lighthouse keeper");
      assert.ok(ids.includes(a), JSON.stringify(ids));
      assert.ok(ids.includes(b), `graph neighbor missing: ${JSON.stringify(ids)}`);
    } finally {
      ctx.cleanup();
    }
  });

  it("dangling link refs are kept but skipped during expansion", () => {
    const ctx = setup();
    try {
      const d = remember(ctx.db, ctx.config, "dangling pointer notebook entry", "lnk-d", {
        links: ["rec_missing_target_xyz"],
      });
      const got = getRecord(ctx.db, ctx.config, { id: d, scope: "personal/default" });
      assert.deepEqual((got.data as { record: { links: string[] } }).record.links, ["rec_missing_target_xyz"]);
      const ids = recallIds(ctx.db, ctx.config, "dangling pointer notebook");
      assert.ok(ids.includes(d));
    } finally {
      ctx.cleanup();
    }
  });

  it("exact link seed promotes the target record", () => {
    const ctx = setup();
    try {
      const target = remember(ctx.db, ctx.config, "seed target gardening almanac", "lnk-t");
      remember(ctx.db, ctx.config, "unrelated weather chatter", "lnk-u");
      const ids = recallIds(ctx.db, ctx.config, "gardening almanac", { link: target });
      assert.ok(ids.includes(target));
    } finally {
      ctx.cleanup();
    }
  });

  it("applies the recall time window to graph neighbors", () => {
    const ctx = setup();
    try {
      const seed = remember(ctx.db, ctx.config, "window graph beacon", "graph-window-seed", {
        now: "2026-07-01T00:00:00.000Z",
      });
      insertRecord(ctx.db, "rec_old_neighbor", "unrelated old neighbor", "2025-01-01T00:00:00.000Z", [seed]);
      const ids = recallIds(ctx.db, ctx.config, "window graph beacon", {
        since: "2026-01-01T00:00:00.000Z",
      });
      assert.ok(ids.includes(seed));
      assert.equal(ids.includes("rec_old_neighbor"), false, JSON.stringify(ids));
    } finally {
      ctx.cleanup();
    }
  });

  it("sorts same-distance graph neighbors before applying the expansion cap", () => {
    const ctx = setup();
    try {
      const seed = remember(ctx.db, ctx.config, "graph cap beacon", "graph-cap-seed", {
        now: "2026-01-01T00:00:00.000Z",
      });
      for (let i = 0; i < 45; i++) {
        const id = `rec_g_${String(i).padStart(2, "0")}`;
        const createdAt = new Date(Date.UTC(2026, 0, 2 + i)).toISOString();
        insertRecord(ctx.db, id, "unrelated graph neighbor", createdAt, [seed]);
      }
      const ids = recallIds(ctx.db, ctx.config, "graph cap beacon", { limit: 25 });
      const neighbors = ids.filter((id) => id !== seed);
      const expected = Array.from({ length: 24 }, (_, i) => `rec_g_${String(44 - i).padStart(2, "0")}`);
      assert.deepEqual(neighbors, expected);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("raw lexical descent maps raw-only terms to records", () => {
  it("a term present only in raw context resolves to the citing record", () => {
    const ctx = setup();
    try {
      const ev = eventAppend(
        ctx.db,
        ctx.config,
        {
          eventId: "e-xylophone",
          sessionId: "s1",
          turnId: "t7",
          body: "xylophone zebra crossing parade",
          provenance: { source: "session:s1:turn:7", observedAt: OBS },
          scope: "personal/default",
        },
        "ev-xylo",
      );
      assert.equal(ev.ok, true);
      const res = rememberRecord(
        ctx.db,
        ctx.config,
        {
          body: "quiet memo about hallway plants",
          kind: "user_fact",
          provenance: { source: "session:s1:turn:8", observedAt: OBS },
          scope: "personal/default",
          sourceRefs: ["e-xylophone"],
        },
        "rem-xylo",
      );
      assert.equal(res.ok, true);
      const id = (res.data as { record: { id: string } }).record.id;
      const ids = recallIds(ctx.db, ctx.config, "xylophone parade");
      assert.ok(ids.includes(id), `raw descent missed ${id}: ${JSON.stringify(ids)}`);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("recall candidate determinism and fallback", () => {
  it("orders equal-rank note and raw FTS candidates by createdAt DESC, id ASC", () => {
    const ctx = setup();
    try {
      for (const id of ["rec_c", "rec_b", "rec_a"]) {
        insertRecord(ctx.db, id, "unrelated note", "2026-04-01T00:00:00.000Z");
        ctx.db.prepare(`INSERT INTO fts_notes(recordId, body) VALUES (?, 'tiephrase')`).run(id);
      }
      assert.deepEqual(recallIds(ctx.db, ctx.config, "tiephrase").slice(0, 3), ["rec_a", "rec_b", "rec_c"]);

      for (const suffix of ["4", "3", "2", "1"]) {
        const eventId = `event_${suffix}`;
        ctx.db.prepare(
          `INSERT INTO raw_events(eventId, sessionId, turnId, body, bodyNorm, source, observedAt, scope, runId, createdAt)
           VALUES (?, 's', 't', 'raw', 'raw', 'test', ?, 'personal/default', NULL, '2026-05-01T00:00:00.000Z')`,
        ).run(eventId, OBS);
        ctx.db.prepare(`INSERT INTO fts_raw(eventId, body) VALUES (?, 'rawtie')`).run(eventId);
        const recordId = `rec_raw_${suffix}`;
        insertRecord(ctx.db, recordId, "unrelated descent note", "2026-05-01T00:00:00.000Z");
        ctx.db.prepare(`INSERT INTO record_source_refs(recordId, eventId) VALUES (?, ?)`).run(recordId, eventId);
      }
      const rawIds = recallIds(ctx.db, ctx.config, "rawtie");
      assert.ok(rawIds.includes("rec_raw_1"), JSON.stringify(rawIds));
      assert.equal(rawIds.includes("rec_raw_4"), false, JSON.stringify(rawIds));
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps raw-only and canonical-only candidates when the fusion pool exceeds 60", () => {
    const ctx = setup();
    try {
      for (let i = 0; i < 60; i++) {
        const id = `rec_lex_${String(i).padStart(2, "0")}`;
        insertRecord(ctx.db, id, "unrelated lexical canonical body", "2026-03-01T00:00:00.000Z");
        ctx.db.prepare(`INSERT INTO fts_notes(recordId, body) VALUES (?, 'pooltoken')`).run(id);
      }
      const rawEvent = eventAppend(
        ctx.db,
        ctx.config,
        {
          eventId: "event_pool_raw",
          sessionId: "s",
          turnId: "t",
          body: "pooltoken raw source",
          provenance: { source: "test", observedAt: OBS },
          scope: "personal/default",
        },
        "pool-raw-event",
      );
      assert.equal(rawEvent.ok, true);
      insertRecord(ctx.db, "rec_raw_only", "unrelated raw-backed note", "2026-03-02T00:00:00.000Z");
      ctx.db.prepare(`INSERT INTO record_source_refs(recordId, eventId) VALUES ('rec_raw_only', 'event_pool_raw')`).run();
      insertRecord(ctx.db, "rec_canon_only", "pooltoken canonical note", "2026-03-03T00:00:00.000Z");

      const ids = recallIds(ctx.db, ctx.config, "pooltoken", { limit: 25 });
      assert.ok(ids.includes("rec_raw_only"), JSON.stringify(ids));
      assert.ok(ids.includes("rec_canon_only"), JSON.stringify(ids));
    } finally {
      ctx.cleanup();
    }
  });

  it("falls back to canonical raw bodyNorm after both derived raw lookups miss", () => {
    const ctx = setup();
    try {
      const eventId = "event_raw_fallback";
      const ev = eventAppend(
        ctx.db,
        ctx.config,
        {
          eventId,
          sessionId: "s",
          turnId: "t",
          body: "multiword fallback beacon",
          provenance: { source: "test", observedAt: OBS },
          scope: "personal/default",
        },
        "raw-fallback-event",
      );
      assert.equal(ev.ok, true);
      const id = remember(ctx.db, ctx.config, "unrelated cited note", "raw-fallback-record", { refs: [eventId] });
      ctx.db.prepare(`DELETE FROM fts_raw WHERE eventId=?`).run(eventId);
      ctx.db.prepare(`DELETE FROM char_bigrams WHERE kind='raw' AND id=?`).run(eventId);
      assert.ok(recallIds(ctx.db, ctx.config, "multiword fallback").includes(id));
    } finally {
      ctx.cleanup();
    }
  });
});

describe("correction atomicity and idempotency", () => {
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
        sourceRefs: [`corr-ev-${key}`],
      },
      key,
    );
  }

  it("supersedes atomically, excludes the old revision, replays idempotently", () => {
    const ctx = setup();
    try {
      const orig = remember(ctx.db, ctx.config, "original meeting time noon sharp", "corr-a");
      raw(ctx.db, ctx.config, "corr-ev-corr-k1");
      const correctedBody = "  CORRECTED   meeting time one oclock sharp  ";
      const done = correct(ctx.db, ctx.config, orig, correctedBody, "corr-k1");
      assert.equal(done.ok, true, JSON.stringify(done));
      const newId = (done.data as { record: { id: string } }).record.id;
      const oldView = getRecord(ctx.db, ctx.config, { id: orig, scope: "personal/default" });
      assert.equal((oldView.data as { record: { status: string } }).record.status, "superseded");
      const listed = listRecords(ctx.db, ctx.config, { scope: "personal/default", limit: 25 });
      const ids = ((listed.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
      assert.ok(ids.includes(newId));
      assert.ok(!ids.includes(orig));
      const hash = (ctx.db.prepare(`SELECT bodyHash FROM records WHERE id=?`).get(newId) as { bodyHash: string }).bodyHash;
      assert.equal(hash, bodyHashFor(normalizeBody(correctedBody)));
      const replay = correct(ctx.db, ctx.config, orig, correctedBody, "corr-k1");
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      // Second correction of the same (now superseded) target loses atomically.
      raw(ctx.db, ctx.config, "corr-ev-corr-k2");
      const loser = correct(ctx.db, ctx.config, orig, "rival correction text here", "corr-k2");
      assert.equal(loser.ok, false);
      assert.equal(loser.code, "CONFLICT");
      const newView = getRecord(ctx.db, ctx.config, { id: newId, scope: "personal/default" });
      assert.equal((newView.data as { record: { status: string } }).record.status, "active");
    } finally {
      ctx.cleanup();
    }
  });

  it("rolls back the losing correction from concurrent independent shared-file connections", { timeout: 20_000 }, async (t) => {
    const ctx = setup();
    const workers: Worker[] = [];
    function assertObject(value: unknown): asserts value is Record<string, unknown> {
      assert.ok(value !== null && typeof value === "object" && !Array.isArray(value));
    }
    try {
      assert.equal(path.dirname(ctx.config.dbPath), ctx.dir);
      assert.equal(path.dirname(ctx.config.vaultPath), ctx.dir);
      assert.ok(fs.existsSync(ctx.config.dbPath));
      const leftLink = remember(ctx.db, ctx.config, "left race link target", "race-link-left");
      const rightLink = remember(ctx.db, ctx.config, "right race link target", "race-link-right");
      const originalBody = "shared correction race original meeting time";
      const original = remember(ctx.db, ctx.config, originalBody, "race-original");
      const contenders = [leftLink, rightLink].map((link, index) => {
        const key = `race-correct-${index}`;
        const eventId = `corr-ev-${key}`;
        raw(ctx.db, ctx.config, eventId);
        return {
          key,
          eventId,
          link,
          params: {
            recordId: original,
            body: `shared correction race replacement ${index}`,
            kind: "correction",
            provenance: { source: "session:s1:turn:9", observedAt: OBS },
            scope: "personal/default",
            sourceRefs: [eventId],
            links: [link],
            runId: key,
          },
        };
      });
      assert.notEqual(contenders[0].key, contenders[1].key);
      const barrier = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
      const shared = new Int32Array(barrier);

      // Launch both workers without awaiting either; each opens its own handle.
      const running = contenders.map(({ key, params }) => {
        const worker = new Worker(path.join(__dirname, "fixtures", "correction-race-worker.js"), {
          workerData: { config: ctx.config, params, idempotencyKey: key, barrier } satisfies CorrectionRaceRequest,
        });
        workers.push(worker);
        let resolveReady!: (message: CorrectionRaceReady) => void;
        let rejectReady!: (error: Error) => void;
        let resolveResult!: (message: CorrectionRaceResult) => void;
        let rejectResult!: (error: Error) => void;
        const ready = new Promise<CorrectionRaceReady>((resolve, reject) => {
          resolveReady = resolve;
          rejectReady = reject;
        });
        const result = new Promise<CorrectionRaceResult>((resolve, reject) => {
          resolveResult = resolve;
          rejectResult = reject;
        });
        let final: CorrectionRaceResult | undefined;
        worker.on("message", (message: CorrectionRaceReady | CorrectionRaceResult) => {
          if (message.type === "ready") resolveReady(message);
          else final = message;
        });
        worker.once("error", (error) => {
          rejectReady(error);
          rejectResult(error);
        });
        worker.once("exit", (code) => {
          rejectReady(new Error(`correction worker exited before ready: ${code}`));
          if (code === 0 && final) resolveResult(final);
          else rejectResult(new Error(`correction worker exited without a result: ${code}`));
        });
        return { ready, result };
      });
      const [ready, results] = await Promise.all([
        Promise.all(running.map((worker) => worker.ready)).then((messages) => {
          assert.notEqual(messages[0].threadId, messages[1].threadId);
          for (const message of messages) {
            assert.ok(message.threadId > 0);
            assert.equal(message.dbFile, fs.realpathSync(ctx.config.dbPath));
            assert.equal(message.targetStatus, "active");
          }
          assert.equal(Atomics.load(shared, 1), 0, "no correction starts before both connections are ready");
          Atomics.store(shared, 0, 1);
          Atomics.notify(shared, 0, 2);
          return messages;
        }),
        Promise.all(running.map((worker) => worker.result)),
      ]);
      assert.equal(Atomics.load(shared, 1), 2, "both store calls rendezvoused at real SQLite BEGIN");
      assert.deepEqual(results.map((result) => result.res.code).sort(), ["CONFLICT", "OK"]);
      assert.equal(results.filter((result) => result.res.ok).length, 1);
      const winnerIndex = results.findIndex((result) => result.res.ok);
      const loserIndex = 1 - winnerIndex;
      const winner = contenders[winnerIndex];
      const loser = contenders[loserIndex];
      assert.deepEqual(results[winnerIndex].transactions, { begin: 1, commit: 1, rollback: 0 });
      assert.deepEqual(results[loserIndex].transactions, { begin: 1, commit: 0, rollback: 1 });
      assert.ok(results.every((result) => !result.inTransaction), "neither connection retains a transaction");
      const winningRecord = results[winnerIndex].res.data?.record;
      assertObject(winningRecord);
      assert.ok(typeof winningRecord.id === "string");
      const newId = winningRecord.id;
      const oldView = getRecord(ctx.db, ctx.config, { id: original, scope: "personal/default" });
      assert.equal(oldView.ok, true, JSON.stringify(oldView));
      const oldRecord = oldView.data?.record;
      assertObject(oldRecord);
      assert.equal(oldRecord.status, "superseded");
      assert.equal(oldRecord.body, originalBody);
      const newView = getRecord(ctx.db, ctx.config, { id: newId, scope: "personal/default" });
      assert.equal(newView.ok, true, JSON.stringify(newView));
      const newRecord = newView.data?.record;
      assertObject(newRecord);
      assert.equal(newRecord.status, "active");
      assert.equal(newRecord.supersedes, original);
      assert.equal(newRecord.revision, 2);
      assert.equal(newRecord.body, winner.params.body);
      assert.deepEqual(newRecord.sourceRefs, [winner.eventId]);
      assert.deepEqual(newRecord.links, [winner.link]);
      const listed = listRecords(ctx.db, ctx.config, { scope: "personal/default", limit: 25 });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      const items = listed.data?.items;
      assert.ok(Array.isArray(items));
      const activeIds = items.map((item: unknown) => {
        assertObject(item);
        assert.ok(typeof item.id === "string");
        return item.id;
      }).sort();
      assert.deepEqual(activeIds, [leftLink, rightLink, newId].sort());
      const recalledRes = recallRecords(ctx.db, ctx.config, {
        query: "shared correction race",
        scope: "personal/default",
        limit: 10,
      });
      assert.equal(recalledRes.ok, true, JSON.stringify(recalledRes));
      const recalledItems = (recalledRes.data as { items: Array<{ id: string; revision: number; kind: string }> }).items;
      const recalled = recalledItems.map((i) => i.id);
      assert.ok(recalled.includes(newId));
      assert.ok(!recalled.includes(original));
      // Recall items expose the source record identity (F-I01-01 additions):
      // revision and kind match record.get exactly, and the corrected record's
      // recall item is the successor revision 2 (citation pinned to the used
      // revision; model_inference entries are distinguishable from user_fact).
      const winnerRecalled = recalledItems.find((i) => i.id === newId);
      assert.ok(winnerRecalled, "corrected successor must appear in recall");
      assert_equal_record_view(winnerRecalled, newRecord);
      const leftRecalled = recalledItems.find((i) => i.id === leftLink);
      assert.ok(leftRecalled, "uncorrected record must appear in recall");
      const leftView = getRecord(ctx.db, ctx.config, { id: leftLink, scope: "personal/default" });
      assert.equal(leftView.ok, true, JSON.stringify(leftView));
      assert_equal_record_view(leftRecalled, leftView.data?.record as Record<string, unknown>);

      const count = (sql: string, ...args: string[]): number => {
        const row = ctx.db.prepare(sql).get(...args);
        assert.ok(row && typeof row.n === "number");
        return row.n;
      };
      assert.equal(count("SELECT COUNT(*) AS n FROM records"), 4);
      const revisions = ctx.db.prepare(
        "SELECT id, status, supersedes, revision FROM records WHERE kind='correction' OR supersedes IS NOT NULL",
      ).all().map((row) => ({ ...row }));
      assert.deepEqual(revisions, [{ id: newId, status: "active", supersedes: original, revision: 2 }]);
      assert.equal(count("SELECT COUNT(*) AS n FROM records WHERE body=?", loser.params.body), 0);
      assert.equal(count("SELECT COUNT(*) AS n FROM record_source_refs WHERE eventId=?", loser.eventId), 0);
      assert.equal(count("SELECT COUNT(*) AS n FROM record_links WHERE toRef=?", loser.link), 0);
      assert.equal(count(`SELECT COUNT(*) AS n FROM record_source_refs s
        LEFT JOIN records r ON r.id=s.recordId LEFT JOIN raw_events e ON e.eventId=s.eventId
        WHERE r.id IS NULL OR e.eventId IS NULL`), 0);
      assert.equal(count(`SELECT COUNT(*) AS n FROM record_links l
        LEFT JOIN records r ON r.id=l.fromId LEFT JOIN records target ON target.id=l.toRef
        WHERE r.id IS NULL OR target.id IS NULL`), 0);
      assert.equal(count("SELECT COUNT(*) AS n FROM record_links"), 1);
      assert.equal(count("SELECT COUNT(*) AS n FROM record_source_refs"), 4);
      assert.equal(count("SELECT COUNT(*) AS n FROM note_heat"), 4);
      for (const [table, column] of [
        ["note_heat", "recordId"], ["projection_queue", "recordId"],
        ["fts_notes", "recordId"], ["char_bigrams", "id"],
      ]) {
        const kind = table === "char_bigrams" ? "AND d.kind='note'" : "";
        assert.equal(count(`SELECT COUNT(*) AS n FROM ${table} d
          LEFT JOIN records r ON r.id=d.${column} WHERE r.id IS NULL ${kind}`), 0, `${table} has no orphan`);
      }
      const operations = ctx.db.prepare(
        "SELECT idempotencyKey, responseJson FROM operations WHERE op='record.correct'",
      ).all();
      assert.equal(operations.length, 1);
      assert.equal(operations[0].idempotencyKey, winner.key);
      assert.equal(count("SELECT COUNT(*) AS n FROM operations WHERE idempotencyKey=?", loser.key), 0);
      const storedResponse = operations[0].responseJson;
      assert.ok(typeof storedResponse === "string");
      assert.deepEqual(JSON.parse(storedResponse), results[winnerIndex].res);
      const audit = ctx.db.prepare(
        "SELECT targetId, code, runId FROM audit WHERE op='record.correct'",
      ).all().map((row) => ({ ...row }));
      assert.deepEqual(audit, [{ targetId: newId, code: "OK", runId: winner.key }]);
      assert.equal(count("SELECT COUNT(*) AS n FROM audit WHERE runId=? AND code='OK'", loser.key), 0);
      t.diagnostic(`shared file ${ctx.config.dbPath}; independent workers ${ready.map((message) => message.threadId).join("/")}; BEGIN barrier=2; OK=1/CONFLICT=1; loser ROLLBACK=1; loser revision/ref/link/operation/audit success=0`);
    } finally {
      try {
        await Promise.all(workers.map((worker) => worker.terminate()));
      } finally {
        ctx.cleanup();
        assert.ok(!fs.existsSync(ctx.dir), "shared DB, sidecars and vault are removed");
        t.diagnostic(`temporary DB/vault fixture removed: ${ctx.dir}`);
      }
    }
  });

  it("rejects non-correction kinds and missing targets", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config, "corr-ev-bad");
      const badKind = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: "rec_nothing",
          body: "text",
          kind: "user_fact",
          provenance: { source: "session:s1:turn:9", observedAt: OBS },
          scope: "personal/default",
          sourceRefs: ["corr-ev-bad"],
        },
        "corr-bad",
      );
      assert.equal(badKind.code, "BAD_REQUEST");
      raw(ctx.db, ctx.config, "corr-ev-corr-miss");
      const missing = correct(ctx.db, ctx.config, "rec_nothing", "some correction text", "corr-miss");
      assert.equal(missing.code, "NOT_FOUND");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("archive atomicity and idempotency", () => {
  it("archives terminally, hides from recall/list, keeps the row", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "archivable note about fern care", "arc-a");
      assert.ok(recallIds(ctx.db, ctx.config, "fern care").includes(id));
      const done = archiveRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "USER_ARCHIVED" }, "arc-k1");
      assert.equal(done.ok, true, JSON.stringify(done));
      const view = getRecord(ctx.db, ctx.config, { id, scope: "personal/default" });
      assert.equal((view.data as { record: { status: string } }).record.status, "archived");
      assert.ok(!recallIds(ctx.db, ctx.config, "fern care").includes(id));
      const listed = listRecords(ctx.db, ctx.config, { scope: "personal/default", limit: 25 });
      assert.ok(!((listed.data as { items: Array<{ id: string }> }).items).map((i) => i.id).includes(id));
      const replay = archiveRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "USER_ARCHIVED" }, "arc-k1");
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      const again = archiveRecord(ctx.db, ctx.config, { id, scope: "personal/default", reasonCode: "OBSOLETE" }, "arc-k2");
      assert.equal(again.code, "CONFLICT");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("feedback exposure validation; heat only on feedback", () => {
  it("counts exposed ids, heats them, and rejects everything else", () => {
    const ctx = setup(["work/default"]);
    try {
      const id = remember(ctx.db, ctx.config, "feedback target persimmon recipe", "fb-a");
      assert.equal(heatOf(ctx.db, id), 0);
      const rec = recallRecords(ctx.db, ctx.config, { query: "persimmon recipe", scope: "personal/default", limit: 10 });
      assert.equal(rec.ok, true);
      const recallId = (rec.data as { recallId: string }).recallId;
      assert.equal(typeof recallId, "string");
      // Mere recall adds no heat.
      assert.equal(heatOf(ctx.db, id), 0);
      const ok = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "personal/default" }, "fb-k1");
      assert.equal(ok.ok, true, JSON.stringify(ok));
      assert.equal((ok.data as { feedback: { counted: number } }).feedback.counted, 1);
      assert.equal(heatOf(ctx.db, id), 1);
      const replay = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "personal/default" }, "fb-k1");
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      // Unknown recall, outside-exposure id, and cross-scope report all fail atomically.
      assert.equal(
        feedbackRecords(ctx.db, ctx.config, { recallId: "recall_nope", recordIds: [id], scope: "personal/default" }, "fb-k2").code,
        "NOT_FOUND",
      );
      assert.equal(
        feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: ["rec_nope"], scope: "personal/default" }, "fb-k3").code,
        "NOT_FOUND",
      );
      assert.equal(
        feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "work/default" }, "fb-k4").code,
        "FORBIDDEN_SCOPE",
      );
      assert.equal(heatOf(ctx.db, id), 1);
    } finally {
      ctx.cleanup();
    }
  });

describe("raw descent respects the requested time window", () => {
  it("an old record found only through raw text does not surface outside since/until", () => {
    const ctx = setup();
    try {
      const token = "windowed xylophone zebra qzxw";
      const ev = eventAppend(
        ctx.db,
        ctx.config,
        {
          eventId: "e-windowed",
          sessionId: "s1",
          turnId: "t7",
          body: `${token} parade ground notes`,
          provenance: { source: "session:s1:turn:7", observedAt: OBS },
          scope: "personal/default",
        },
        "ev-windowed",
      );
      assert.equal(ev.ok, true);
      const oldCreatedAt = "2026-01-10T00:00:00.000Z";
      const res = rememberRecord(
        ctx.db,
        ctx.config,
        {
          body: "quiet memo about hallway plants",
          kind: "user_fact",
          provenance: { source: "session:s1:turn:8", observedAt: OBS },
          scope: "personal/default",
          sourceRefs: ["e-windowed"],
        },
        "rem-windowed",
        oldCreatedAt,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const id = (res.data as { record: { id: string } }).record.id;
      // Sanity: raw-only term resolves without a window.
      assert.ok(recallIds(ctx.db, ctx.config, "windowed xylophone").includes(id));
      // Inclusive since at the exact createdAt still matches.
      const atSince = recallIds(ctx.db, ctx.config, "windowed xylophone", { since: oldCreatedAt });
      assert.ok(atSince.includes(id), JSON.stringify(atSince));
      // A later since window excludes the old record.
      const afterSince = recallIds(ctx.db, ctx.config, "windowed xylophone", {
        since: "2026-06-01T00:00:00.000Z",
      });
      assert.ok(!afterSince.includes(id), JSON.stringify(afterSince));
      // Exclusive until at the exact createdAt excludes the old record.
      const atUntil = recallIds(ctx.db, ctx.config, "windowed xylophone", { until: oldCreatedAt });
      assert.ok(!atUntil.includes(id), JSON.stringify(atUntil));
      // A covering window still matches.
      const covered = recallIds(ctx.db, ctx.config, "windowed xylophone", {
        since: "2026-01-01T00:00:00.000Z",
        until: "2026-06-01T00:00:00.000Z",
      });
      assert.ok(covered.includes(id), JSON.stringify(covered));
    } finally {
      ctx.cleanup();
    }
  });
});

describe("canonical bodyNorm fallback without derived indexes", () => {
  it("recalls the committed record deterministically with snippets only", () => {
    const ctx = setup();
    try {
      const rawSecret = "fallback raw secret payload kjqx";
      const ev = eventAppend(
        ctx.db,
        ctx.config,
        {
          eventId: "e-fallback-raw",
          sessionId: "s1",
          turnId: "t7",
          body: `${rawSecret} background chatter`,
          provenance: { source: "session:s1:turn:7", observedAt: OBS },
          scope: "personal/default",
        },
        "ev-fallback-raw",
      );
      assert.equal(ev.ok, true);
      const bodyMark = "canonical fallback quartz lantern ledger qzvf";
      const res = rememberRecord(
        ctx.db,
        ctx.config,
        {
          body: `${bodyMark} keeps evening notes`,
          kind: "user_fact",
          provenance: { source: "session:s1:turn:8", observedAt: OBS },
          scope: "personal/default",
          sourceRefs: ["e-fallback-raw"],
        },
        "rem-fallback",
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const id = (res.data as { record: { id: string } }).record.id;
      assert.ok(recallIds(ctx.db, ctx.config, "quartz lantern ledger").includes(id));
      // Drop every derived lexical row after commit; canonical rows stay.
      ctx.db.exec(`DELETE FROM fts_notes`);
      ctx.db.exec(`DELETE FROM fts_raw`);
      ctx.db.exec(`DELETE FROM char_bigrams`);
      const first = recallRecords(ctx.db, ctx.config, {
        query: "quartz lantern ledger",
        scope: "personal/default",
        limit: 10,
      });
      assert.equal(first.ok, true, JSON.stringify(first));
      const firstIds = ((first.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
      assert.ok(firstIds.includes(id), JSON.stringify(firstIds));
      const second = recallRecords(ctx.db, ctx.config, {
        query: "quartz lantern ledger",
        scope: "personal/default",
        limit: 10,
      });
      assert.equal(second.ok, true, JSON.stringify(second));
      const secondIds = ((second.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
      assert.deepEqual(secondIds, firstIds);
      // Snippets only: no canonical body key, no raw text exposure.
      const items = (first.data as {
        items: Array<{ id: string; snippet: string; truncated: boolean; tags: string[]; createdAt: string }>;
      }).items;
      for (const it of items) {
        // F-I01-01 additive record-identity fields join the adopted snippet
        // contract; no body/raw-text keys appear.
        assert.deepEqual(Object.keys(it).sort(), [
          "createdAt",
          "id",
          "kind",
          "revision",
          "snippet",
          "tags",
          "truncated",
        ]);
        assert.equal(typeof it.snippet, "string");
        assert.ok([...it.snippet].length <= ctx.config.limits.snippetMaxCp);
      }
      assert.equal(JSON.stringify(first.data).includes(rawSecret), false);
      assert.equal(JSON.stringify(ctx.db.prepare(`SELECT * FROM audit`).all()).includes(bodyMark), false);
      assert.equal(JSON.stringify(ctx.db.prepare(`SELECT * FROM exposures`).all()).includes(bodyMark), false);
    } finally {
      ctx.cleanup();
    }
  });
});

  it("repeat feedback under a new key does not double-heat the same exposure", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "duplicate feedback heat check persimmon", "fb-dup-a");
      const rec = recallRecords(ctx.db, ctx.config, { query: "persimmon heat", scope: "personal/default", limit: 10 });
      assert.equal(rec.ok, true);
      const recallId = (rec.data as { recallId: string }).recallId;
      const first = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "personal/default" }, "fb-dup-k1");
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(heatOf(ctx.db, id), 1);
      // Same exposure reported again under a fresh idempotency key: accepted
      // but usage stays unique per (recallId, recordId) so heat is unchanged.
      const second = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "personal/default" }, "fb-dup-k2");
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(heatOf(ctx.db, id), 1);
      const usageRows = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM usage WHERE recallId = ? AND recordId = ?`)
        .get(recallId, id) as { n: number };
      assert.equal(usageRows.n, 1);
      // Same-key replay stays deduplicated with no extra heat.
      const replay = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id], scope: "personal/default" }, "fb-dup-k1");
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      assert.equal(heatOf(ctx.db, id), 1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("shared-file concurrent correction race", () => {
  interface RaceReady { ready: boolean; threadId: number; dbFile: string; status: string | null }
  interface RaceResult {
    res: { ok: boolean; code: string; data?: unknown; deduplicated?: boolean };
    begin: number; commit: number; rollback: number; isTransaction: unknown; threadId: number;
  }
  type RaceSettled<T> = { ok: true; value: T } | { ok: false; error: unknown };
  // ONE shared actual worker lifecycle, parameterized by config/params/key/
  // barrier. Both the genuine same-DB race and the real bad-DB failure test
  // use this helper: settled outcomes bind immediately, sync spawn failure
  // rejects both outcomes, success resolves only after an actual code-0 exit
  // with ready+result observed, and every physical exit is recorded so temp
  // fixtures are removed only after workers actually exited.
  function launchRaceContender(opts: {
    workerPath: string;
    config: AppConfig;
    params: Record<string, unknown>;
    key: string;
    barrier: SharedArrayBuffer;
    workers: Worker[];
    settledSink: Array<Promise<unknown>>;
    exits: number[];
  }): {
    readyP: Promise<RaceReady>;
    doneP: Promise<RaceResult>;
    readySettled: Promise<RaceSettled<RaceReady>>;
    doneSettled: Promise<RaceSettled<RaceResult>>;
  } {
    let readyResolve!: (v: RaceReady) => void;
    let readyReject!: (e: unknown) => void;
    let doneResolve!: (v: RaceResult) => void;
    let doneReject!: (e: unknown) => void;
    const readyP = new Promise<RaceReady>((resolve, reject) => {
      readyResolve = resolve;
      readyReject = reject;
    });
    const doneP = new Promise<RaceResult>((resolve, reject) => {
      doneResolve = resolve;
      doneReject = reject;
    });
    // Attach settled-outcome handlers IMMEDIATELY (before spawn) so both
    // readiness and completion always have a rejection handler even when
    // the later awaits never attach (ready failure / pre-start assert
    // failure). Outcomes preserve the real error for propagation.
    const readySettled: Promise<RaceSettled<RaceReady>> = readyP.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    const doneSettled: Promise<RaceSettled<RaceResult>> = doneP.then(
      (value) => ({ ok: true as const, value }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    opts.settledSink.push(readySettled, doneSettled);
    let ready: RaceReady | null = null;
    let result: RaceResult | null = null;
    let worker: Worker;
    try {
      worker = new Worker(opts.workerPath, {
        workerData: { config: opts.config, params: opts.params, idempotencyKey: opts.key, barrier: opts.barrier },
      });
    } catch (err) {
      readyReject(err);
      doneReject(err);
      throw err;
    }
    opts.workers.push(worker);
    worker.once("error", readyReject);
    worker.once("exit", (code) => {
      opts.exits.push(code);
      // The result resolves only AFTER a successful worker exit.
      if (code === 0 && ready && result) doneResolve(result);
      else {
        const err = new Error(`race worker exited code=${code} ready=${ready !== null} result=${result !== null}`);
        try {
          readyReject(err);
        } catch {
          /* ignore */
        }
        doneReject(err);
      }
    });
    worker.on("message", (msg: unknown) => {
      const m = msg as { ready?: boolean } & RaceReady & RaceResult & { res?: RaceResult["res"] };
      try {
        if (m && typeof m === "object" && "res" in m && m.res && typeof m.res === "object") {
          result = m as unknown as RaceResult;
        } else if (m && typeof m === "object" && (m as { ready?: unknown }).ready === true) {
          ready = m as unknown as RaceReady;
          readyResolve(ready);
        }
      } catch {
        /* ignore */
      }
    });
    return { readyP, doneP, readySettled, doneSettled };
  }
  it("exactly one of two simultaneous same-file corrections wins; the loser leaves zero residue", async () => {
    // Genuine same-file concurrency: two worker threads each open their OWN
    // DatabaseSync on the same temp file and call the REAL correctRecord with
    // distinct keys, own raw source events, and distinct replacement
    // body/link/runId. A shared rendezvous holds both contenders at native
    // BEGIN until both have arrived, so the conditional status flip arbitrates
    // exactly one winner. This is the concurrent counterpart of the existing
    // sequential replay tests (which are preserved untouched); it never
    // duplicates them and never uses echo/tautology assertions.
    const ctx = setup();
    const workers: Worker[] = [];
    const allSettled: Array<Promise<unknown>> = [];
    const exits: number[] = [];
    const barrier = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const barr = new Int32Array(barrier);
    const failAfterMs = 60000;
    function failTimeout<T>(p: Promise<T>, what: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`correction race: ${what} timed out`)), failAfterMs);
        try {
          (timer as unknown as { unref?: () => void }).unref?.();
        } catch {
          /* ignore */
        }
        p.then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });
    }
    const watchdog = setTimeout(() => {
      try {
        Atomics.store(barr, 0, 1);
        Atomics.store(barr, 1, 2);
        Atomics.notify(barr, 0);
      } catch {
        /* ignore */
      }
      for (const w of workers) {
        try {
          void w.terminate();
        } catch {
          /* ignore */
        }
      }
    }, failAfterMs);
    try {
      // Setup: left/right link records and the original active record.
      const left = remember(ctx.db, ctx.config, "race left anchor harbor memo", "race-left");
      const right = remember(ctx.db, ctx.config, "race right anchor harbor memo", "race-right");
      const origBody = "race original canyon memo noon sharp";
      const orig = remember(ctx.db, ctx.config, origBody, "race-orig");
      raw(ctx.db, ctx.config, "race-src-a");
      raw(ctx.db, ctx.config, "race-src-b");
      const paramsA: Record<string, unknown> = {
        recordId: orig,
        body: "race canyon verdict alpha orchard",
        kind: "correction",
        provenance: { source: "session:s1:turn:9", observedAt: OBS },
        scope: "personal/default",
        links: [left],
        sourceRefs: ["race-src-a"],
        runId: "race-run-a",
      };
      const paramsB: Record<string, unknown> = {
        recordId: orig,
        body: "race canyon verdict beta orchard",
        kind: "correction",
        provenance: { source: "session:s1:turn:9", observedAt: OBS },
        scope: "personal/default",
        links: [right],
        sourceRefs: ["race-src-b"],
        runId: "race-run-b",
      };
      const workerPath = path.join(__dirname, "fixtures", "correction-race-worker.js");
      function launch(params: Record<string, unknown>, key: string): ReturnType<typeof launchRaceContender> {
        return launchRaceContender({
          workerPath,
          config: ctx.config,
          params,
          key,
          barrier,
          workers,
          settledSink: allSettled,
          exits,
        });
      }
      const a = launch(paramsA, "race-key-a");
      let b: ReturnType<typeof launch> | undefined;
      try {
        b = launch(paramsB, "race-key-b");
      } catch (err) {
        // Synchronous second-spawn failure: consume the first worker's
        // settlements so its promises never reject unhandled, then propagate
        // the real spawn error. Cleanup in finally still terminates/joins.
        await Promise.allSettled(allSettled);
        throw err;
      }
      assert.ok(b, "second contender must launch");
      const [readyA, readyB] = await Promise.all([
        failTimeout(a.readyP, "contender A ready"),
        failTimeout(b.readyP, "contender B ready"),
      ]);
      // Both contenders run on real distinct worker threads against the same
      // actual database file (junction-safe: resolve BOTH reported paths),
      // with the target still active and no BEGIN executed yet.
      for (const r of [readyA, readyB]) {
        assert.equal(r.ready, true);
        assert.ok(Number.isInteger(r.threadId) && r.threadId > 0, `positive threadId: ${JSON.stringify(r)}`);
        assert.equal(r.status, "active");
        assert.equal(fs.realpathSync(r.dbFile), fs.realpathSync(ctx.config.dbPath));
      }
      assert.notEqual(readyA.threadId, readyB.threadId, "contenders must run on distinct threads");
      assert.equal(Atomics.load(barr, 1), 0, "BEGIN executed before the start release");
      // Release the start gate: both real BEGINs rendezvous, then arbitrate.
      Atomics.store(barr, 0, 1);
      Atomics.notify(barr, 0);
      const [doneA, doneB] = await Promise.all([
        failTimeout(a.doneP, "contender A result"),
        failTimeout(b.doneP, "contender B result"),
      ]);
      // Two real BEGINs arrived; exactly one OK and one CONFLICT.
      assert.equal(Atomics.load(barr, 1), 2, "expected exactly 2 real BEGIN arrivals");
      const oks = [doneA.res.ok, doneB.res.ok];
      assert.deepEqual([...oks].sort(), [false, true]);
      const winnerIdx = doneA.res.ok ? 0 : 1;
      const married = [
        { done: doneA, params: paramsA, key: "race-key-a", word: "alpha" },
        { done: doneB, params: paramsB, key: "race-key-b", word: "beta" },
      ];
      const winner = married[winnerIdx] as (typeof married)[number];
      const loser = married[1 - winnerIdx] as (typeof married)[number];
      assert.equal(loser.done.res.ok, false);
      assert.equal(loser.done.res.code, "CONFLICT", JSON.stringify(loser.done.res));
      // Native transaction counters: winner begin1/commit1/rollback0, loser
      // begin1/commit0/rollback1, both connections closed cleanly.
      assert.deepEqual(
        [winner.done.begin, winner.done.commit, winner.done.rollback],
        [1, 1, 0],
        JSON.stringify(winner.done),
      );
      assert.deepEqual(
        [loser.done.begin, loser.done.commit, loser.done.rollback],
        [1, 0, 1],
        JSON.stringify(loser.done),
      );
      assert.equal(winner.done.isTransaction, false);
      assert.equal(loser.done.isTransaction, false);
      const winnerBody = winner.params["body"] as string;
      const winnerLink = (winner.params["links"] as string[])[0] as string;
      const winnerRef = (winner.params["sourceRefs"] as string[])[0] as string;
      const winnerRun = winner.params["runId"] as string;
      const loserBody = loser.params["body"] as string;
      const loserRef = (loser.params["sourceRefs"] as string[])[0] as string;
      const loserLink = (loser.params["links"] as string[])[0] as string;
      const loserRun = loser.params["runId"] as string;
      const loserWord = loser.word;
      const newId = (winner.done.res.data as { record: { id: string } }).record.id;
      // Winning canonical shape: old superseded with unchanged body;
      // replacement active, revision 2, exact winning body/sourceRef/link.
      const oldRow = ctx.db.prepare(`SELECT body, status, revision FROM records WHERE id = ?`).get(orig) as
        | { body: string; status: string; revision: number }
        | undefined;
      assert.ok(oldRow);
      assert.equal(oldRow?.status, "superseded");
      assert.equal(oldRow?.body, origBody);
      const newRow = ctx.db.prepare(
        `SELECT body, kind, status, supersedes, revision FROM records WHERE id = ?`,
      ).get(newId) as
        | { body: string; kind: string; status: string; supersedes: string | null; revision: number }
        | undefined;
      assert.ok(newRow);
      assert.equal(newRow?.status, "active");
      assert.equal(newRow?.kind, "correction");
      assert.equal(newRow?.supersedes, orig);
      assert.equal(newRow?.revision, 2);
      assert.equal(newRow?.body, winnerBody);
      // Consumer-visible: active list is only left/right/new, get works, and
      // recall includes the replacement but never the superseded revision.
      assert.deepEqual(new Set(list(ctx.db, ctx.config)), new Set([left, right, newId]));
      assert.equal(get(ctx.db, ctx.config, newId)["id"], newId);
      const hits = recallIds(ctx.db, ctx.config, "race canyon verdict");
      assert.ok(hits.includes(newId), JSON.stringify(hits));
      assert.ok(!hits.includes(orig), JSON.stringify(hits));
      // Exact cardinalities: 4 records, 4 source refs, 4 heat rows, 1 link,
      // and a single correction revision.
      const count = (sql: string): number =>
        (ctx.db.prepare(sql).get() as { n: number }).n;
      assert.equal(count(`SELECT COUNT(*) AS n FROM records`), 4);
      assert.equal(count(`SELECT COUNT(*) AS n FROM record_source_refs`), 4);
      assert.equal(count(`SELECT COUNT(*) AS n FROM note_heat`), 4);
      assert.equal(count(`SELECT COUNT(*) AS n FROM record_links`), 1);
      assert.equal(count(`SELECT COUNT(*) AS n FROM records WHERE kind = 'correction'`), 1);
      assert.deepEqual(
        (ctx.db.prepare(`SELECT fromId, toRef FROM record_links`).all() as Array<{ fromId: string; toRef: string }>).map(
          (r) => [r.fromId, r.toRef],
        ),
        [[newId, winnerLink]],
      );
      assert.deepEqual(
        (ctx.db.prepare(`SELECT recordId FROM record_source_refs WHERE eventId = ?`).all(winnerRef) as Array<{ recordId: string }>).map((r) => r.recordId),
        [newId],
      );
      // ZERO loser residue: no canonical body/ref/link/operation/success audit.
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE body = ?`).get(loserBody) as { n: number }).n,
        0,
      );
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM record_source_refs WHERE eventId = ?`).get(loserRef) as { n: number }).n,
        0,
      );
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM record_links WHERE toRef = ?`).get(loserLink) as { n: number }).n,
        0,
      );
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM operations WHERE idempotencyKey = ?`).get(loser.key) as { n: number }).n,
        0,
      );
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM audit WHERE runId = ?`).get(loserRun) as { n: number }).n,
        0,
      );
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM fts_notes WHERE body LIKE ?`).get(`%${loserWord}%`) as { n: number }).n,
        0,
      );
      // ZERO orphans across derived ledgers: every heat/queue/fts/bigram/ref
      // row belongs to a surviving canonical record.
      const known = new Set([left, right, orig, newId]);
      for (const r of ctx.db.prepare(`SELECT recordId FROM note_heat`).all() as Array<{ recordId: string }>) {
        assert.ok(known.has(r.recordId), `orphan heat ${r.recordId}`);
      }
      const queued = (ctx.db.prepare(`SELECT recordId FROM projection_queue`).all() as Array<{ recordId: string }>).map((r) => r.recordId);
      assert.deepEqual(new Set(queued), new Set([left, right, orig, newId]));
      for (const r of ctx.db.prepare(`SELECT recordId FROM fts_notes`).all() as Array<{ recordId: string }>) {
        assert.ok(known.has(r.recordId), `orphan fts ${r.recordId}`);
      }
      assert.equal(count(`SELECT COUNT(*) AS n FROM fts_notes`), 4);
      for (const r of ctx.db.prepare(`SELECT DISTINCT id FROM char_bigrams WHERE kind = 'note'`).all() as Array<{ id: string }>) {
        assert.ok(known.has(r.id), `orphan bigram ${r.id}`);
      }
      for (const r of ctx.db.prepare(`SELECT recordId FROM record_source_refs`).all() as Array<{ recordId: string }>) {
        assert.ok(known.has(r.recordId), `orphan ref ${r.recordId}`);
      }
      // Only the winning correction operation stores the actual response, and
      // only the winning runId owns the OK audit row.
      const opRows = ctx.db.prepare(`SELECT idempotencyKey, op, responseJson FROM operations WHERE op = 'record.correct'`).all() as Array<{
        idempotencyKey: string; op: string; responseJson: string;
      }>;
      assert.equal(opRows.length, 1);
      assert.equal(opRows[0]?.idempotencyKey, winner.key);
      assert.deepEqual(JSON.parse(opRows[0]?.responseJson as string), winner.done.res);
      const auditRows = (ctx.db.prepare(`SELECT code, runId FROM audit WHERE op = 'record.correct'`).all() as Array<{
        code: string; runId: string | null;
      }>).map((r) => [r.code, r.runId]);
      assert.equal(auditRows.length, 1);
      assert.deepEqual(auditRows, [["OK", winnerRun]]);
      // Same-key winner replay against the REAL store: deduplicated with the
      // same canonical ID and no new canonical/operation rows.
      const replay = correctRecord(ctx.db, ctx.config, winner.params, winner.key);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.equal(replay.deduplicated, true, JSON.stringify(replay));
      assert.equal((replay.data as { record: { id: string } }).record.id, newId);
      assert.equal(count(`SELECT COUNT(*) AS n FROM records`), 4);
      // Both genuine contenders physically exited 0 before inspect/cleanup:
      // each success resolved only after its actual exit event.
      assert.deepEqual(exits, [0, 0], JSON.stringify(exits));
    } finally {
      clearTimeout(watchdog);
      try {
        Atomics.store(barr, 0, 1);
        Atomics.store(barr, 1, 2);
        Atomics.notify(barr, 0);
      } catch {
        /* ignore */
      }
      // Consume every settlement (ready + completion of both contenders)
      // before joining, so a readiness/assert failure never leaves a worker
      // error/exit/termination rejection unawaited.
      try {
        await Promise.allSettled(allSettled);
      } catch {
        /* ignore */
      }
      for (const w of workers) {
        try {
          await w.terminate();
        } catch {
          /* ignore */
        }
      }
      ctx.cleanup();
    }
  });

  it("worker lifecycle failure before ready settles every outcome with no leaks", async () => {
    // Native failure-edge counterpart using the SAME launch lifecycle: both
    // contenders open a REAL DatabaseSync on an invalid temp DB path, so the
    // actual SQLite open fails BEFORE ready. The primary error is awaited via
    // settled outcomes (not a bare throw), every completion is consumed, both
    // workers actually exit, and fixtures are removed.
    const ctx = setup();
    const workers: Worker[] = [];
    const exits: number[] = [];
    const failSettled: Array<Promise<unknown>> = [];
    const barrier = new SharedArrayBuffer(2 * Int32Array.BYTES_PER_ELEMENT);
    const barr = new Int32Array(barrier);
    const failAfterMs = 60000;
    function failTimeout<T>(p: Promise<T>, what: string): Promise<T> {
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error(`correction race failure-edge: ${what} timed out`)), failAfterMs);
        try {
          (timer as unknown as { unref?: () => void }).unref?.();
        } catch {
          /* ignore */
        }
        p.then(
          (v) => {
            clearTimeout(timer);
            resolve(v);
          },
          (e) => {
            clearTimeout(timer);
            reject(e);
          },
        );
      });
    }
    const watchdog = setTimeout(() => {
      try {
        Atomics.store(barr, 0, 1);
        Atomics.store(barr, 1, 2);
        Atomics.notify(barr, 0);
      } catch {
        /* ignore */
      }
      for (const w of workers) {
        try {
          void w.terminate();
        } catch {
          /* ignore */
        }
      }
    }, failAfterMs);
    try {
      (watchdog as unknown as { unref?: () => void }).unref?.();
    } catch {
      /* ignore */
    }
    const workerPath = path.join(__dirname, "fixtures", "correction-race-worker.js");
    // Invalid temp DB path: parent directory does not exist, so the worker's
    // real DatabaseSync open throws natively before any ready post. The
    // recordId is a valid non-empty string so the failure is the native
    // SQLite open, never the fixture's params validation.
    const badConfig: AppConfig = { ...ctx.config, dbPath: path.join(ctx.dir, "missing-parent", "t.db") };
    const badParams: Record<string, unknown> = { recordId: "missing-target" };
    function launchBad(idempotencyKey: string): ReturnType<typeof launchRaceContender> {
      return launchRaceContender({
        workerPath,
        config: badConfig,
        params: badParams,
        key: idempotencyKey,
        barrier,
        workers,
        settledSink: failSettled,
        exits,
      });
    }
    let fa: ReturnType<typeof launchBad>;
    let fb: ReturnType<typeof launchBad> | undefined;
    try {
      try {
        fa = launchBad("race-fail-a");
      } catch (err) {
        await Promise.allSettled(failSettled);
        throw err;
      }
      try {
        fb = launchBad("race-fail-b");
      } catch (err) {
        await Promise.allSettled(failSettled);
        throw err;
      }
      assert.ok(fb, "second failing contender must launch");
      // Primary errors awaited as settled outcomes (never a bare throw):
      // readiness must fail for BOTH contenders before any result.
      const [ra, rb] = await Promise.all([
        failTimeout(fa.readySettled, "failing contender A readiness settles"),
        failTimeout(fb.readySettled, "failing contender B readiness settles"),
      ]);
      assert.equal(ra.ok, false, "contender A readiness must settle as failure");
      assert.equal(rb.ok, false, "contender B readiness must settle as failure");
      assert.ok(ra.ok === false && ra.error instanceof Error, JSON.stringify(ra));
      assert.ok(rb.ok === false && rb.error instanceof Error, JSON.stringify(rb));
      // Preserved actual native SQLite open identity (observed at runtime:
      // worker 'error' event carries code ERR_SQLITE_ERROR, errcode 14,
      // "unable to open database file"). This rejects a fixture validation
      // error or any generic exit wording as the readiness cause.
      for (const r of [ra, rb]) {
        assert.ok(r.ok === false, JSON.stringify(r));
        const err = (r as { ok: false; error: unknown }).error as Error & { code?: unknown; errcode?: unknown };
        assert.equal((err as { code?: unknown }).code, "ERR_SQLITE_ERROR", String(err?.message));
        assert.equal((err as { errcode?: unknown }).errcode, 14, String(err?.message));
        assert.ok(/unable to open database file/.test(err.message), JSON.stringify(err.message));
        assert.ok(!/params\.recordId must be/.test(err.message), JSON.stringify(err.message));
      }
      // Completions consumed: both settle as failures, proving no completion
      // rejection is left unawaited. The meaningful failure proof is the
      // native readiness cause above plus the physical nonzero exits below.
      const [da, db] = await Promise.all([
        failTimeout(fa.doneSettled, "failing contender A completion settles"),
        failTimeout(fb.doneSettled, "failing contender B completion settles"),
      ]);
      assert.equal(da.ok, false, "contender A completion must settle as failure");
      assert.equal(db.ok, false, "contender B completion must settle as failure");
      assert.ok(da.ok === false && da.error instanceof Error, JSON.stringify(da));
      assert.ok(db.ok === false && db.error instanceof Error, JSON.stringify(db));
      // Both workers actually exited nonzero (native open failed) before any
      // fixture removal: physical exit proof, not message wording.
      assert.equal(exits.length, 2, `both failing workers must exit: ${JSON.stringify(exits)}`);
      for (const code of exits) assert.notEqual(code, 0);
      // No correction ran against the real DB file: zero race operations.
      const n = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM operations WHERE op = 'record.correct'`).get() as { n: number }).n;
      assert.equal(n, 0);
    } finally {
      clearTimeout(watchdog);
      try {
        Atomics.store(barr, 0, 1);
        Atomics.store(barr, 1, 2);
        Atomics.notify(barr, 0);
      } catch {
        /* ignore */
      }
      try {
        await Promise.allSettled(failSettled);
      } catch {
        /* ignore */
      }
      for (const w of workers) {
        try {
          await w.terminate();
        } catch {
          /* ignore */
        }
      }
      ctx.cleanup();
      assert.equal(fs.existsSync(ctx.dir), false, "failure-edge fixtures must be removed");
    }
  });
});
