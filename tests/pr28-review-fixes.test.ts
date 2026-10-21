/**
 * PR #28 review regressions:
 * 1. graph.local dedupes/excludes visited neighbours BEFORE the SQL bound, so
 *    a node linking to several frontier nodes cannot hide other neighbours.
 * 2. Omitted graph limits use min(limitDefault, graphLimitMax).
 * 3. Persisted edge reads do not treat the current linksMax as a read bound.
 *
 * Synthetic temp DBs only.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { eventAppend, graphLocal, graphPage, rememberRecord } from "../src/store.js";

const SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";

interface LocalData {
  center: string;
  nodes: Array<{ id: string; hop: number }>;
  edges: Array<{ from: string; to: string; kind: string }>;
  truncated: boolean;
  version: string;
}

function baseConfig(dir: string, overrides: Partial<AppConfig["limits"]> = {}): AppConfig {
  return {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE],
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      linksMax: 8,
      sourceRefsMax: 8,
      limitDefault: 3,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 65536,
      ...overrides,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
}

function setup(overrides: Partial<AppConfig["limits"]> = {}): {
  config: AppConfig;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr28-graph-"));
  const config = baseConfig(dir, overrides);
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

let keyN = 0;
const key = (p: string): string => `${p}-${Date.now()}-${keyN++}`;

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  now: string,
  links: string[] = [],
): string {
  const r = rememberRecord(db, config, {
    body,
    kind: "user_fact",
    provenance: { source: "session:s1:turn:1", observedAt: OBS },
    scope: SCOPE,
    tags: [],
    links,
    sourceRefs: ["e1"],
  }, key("rem"), now);
  assert.equal(r.code, "OK", JSON.stringify(r));
  return (r.data?.["record"] as { id: string }).id;
}

function local(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
): { code: string; data: LocalData | null } {
  const res = graphLocal(db, config, params);
  return { code: res.code, data: res.data as LocalData | null };
}

describe("PR #28 review fixes", () => {
  it("graph.local bounds deduped, unvisited neighbours instead of raw link rows", () => {
    const ctx = setup();
    try {
      assert.equal(eventAppend(ctx.db, ctx.config, {
        eventId: "e1",
        sessionId: "s1",
        turnId: "t1",
        body: "raw body for PR 28 regression",
        provenance: { source: "session:s1:turn:1", observedAt: OBS },
        scope: SCOPE,
      }, key("ev")).code, "OK");

      // a,b,c -> center; d -> a,b,c; e -> a. d is newer than e.
      const center = remember(ctx.db, ctx.config, "center", "2026-09-01T00:00:00.000Z");
      const a = remember(ctx.db, ctx.config, "a", "2026-09-01T00:00:01.000Z", [center]);
      const b = remember(ctx.db, ctx.config, "b", "2026-09-01T00:00:02.000Z", [center]);
      const c = remember(ctx.db, ctx.config, "c", "2026-09-01T00:00:03.000Z", [center]);
      const e = remember(ctx.db, ctx.config, "e", "2026-09-01T00:00:05.000Z", [a]);
      const d = remember(ctx.db, ctx.config, "d", "2026-09-01T00:00:06.000Z", [a, b, c]);

      const full = local(ctx.db, ctx.config, {
        scope: SCOPE,
        id: center,
        depth: 2,
        limit: 6,
      });
      assert.equal(full.code, "OK", JSON.stringify(full));
      assert.deepEqual(
        new Set(full.data?.nodes.map((n) => n.id)),
        new Set([center, a, b, c, d, e]),
      );
      assert.equal(full.data?.truncated, false);

      const cut = local(ctx.db, ctx.config, {
        scope: SCOPE,
        id: center,
        depth: 2,
        limit: 5,
      });
      assert.equal(cut.code, "OK", JSON.stringify(cut));
      const cutIds = new Set(cut.data?.nodes.map((n) => n.id));
      assert.equal(cutIds.size, 5);
      assert.equal(cut.data?.truncated, true);
      for (const id of [center, a, b, c, d]) assert.ok(cutIds.has(id));
      assert.equal(cutIds.has(e), false, "the older second-hop neighbour is the one cut");
    } finally {
      ctx.cleanup();
    }
  });

  it("omitted graph limits use min(limitDefault, graphLimitMax)", () => {
    const ctx = setup({ limitDefault: 3, graphLimitMax: 1 });
    try {
      assert.equal(eventAppend(ctx.db, ctx.config, {
        eventId: "e1",
        sessionId: "s1",
        turnId: "t1",
        body: "raw body for PR 28 regression",
        provenance: { source: "session:s1:turn:1", observedAt: OBS },
        scope: SCOPE,
      }, key("ev")).code, "OK");
      const first = remember(ctx.db, ctx.config, "first", "2026-09-01T00:00:01.000Z");
      const second = remember(ctx.db, ctx.config, "second", "2026-09-01T00:00:02.000Z", [first]);

      const page = graphPage(ctx.db, ctx.config, { scope: SCOPE });
      assert.equal(page.code, "OK", JSON.stringify(page));
      const nodes = page.data?.["nodes"] as Array<{ id: string }>;
      assert.equal(nodes.length, 1);
      assert.equal(nodes[0].id, second);
      assert.notEqual(page.data?.["nextCursor"], null);

      const near = local(ctx.db, ctx.config, { scope: SCOPE, id: second });
      assert.equal(near.code, "OK", JSON.stringify(near));
      assert.equal(near.data?.nodes.length, 1);
      assert.equal(near.data?.nodes[0].id, second);
      assert.equal(near.data?.truncated, true);
    } finally {
      ctx.cleanup();
    }
  });

  it("graph.page/graph.local read persisted edges beyond the current linksMax", () => {
    const ctx = setup();
    try {
      assert.equal(eventAppend(ctx.db, ctx.config, {
        eventId: "e1",
        sessionId: "s1",
        turnId: "t1",
        body: "raw body for PR 28 regression",
        provenance: { source: "session:s1:turn:1", observedAt: OBS },
        scope: SCOPE,
      }, key("ev")).code, "OK");
      const a = remember(ctx.db, ctx.config, "a", "2026-09-01T00:00:01.000Z");
      const b = remember(ctx.db, ctx.config, "b", "2026-09-01T00:00:02.000Z");
      // Stored while linksMax is 8, i.e. two persisted outbound links.
      const source = remember(ctx.db, ctx.config, "source", "2026-09-01T00:00:03.000Z", [a, b]);

      // A later config tightens linksMax below the persisted row's link count.
      ctx.config.limits.linksMax = 1;

      const page = graphPage(ctx.db, ctx.config, { scope: SCOPE, limit: 10 });
      assert.equal(page.code, "OK", JSON.stringify(page));
      const node = (page.data?.["nodes"] as Array<{ id: string; out: Array<{ to: string }> }>)
        .find((n) => n.id === source);
      assert.ok(node);
      assert.deepEqual(new Set(node.out.map((o) => o.to)), new Set([a, b]));

      const near = local(ctx.db, ctx.config, { scope: SCOPE, id: source, depth: 1, limit: 10 });
      assert.equal(near.code, "OK", JSON.stringify(near));
      assert.equal(near.data?.truncated, false);
      assert.deepEqual(
        new Set((near.data?.edges ?? []).filter((ed) => ed.from === source).map((ed) => ed.to)),
        new Set([a, b]),
      );
    } finally {
      ctx.cleanup();
    }
  });
});
