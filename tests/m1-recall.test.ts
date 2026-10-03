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
        assert.deepEqual(Object.keys(it).sort(), ["createdAt", "id", "snippet", "tags", "truncated"]);
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
