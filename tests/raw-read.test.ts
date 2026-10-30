/**
 * P1 raw-read behavior: event.get paging, event.range cursor/filters,
 * event.append chunk conflicts + legacy hash compatibility, record.sources
 * span excerpts, and the legacy raw_events/record_source_refs migration.
 *
 * Public store behavior only, temp-only SQLite, deterministic timestamps.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import type { AppConfig } from "../src/config.js";
import { initDb, SCHEMA_VERSION } from "../src/db.js";
import { requestHashFor } from "../src/normalize.js";
import type { ResponseEnvelope } from "../src/protocol.js";
import {
  ensureM1Schema,
  eventAppend,
  getEvent,
  rangeEvents,
  recordSources,
  rememberRecord,
} from "../src/store.js";

const SCOPE = "personal/default";
const OTHER = "work/x";
const OBS = "2026-09-01T00:00:00.000Z";
let keyCtr = 0;

interface Chunk {
  docId: string;
  seq: number;
}

function baseConfig(dir: string, extraScopes: string[] = []): {
  config: AppConfig;
  configPath: string;
} {
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE, ...extraScopes],
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      linksMax: 10,
      sourceRefsMax: 10,
      limitDefault: 2,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 8192,
      rawBodyMaxCp: 8000,
      rawPageMaxCp: 10,
      rangeLimitMax: 4,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  return { config, configPath: path.join(dir, "memory.config.json") };
}

function setup(extraScopes: string[] = []): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-read-"));
  const { config, configPath } = baseConfig(dir, extraScopes);
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

function expectOk<T>(res: ResponseEnvelope): T {
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.data as T;
}

function expectCode(res: ResponseEnvelope, code: ResponseEnvelope["code"]): void {
  assert.equal(res.ok, false, JSON.stringify(res));
  assert.equal(res.code, code);
}

function append(
  db: DatabaseSync,
  config: AppConfig,
  overrides: Record<string, unknown> = {},
  key = `raw-${keyCtr++}`,
): ResponseEnvelope {
  return eventAppend(
    db,
    config,
    {
      eventId: "e1",
      sessionId: "s1",
      turnId: "t1",
      body: "raw body",
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: SCOPE,
      ...overrides,
    },
    key,
  );
}

function appendOk(
  db: DatabaseSync,
  config: AppConfig,
  eventId: string,
  observedAt: string,
  extra: Record<string, unknown> = {},
): void {
  const res = append(
    db,
    config,
    {
      eventId,
      provenance: { source: `session:${String(extra["sessionId"] ?? "s1")}:turn:1`, observedAt },
      ...extra,
    },
    `rr-${eventId}-${keyCtr++}`,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
}

function remember(
  db: DatabaseSync,
  config: AppConfig,
  key: string,
  body: string,
  sourceRefs: unknown[],
): ResponseEnvelope {
  return rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: SCOPE,
      sourceRefs,
    },
    key,
  );
}

interface EventGetData {
  eventId: string;
  totalCp: number;
  offset: number;
  body: string;
  nextOffset: number | null;
  chunk: Chunk | null;
}

interface RangeData {
  items: Array<{
    eventId: string;
    sessionId: string;
    observedAt: string;
    chunk: Chunk | null;
    totalCp: number;
    snippet: string;
    truncated: boolean;
  }>;
  nextCursor: string | null;
}

interface SourcesData {
  id: string;
  sources: Array<{
    eventId: string;
    span: { start: number; end: number } | null;
    excerpt: string;
    truncated: boolean;
    totalCp: number;
    missing?: boolean;
  }>;
}

describe("event.get paging", () => {
  it("multibyte + emoji pages concatenate exactly to the raw body", () => {
    const ctx = setup();
    try {
      const body = "Aé😀𠮷B🚀é";
      const total = [...body].length;
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-multi", body }).ok, true);

      const pages: EventGetData[] = [];
      let offset = 0;
      for (let guard = 0; guard < 20; guard++) {
        const page = expectOk<EventGetData>(
          getEvent(ctx.db, ctx.config, { eventId: "e-multi", scope: SCOPE, offset, maxCp: 3 }),
        );
        pages.push(page);
        offset = page.nextOffset ?? -1;
        if (page.nextOffset === null) break;
      }

      assert.ok(pages.length > 1, "body spans multiple pages");
      assert.equal(pages.map((p) => p.body).join(""), body);
      assert.equal([...pages.map((p) => p.body).join("")].length, total);
      for (const p of pages) {
        assert.ok([...p.body].length <= 3);
        assert.equal(p.totalCp, total);
      }
      assert.equal(pages[pages.length - 1]!.nextOffset, null);
      assert.equal(offset, -1);
    } finally {
      ctx.cleanup();
    }
  });

  it("offset == totalCp yields an empty body with nextOffset null", () => {
    const ctx = setup();
    try {
      const body = "abcdef";
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-eof", body }).ok, true);
      const data = expectOk<EventGetData>(
        getEvent(ctx.db, ctx.config, {
          eventId: "e-eof",
          scope: SCOPE,
          offset: [...body].length,
          maxCp: 2,
        }),
      );
      assert.equal(data.body, "");
      assert.equal(data.nextOffset, null);
      assert.equal(data.totalCp, [...body].length);
    } finally {
      ctx.cleanup();
    }
  });

  it("offset > totalCp is BAD_REQUEST and maxCp > rawPageMaxCp is LIMIT_EXCEEDED", () => {
    const ctx = setup();
    try {
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-bad", body: "abcdef" }).ok, true);
      expectCode(
        getEvent(ctx.db, ctx.config, { eventId: "e-bad", scope: SCOPE, offset: 7 }),
        "BAD_REQUEST",
      );
      expectCode(
        getEvent(ctx.db, ctx.config, { eventId: "e-bad", scope: SCOPE, maxCp: 11 }),
        "LIMIT_EXCEEDED",
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("missing event is NOT_FOUND and a cross-scope read is FORBIDDEN_SCOPE", () => {
    const ctx = setup([OTHER]);
    try {
      expectCode(
        getEvent(ctx.db, ctx.config, { eventId: "nope", scope: SCOPE }),
        "NOT_FOUND",
      );
      assert.equal(
        append(ctx.db, ctx.config, { eventId: "e-other", body: "other body", scope: OTHER }).ok,
        true,
      );
      expectCode(
        getEvent(ctx.db, ctx.config, { eventId: "e-other", scope: SCOPE }),
        "FORBIDDEN_SCOPE",
      );
      const own = expectOk<EventGetData>(
        getEvent(ctx.db, ctx.config, { eventId: "e-other", scope: OTHER }),
      );
      assert.equal(own.body, "other body");
    } finally {
      ctx.cleanup();
    }
  });

  it("raw reads leave note_heat and exposures untouched", () => {
    const ctx = setup();
    try {
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-read", body: "read me" }).ok, true);
      const heatBefore = ctx.db
        .prepare(`SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId`)
        .all();
      const expBefore = ctx.db
        .prepare(`SELECT * FROM exposures ORDER BY recallId, recordId`)
        .all();
      for (const maxCp of [1, 3, 10]) {
        expectOk<EventGetData>(
          getEvent(ctx.db, ctx.config, { eventId: "e-read", scope: SCOPE, maxCp }),
        );
      }
      expectOk<RangeData>(rangeEvents(ctx.db, ctx.config, { scope: SCOPE }));
      const heatAfter = ctx.db
        .prepare(`SELECT recordId, usedCount, lastUsedAt FROM note_heat ORDER BY recordId`)
        .all();
      const expAfter = ctx.db
        .prepare(`SELECT * FROM exposures ORDER BY recallId, recordId`)
        .all();
      assert.deepEqual(heatAfter, heatBefore);
      assert.deepEqual(expAfter, expBefore);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("event.range", () => {
  const T = (s: number): string => `2026-09-01T00:00:0${s}.000Z`;

  function seed(ctx: ReturnType<typeof setup>): void {
    appendOk(ctx.db, ctx.config, "r1", T(1), {
      sessionId: "s1",
      chunk: { docId: "doc-a", seq: 0 },
    });
    appendOk(ctx.db, ctx.config, "r2", T(2), {
      sessionId: "s1",
      chunk: { docId: "doc-a", seq: 1 },
    });
    appendOk(ctx.db, ctx.config, "r3", T(2), { sessionId: "s2" });
    appendOk(ctx.db, ctx.config, "r4", T(3), { sessionId: "s1" });
    appendOk(ctx.db, ctx.config, "r5", T(4), { sessionId: "s1" });
  }

  it("pages by limit with observedAt ASC, eventId ASC and no dup/skip", () => {
    const ctx = setup();
    try {
      seed(ctx);
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 10; guard++) {
        const params: Record<string, unknown> = { scope: SCOPE, limit: 2 };
        if (cursor !== null) params["cursor"] = cursor;
        const data = expectOk<RangeData>(rangeEvents(ctx.db, ctx.config, params));
        assert.ok(data.items.length <= 2);
        seen.push(...data.items.map((i) => i.eventId));
        cursor = data.nextCursor;
        if (cursor === null) break;
      }
      assert.equal(cursor, null);
      assert.deepEqual(seen, ["r1", "r2", "r3", "r4", "r5"]);
      assert.equal(new Set(seen).size, seen.length);
    } finally {
      ctx.cleanup();
    }
  });

  it("since is inclusive and until is exclusive", () => {
    const ctx = setup();
    try {
      seed(ctx);
      const data = expectOk<RangeData>(
        rangeEvents(ctx.db, ctx.config, {
          scope: SCOPE,
          since: T(2),
          until: T(3),
          limit: 4,
        }),
      );
      assert.deepEqual(
        data.items.map((i) => i.eventId),
        ["r2", "r3"],
      );
      assert.equal(data.nextCursor, null);
    } finally {
      ctx.cleanup();
    }
  });

  it("filters by sessionId and by chunk docId", () => {
    const ctx = setup();
    try {
      seed(ctx);
      const bySession = expectOk<RangeData>(
        rangeEvents(ctx.db, ctx.config, { scope: SCOPE, sessionId: "s2", limit: 4 }),
      );
      assert.deepEqual(bySession.items.map((i) => i.eventId), ["r3"]);

      const byDoc = expectOk<RangeData>(
        rangeEvents(ctx.db, ctx.config, { scope: SCOPE, docId: "doc-a", limit: 4 }),
      );
      assert.deepEqual(byDoc.items.map((i) => i.eventId), ["r1", "r2"]);
      assert.deepEqual(byDoc.items[0]!.chunk, { docId: "doc-a", seq: 0 });
      assert.deepEqual(byDoc.items[1]!.chunk, { docId: "doc-a", seq: 1 });
    } finally {
      ctx.cleanup();
    }
  });

  it("limit above rangeLimitMax is LIMIT_EXCEEDED and malformed cursors are BAD_REQUEST", () => {
    const ctx = setup();
    try {
      seed(ctx);
      expectCode(
        rangeEvents(ctx.db, ctx.config, { scope: SCOPE, limit: 5 }),
        "LIMIT_EXCEEDED",
      );
      expectCode(
        rangeEvents(ctx.db, ctx.config, { scope: SCOPE, cursor: "not*base64" }),
        "BAD_REQUEST",
      );
      // Valid base64url that is not the expected {o,e} cursor shape.
      expectCode(
        rangeEvents(ctx.db, ctx.config, { scope: SCOPE, cursor: "e30" }),
        "BAD_REQUEST",
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("event.append chunk and legacy hash compatibility", () => {
  it("the same (docId, seq) under a different eventId is CONFLICT", () => {
    const ctx = setup();
    try {
      const chunk = { docId: "doc-1", seq: 0 };
      assert.equal(
        append(ctx.db, ctx.config, { eventId: "c1", body: "first chunk", chunk }).ok,
        true,
      );
      expectCode(
        append(ctx.db, ctx.config, { eventId: "c2", body: "second chunk", chunk }),
        "CONFLICT",
      );
      const got = expectOk<EventGetData>(
        getEvent(ctx.db, ctx.config, { eventId: "c1", scope: SCOPE }),
      );
      assert.deepEqual(got.chunk, chunk);
    } finally {
      ctx.cleanup();
    }
  });

  it("a legacy-shaped append hashes like the pre-change formula and dedups", () => {
    const ctx = setup();
    try {
      const params = {
        eventId: "legacy-hash",
        sessionId: "s1",
        turnId: "t1",
        body: "legacy body",
        provenance: { source: "session:s1:turn:1", observedAt: OBS },
        scope: SCOPE,
      };
      const expectedHash = requestHashFor("event.append", {
        body: params.body,
        eventId: params.eventId,
        observedAt: params.provenance.observedAt,
        runId: null,
        scope: SCOPE,
        sessionId: params.sessionId,
        source: params.provenance.source,
        turnId: params.turnId,
      });

      const first = append(ctx.db, ctx.config, params, "legacy-key");
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.deduplicated, false);
      const row = ctx.db
        .prepare(`SELECT requestHash FROM operations WHERE idempotencyKey = ?`)
        .get("legacy-key") as { requestHash: string };
      assert.equal(row.requestHash, expectedHash);

      const again = append(ctx.db, ctx.config, params, "legacy-key");
      assert.equal(again.ok, true, JSON.stringify(again));
      assert.equal(again.deduplicated, true);
      const count = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM raw_events WHERE eventId = ?`)
        .get("legacy-hash") as { n: number };
      assert.equal(count.n, 1);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("record.sources spans and excerpts", () => {
  it("a valid span excerpt is exactly the code-point slice", () => {
    const ctx = setup();
    try {
      const body = "αβγ😀def";
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-span", body }).ok, true);
      const remembered = remember(ctx.db, ctx.config, "span-ok", "span note", [
        { eventId: "e-span", start: 2, end: 5 },
      ]);
      const id = expectOk<{ record: { id: string } }>(remembered).record.id;
      const data = expectOk<SourcesData>(
        recordSources(ctx.db, ctx.config, { id, scope: SCOPE }),
      );
      assert.equal(data.sources.length, 1);
      assert.deepEqual(data.sources[0]!.span, { start: 2, end: 5 });
      assert.equal(data.sources[0]!.excerpt, [...body].slice(2, 5).join(""));
      assert.equal(data.sources[0]!.excerpt, "γ😀d");
      assert.equal(data.sources[0]!.truncated, false);
      assert.equal(data.sources[0]!.totalCp, [...body].length);
    } finally {
      ctx.cleanup();
    }
  });

  it("end beyond totalCp and start >= end are BAD_REQUEST", () => {
    const ctx = setup();
    try {
      const body = "αβγ😀def";
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-span-bad", body }).ok, true);
      expectCode(
        remember(ctx.db, ctx.config, "span-end", "bad end note", [
          { eventId: "e-span-bad", start: 0, end: [...body].length + 1 },
        ]),
        "BAD_REQUEST",
      );
      expectCode(
        remember(ctx.db, ctx.config, "span-order", "bad order note", [
          { eventId: "e-span-bad", start: 3, end: 3 },
        ]),
        "BAD_REQUEST",
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("a string sourceRef excerpt is the body prefix, truncated at rawPageMaxCp", () => {
    const ctx = setup();
    try {
      const body = "0123456789ABCDEF";
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-string", body }).ok, true);
      const remembered = remember(ctx.db, ctx.config, "string-ref", "prefix note", ["e-string"]);
      const id = expectOk<{ record: { id: string } }>(remembered).record.id;
      const data = expectOk<SourcesData>(
        recordSources(ctx.db, ctx.config, { id, scope: SCOPE }),
      );
      assert.equal(data.sources.length, 1);
      assert.equal(data.sources[0]!.span, null);
      assert.equal(data.sources[0]!.excerpt, "0123456789");
      assert.equal(data.sources[0]!.truncated, true);
      assert.equal(data.sources[0]!.totalCp, 16);
    } finally {
      ctx.cleanup();
    }
  });

  it("shares the excerpt budget across eight long spans so the response fits", () => {
    const ctx = setup();
    try {
      ctx.config.limits.rawPageMaxCp = 2000;
      const texts: string[] = [];
      const refs: Array<{ eventId: string; start: number; end: number }> = [];
      for (let i = 0; i < 8; i++) {
        const eventId = `e-share-${i}`;
        const body = String.fromCharCode(65 + i).repeat(1200);
        appendOk(ctx.db, ctx.config, eventId, OBS, { body });
        texts.push(body);
        refs.push({ eventId, start: 0, end: 1200 });
      }
      const remembered = remember(ctx.db, ctx.config, "shared-budget", "shared budget note", refs);
      const id = expectOk<{ record: { id: string } }>(remembered).record.id;
      const res = recordSources(ctx.db, ctx.config, { id, scope: SCOPE });
      const data = expectOk<SourcesData>(res);
      assert.equal(data.sources.length, 8);
      for (const [i, source] of data.sources.entries()) {
        assert.equal(source.truncated, true);
        assert.ok(source.excerpt.length > 0);
        assert.ok(texts[i]!.startsWith(source.excerpt));
        assert.ok(source.excerpt.length <= 250, `cap ${source.excerpt.length}`);
      }
      assert.ok(Buffer.byteLength(JSON.stringify(res), "utf8") <= ctx.config.limits.responseMaxBytes);
    } finally {
      ctx.cleanup();
    }
  });

  it("shrinks shared excerpt caps for multibyte spans until the response fits", () => {
    const ctx = setup();
    try {
      ctx.config.limits.rawPageMaxCp = 2000;
      const texts: string[] = [];
      const refs: Array<{ eventId: string; start: number; end: number }> = [];
      for (let i = 0; i < 8; i++) {
        const eventId = `e-share-multi-${i}`;
        const body = "😀".repeat(1200);
        appendOk(ctx.db, ctx.config, eventId, OBS, { body });
        texts.push(body);
        refs.push({ eventId, start: 0, end: 1200 });
      }
      const remembered = remember(ctx.db, ctx.config, "shared-budget-multi", "shared budget note", refs);
      const id = expectOk<{ record: { id: string } }>(remembered).record.id;
      const res = recordSources(ctx.db, ctx.config, { id, scope: SCOPE });
      const data = expectOk<SourcesData>(res);
      assert.equal(data.sources.length, 8);
      for (const [i, source] of data.sources.entries()) {
        assert.equal(source.truncated, true);
        assert.ok(source.excerpt.length > 0);
        assert.ok(texts[i]!.startsWith(source.excerpt));
      }
      assert.ok(Buffer.byteLength(JSON.stringify(res), "utf8") <= ctx.config.limits.responseMaxBytes);
    } finally {
      ctx.cleanup();
    }
  });

  it("a dangling ref is reported as missing rather than fabricated", () => {
    const ctx = setup();
    try {
      assert.equal(append(ctx.db, ctx.config, { eventId: "e-gone", body: "gone body" }).ok, true);
      const remembered = remember(ctx.db, ctx.config, "dangling", "dangling note", [
        { eventId: "e-gone", start: 0, end: 4 },
      ]);
      const id = expectOk<{ record: { id: string } }>(remembered).record.id;
      ctx.db.prepare(`DELETE FROM raw_events WHERE eventId = ?`).run("e-gone");
      const data = expectOk<SourcesData>(
        recordSources(ctx.db, ctx.config, { id, scope: SCOPE }),
      );
      assert.equal(data.sources.length, 1);
      assert.equal(data.sources[0]!.eventId, "e-gone");
      assert.equal(data.sources[0]!.missing, true);
      assert.equal("excerpt" in data.sources[0]!, false);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("legacy raw_events / record_source_refs migration", () => {
  it("preserves a legacy source ref (span null) and accepts chunked appends", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-read-legacy-"));
    try {
      const { config, configPath } = baseConfig(dir, [OTHER]);
      const legacy = new DatabaseSync(config.dbPath);
      try {
        legacy.exec(`CREATE TABLE scopes(scope TEXT PRIMARY KEY)`);
        legacy.prepare(`INSERT INTO scopes(scope) VALUES (?)`).run(SCOPE);
        legacy.prepare(`INSERT INTO scopes(scope) VALUES (?)`).run(OTHER);
        // Pre-change raw_events: no docId/chunkSeq columns.
        legacy.exec(`CREATE TABLE raw_events(
          eventId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
          body TEXT NOT NULL, bodyNorm TEXT NOT NULL,
          source TEXT NOT NULL, observedAt TEXT NOT NULL,
          scope TEXT NOT NULL, runId TEXT NULL, createdAt TEXT NOT NULL,
          privacySensitivity TEXT NULL CHECK(privacySensitivity IN ('normal','sensitive')),
          privacyOrigin TEXT NULL CHECK(privacyOrigin IN ('conversation','self_activity')))`);
        legacy.exec(`CREATE TABLE records(
          id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
          source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','superseded','archived','retired')),
          supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL,
          privacySensitivity TEXT NULL CHECK(privacySensitivity IN ('normal','sensitive')),
          privacyOrigin TEXT NULL CHECK(privacyOrigin IN ('conversation','self_activity')))`);
        // Pre-change source refs: PK(recordId,eventId), no span columns.
        legacy.exec(`CREATE TABLE record_source_refs(
          recordId TEXT NOT NULL, eventId TEXT NOT NULL,
          PRIMARY KEY(recordId, eventId))`);
        legacy
          .prepare(
            `INSERT INTO raw_events(eventId, sessionId, turnId, body, bodyNorm, source, observedAt, scope, runId, createdAt)
             VALUES ('e-legacy', 's1', 't1', 'legacy raw', 'legacy raw', 'session:s1:turn:1', ?, ?, NULL, ?)`,
          )
          .run(OBS, SCOPE, OBS);
        legacy
          .prepare(
            `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
             VALUES ('rec_legacy', 'legacy note', 'legacy note', 'sha256:legacy', 'user_fact', 'session:s1:turn:1', ?, ?, 'active', NULL, 1, ?)`,
          )
          .run(OBS, SCOPE, OBS);
        legacy
          .prepare(`INSERT INTO record_source_refs(recordId, eventId) VALUES ('rec_legacy', 'e-legacy')`)
          .run();
        legacy.exec(`PRAGMA user_version = 2`);
      } finally {
        legacy.close();
      }

      const { db } = initDb(config, configPath);
      try {
        const rawCols = (
          db.prepare(`PRAGMA table_info(raw_events)`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        assert.ok(rawCols.includes("docId"));
        assert.ok(rawCols.includes("chunkSeq"));
        const refCols = (
          db.prepare(`PRAGMA table_info(record_source_refs)`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        assert.ok(refCols.includes("spanStart"));
        assert.ok(refCols.includes("spanEnd"));
        assert.equal(
          (db.prepare(`SELECT COUNT(*) AS n FROM record_source_refs`).get() as { n: number }).n,
          1,
        );

        const sources = expectOk<SourcesData>(
          recordSources(db, config, { id: "rec_legacy", scope: SCOPE }),
        );
        assert.equal(sources.sources.length, 1);
        assert.equal(sources.sources[0]!.eventId, "e-legacy");
        assert.equal(sources.sources[0]!.span, null);
        assert.equal(sources.sources[0]!.excerpt, "legacy raw");

        const appended = append(
          db,
          config,
          {
            eventId: "e-new-chunk",
            body: "new chunk body",
            chunk: { docId: "legacy-doc", seq: 0 },
          },
          "legacy-new-key",
        );
        assert.equal(appended.ok, true, JSON.stringify(appended));
        const got = expectOk<EventGetData>(
          getEvent(db, config, { eventId: "e-new-chunk", scope: SCOPE }),
        );
        assert.deepEqual(got.chunk, { docId: "legacy-doc", seq: 0 });
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("migrates legacy spans under a write transaction and second opener no-ops", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-read-legacy-race-"));
    const { config } = baseConfig(dir, [OTHER]);
    let a: DatabaseSync | null = null;
    let worker: Worker | null = null;
    try {
      // Pre-span schema: PRIMARY KEY(recordId,eventId), no span columns.
      const legacy = new DatabaseSync(config.dbPath);
      try {
        legacy.exec(`CREATE TABLE record_source_refs(
          recordId TEXT NOT NULL, eventId TEXT NOT NULL,
          PRIMARY KEY(recordId, eventId))`);
        legacy
          .prepare(`INSERT INTO record_source_refs(recordId, eventId) VALUES ('rec_legacy', 'e_legacy')`)
          .run();
      } finally {
        legacy.close();
      }

      // Connection A acquires the write lock BEFORE any schema inspection and
      // migrates + inserts a span row, holding the lock while B starts.
      a = new DatabaseSync(config.dbPath);
      a.exec(`PRAGMA busy_timeout = 5000`);
      a.exec("BEGIN IMMEDIATE");
      ensureM1Schema(a); // savepoint-based: composes with A's transaction
      a.prepare(
        `INSERT INTO record_source_refs(recordId, eventId, spanStart, spanEnd)
         VALUES ('rec_a', 'e_a', 0, 4)`,
      ).run();

      interface WorkerResult {
        ok: boolean;
        error?: string;
        elapsedMs: number;
        cols: string[];
        rows: Array<{
          recordId: string;
          eventId: string;
          spanStart: number | null;
          spanEnd: number | null;
        }>;
        index: string | null;
      }
      worker = new Worker(path.join(__dirname, "fixtures", "legacy-schema-worker.js"), {
        workerData: { dbPath: config.dbPath, busyMs: 5000 },
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker ready timeout")), 10000);
        worker!.once("message", (msg: { type?: string }) => {
          clearTimeout(timer);
          if (msg.type === "ready") resolve();
          else reject(new Error(`unexpected worker message ${JSON.stringify(msg)}`));
        });
        worker!.once("error", reject);
      });
      const resultPromise = new Promise<WorkerResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker result timeout")), 10000);
        const onMessage = (msg: { type?: string; result?: unknown }): void => {
          if (msg.type !== "result") return; // ready is handled separately
          clearTimeout(timer);
          worker!.off("message", onMessage);
          resolve(msg.result as WorkerResult);
        };
        worker!.on("message", onMessage);
        worker!.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      await ready;
      // Let B reach BEGIN IMMEDIATE and wait on A's lock.
      await new Promise((r) => setTimeout(r, 100));
      a.exec("COMMIT");

      const result = await resultPromise;
      assert.equal(result.ok, true, result.error);
      assert.ok(result.elapsedMs >= 50, `worker did not wait for the lock: ${result.elapsedMs}ms`);
      assert.ok(result.cols.includes("spanStart"));
      assert.ok(result.cols.includes("spanEnd"));
      assert.equal(result.index, "idx_source_refs_unique");
      assert.deepEqual(result.rows, [
        { recordId: "rec_a", eventId: "e_a", spanStart: 0, spanEnd: 4 },
        { recordId: "rec_legacy", eventId: "e_legacy", spanStart: null, spanEnd: null },
      ]);
      // NULL spans stay unique: re-inserting the legacy ref must be rejected.
      assert.throws(() =>
        a!
          .prepare(`INSERT INTO record_source_refs(recordId, eventId) VALUES ('rec_legacy', 'e_legacy')`)
          .run(),
      );
    } finally {
      if (worker) await worker.terminate();
      try {
        a?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("serializes the whole schema upgrade so a second initDb never races a duplicate column", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "raw-read-init-race-"));
    const { config, configPath } = baseConfig(dir, [OTHER]);
    let a: DatabaseSync | null = null;
    let worker: Worker | null = null;
    try {
      // Legacy M1-v2 file with the pre-privacy/pre-chunk/pre-span shape.
      const legacy = new DatabaseSync(config.dbPath);
      try {
        legacy.exec(`CREATE TABLE scopes(scope TEXT PRIMARY KEY)`);
        legacy.prepare(`INSERT INTO scopes(scope) VALUES (?)`).run(SCOPE);
        legacy.exec(`CREATE TABLE raw_events(
          eventId TEXT PRIMARY KEY, sessionId TEXT NOT NULL, turnId TEXT NOT NULL,
          body TEXT NOT NULL, bodyNorm TEXT NOT NULL,
          source TEXT NOT NULL, observedAt TEXT NOT NULL,
          scope TEXT NOT NULL, runId TEXT NULL, createdAt TEXT NOT NULL)`);
        legacy.exec(`CREATE TABLE records(
          id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
          source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','superseded','archived','retired')),
          supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL)`);
        legacy.exec(`CREATE TABLE record_source_refs(
          recordId TEXT NOT NULL, eventId TEXT NOT NULL,
          PRIMARY KEY(recordId, eventId))`);
        legacy.exec(`PRAGMA journal_mode = WAL`);
        legacy.exec(`PRAGMA user_version = 2`);
      } finally {
        legacy.close();
      }

      // First connection inspects and runs the ENTIRE additive sequence under
      // its write lock, but does not commit yet.
      a = new DatabaseSync(config.dbPath);
      a.exec(`PRAGMA busy_timeout = 5000`);
      a.exec("BEGIN IMMEDIATE");
      ensureM1Schema(a);

      interface InitResult {
        ok: boolean;
        error?: string;
        userVersion?: number;
      }
      worker = new Worker(path.join(__dirname, "fixtures", "legacy-init-worker.js"), {
        workerData: { dbPath: config.dbPath, configPath, config, busyMs: 5000 },
      });
      const ready = new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker ready timeout")), 10000);
        worker!.once("message", (msg: { type?: string }) => {
          clearTimeout(timer);
          if (msg.type === "ready") resolve();
          else reject(new Error(`unexpected worker message ${JSON.stringify(msg)}`));
        });
        worker!.once("error", reject);
      });
      const resultPromise = new Promise<InitResult>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("worker result timeout")), 10000);
        const onMessage = (msg: { type?: string; result?: unknown }): void => {
          if (msg.type !== "result") return;
          clearTimeout(timer);
          worker!.off("message", onMessage);
          resolve(msg.result as InitResult);
        };
        worker!.on("message", onMessage);
        worker!.once("error", (e) => {
          clearTimeout(timer);
          reject(e);
        });
      });
      await ready;
      // Let the second opener reach BEGIN IMMEDIATE and wait on the first.
      await new Promise((r) => setTimeout(r, 100));
      a.exec("COMMIT");

      const result = await resultPromise;
      assert.equal(result.ok, true, result.error);
      assert.equal(result.userVersion, SCHEMA_VERSION);
      // Both connections see the fully migrated, committed schema.
      for (const table of ["raw_events", "records"]) {
        const cols = (
          a!.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>
        ).map((c) => c.name);
        assert.ok(cols.includes("privacySensitivity"), `${table}.privacySensitivity`);
      }
      const rawCols = (
        a!.prepare(`PRAGMA table_info(raw_events)`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.ok(rawCols.includes("speaker"), "raw_events.speaker");
      const refCols = (
        a!.prepare(`PRAGMA table_info(record_source_refs)`).all() as Array<{ name: string }>
      ).map((c) => c.name);
      assert.ok(refCols.includes("spanStart"));
      assert.ok(refCols.includes("spanEnd"));
    } finally {
      if (worker) await worker.terminate();
      try {
        a?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("raw event speaker", () => {
  it("stores user/assistant speakers, keeps legacy rows null, and rejects invalid values", () => {
    const t = setup();
    try {
      appendOk(t.db, t.config, "e-user", OBS, {
        body: "user words",
        speaker: "user",
      });
      const userGet = expectOk<{ speaker: string | null }>(
        getEvent(t.db, t.config, { eventId: "e-user", scope: SCOPE }),
      );
      assert.equal(userGet.speaker, "user");

      appendOk(t.db, t.config, "e-assistant", "2026-09-01T00:00:01.000Z", {
        body: "assistant words",
        speaker: "assistant",
      });
      const assistantGet = expectOk<{ speaker: string | null }>(
        getEvent(t.db, t.config, { eventId: "e-assistant", scope: SCOPE }),
      );
      assert.equal(assistantGet.speaker, "assistant");

      // Legacy/plain append stays null (never guessed).
      appendOk(t.db, t.config, "e-legacy", "2026-09-01T00:00:02.000Z", {
        body: "combined legacy",
      });
      const legacyGet = expectOk<{ speaker: string | null }>(
        getEvent(t.db, t.config, { eventId: "e-legacy", scope: SCOPE }),
      );
      assert.equal(legacyGet.speaker, null);

      const range = expectOk<{
        items: Array<{ eventId: string; speaker: string | null }>;
      }>(
        rangeEvents(t.db, t.config, {
          scope: SCOPE,
          limit: 4,
        }),
      );
      assert.deepEqual(
        range.items.map((i) => [i.eventId, i.speaker]),
        [
          ["e-user", "user"],
          ["e-assistant", "assistant"],
          ["e-legacy", null],
        ],
      );

      const rec = remember(t.db, t.config, "raw-speaker-rec", "user fact", ["e-user"]);
      assert.equal(rec.ok, true, JSON.stringify(rec));
      const id = (rec.data as { record: { id: string } }).record.id;
      const sources = expectOk<{
        sources: Array<{ eventId: string; speaker: string | null }>;
      }>(
        recordSources(t.db, t.config, { id, scope: SCOPE }),
      );
      assert.equal(sources.sources[0]?.eventId, "e-user");
      assert.equal(sources.sources[0]?.speaker, "user");

      expectCode(
        append(t.db, t.config, { eventId: "e-bad", speaker: "narrator" }),
        "BAD_REQUEST",
      );
      expectCode(
        getEvent(t.db, t.config, { eventId: "e-bad", scope: SCOPE }),
        "NOT_FOUND",
      );
    } finally {
      t.cleanup();
    }
  });
});
