/**
 * Derived association layer consumed by readers:
 * - record.recall / record.search topic seeding and similar-edge expansion,
 * - graph.page / graph.local topics + 'similar' edges,
 * - graph.version changes on derived writes,
 * - empty derived tables preserve the pre-association recall ranking.
 *
 * Synthetic temp DBs only; the injected embedder replaces the local model.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { bodyHashFor, normalizeBody } from "../src/normalize.js";
import {
  eventAppend,
  graphLocal,
  graphPage,
  graphVersion,
  recallRecords,
  rememberRecord,
  searchRecords,
} from "../src/store.js";
import {
  maintainAssociate,
  topicSet,
  type AssociateEmbed,
} from "../src/associate.js";

const SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";
let ctr = 0;

function setup(): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-assoc-"));
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
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

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  createdAt: string,
  links: string[] = [],
): string {
  const eventId = `ra-ev-${ctr++}`;
  const er = eventAppend(db, config, {
    eventId,
    sessionId: "s1",
    turnId: "t1",
    body: `raw ${eventId}`,
    provenance: { source: "session:s1:turn:1", observedAt: createdAt },
    scope: SCOPE,
  }, `ra-evk-${ctr++}`, createdAt);
  assert.equal(er.ok, true, JSON.stringify(er));
  const res = rememberRecord(db, config, {
    body,
    kind: "user_fact",
    provenance: { source: "session:s1:turn:1", observedAt: createdAt },
    scope: SCOPE,
    sourceRefs: [eventId],
    links,
  }, `ra-rem-${ctr++}`, createdAt);
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function setTopics(
  db: DatabaseSync,
  config: AppConfig,
  id: string,
  topics: string[],
): void {
  const row = db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(id) as { bodyHash: string };
  const res = topicSet(db, config, { scope: SCOPE, id, bodyHash: row.bodyHash, topics }, `ra-ts-${ctr++}`, OBS);
  assert.equal(res.code, "OK", JSON.stringify(res));
}

function recallIds(db: DatabaseSync, config: AppConfig, query: string): string[] {
  const res = recallRecords(db, config, { query, scope: SCOPE, limit: 10 });
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { items: Array<{ id: string }> }).items.map((i) => i.id);
}

function searchIds(db: DatabaseSync, config: AppConfig, query: string): string[] {
  const res = searchRecords(db, config, { query, scope: SCOPE, limit: 10 });
  assert.equal(res.code, "OK", JSON.stringify(res));
  return (res.data as { items: Array<{ id: string }> }).items.map((i) => i.id);
}

function insertRecord(db: DatabaseSync, id: string, body: string, createdAt: string): void {
  const bodyNorm = normalizeBody(body);
  db.prepare(
    `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
     VALUES (?, ?, ?, ?, 'user_fact', 'test', ?, ?, 'active', NULL, 1, ?)`,
  ).run(id, body, bodyNorm, bodyHashFor(bodyNorm), OBS, SCOPE, createdAt);
}

function insertSimilar(db: DatabaseSync, a: string, b: string, score: number): void {
  db.prepare(
    `INSERT INTO similar_edges(scope, a, b, score, computedAt) VALUES (?, ?, ?, ?, ?)`,
  ).run(SCOPE, a < b ? a : b, a < b ? b : a, score, OBS);
}

const T1 = "2026-09-01T00:00:01.000Z";
const T2 = "2026-09-01T00:00:02.000Z";
const T3 = "2026-09-01T00:00:03.000Z";

describe("derived association readers: recall/search", () => {
  it("topic seeding recalls a record with no lexical overlap", () => {
    const ctx = setup();
    try {
      const bike = remember(ctx.db, ctx.config, "GSX-S1000Fに乗りたい", T1);
      remember(ctx.db, ctx.config, "miso soup recipe for dinner", T2);
      setTopics(ctx.db, ctx.config, bike, ["バイク"]);
      assert.deepEqual(recallIds(ctx.db, ctx.config, "バイクの好み"), [bike]);
    } finally {
      ctx.cleanup();
    }
  });

  it("record.search uses the same topic seeding", () => {
    const ctx = setup();
    try {
      const bike = remember(ctx.db, ctx.config, "GSX-S1000Fに乗りたい", T1);
      remember(ctx.db, ctx.config, "miso soup recipe for dinner", T2);
      setTopics(ctx.db, ctx.config, bike, ["バイク"]);
      assert.deepEqual(searchIds(ctx.db, ctx.config, "バイクの好み"), [bike]);
    } finally {
      ctx.cleanup();
    }
  });

  it("similar-edge expansion adds a neighbour below explicit links", () => {
    const ctx = setup();
    try {
      const linked = remember(ctx.db, ctx.config, "tide chart harbor copy", T1);
      const source = remember(ctx.db, ctx.config, "lighthouse keeper evening log", T2, [linked]);
      const similar = remember(ctx.db, ctx.config, "zzz unrelated mechanic note", T3);
      insertSimilar(ctx.db, source, similar, 0.9);

      const ids = recallIds(ctx.db, ctx.config, "lighthouse keeper");
      assert.ok(ids.includes(linked), JSON.stringify(ids));
      assert.ok(ids.includes(similar), JSON.stringify(ids));
      assert.ok(ids.indexOf(linked) < ids.indexOf(similar), `explicit link must outrank similar: ${JSON.stringify(ids)}`);

      ctx.db.prepare(`DELETE FROM similar_edges WHERE scope = ?`).run(SCOPE);
      assert.equal(recallIds(ctx.db, ctx.config, "lighthouse keeper").includes(similar), false);
    } finally {
      ctx.cleanup();
    }
  });

  it("empty derived tables reproduce the existing tie-break fixture", () => {
    const ctx = setup();
    try {
      for (const id of ["rec_c", "rec_b", "rec_a"]) {
        insertRecord(ctx.db, id, "unrelated note", "2026-04-01T00:00:00.000Z");
        ctx.db.prepare(`INSERT INTO fts_notes(recordId, body) VALUES (?, 'tiephrase')`).run(id);
      }
      assert.deepEqual(recallIds(ctx.db, ctx.config, "tiephrase").slice(0, 3), ["rec_a", "rec_b", "rec_c"]);
      const topics = ctx.db.prepare(`SELECT COUNT(*) AS n FROM record_topics`).get() as { n: number };
      const similar = ctx.db.prepare(`SELECT COUNT(*) AS n FROM similar_edges`).get() as { n: number };
      assert.equal(topics.n, 0);
      assert.equal(similar.n, 0);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("derived association readers: graph", () => {
  it("graph.page and graph.local expose topics and 'similar' edges", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "alpha record", T1);
      const b = remember(ctx.db, ctx.config, "beta record", T2);
      setTopics(ctx.db, ctx.config, a, ["整備"]);
      setTopics(ctx.db, ctx.config, b, ["バイク"]);
      insertSimilar(ctx.db, a, b, 0.9);

      const page = graphPage(ctx.db, ctx.config, { scope: SCOPE, limit: 20 });
      assert.equal(page.code, "OK", JSON.stringify(page));
      const nodes = (page.data as { nodes: Array<Record<string, unknown>> }).nodes;
      assert.deepEqual(nodes.find((n) => n["id"] === a)?.["topics"], ["整備"]);
      assert.deepEqual(nodes.find((n) => n["id"] === b)?.["topics"], ["バイク"]);
      const small = a < b ? a : b;
      const large = a < b ? b : a;
      const smallOut = nodes.find((n) => n["id"] === small)?.["out"] as Array<Record<string, unknown>>;
      const largeOut = nodes.find((n) => n["id"] === large)?.["out"] as Array<Record<string, unknown>>;
      assert.deepEqual(smallOut, [{ to: large, kind: "similar" }]);
      assert.deepEqual(largeOut, []);

      const local = graphLocal(ctx.db, ctx.config, { scope: SCOPE, id: small, depth: 1, limit: 20 });
      assert.equal(local.code, "OK", JSON.stringify(local));
      const data = local.data as {
        nodes: Array<Record<string, unknown>>;
        edges: Array<{ from: string; to: string; kind: string }>;
      };
      assert.deepEqual(data.nodes.find((n) => n["id"] === a)?.["topics"], ["整備"]);
      assert.deepEqual(data.nodes.find((n) => n["id"] === b)?.["topics"], ["バイク"]);
      assert.deepEqual(data.edges, [{ from: small, to: large, kind: "similar" }]);
    } finally {
      ctx.cleanup();
    }
  });

  it("graph.version changes on record_topics / similar_edges writes and stays stable on reads", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "version alpha", T1);
      const b = remember(ctx.db, ctx.config, "version beta", T2);
      const v0 = graphVersion(ctx.db, ctx.config, { scope: SCOPE });
      assert.equal(v0.code, "OK", JSON.stringify(v0));
      const before = v0.data?.["version"] as string;

      setTopics(ctx.db, ctx.config, a, ["整備"]);
      const v1 = graphVersion(ctx.db, ctx.config, { scope: SCOPE });
      assert.notEqual(v1.data?.["version"], before);

      insertSimilar(ctx.db, a, b, 0.8);
      const v2 = graphVersion(ctx.db, ctx.config, { scope: SCOPE });
      assert.notEqual(v2.data?.["version"], v1.data?.["version"]);

      const page = graphPage(ctx.db, ctx.config, { scope: SCOPE, limit: 5 });
      assert.equal(page.code, "OK", JSON.stringify(page));
      assert.equal(page.data?.["version"], v2.data?.["version"]);
      assert.equal(graphVersion(ctx.db, ctx.config, { scope: SCOPE }).data?.["version"], v2.data?.["version"]);
    } finally {
      ctx.cleanup();
    }
  });

  it("maintain.associate writes move graph.version", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "associate alpha", T1);
      remember(ctx.db, ctx.config, "associate beta", T2);
      const before = graphVersion(ctx.db, ctx.config, { scope: SCOPE }).data?.["version"];
      const embed: AssociateEmbed = async (texts) =>
        texts.map(() => {
          const v = new Float32Array(384);
          v[0] = 1;
          return v;
        });
      const res = await maintainAssociate(
        ctx.db,
        ctx.config,
        ctx.configPath,
        { scope: SCOPE },
        "ra-assoc-1",
        embed,
        T3,
      );
      assert.equal(res.code, "OK", JSON.stringify(res));
      const after = graphVersion(ctx.db, ctx.config, { scope: SCOPE }).data?.["version"];
      assert.notEqual(after, before);
    } finally {
      ctx.cleanup();
    }
  });
});
