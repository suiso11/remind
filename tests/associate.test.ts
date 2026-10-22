/**
 * maintain.associate: derived association-layer behavior.
 *
 * Uses a deterministic injected embedder (same shape as the M2 tests' vector
 * injection) so no model files or network are needed. Canonical links are
 * never written by these tests' subject; all assertions are about the
 * rebuildable vec_notes / similar_edges / associate_state layer.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import {
  ASSOCIATE_DEFAULT_BATCH_MAX,
  ASSOCIATE_DEFAULT_MIN_SCORE,
  ASSOCIATE_DEFAULT_TOP_K,
  loadConfig,
} from "../src/config.js";
import { initDb } from "../src/db.js";
import { normalizeBody } from "../src/normalize.js";
import { eventAppend, rememberRecord, correctRecord, retireRecord } from "../src/store.js";
import { acquireCultivationLease, releaseCultivationLease } from "../src/cultivation.js";
import { maintainAssociate, topicSet, topicPending, buildTopicPrompt, parseTopicResponse, type AssociateEmbed, type AssociateGenerate } from "../src/associate.js";
import { VECTOR_DIM, normalizeVec } from "../src/vectors.js";

const SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";
let ctr = 0;

function setup(associate?: Partial<NonNullable<AppConfig["associate"]>>): {
  dir: string;
  config: AppConfig;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assoc-"));
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
  if (associate) {
    config.associate = {
      batchMax: associate.batchMax ?? ASSOCIATE_DEFAULT_BATCH_MAX,
      topK: associate.topK ?? ASSOCIATE_DEFAULT_TOP_K,
      minScore: associate.minScore ?? ASSOCIATE_DEFAULT_MIN_SCORE,
      ...(associate.topicMergeMin !== undefined ? { topicMergeMin: associate.topicMergeMin } : {}),
      ...(associate.topicBonus !== undefined ? { topicBonus: associate.topicBonus } : {}),
      ...(associate.llmTopics !== undefined ? { llmTopics: associate.llmTopics } : {}),
    };
  }
  const { db } = initDb(config, path.join(dir, "memory.config.json"));
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
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    },
  };
}

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  key: string,
  createdAt: string = OBS,
  tags?: string[],
): string {
  const eventId = `assoc-ev-${key}`;
  const er = eventAppend(
    db,
    config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: `raw ${key}`,
      provenance: { source: "session:s1:turn:1", observedAt: createdAt },
      scope: SCOPE,
    },
    `assoc-evk-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(er.ok, true, JSON.stringify(er));
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: createdAt },
      scope: SCOPE,
      sourceRefs: [eventId],
      ...(tags !== undefined ? { tags } : {}),
    },
    `assoc-rem-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function vec(x: number, y: number, extraIndex?: number): Float32Array {
  const v = new Float32Array(VECTOR_DIM);
  v[0] = x;
  v[1] = y;
  if (extraIndex !== undefined) v[extraIndex] = 1;
  return normalizeVec(v);
}

function vecAxis(x: number, axis: number): Float32Array {
  const v = new Float32Array(VECTOR_DIM);
  v[0] = x;
  v[axis] = Math.sqrt(1 - x * x);
  return normalizeVec(v);
}

function fakeEmbed(map: Map<string, Float32Array>): AssociateEmbed {
  return async (texts: string[]) => {
    const out: Float32Array[] = [];
    for (const t of texts) {
      const v = map.get(t);
      if (!v) return null;
      out.push(v);
    }
    return out;
  };
}

function keyed(entries: Array<[string, Float32Array]>): Map<string, Float32Array> {
  return new Map(entries.map(([body, v]) => [normalizeBody(body), v]));
}

/** Embedding input actually sent for a record with topics (topics sorted). */
function topicText(body: string, topics: string[]): string {
  return `${normalizeBody(body)}\n話題: ${[...topics].sort().join("、")}`;
}

/** Generator keyed by a body substring; the prompt embeds the normalized body. */
function fakeGenerate(entries: Array<[string, string | null]>): AssociateGenerate {
  return async (prompt: string) => {
    for (const [body, out] of entries) {
      if (prompt.includes(normalizeBody(body))) return out;
    }
    return null;
  };
}

function topicRows(db: DatabaseSync): Array<{ recordId: string; topic: string; origin: string }> {
  return db
    .prepare(`SELECT recordId, topic, origin FROM record_topics ORDER BY recordId, topic`)
    .all() as Array<{ recordId: string; topic: string; origin: string }>;
}

function bodyHashOf(db: DatabaseSync, id: string): string {
  const row = db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(id) as
    | { bodyHash: string }
    | undefined;
  assert.ok(row, `missing record ${id}`);
  return row.bodyHash;
}

function vecIds(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT recordId FROM vec_notes ORDER BY recordId`).all() as Array<{ recordId: string }>).map(
    (r) => r.recordId,
  );
}

function edgeRows(db: DatabaseSync): Array<{ a: string; b: string; score: number }> {
  return db
    .prepare(`SELECT a, b, score FROM similar_edges ORDER BY a, b`)
    .all() as Array<{ a: string; b: string; score: number }>;
}

function stateIds(db: DatabaseSync): string[] {
  return (db.prepare(`SELECT recordId FROM associate_state ORDER BY recordId`).all() as Array<{ recordId: string }>).map(
    (r) => r.recordId,
  );
}

function assoc(res: { data: unknown }): Record<string, unknown> {
  return (res.data as { associate: Record<string, unknown> }).associate;
}

const T1 = "2026-09-01T00:00:01.000Z";
const T2 = "2026-09-01T00:00:02.000Z";

describe("maintain.associate derived layer", () => {
  it("embeds missing active records and writes a symmetric edge", async () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "motorcycle alpha", "a", T1);
      const b = remember(ctx.db, ctx.config, "motorcycle beta", "b", T2);
      const embed = fakeEmbed(
        keyed([
          ["motorcycle alpha", vec(1, 0)],
          ["motorcycle beta", vec(0.8, 0.6)],
        ]),
      );
      const res = await maintainAssociate(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "assoc-embed-1",
        embed,
        T2,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const d = assoc(res);
      assert.equal(d["degraded"], false);
      assert.equal(d["embedded"], 2);
      assert.equal(d["scanned"], 2);
      assert.equal(d["remaining"], 0);
      assert.deepEqual(vecIds(ctx.db).sort(), [a, b].sort());
      assert.deepEqual(stateIds(ctx.db).sort(), [a, b].sort());
      const edges = edgeRows(ctx.db);
      assert.equal(edges.length, 1, JSON.stringify(edges));
      assert.equal(edges[0]!.a, a < b ? a : b);
      assert.equal(edges[0]!.b, a < b ? b : a);
      assert.equal(d["edgesWritten"], 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("re-embeds the corrected revision and drops the superseded vec+edges", async () => {
    const ctx = setup();
    try {
      const oldId = remember(ctx.db, ctx.config, "motorcycle alpha", "c-old", T1);
      const peer = remember(ctx.db, ctx.config, "motorcycle beta", "c-peer", T2);
      const embed1 = fakeEmbed(
        keyed([
          ["motorcycle alpha", vec(1, 0)],
          ["motorcycle beta", vec(1, 0)],
        ]),
      );
      const first = await maintainAssociate(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "assoc-correct-1",
        embed1,
        T2,
      );
      assert.equal(assoc(first)["edgesWritten"], 1);
      assert.equal(edgeRows(ctx.db).length, 1);

      const corr = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: oldId,
          body: "motorcycle alpha corrected",
          kind: "correction",
          provenance: { source: "session:s1:turn:1", observedAt: T2 },
          scope: SCOPE,
        },
        "assoc-correct-op",
        T2,
      );
      assert.equal(corr.ok, true, JSON.stringify(corr));
      const newId = (corr.data as { record: { id: string } }).record.id;

      const embed2 = fakeEmbed(
        keyed([
          ["motorcycle alpha", vec(1, 0)],
          ["motorcycle beta", vec(1, 0)],
          ["motorcycle alpha corrected", vec(0, 1)],
        ]),
      );
      const second = await maintainAssociate(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "assoc-correct-2",
        embed2,
        T2,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      const d = assoc(second);
      assert.equal(d["embedded"], 1);
      assert.equal(d["scanned"], 1);
      assert.ok(d["edgesRemoved"] as number >= 1, JSON.stringify(d));
      assert.ok(vecIds(ctx.db).includes(newId));
      assert.ok(!vecIds(ctx.db).includes(oldId));
      assert.ok(vecIds(ctx.db).includes(peer));
      assert.equal(edgeRows(ctx.db).length, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps top-K above the threshold with one row per symmetric pair", async () => {
    const ctx = setup({ batchMax: 50, topK: 5, minScore: 0.6 });
    try {
      const hub = remember(ctx.db, ctx.config, "hub topic", "k-hub", T1);
      const cosines = [0.75, 0.72, 0.69, 0.66, 0.55];
      const peers: string[] = [];
      const entries: Array<[string, Float32Array]> = [["hub topic", vec(1, 0)]];
      for (let i = 0; i < cosines.length; i++) {
        const c = cosines[i]!;
        const body = `peer topic ${i}`;
        peers.push(remember(ctx.db, ctx.config, body, `k-p${i}`, T2));
        entries.push([body, vecAxis(c, 2 + i)]);
      }
      const res = await maintainAssociate(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "assoc-topk-1",
        fakeEmbed(keyed(entries)),
        T2,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const edges = edgeRows(ctx.db);
      assert.equal(edges.length, 4, JSON.stringify(edges));
      assert.equal(assoc(res)["edgesWritten"], 4);
      for (const e of edges) assert.ok(e.a < e.b);
      const hubEdges = edges.filter((e) => e.a === hub || e.b === hub);
      assert.equal(hubEdges.length, 4, JSON.stringify(edges));
      // The 0.55 peer is below minScore: no incident edge.
      assert.equal(edges.filter((e) => e.a === peers[4] || e.b === peers[4]).length, 0);
      // Symmetric pairs are deduped by PRIMARY KEY(scope,a,b).
      const keys = new Set(edges.map((e) => `${e.a}\u0000${e.b}`));
      assert.equal(keys.size, edges.length);
    } finally {
      ctx.cleanup();
    }
  });

  it("removes a retired record's vec and edges on the next run", async () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "retire alpha", "r-a", T1);
      const b = remember(ctx.db, ctx.config, "retire beta", "r-b", T2);
      const entries = keyed([
        ["retire alpha", vec(1, 0)],
        ["retire beta", vec(1, 0)],
      ]);
      const first = await maintainAssociate(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "assoc-retire-1",
        fakeEmbed(entries),
        T2,
      );
      assert.equal(assoc(first)["edgesWritten"], 1);
      const ret = retireRecord(
        ctx.db,
        ctx.config,
        { id: b, scope: SCOPE, reasonCode: "NO_LONGER_USEFUL" },
        "assoc-retire-op",
        T2,
      );
      assert.equal(ret.ok, true, JSON.stringify(ret));
      const second = await maintainAssociate(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "assoc-retire-2",
        fakeEmbed(entries),
        T2,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(edgeRows(ctx.db).length, 0);
      assert.ok(!vecIds(ctx.db).includes(b));
      assert.ok(vecIds(ctx.db).includes(a));
      assert.ok(!stateIds(ctx.db).includes(b));
      assert.ok((assoc(second)["edgesRemoved"] as number) >= 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("replays the same key and rejects a changed request under that key", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "idem alpha", "i-a", T1);
      remember(ctx.db, ctx.config, "idem beta", "i-b", T2);
      const embed = fakeEmbed(
        keyed([
          ["idem alpha", vec(1, 0)],
          ["idem beta", vec(0.9, 0.1)],
        ]),
      );
      const params = { scope: SCOPE };
      const first = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), params, "assoc-idem", embed, T2,
      );
      assert.equal(first.ok, true);
      assert.equal(first.deduplicated, false);
      const second = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), params, "assoc-idem", embed, T2,
      );
      assert.equal(second.ok, true);
      assert.equal(second.deduplicated, true);
      assert.deepEqual(second.data, first.data);
      const changed = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE, limit: 1 }, "assoc-idem", embed, T2,
      );
      assert.equal(changed.code, "CONFLICT");
      const ops = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM operations WHERE idempotencyKey = 'assoc-idem'`)
        .get() as { n: number };
      assert.equal(ops.n, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("returns CONFLICT when another maintenance holder owns the lease", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "lease alpha", "l-a", T1);
      acquireCultivationLease(ctx.db, ctx.config, { owner: "other-run", scope: SCOPE, now: T1 });
      try {
        const res = await maintainAssociate(
          ctx.db,
          ctx.config,
          path.join(ctx.dir, "memory.config.json"),
          { scope: SCOPE },
          "assoc-lease",
          fakeEmbed(keyed([["lease alpha", vec(1, 0)]])),
          T1,
        );
        assert.equal(res.code, "CONFLICT");
        assert.equal(vecIds(ctx.db).length, 0);
      } finally {
        releaseCultivationLease(ctx.db, "other-run");
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("degrades OK when vectors are disabled", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "disabled alpha", "d-a", T1);
      const res = await maintainAssociate(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "assoc-disabled",
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const d = assoc(res);
      assert.equal(d["degraded"], true);
      assert.equal(d["applied"], 0);
      assert.equal(d["embedded"], 0);
      assert.equal(vecIds(ctx.db).length, 0);
      assert.equal(edgeRows(ctx.db).length, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("is bounded by limit and reports remaining work", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "bound alpha", "b-a", "2026-09-01T00:00:01.000Z");
      remember(ctx.db, ctx.config, "bound beta", "b-b", "2026-09-01T00:00:02.000Z");
      remember(ctx.db, ctx.config, "bound gamma", "b-c", "2026-09-01T00:00:03.000Z");
      const embed = fakeEmbed(
        keyed([
          ["bound alpha", vec(1, 0)],
          ["bound beta", vec(0, 1)],
          ["bound gamma", vec(1, 1)],
        ]),
      );
      const first = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE, limit: 2 }, "assoc-limit-1", embed, T2,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(assoc(first)["embedded"], 2);
      assert.equal(assoc(first)["scanned"], 2);
      assert.equal(assoc(first)["remaining"], 1);
      const second = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE, limit: 2 }, "assoc-limit-2", embed, T2,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(assoc(second)["embedded"], 1);
      assert.equal(assoc(second)["scanned"], 1);
      assert.equal(assoc(second)["remaining"], 0);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("maintain.associate SLM topics", () => {
  it("writes topics per record and replaces them on a correction", async () => {
    const ctx = setup({ llmTopics: true });
    try {
      const a = remember(ctx.db, ctx.config, "motorcycle alpha", "t-a", T1);
      const b = remember(ctx.db, ctx.config, "motorcycle beta", "t-b", T2);
      const embed = fakeEmbed(
        new Map([
          ["バイク", vec(0, 0, 200)],
          ["趣味", vec(0, 0, 201)],
          [topicText("motorcycle alpha", ["バイク", "趣味"]), vec(1, 0)],
          [topicText("motorcycle beta", ["バイク", "趣味"]), vec(0.9, 0.1)],
          [topicText("motorcycle alpha corrected", ["整備"]), vec(0, 1)],
        ]),
      );
      const gen = fakeGenerate([
        ["motorcycle alpha corrected", "整備"],
        ["motorcycle alpha", "バイク、趣味"],
        ["motorcycle beta", "バイク、趣味"],
      ]);
      const first = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-topics-1", embed, T2, gen,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      const d = assoc(first);
      assert.equal(d["topicsWritten"], 2);
      assert.equal(d["topicsFailed"], 0);
      assert.equal(d["topicsDegraded"], false);
      assert.deepEqual(
        topicRows(ctx.db).map((r) => `${r.recordId}:${r.topic}`).sort(),
        [`${a}:バイク`, `${a}:趣味`, `${b}:バイク`, `${b}:趣味`].sort(),
      );
      assert.equal(edgeRows(ctx.db).length, 1);

      const corr = correctRecord(
        ctx.db, ctx.config,
        {
          recordId: a,
          body: "motorcycle alpha corrected",
          kind: "correction",
          provenance: { source: "session:s1:turn:1", observedAt: T2 },
          scope: SCOPE,
        },
        "assoc-topics-correct", T2,
      );
      assert.equal(corr.ok, true, JSON.stringify(corr));
      const newId = (corr.data as { record: { id: string } }).record.id;
      const second = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-topics-2", embed, T2, gen,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      const rows = topicRows(ctx.db);
      assert.deepEqual(rows.filter((r) => r.recordId === newId).map((r) => r.topic), ["整備"]);
      assert.equal(rows.filter((r) => r.recordId === a).length, 0);
      assert.equal(assoc(second)["topicsWritten"], 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("parses brand-to-category output strictly and rejects garbage", () => {
    assert.deepEqual(parseTopicResponse("スマートフォン、カメラ"), ["スマートフォン", "カメラ"]);
    assert.deepEqual(parseTopicResponse("スマートフォン／カメラ\n予定"), [
      "スマートフォン",
      "カメラ",
      "予定",
    ]);
    assert.deepEqual(parseTopicResponse("「スマートフォン」「カメラ」"), ["スマートフォン", "カメラ"]);
    // Sentences, long spans, punctuation and duplicate topics are dropped.
    assert.deepEqual(parseTopicResponse("これは説明文です。スマートフォン"), []);
    assert.deepEqual(parseTopicResponse("1234567890123、カメラ"), ["カメラ"]);
    assert.deepEqual(parseTopicResponse("カメラ、カメラ、カメラ、カメラ"), ["カメラ"]);
    assert.deepEqual(parseTopicResponse(null), []);
    const prompt = buildTopicPrompt("スマートフォンのカメラ設定");
    assert.ok(prompt.includes("<|im_start|>system"));
    assert.ok(prompt.includes("スマートフォンのカメラ設定"));
    // No domain-specific motorcycle mapping or few-shots in the prompt.
    for (const hint of ["Ninja", "GSX", "ZX", "CBR", "YZF", "バイク", "車"]) {
      assert.ok(!prompt.includes(hint), hint);
    }
  });

  it("canonicalizes a near-synonym onto the existing scope topic", async () => {
    const ctx = setup({ batchMax: 50, topK: 5, minScore: 0.9, llmTopics: true });
    try {
      const a = remember(ctx.db, ctx.config, "bike alpha", "c-a", T1);
      const surface = vec(1, 0);
      const embed = fakeEmbed(
        new Map([
          ["バイク", surface],
          ["オートバイ", vec(0.9, Math.sqrt(1 - 0.9 * 0.9))],
          [topicText("bike alpha", ["バイク"]), vec(1, 0)],
          [topicText("bike beta", ["バイク"]), vec(0.8, 0.6)],
        ]),
      );
      const gen = fakeGenerate([
        ["bike alpha", "バイク"],
        ["bike beta", "オートバイ"],
      ]);
      const first = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-canon-1", embed, T2, gen,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.deepEqual(topicRows(ctx.db).map((r) => r.topic), ["バイク"]);

      const b = remember(ctx.db, ctx.config, "bike beta", "c-b", T2);
      const second = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-canon-2", embed, T2, gen,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.deepEqual(
        topicRows(ctx.db).filter((r) => r.recordId === b).map((r) => r.topic),
        ["バイク"],
      );
      assert.equal(assoc(second)["topicsWritten"], 1);
      assert.ok(a !== b);
    } finally {
      ctx.cleanup();
    }
  });

  it("adds the topic bonus so a shared topic clears minScore", async () => {
    const ctx = setup({ batchMax: 50, topK: 5, minScore: 0.45, topicBonus: 0.3, llmTopics: true });
    try {
      const a = remember(ctx.db, ctx.config, "h2 intake", "s-a", T1);
      const b = remember(ctx.db, ctx.config, "gsx ride", "s-b", T2);
      const embed = fakeEmbed(
        new Map([
          ["モーターサイクル", vec(0, 0, 210)],
          [topicText("h2 intake", ["モーターサイクル"]), vec(1, 0)],
          [topicText("gsx ride", ["モーターサイクル"]), vec(0.2, Math.sqrt(1 - 0.04))],
        ]),
      );
      const gen = fakeGenerate([
        ["h2 intake", "モーターサイクル"],
        ["gsx ride", "モーターサイクル"],
      ]);
      const res = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-bonus-1", embed, T2, gen,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const d = assoc(res);
      assert.equal(d["topicsWritten"], 2);
      assert.equal(d["edgesWritten"], 1);
      const edges = edgeRows(ctx.db);
      assert.equal(edges.length, 1);
      assert.ok(Math.abs(edges[0]!.score - 0.5) < 1e-6, JSON.stringify(edges));
      assert.ok(edges[0]!.a === (a < b ? a : b) && edges[0]!.b === (a < b ? b : a));
    } finally {
      ctx.cleanup();
    }
  });

  it("skips topics (degraded for topics only) and still embeds when the LLM is disabled", async () => {
    const ctx = setup({ llmTopics: true });
    try {
      remember(ctx.db, ctx.config, "disabled topics alpha", "dt-a", T1);
      const embed = fakeEmbed(
        keyed([["disabled topics alpha", vec(1, 0)]]),
      );
      const res = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-topics-disabled", embed, T2,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const d = assoc(res);
      assert.equal(d["degraded"], false);
      assert.equal(d["embedded"], 1);
      assert.equal(d["topicsDegraded"], true);
      assert.equal(d["topicsWritten"], 0);
      assert.equal(topicRows(ctx.db).length, 0);
      assert.equal(vecIds(ctx.db).length, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("leaves topics dirty after a generator timeout and retries next run", async () => {
    const ctx = setup({ llmTopics: true });
    try {
      const a = remember(ctx.db, ctx.config, "timeout alpha", "to-a", T1);
      const embed = fakeEmbed(
        new Map([
          [normalizeBody("timeout alpha"), vec(1, 0)],
          ["整備", vec(0, 0, 220)],
          [topicText("timeout alpha", ["整備"]), vec(0.9, 0.1)],
        ]),
      );
      let calls = 0;
      const gen: AssociateGenerate = async () => {
        calls++;
        return calls === 1 ? null : "整備";
      };
      const first = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-timeout-1", embed, T2, gen,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      const d1 = assoc(first);
      assert.equal(d1["topicsFailed"], 1);
      assert.equal(d1["topicsWritten"], 0);
      assert.equal(d1["embedded"], 1);
      assert.equal(topicRows(ctx.db).length, 0);

      const second = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-timeout-2", embed, T2, gen,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      const d2 = assoc(second);
      assert.equal(d2["topicsFailed"], 0);
      assert.equal(d2["topicsWritten"], 1);
      assert.equal(d2["embedded"], 1);
      assert.deepEqual(topicRows(ctx.db).map((r) => ({ recordId: r.recordId, topic: r.topic })), [{ recordId: a, topic: "整備" }]);
      assert.equal(calls, 2);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("topic.set / topic.pending / tag precedence", () => {
  it("turns canonical tags into tag-origin topics without calling the generator", async () => {
    const ctx = setup({ llmTopics: true });
    try {
      const tags = ["健康", "予定"];
      const a = remember(ctx.db, ctx.config, "tagged alpha", "g-a", T1, tags);
      let genCalls = 0;
      const gen: AssociateGenerate = async () => {
        genCalls++;
        return "仕事";
      };
      const embed = fakeEmbed(new Map([[topicText("tagged alpha", tags), vec(1, 0)]]));
      const first = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-tag-1", embed, T2, gen,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(genCalls, 0);
      assert.equal(assoc(first)["topicsWritten"], 1);
      const firstRows = topicRows(ctx.db);
      assert.deepEqual(firstRows.map((r) => r.topic).sort(), [...tags].sort());
      assert.ok(firstRows.every((r) => r.origin === "tag"), JSON.stringify(firstRows));

      // External topics can be stored, but canonical tags still win on the
      // next maintain.associate and the external rows are reconciled away.
      const set = topicSet(
        ctx.db, ctx.config,
        { scope: SCOPE, id: a, bodyHash: bodyHashOf(ctx.db, a), topics: ["仕事"] },
        "assoc-tag-set-1", T2,
      );
      assert.equal(set.ok, true, JSON.stringify(set));
      const second = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-tag-2", embed, T2, gen,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(genCalls, 0);
      const rows = topicRows(ctx.db);
      assert.deepEqual(rows.map((r) => r.topic).sort(), [...tags].sort());
      assert.ok(rows.every((r) => r.origin === "tag"), JSON.stringify(rows));
      assert.equal(assoc(second)["topicsWritten"], 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects topic.set for a stale bodyHash with CONFLICT", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "stale topic alpha", "st-a", T1);
      const res = topicSet(
        ctx.db, ctx.config,
        { scope: SCOPE, id: a, bodyHash: "stale-body-hash", topics: ["仕事"] },
        "assoc-stale-set-1", T2,
      );
      assert.equal(res.code, "CONFLICT");
      assert.equal(topicRows(ctx.db).length, 0);
      const ops = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM operations WHERE idempotencyKey = 'assoc-stale-set-1'`)
        .get() as { n: number };
      assert.equal(ops.n, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("marks the record dirty so the next associate re-embeds and rescans it", async () => {
    const ctx = setup({ batchMax: 50, topK: 5 });
    try {
      const a = remember(ctx.db, ctx.config, "external dirty alpha", "ed-a", T1);
      const embed = fakeEmbed(
        new Map([
          [normalizeBody("external dirty alpha"), vec(1, 0)],
          [topicText("external dirty alpha", ["仕事"]), vec(0.8, 0.6)],
        ]),
      );
      const first = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-ext-1", embed, T2,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(assoc(first)["embedded"], 1);
      assert.equal(assoc(first)["scanned"], 1);
      assert.deepEqual(vecIds(ctx.db), [a]);
      assert.deepEqual(stateIds(ctx.db), [a]);

      const set = topicSet(
        ctx.db, ctx.config,
        { scope: SCOPE, id: a, bodyHash: bodyHashOf(ctx.db, a), topics: ["仕事"] },
        "assoc-ext-set-1", T2,
      );
      assert.equal(set.ok, true, JSON.stringify(set));
      const topic = (set.data as { topic: { origin: string } }).topic;
      assert.equal(topic.origin, "external");
      // Derived caches are invalidated immediately.
      assert.equal(vecIds(ctx.db).length, 0);
      assert.equal(stateIds(ctx.db).length, 0);

      const second = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-ext-2", embed, T2,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      const d = assoc(second);
      assert.equal(d["embedded"], 1);
      assert.equal(d["scanned"], 1);
      assert.deepEqual(vecIds(ctx.db), [a]);
      assert.deepEqual(stateIds(ctx.db), [a]);
      const rows = topicRows(ctx.db);
      assert.deepEqual(rows.map((r) => `${r.topic}:${r.origin}`), ["仕事:external"]);
    } finally {
      ctx.cleanup();
    }
  });

  it("topic.pending excludes tagged/external records and includes llm-only ones", async () => {
    const ctx = setup({ llmTopics: true });
    try {
      const tagged = remember(ctx.db, ctx.config, "pending tagged", "p-t", T1, ["健康"]);
      const external = remember(ctx.db, ctx.config, "pending external", "p-e", T2);
      const llmOnly = remember(ctx.db, ctx.config, "pending llm", "p-l", "2026-09-01T00:00:03.000Z");
      const plain = remember(ctx.db, ctx.config, "pending plain", "p-p", "2026-09-01T00:00:04.000Z");
      const set = topicSet(
        ctx.db, ctx.config,
        { scope: SCOPE, id: external, bodyHash: bodyHashOf(ctx.db, external), topics: ["仕事"] },
        "assoc-pending-set-1", T2,
      );
      assert.equal(set.ok, true, JSON.stringify(set));
      const embed = fakeEmbed(
        new Map([
          [topicText("pending tagged", ["健康"]), vec(1, 0)],
          [topicText("pending external", ["仕事"]), vec(0.9, 0.1)],
          [topicText("pending llm", ["整備"]), vec(0.8, 0.6)],
          [normalizeBody("pending plain"), vec(0.7, 0.7)],
        ]),
      );
      const gen = fakeGenerate([["pending llm", "整備"]]);
      const res = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-pending-1", embed, T2, gen,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.ok(
        topicRows(ctx.db).some((r) => r.recordId === llmOnly && r.origin === "llm"),
        JSON.stringify(topicRows(ctx.db)),
      );

      const pending = topicPending(ctx.db, ctx.config, { scope: SCOPE });
      assert.equal(pending.ok, true, JSON.stringify(pending));
      const data = pending.data as { items: Array<{ id: string }>; remaining: number };
      assert.deepEqual(data.items.map((i) => i.id).sort(), [llmOnly, plain].sort());
      assert.equal(data.remaining, 0);
      assert.ok(!data.items.some((i) => i.id === tagged));
      assert.ok(!data.items.some((i) => i.id === external));
    } finally {
      ctx.cleanup();
    }
  });

  it("never calls the generator when llmTopics is false", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "llm off alpha", "lo-a", T1);
      let calls = 0;
      const gen: AssociateGenerate = async () => {
        calls++;
        return "仕事";
      };
      const res = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-llm-off-1", fakeEmbed(keyed([["llm off alpha", vec(1, 0)]])), T2, gen,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const d = assoc(res);
      assert.equal(calls, 0);
      assert.equal(d["topicsWritten"], 0);
      assert.equal(d["topicsDegraded"], false);
      assert.equal(d["embedded"], 1);
      assert.equal(topicRows(ctx.db).length, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("connects two records sharing an external topic via topicBonus", async () => {
    const ctx = setup({ batchMax: 50, topK: 5, minScore: 0.45, topicBonus: 0.3 });
    try {
      const topic = "モーターサイクル";
      const a = remember(ctx.db, ctx.config, "ext shared alpha", "ex-a", T1);
      const b = remember(ctx.db, ctx.config, "ext shared beta", "ex-b", T2);
      for (const [id, key] of [[a, "alpha"], [b, "beta"]] as const) {
        const set = topicSet(
          ctx.db, ctx.config,
          { scope: SCOPE, id, bodyHash: bodyHashOf(ctx.db, id), topics: [topic] },
          `assoc-shared-set-${key}`, T2,
        );
        assert.equal(set.ok, true, JSON.stringify(set));
      }
      const embed = fakeEmbed(
        new Map([
          [topicText("ext shared alpha", [topic]), vec(1, 0)],
          [topicText("ext shared beta", [topic]), vec(0.2, Math.sqrt(1 - 0.04))],
        ]),
      );
      const res = await maintainAssociate(
        ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE },
        "assoc-shared-1", embed, T2,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(assoc(res)["edgesWritten"], 1);
      const edges = edgeRows(ctx.db);
      assert.equal(edges.length, 1, JSON.stringify(edges));
      assert.equal(edges[0]!.a, a < b ? a : b);
      assert.equal(edges[0]!.b, a < b ? b : a);
      assert.ok(Math.abs(edges[0]!.score - 0.5) < 1e-6, JSON.stringify(edges));
    } finally {
      ctx.cleanup();
    }
  });
});

describe("associate config validation", () => {
  it("rejects unknown keys and out-of-range values", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "assoc-cfg-"));
    try {
      const base = {
        dbPath: "./t.db",
        vaultPath: "./vault",
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
      const p = path.join(dir, "memory.config.json");
      fs.writeFileSync(p, JSON.stringify({ ...base, associate: { bogus: 1 } }));
      assert.throws(() => loadConfig(p), /unknown associate field/);
      fs.writeFileSync(p, JSON.stringify({ ...base, associate: { batchMax: 501 } }));
      assert.throws(() => loadConfig(p), /associate\.batchMax/);
      fs.writeFileSync(p, JSON.stringify({ ...base, associate: { minScore: 1.5 } }));
      assert.throws(() => loadConfig(p), /associate\.minScore/);
      fs.writeFileSync(p, JSON.stringify({ ...base, associate: { llmTopics: "yes" } }));
      assert.throws(() => loadConfig(p), /associate\.llmTopics/);
      fs.writeFileSync(p, JSON.stringify({ ...base, associate: { topK: 5, minScore: 0.45 } }));
      const cfg = loadConfig(p);
      assert.equal(cfg.associate?.topK, 5);
      assert.equal(cfg.associate?.minScore, 0.45);
      assert.equal(cfg.associate?.batchMax, 50);
      assert.equal(cfg.associate?.llmTopics, false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
