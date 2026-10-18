/**
 * M2 vector recall tests (consumer-visible behavior only).
 *
 * Covers the bounded deterministic lexical/raw/graph + vector fusion:
 * - without vectors, recall is the M1 lexical+graph path (fallback);
 * - injected valid vectors promote a paraphrase target with no shared
 *   tokens over a lexical decoy, deterministically;
 * - invalid vectors (wrong dim, NaN, zero-norm) and unknown record rows
 *   are ignored (offline fallback, never an error);
 * - dropping vec_notes restores exactly the lexical order (rebuildable
 *   derived index; canonical rows untouched);
 * - vector candidates respect scope isolation and the since/until window.
 *
 * Uses small synthetic unit vectors (no model download): what is asserted
 * is recall ordering/fallback behavior, never embedding text or wiring.
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
  recallRecords,
  rememberRecord,
  upsertRecordVector,
  eventAppend,
} from "../src/store.js";
import { VECTOR_DIM } from "../src/vectors.js";
import { runStoreOpWithDeadline } from "../src/deadline.js";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";

function setup(
  extraScopes: string[] = [],
  vectors?: NonNullable<AppConfig["vectors"]>,
): {
  config: AppConfig;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m2-vec-"));
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
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 8192,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  if (vectors) config.vectors = vectors;
  const { db } = initDb(config, path.join(dir, "memory.config.json"));
  return {
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

let evCounter = 0;

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  key: string,
  scope = SCOPE,
): string {
  const eventId = `m2ev-${key}`;
  const er = eventAppend(
    db, config,
    {
      eventId, sessionId: "s1", turnId: "t1", body: `raw context ${key}`,
      provenance: { source: "session:s1:turn:1", observedAt: OBS }, scope,
    },
    `m2evk-${key}-${evCounter++}`,
  );
  assert.equal(er.ok, true, JSON.stringify(er));
  const res = rememberRecord(
    db, config,
    {
      body, kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope, sourceRefs: [eventId],
    },
    `m2rem-${key}`,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

/** Deterministic orthogonal unit vectors in the pinned dim. */
function unitAt(i: number): Float32Array {
  const v = new Float32Array(VECTOR_DIM);
  v[i % VECTOR_DIM] = 1;
  return v;
}

function recallTop(
  db: DatabaseSync,
  config: AppConfig,
  query: string,
  vec?: Float32Array | null,
): string[] {
  const res = recallRecords(
    db, config, { query, scope: SCOPE, limit: 10 }, undefined,
    vec ? { vec, topK: 20 } : undefined,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return ((res.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
}

describe("M2 vector fusion fallback and promotion", () => {
  it("recalls lexically without vectors and promotes the paraphrase with vectors", () => {
    const ctx = setup();
    try {
      const target = remember(ctx.db, ctx.config, "orchard persimmon dawn gathering", "m2-t");
      const decoy = remember(ctx.db, ctx.config, "server migration midnight window", "m2-d");
      // Query shares no content token with the target; lexical ranks the decoy first.
      const lex = recallTop(ctx.db, ctx.config, "fruit pickers autumn crop morning");
      assert.ok(lex.includes(target) || lex.includes(decoy), JSON.stringify(lex));
      // Inject vectors: query == target direction, decoy orthogonal.
      const now = new Date().toISOString();
      const q = unitAt(3);
      assert.equal(
        upsertRecordVector(ctx.db, target, q, bodyHashFor(normalizeBody("orchard persimmon dawn gathering")), now),
        true,
      );
      assert.equal(
        upsertRecordVector(ctx.db, decoy, unitAt(7), bodyHashFor(normalizeBody("server migration midnight window")), now),
        true,
      );
      const fused = recallTop(ctx.db, ctx.config, "fruit pickers autumn crop morning", q);
      assert.equal(fused[0], target, JSON.stringify(fused));
      // Deterministic: same query+vectors => same order.
      assert.deepEqual(recallTop(ctx.db, ctx.config, "fruit pickers autumn crop morning", q), fused);
      // Rebuildable: dropping derived vectors restores exactly the lexical order.
      ctx.db.exec(`DELETE FROM vec_notes`);
      assert.deepEqual(recallTop(ctx.db, ctx.config, "fruit pickers autumn crop morning", q), lex);
    } finally {
      ctx.cleanup();
    }
  });

  it("ignores invalid vectors and unknown rows (fallback, never an error)", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "lighthouse brass lamp evening", "m2-i-a");
      const lex = recallTop(ctx.db, ctx.config, "lighthouse brass lamp");
      assert.ok(lex.includes(a));
      const now = new Date().toISOString();
      // Wrong dim.
      ctx.db.prepare(
        `INSERT INTO vec_notes(recordId, dim, vec, bodyHash, updatedAt) VALUES (?, 8, ?, 'x', ?)`,
      ).run(a, Buffer.alloc(32), now);
      // NaN vector at the right dim.
      const nan = new Float32Array(VECTOR_DIM).fill(Number.NaN);
      assert.equal(upsertRecordVector(ctx.db, a, nan, "x", now), false);
      // Zero-norm vector.
      assert.equal(upsertRecordVector(ctx.db, a, new Float32Array(VECTOR_DIM), "x", now), false);
      // Row for an unknown record.
      assert.equal(upsertRecordVector(ctx.db, "rec_missing_xyz", unitAt(1), "x", now), true);
      const q = unitAt(1);
      const again = recallTop(ctx.db, ctx.config, "lighthouse brass lamp", q);
      assert.deepEqual(again, lex, JSON.stringify({ again, lex }));
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps vector candidates inside scope and time-window isolation", () => {
    const ctx = setup(["work/default"]);
    try {
      const same = remember(ctx.db, ctx.config, "garden bench afternoon shadows", "m2-s-a");
      const other = remember(ctx.db, ctx.config, "garden bench afternoon shadows", "m2-s-b", "work/default");
      const now = new Date().toISOString();
      const q = unitAt(5);
      // Both scopes carry the same direction; only same-scope may surface.
      upsertRecordVector(ctx.db, same, q, "x", now);
      upsertRecordVector(ctx.db, other, q, "x", now);
      const ids = recallTop(ctx.db, ctx.config, "garden bench afternoon", q);
      assert.ok(ids.includes(same), JSON.stringify(ids));
      assert.ok(!ids.includes(other), JSON.stringify(ids));
      // Window excluding the record removes its vector candidacy too.
      const old = remember(ctx.db, ctx.config, "garden bench afternoon shadows", "m2-s-c");
      upsertRecordVector(ctx.db, old, q, "x", now);
      ctx.db.prepare(`UPDATE records SET createdAt = '2020-01-01T00:00:00.000Z' WHERE id = ?`).run(old);
      const res = recallRecords(
        ctx.db, ctx.config,
        { query: "garden bench afternoon", scope: SCOPE, limit: 10, since: "2026-01-01T00:00:00.000Z" },
        undefined, { vec: q, topK: 20 },
      );
      assert.equal(res.ok, true);
      const wids = ((res.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
      assert.ok(!wids.includes(old), JSON.stringify(wids));
    } finally {
      ctx.cleanup();
    }
  });
});

describe("M2 recall vector availability report (F-I01-06)", () => {
  const vectorConfig: NonNullable<AppConfig["vectors"]> = {
    modelDir: "./models/paraphrase-multilingual-MiniLM-L12-v2",
    topK: 20,
    timeoutMs: 15000,
    enabled: true,
  };
  it("reports disabled when the vectors section is absent", () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "harbor lantern evening signal", "m2-v-disabled");
      const res = recallRecords(ctx.db, ctx.config, { query: "harbor lantern", scope: SCOPE, limit: 10 });
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal((res.data as { vector?: string }).vector, "disabled");
    } finally {
      ctx.cleanup();
    }
  });

  it("reports unavailable when enabled but the query vector or index yields no candidates", () => {
    const ctx = setup([], vectorConfig);
    try {
      const id = remember(ctx.db, ctx.config, "harbor lantern evening signal", "m2-v-unavail");
      // Enabled but the query-embedding failed (simulates the worker's
      // recallVectorFor returning undefined): lexical+graph fallback.
      const failed = recallRecords(ctx.db, ctx.config, { query: "harbor lantern", scope: SCOPE, limit: 10 });
      assert.equal(failed.ok, true, JSON.stringify(failed));
      assert.equal((failed.data as { vector?: string }).vector, "unavailable");
      assert.ok(
        (failed.data as { items: Array<{ id: string }> }).items.length > 0,
        "fallback recall still returns lexical items",
      );
      // Enabled with a computed query vector but an empty derived index:
      // no vector candidates participate -> unavailable.
      const res = recallRecords(
        ctx.db, ctx.config, { query: "harbor lantern", scope: SCOPE, limit: 10 },
        undefined, { vec: unitAt(9), topK: 20 },
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal((res.data as { vector?: string }).vector, "unavailable");
      // Index populated and the query vector matches: used.
      assert.equal(
        upsertRecordVector(ctx.db, id, unitAt(9), bodyHashFor(normalizeBody("harbor lantern evening signal")), new Date().toISOString()),
        true,
      );
      const used = recallRecords(
        ctx.db, ctx.config, { query: "harbor lantern", scope: SCOPE, limit: 10 },
        undefined, { vec: unitAt(9), topK: 20 },
      );
      assert.equal(used.ok, true, JSON.stringify(used));
      assert.equal((used.data as { vector?: string }).vector, "used");
    } finally {
      ctx.cleanup();
    }
  });

  it("reports unavailable through the real worker path with a missing model directory", async () => {
    const ctx = setup([], { ...vectorConfig, modelDir: "./models/no-such-vector-model" });
    try {
      remember(ctx.db, ctx.config, "harbor lantern evening signal", "m2-v-missing-model");
      const okRes = recallRecords(ctx.db, ctx.config, { query: "seed lexical", scope: SCOPE, limit: 10 });
      assert.equal(okRes.ok, true, JSON.stringify(okRes));
      ctx.db.close();
      const out = await runStoreOpWithDeadline(
        {
          dbFile: ctx.config.dbPath,
          config: ctx.config,
          configPath: path.join(ctx.config.dbPath, ".."),
          op: "record.recall",
          params: { query: "harbor lantern", scope: SCOPE, limit: 10 },
          effectiveBusyMs: 1000,
          remainingMs: 20000,
        },
        20000,
      );
      assert.equal(out.timedOut, false);
      if (!out.timedOut) {
        assert.equal(out.res.ok, true, JSON.stringify(out.res));
        assert.equal((out.res.data as { vector?: string }).vector, "unavailable");
      }
    } finally {
      ctx.cleanup();
    }
  });
});
