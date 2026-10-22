/**
 * graph.local / graph.version tests: undirected BFS around one record,
 * status/scope filtering, deterministic ordering, bounded shrinking, and
 * an opaque freshness token that ignores pure reads.
 *
 * Synthetic temp DBs only. No source-text or UI assertions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  correctRecord,
  eventAppend,
  graphLocal,
  graphPage,
  graphVersion,
  insertEpisodeSummary,
  rememberRecord,
  retireRecord,
} from "../src/store.js";

const SCOPE = "personal/default";
const OTHER = "personal/other";
const OBS = "2026-09-01T00:00:00.000Z";

interface LocalNode {
  id: string;
  status: string;
  kind: string;
  label: string;
  tags: string[];
  createdAt: string;
  episode: { kind: string; episodeKey: string; level: string } | null;
  hop: number;
}

interface LocalData {
  center: string;
  nodes: LocalNode[];
  edges: Array<{ from: string; to: string; kind: string }>;
  truncated: boolean;
  version: string;
}

function baseConfig(dir: string, overrides: Partial<AppConfig["limits"]> = {}): AppConfig {
  return {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE, OTHER],
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
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-local-"));
  const config = baseConfig(dir, overrides);
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

function prov(source = "session:s1:turn:1"): { source: string; observedAt: string } {
  return { source, observedAt: OBS };
}

let keyN = 0;
const key = (p: string): string => `${p}-${Date.now()}-${keyN++}`;

function raw(db: DatabaseSync, config: AppConfig): void {
  const r = eventAppend(db, config, {
    eventId: "e1",
    sessionId: "s1",
    turnId: "t1",
    body: "raw body for graph.local tests",
    provenance: prov(),
    scope: SCOPE,
  }, key("ev"));
  assert.equal(r.code, "OK", JSON.stringify(r));
}

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  opts: {
    kind?: string;
    links?: string[];
    scope?: string;
    now?: string;
    source?: string;
  } = {},
): string {
  const summary = (opts.kind ?? "user_fact") === "summary" || (opts.kind ?? "") === "correction";
  const r = rememberRecord(db, config, {
    body,
    kind: opts.kind ?? "user_fact",
    provenance: prov(opts.source ?? (summary ? "derived:test" : "session:s1:turn:1")),
    scope: opts.scope ?? SCOPE,
    tags: [],
    links: opts.links ?? [],
    sourceRefs: summary ? [] : ["e1"],
  }, key("rem"), opts.now);
  assert.equal(r.code, "OK", JSON.stringify(r));
  return (r.data?.["record"] as { id: string }).id;
}

function local(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
): { code: string; data: LocalData | null; bytes: number } {
  const res = graphLocal(db, config, params);
  return {
    code: res.code,
    data: res.data as LocalData | null,
    bytes: Buffer.byteLength(JSON.stringify(res), "utf8"),
  };
}

function version(db: DatabaseSync, config: AppConfig, scope = SCOPE): string {
  const res = graphVersion(db, config, { scope });
  assert.equal(res.code, "OK", JSON.stringify(res));
  const v = res.data?.["version"];
  assert.equal(typeof v, "string");
  return v as string;
}

describe("graph.local: depth and undirected traversal", () => {
  it("depth 1 returns inbound+outbound neighbours; depth 2 adds the next hop", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const a = remember(ctx.db, ctx.config, "a", { now: "2026-09-01T00:00:01.000Z" });
      const b = remember(ctx.db, ctx.config, "b", {
        now: "2026-09-01T00:00:02.000Z",
        links: [a],
      });
      const c = remember(ctx.db, ctx.config, "c", {
        now: "2026-09-01T00:00:03.000Z",
        links: [b],
      });
      const d = remember(ctx.db, ctx.config, "d", {
        now: "2026-09-01T00:00:04.000Z",
        links: [c],
      });

      const one = local(ctx.db, ctx.config, { scope: SCOPE, id: b, depth: 1, limit: 20 });
      assert.equal(one.code, "OK", JSON.stringify(one));
      assert.equal(one.data?.center, b);
      assert.deepEqual(one.data?.nodes.map((n) => n.id), [b, c, a]);
      assert.deepEqual(one.data?.nodes.map((n) => n.hop), [0, 1, 1]);
      assert.deepEqual(
        [...(one.data?.edges ?? [])].sort((x, y) => x.from.localeCompare(y.from)),
        [
          { from: b, to: a, kind: "related" },
          { from: c, to: b, kind: "related" },
        ].sort((x, y) => x.from.localeCompare(y.from)),
      );
      assert.equal(one.data?.truncated, false);

      const two = local(ctx.db, ctx.config, { scope: SCOPE, id: b, depth: 2, limit: 20 });
      assert.equal(two.code, "OK", JSON.stringify(two));
      assert.deepEqual(two.data?.nodes.map((n) => n.id), [b, c, a, d]);
      assert.deepEqual(two.data?.nodes.map((n) => n.hop), [0, 1, 1, 2]);
      const edges = two.data?.edges ?? [];
      assert.equal(edges.length, 3);
      assert.ok(edges.some((e) => e.from === d && e.to === c));
    } finally {
      ctx.cleanup();
    }
  });

  it("uses summary/correction links as consolidation edges in both directions", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const a = remember(ctx.db, ctx.config, "source a", { now: "2026-09-01T00:00:01.000Z" });
      const sum = remember(ctx.db, ctx.config, "summary", {
        kind: "summary",
        now: "2026-09-01T00:00:02.000Z",
        links: [a],
      });
      // Centre is the SOURCE: consolidation is reached through a backlink.
      const r = local(ctx.db, ctx.config, { scope: SCOPE, id: a, depth: 1, limit: 20 });
      assert.equal(r.code, "OK", JSON.stringify(r));
      assert.deepEqual(r.data?.nodes.map((n) => n.id), [a, sum]);
      assert.deepEqual(r.data?.edges, [{ from: sum, to: a, kind: "consolidation" }]);
    } finally {
      ctx.cleanup();
    }
  });

  it("orders each hop by createdAt DESC, id ASC", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const center = remember(ctx.db, ctx.config, "center", { now: "2026-09-01T00:00:01.000Z" });
      const older = remember(ctx.db, ctx.config, "older", {
        now: "2026-09-01T00:00:02.000Z",
        links: [center],
      });
      const tie1 = remember(ctx.db, ctx.config, "tie1", {
        now: "2026-09-01T00:00:09.000Z",
        links: [center],
      });
      const tie2 = remember(ctx.db, ctx.config, "tie2", {
        now: "2026-09-01T00:00:09.000Z",
        links: [center],
      });
      const r = local(ctx.db, ctx.config, { scope: SCOPE, id: center, depth: 1, limit: 20 });
      assert.equal(r.code, "OK", JSON.stringify(r));
      const hop1 = (r.data?.nodes ?? []).filter((n) => n.hop === 1);
      assert.deepEqual(
        hop1.map((n) => n.id),
        [...[tie1, tie2].sort((x, y) => x.localeCompare(y)), older],
      );
      assert.equal(hop1[0].createdAt, hop1[1].createdAt);
      assert.ok(hop1[2].createdAt < hop1[0].createdAt);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("graph.local: scope and status filters", () => {
  it("excludes retired neighbours unless includeRetired, and still returns a retired centre", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const retired = remember(ctx.db, ctx.config, "retired neighbour", {
        now: "2026-09-01T00:00:01.000Z",
      });
      const rr = retireRecord(ctx.db, ctx.config, {
        id: retired,
        scope: SCOPE,
        reasonCode: "NO_LONGER_USEFUL",
      }, key("ret"));
      assert.equal(rr.code, "OK", JSON.stringify(rr));
      const center = remember(ctx.db, ctx.config, "center", {
        now: "2026-09-01T00:00:02.000Z",
        links: [retired],
      });

      const plain = local(ctx.db, ctx.config, { scope: SCOPE, id: center, depth: 1, limit: 20 });
      assert.equal(plain.code, "OK", JSON.stringify(plain));
      assert.deepEqual(plain.data?.nodes.map((n) => n.id), [center]);
      assert.deepEqual(plain.data?.edges, []);
      assert.equal(plain.data?.truncated, false);

      const withRetired = local(ctx.db, ctx.config, {
        scope: SCOPE,
        id: center,
        depth: 1,
        limit: 20,
        includeRetired: true,
      });
      assert.equal(withRetired.code, "OK", JSON.stringify(withRetired));
      assert.deepEqual(
        withRetired.data?.nodes.map((n) => n.id).sort(),
        [center, retired].sort(),
      );
      assert.deepEqual(withRetired.data?.edges, [{ from: center, to: retired, kind: "related" }]);

      // Centre may itself be retired (any status).
      const retiredCenter = local(ctx.db, ctx.config, { scope: SCOPE, id: retired, depth: 1, limit: 20 });
      assert.equal(retiredCenter.code, "OK", JSON.stringify(retiredCenter));
      assert.equal(retiredCenter.data?.nodes[0].id, retired);
      assert.equal(retiredCenter.data?.nodes[0].status, "retired");
    } finally {
      ctx.cleanup();
    }
  });

  it("excludes other-scope neighbours and does not resolve an other-scope centre", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const other = remember(ctx.db, ctx.config, "other scope", {
        kind: "summary",
        scope: OTHER,
        now: "2026-09-01T00:00:01.000Z",
      });
      const center = remember(ctx.db, ctx.config, "center", {
        now: "2026-09-01T00:00:02.000Z",
        links: [other],
      });
      const r = local(ctx.db, ctx.config, { scope: SCOPE, id: center, depth: 2, limit: 20 });
      assert.equal(r.code, "OK", JSON.stringify(r));
      assert.deepEqual(r.data?.nodes.map((n) => n.id), [center]);
      assert.deepEqual(r.data?.edges, []);

      const cross = local(ctx.db, ctx.config, { scope: OTHER, id: center, depth: 1, limit: 20 });
      assert.equal(cross.code, "FORBIDDEN_SCOPE");
      const missing = local(ctx.db, ctx.config, { scope: SCOPE, id: "rec_missing", depth: 1 });
      assert.equal(missing.code, "NOT_FOUND");
      assert.equal(local(ctx.db, ctx.config, { scope: "personal/nope", id: center }).code, "FORBIDDEN_SCOPE");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("graph.local: bounds", () => {
  it("sets truncated when the limit cuts the BFS, and shrinks under the byte budget", () => {
    const ctx = setup({ responseMaxBytes: 1024, snippetMaxCp: 200, limitDefault: 20 });
    try {
      raw(ctx.db, ctx.config);
      const long = "x".repeat(300);
      const ids: string[] = [];
      for (let i = 0; i < 8; i++) {
        ids.push(remember(ctx.db, ctx.config, `${i}-${long}`, {
          now: `2026-09-01T00:00:0${i}.000Z`,
          links: i === 0 ? [] : [ids[i - 1]],
        }));
      }
      const limited = local(ctx.db, ctx.config, {
        scope: SCOPE,
        id: ids[0],
        depth: 2,
        limit: 2,
      });
      assert.equal(limited.code, "OK", JSON.stringify(limited));
      assert.equal(limited.data?.nodes.length, 2);
      assert.equal(limited.data?.truncated, true);

      const shrunk = local(ctx.db, ctx.config, {
        scope: SCOPE,
        id: ids[0],
        depth: 2,
        limit: 20,
      });
      assert.equal(shrunk.code, "OK", JSON.stringify(shrunk));
      assert.ok(shrunk.bytes <= 1024, `bytes=${shrunk.bytes}`);
      assert.equal(shrunk.data?.nodes[0].id, ids[0]);
      assert.equal(shrunk.data?.truncated, true);
      assert.ok((shrunk.data?.nodes.length ?? 0) < 8);
      for (const n of shrunk.data?.nodes ?? []) {
        assert.ok([...n.label].length <= 200);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects invalid depth/limit/params with fixed codes", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const id = remember(ctx.db, ctx.config, "one", { now: "2026-09-01T00:00:01.000Z" });
      assert.equal(local(ctx.db, ctx.config, { scope: SCOPE, id, depth: 3 }).code, "BAD_REQUEST");
      assert.equal(local(ctx.db, ctx.config, { scope: SCOPE, id, depth: 0 }).code, "BAD_REQUEST");
      assert.equal(local(ctx.db, ctx.config, { scope: SCOPE, id, limit: 0 }).code, "BAD_REQUEST");
      assert.equal(local(ctx.db, ctx.config, { scope: SCOPE, id, limit: 100000 }).code, "LIMIT_EXCEEDED");
      assert.equal(local(ctx.db, ctx.config, { scope: SCOPE, id, includeRetired: "yes" }).code, "BAD_REQUEST");
      assert.equal(local(ctx.db, ctx.config, { scope: SCOPE, id, extra: true }).code, "BAD_REQUEST");
      assert.equal(local(ctx.db, ctx.config, { scope: SCOPE }).code, "BAD_REQUEST");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("graph.version", () => {
  it("changes after remember/link/retire/correct/episode writes and is stable across reads", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const a = remember(ctx.db, ctx.config, "a", { now: "2026-09-01T00:00:01.000Z" });
      const v0 = version(ctx.db, ctx.config);
      // Pure reads never move the token.
      assert.equal(version(ctx.db, ctx.config), v0);
      const read = graphPage(ctx.db, ctx.config, { scope: SCOPE, limit: 5 });
      assert.equal(read.code, "OK", JSON.stringify(read));
      assert.equal(read.data?.["version"], v0);
      const lr = local(ctx.db, ctx.config, { scope: SCOPE, id: a, limit: 5 });
      assert.equal(lr.code, "OK", JSON.stringify(lr));
      assert.equal(lr.data?.version, v0);
      assert.equal(version(ctx.db, ctx.config), v0);

      const b = remember(ctx.db, ctx.config, "b", {
        now: "2026-09-01T00:00:02.000Z",
        links: [a],
      });
      const v1 = version(ctx.db, ctx.config);
      assert.notEqual(v1, v0);

      const rr = retireRecord(ctx.db, ctx.config, {
        id: a,
        scope: SCOPE,
        reasonCode: "NO_LONGER_USEFUL",
      }, key("ret"));
      assert.equal(rr.code, "OK", JSON.stringify(rr));
      const v2 = version(ctx.db, ctx.config);
      assert.notEqual(v2, v1);

      const cr = correctRecord(ctx.db, ctx.config, {
        recordId: b,
        body: "b revised",
        kind: "correction",
        provenance: prov("session:s1:turn:2"),
        scope: SCOPE,
        links: [a],
        sourceRefs: ["e1"],
      }, key("cor"));
      assert.equal(cr.code, "OK", JSON.stringify(cr));
      const v3 = version(ctx.db, ctx.config);
      assert.notEqual(v3, v2);

      insertEpisodeSummary(ctx.db, {
        scope: SCOPE,
        kind: "doc",
        episodeKey: "doc-episode",
        level: "episode",
        recordId: b,
        createdAt: "2026-09-01T00:00:09.000Z",
      });
      const v4 = version(ctx.db, ctx.config);
      assert.notEqual(v4, v3);

      assert.equal(version(ctx.db, ctx.config), v4);
      assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM note_heat").get()?.["n"] !== undefined, true);
    } finally {
      ctx.cleanup();
    }
  });

  it("validates scope and params", () => {
    const ctx = setup();
    try {
      assert.equal(graphVersion(ctx.db, ctx.config, { scope: 1 }).code, "BAD_REQUEST");
      assert.equal(graphVersion(ctx.db, ctx.config, { scope: "personal/nope" }).code, "FORBIDDEN_SCOPE");
      assert.equal(graphVersion(ctx.db, ctx.config, { scope: SCOPE, extra: 1 }).code, "BAD_REQUEST");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("graph byte/limit config", () => {
  it("graphResponseMaxBytes lets graph.page return more nodes than responseMaxBytes", () => {
    const ctx = setup({ responseMaxBytes: 1024, graphResponseMaxBytes: 65536, graphLimitMax: 100 });
    try {
      raw(ctx.db, ctx.config);
      for (let i = 0; i < 60; i++) {
        remember(ctx.db, ctx.config, `node ${i} ${"y".repeat(60)}`, {
          now: `2026-09-01T00:00:${String(i).padStart(2, "0")}.000Z`,
        });
      }
      const res = graphPage(ctx.db, ctx.config, { scope: SCOPE, limit: 60 });
      assert.equal(res.code, "OK", JSON.stringify(res));
      const nodes = res.data?.["nodes"] as Array<{ id: string }>;
      assert.equal(nodes.length, 60);
      assert.ok(Buffer.byteLength(JSON.stringify(res), "utf8") > 1024);
    } finally {
      ctx.cleanup();
    }
  });

  it("validates optional graph limits at config load", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-config-"));
    try {
      const limits = {
        bodyMaxCp: 2000,
        queryMaxCp: 500,
        tagsMax: 5,
        linksMax: 8,
        sourceRefsMax: 8,
        limitDefault: 10,
        limitMax: 25,
        snippetMaxCp: 200,
        responseMaxBytes: 8192,
      };
      const base = {
        dbPath: "./t.db",
        vaultPath: "./v",
        allowedScopes: [SCOPE],
        timeouts: { cliMs: 5000, busyMs: 2000 },
        dbMaxBytes: 104857600,
      };
      const write = (name: string, extra: Record<string, unknown>): string => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, JSON.stringify({ ...base, limits: { ...limits, ...extra } }));
        return p;
      };
      assert.throws(
        () => loadConfig(write("low.json", { graphResponseMaxBytes: 1024 })),
        /graphResponseMaxBytes/,
      );
      assert.throws(
        () => loadConfig(write("high.json", { graphResponseMaxBytes: 1048577 })),
        /graphResponseMaxBytes/,
      );
      assert.throws(
        () => loadConfig(write("limit.json", { graphLimitMax: 2001 })),
        /graphLimitMax/,
      );
      const cfg = loadConfig(write("ok.json", { graphLimitMax: 2000, graphResponseMaxBytes: 1048576 }));
      assert.equal(cfg.limits.graphLimitMax, 2000);
      assert.equal(cfg.limits.graphResponseMaxBytes, 1048576);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
