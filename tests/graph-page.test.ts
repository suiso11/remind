/**
 * graph.page read-op tests: bounded paging, edge filtering, episode tagging,
 * byte-budget shrinking, and read-only behavior.
 *
 * Synthetic temp DBs only. No source-text or UI assertions.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  eventAppend,
  graphPage,
  insertEpisodeSummary,
  rememberRecord,
  retireRecord,
} from "../src/store.js";

const SCOPE = "personal/default";
const OTHER = "personal/other";
const OBS = "2026-09-01T00:00:00.000Z";

interface PageNode {
  id: string;
  status: string;
  kind: string;
  label: string;
  tags: string[];
  createdAt: string;
  episode: { kind: string; episodeKey: string; level: string } | null;
  out: Array<{ to: string; kind: string }>;
  danglingOut: number;
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-page-"));
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
    body: "raw body for graph.page tests",
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
    tags?: string[];
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
    tags: opts.tags ?? [],
    links: opts.links ?? [],
    sourceRefs: summary ? [] : ["e1"],
  }, key("rem"), opts.now);
  assert.equal(r.code, "OK", JSON.stringify(r));
  return (r.data?.["record"] as { id: string }).id;
}

function page(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
): { code: string; nodes: PageNode[]; nextCursor: string | null; bytes: number } {
  const res = graphPage(db, config, params);
  const data = res.data as { nodes?: PageNode[]; nextCursor?: string | null } | null;
  return {
    code: res.code,
    nodes: data?.nodes ?? [],
    nextCursor: data?.nextCursor ?? null,
    bytes: Buffer.byteLength(JSON.stringify(res), "utf8"),
  };
}

describe("graph.page: paging and edges", () => {
  it("pages every included node exactly once in createdAt DESC, id ASC order", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const created: Array<{ id: string; createdAt: string }> = [];
      for (let i = 0; i < 7; i++) {
        const createdAt = `2026-09-01T00:00:0${i}.000Z`;
        const id = remember(ctx.db, ctx.config, `note ${i}`, { now: createdAt });
        created.push({ id, createdAt });
      }
      const seen: PageNode[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const r = page(ctx.db, ctx.config, { scope: SCOPE, limit: 2, ...(cursor ? { cursor } : {}) });
        assert.equal(r.code, "OK", JSON.stringify(r));
        assert.ok(r.nodes.length <= 2);
        seen.push(...r.nodes);
        cursor = r.nextCursor;
        pages++;
        assert.ok(pages < 10, "paging must terminate");
      } while (cursor !== null);

      assert.equal(seen.length, 7);
      assert.equal(new Set(seen.map((n) => n.id)).size, 7);
      for (let i = 1; i < seen.length; i++) {
        const prev = seen[i - 1];
        const cur = seen[i];
        assert.ok(
          prev.createdAt > cur.createdAt ||
            (prev.createdAt === cur.createdAt && prev.id < cur.id),
          `unexpected order at ${i}: ${prev.createdAt}/${prev.id} then ${cur.createdAt}/${cur.id}`,
        );
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("returns out only to included nodes and counts dangling/out-of-filter refs", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const active = remember(ctx.db, ctx.config, "active target", { now: "2026-09-01T00:00:01.000Z" });
      const retired = remember(ctx.db, ctx.config, "retired target", { now: "2026-09-01T00:00:02.000Z" });
      const rr = retireRecord(ctx.db, ctx.config, {
        id: retired,
        scope: SCOPE,
        reasonCode: "NO_LONGER_USEFUL",
      }, key("ret"));
      assert.equal(rr.code, "OK", JSON.stringify(rr));
      const other = remember(ctx.db, ctx.config, "other scope target", {
        kind: "summary",
        now: "2026-09-01T00:00:03.000Z",
        scope: OTHER,
      });
      const source = remember(ctx.db, ctx.config, "linking source", {
        now: "2026-09-01T00:00:04.000Z",
        links: [active, retired, other, "rec_missing"],
      });

      const activeOnly = page(ctx.db, ctx.config, { scope: SCOPE, limit: 20 });
      assert.equal(activeOnly.code, "OK", JSON.stringify(activeOnly));
      const src = activeOnly.nodes.find((n) => n.id === source);
      assert.ok(src);
      assert.deepEqual(src.out, [{ to: active, kind: "related" }]);
      assert.equal(src.danglingOut, 3);
      assert.equal(activeOnly.nodes.some((n) => n.id === retired), false);
      assert.equal(activeOnly.nodes.some((n) => n.id === other), false);

      const withRetired = page(ctx.db, ctx.config, {
        scope: SCOPE,
        includeRetired: true,
        limit: 20,
      });
      assert.equal(withRetired.code, "OK", JSON.stringify(withRetired));
      const src2 = withRetired.nodes.find((n) => n.id === source);
      assert.ok(src2);
      assert.deepEqual(
        [...src2.out].sort((x, y) => x.to.localeCompare(y.to)),
        [
          { to: active, kind: "related" },
          { to: retired, kind: "related" },
        ].sort((x, y) => x.to.localeCompare(y.to)),
      );
      assert.equal(src2.danglingOut, 2);
      assert.equal(withRetired.nodes.some((n) => n.id === retired), true);
      assert.equal(withRetired.nodes.some((n) => n.id === other), false);
    } finally {
      ctx.cleanup();
    }
  });

  it("classifies summary/correction links as consolidation", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const a = remember(ctx.db, ctx.config, "source a", { now: "2026-09-01T00:00:01.000Z" });
      const b = remember(ctx.db, ctx.config, "source b", { now: "2026-09-01T00:00:02.000Z" });
      const summary = remember(ctx.db, ctx.config, "summary of a and b", {
        kind: "summary",
        now: "2026-09-01T00:00:03.000Z",
        links: [a, b],
      });
      const r = page(ctx.db, ctx.config, { scope: SCOPE, limit: 20 });
      assert.equal(r.code, "OK", JSON.stringify(r));
      const node = r.nodes.find((n) => n.id === summary);
      assert.ok(node);
      assert.deepEqual(
        [...node.out].sort((x, y) => x.to.localeCompare(y.to)),
        [
          { to: a, kind: "consolidation" },
          { to: b, kind: "consolidation" },
        ].sort((x, y) => x.to.localeCompare(y.to)),
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("graph.page: episode tagging and labels", () => {
  it("tags nodes from the episode ledger, preferring level=episode", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      const tagged = remember(ctx.db, ctx.config, "tagged record", { now: "2026-09-01T00:00:01.000Z" });
      const plain = remember(ctx.db, ctx.config, "plain record", { now: "2026-09-01T00:00:02.000Z" });
      insertEpisodeSummary(ctx.db, {
        scope: SCOPE,
        kind: "doc",
        episodeKey: "doc-window",
        level: "window",
        recordId: tagged,
        createdAt: "2026-09-01T00:00:09.000Z",
      });
      insertEpisodeSummary(ctx.db, {
        scope: SCOPE,
        kind: "doc",
        episodeKey: "doc-episode",
        level: "episode",
        recordId: tagged,
        createdAt: "2026-09-01T00:00:03.000Z",
      });
      const r = page(ctx.db, ctx.config, { scope: SCOPE, limit: 20 });
      assert.equal(r.code, "OK", JSON.stringify(r));
      const node = r.nodes.find((n) => n.id === tagged);
      assert.deepEqual(node?.episode, {
        kind: "doc",
        episodeKey: "doc-episode",
        level: "episode",
      });
      assert.equal(r.nodes.find((n) => n.id === plain)?.episode, null);
    } finally {
      ctx.cleanup();
    }
  });

  it("labels are whitespace-collapsed and bounded to snippetMaxCp", () => {
    const ctx = setup({ snippetMaxCp: 12 });
    try {
      raw(ctx.db, ctx.config);
      const id = remember(ctx.db, ctx.config, "  alpha\n\n\tbeta gamma delta epsilon  ", {
        now: "2026-09-01T00:00:01.000Z",
      });
      const r = page(ctx.db, ctx.config, { scope: SCOPE, limit: 5 });
      const node = r.nodes.find((n) => n.id === id);
      assert.equal(node?.label, "alpha beta g");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("graph.page: byte budget and read-only behavior", () => {
  it("shrinks pages deterministically and still pages through every node", () => {
    const ctx = setup({ responseMaxBytes: 1024, snippetMaxCp: 200 });
    try {
      raw(ctx.db, ctx.config);
      const created: string[] = [];
      const long = "x".repeat(600);
      for (let i = 0; i < 8; i++) {
        created.push(remember(ctx.db, ctx.config, `${i}-${long}`, {
          now: `2026-09-01T00:00:0${i}.000Z`,
        }));
      }
      const seen: PageNode[] = [];
      let cursor: string | null | undefined;
      let pages = 0;
      do {
        const r = page(ctx.db, ctx.config, {
          scope: SCOPE,
          limit: 10,
          ...(cursor ? { cursor } : {}),
        });
        assert.equal(r.code, "OK", JSON.stringify(r));
        assert.ok(r.bytes <= 1024, `page ${pages} was ${r.bytes} bytes`);
        assert.ok(r.nodes.length >= 1);
        assert.ok(r.nodes.length < 8, "the first page must shrink below the requested limit");
        for (const n of r.nodes) {
          assert.ok([...n.label].length <= 200);
          assert.ok(n.label.length < 600, "full body must never be the label");
        }
        seen.push(...r.nodes);
        cursor = r.nextCursor;
        pages++;
        assert.ok(pages < 20, "paging must terminate");
      } while (cursor !== null);
      assert.deepEqual([...seen.map((n) => n.id)].sort(), [...created].sort());
    } finally {
      ctx.cleanup();
    }
  });

  it("writes no note_heat/exposures/usage rows", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      remember(ctx.db, ctx.config, "one", { now: "2026-09-01T00:00:01.000Z" });
      remember(ctx.db, ctx.config, "two", { now: "2026-09-01T00:00:02.000Z" });
      const count = (table: string): number => {
        const row = ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
        return row.n;
      };
      const before = {
        heat: count("note_heat"),
        exposures: count("exposures"),
        usage: count("usage"),
      };
      const r = page(ctx.db, ctx.config, { scope: SCOPE, limit: 1 });
      assert.equal(r.code, "OK", JSON.stringify(r));
      assert.ok(r.nextCursor !== null);
      page(ctx.db, ctx.config, { scope: SCOPE, limit: 5, cursor: r.nextCursor });
      assert.deepEqual(
        { heat: count("note_heat"), exposures: count("exposures"), usage: count("usage") },
        before,
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("graph.page: request validation", () => {
  it("rejects bad limits/cursors/params with fixed codes", () => {
    const ctx = setup();
    try {
      raw(ctx.db, ctx.config);
      remember(ctx.db, ctx.config, "one", { now: "2026-09-01T00:00:01.000Z" });
      assert.equal(page(ctx.db, ctx.config, { scope: SCOPE, limit: 0 }).code, "BAD_REQUEST");
      assert.equal(page(ctx.db, ctx.config, { scope: SCOPE, limit: 1000 }).code, "LIMIT_EXCEEDED");
      assert.equal(page(ctx.db, ctx.config, { scope: SCOPE, cursor: "!!!" }).code, "BAD_REQUEST");
      assert.equal(
        page(ctx.db, ctx.config, { scope: SCOPE, cursor: Buffer.from("{\"x\":1}").toString("base64url") }).code,
        "BAD_REQUEST",
      );
      assert.equal(page(ctx.db, ctx.config, { scope: SCOPE, includeRetired: "yes" }).code, "BAD_REQUEST");
      assert.equal(page(ctx.db, ctx.config, { scope: SCOPE, extra: true }).code, "BAD_REQUEST");
      assert.equal(page(ctx.db, ctx.config, { scope: "personal/nope" }).code, "FORBIDDEN_SCOPE");
      assert.equal(page(ctx.db, ctx.config, { scope: 123 }).code, "BAD_REQUEST");
    } finally {
      ctx.cleanup();
    }
  });
});
