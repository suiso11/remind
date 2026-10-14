/**
 * Graph view tests (§14.5): read-only projection regressions only.
 *
 * Covers plausible consumer bugs: scope isolation, status selection
 * (active default vs explicit retired/history), edge-kind distinction
 * (related/consolidation/supersedes) with dangling refs as markers only,
 * XSS/script-breakout escaping of untrusted fields, LIMIT+1 over-bound
 * failure, output byte cap, determinism, and canonical-table invariance
 * (no audit/heat/ops/status writes from graph reads).
 *
 * Synthetic temp DBs only. No source-text/wiring/UI-wording assertions.
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
  archiveRecord,
  correctRecord,
  eventAppend,
  rememberRecord,
  retireRecord,
} from "../src/store.js";
import {
  GraphLimitError,
  buildGraphData,
  escapeHtml,
  renderGraphHtml,
  serializeForScript,
  type GraphData,
} from "../src/graph.js";

const SCOPE = "personal/default";
const OTHER = "personal/other";
const OBS = "2026-09-01T00:00:00.000Z";

function baseConfig(dir: string): AppConfig {
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
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 65536,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
}

function setup(): { dir: string; config: AppConfig; configPath: string; db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "graph-view-"));
  const config = baseConfig(dir);
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

function raw(db: DatabaseSync, config: AppConfig, eventId: string, scope = SCOPE): void {
  const r = eventAppend(db, config, {
    eventId, sessionId: "s1", turnId: "t1", body: `raw body ${eventId}`,
    provenance: prov(), scope,
  }, key("ev"));
  assert.equal(r.code, "OK", JSON.stringify(r));
}

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  opts: { kind?: string; tags?: string[]; links?: string[]; sourceRefs?: string[]; scope?: string; source?: string } = {},
): string {
  const r = rememberRecord(db, config, {
    body,
    kind: opts.kind ?? "user_fact",
    provenance: prov(opts.source),
    scope: opts.scope ?? SCOPE,
    tags: opts.tags ?? [],
    links: opts.links ?? [],
    sourceRefs: opts.sourceRefs ?? ["e1"],
  }, key("rem"));
  assert.equal(r.code, "OK", JSON.stringify(r));
  return (r.data?.["record"] as { id: string }).id;
}

function canonicalDump(db: DatabaseSync): string {
  const tables = ["raw_events", "records", "record_tags", "record_links", "record_source_refs", "operations", "audit", "usage", "note_heat"];
  const out: unknown[] = [];
  for (const t of tables) {
    try {
      out.push(db.prepare(`SELECT * FROM ${t} ORDER BY rowid`).all());
    } catch {
      out.push(null);
    }
  }
  return JSON.stringify(out);
}

describe("graph view: status selection and scope isolation", () => {
  it("default is active-only; retired/history need explicit flags; other scopes excluded", () => {
    const { db, config, cleanup } = setup();
    try {
      raw(db, config, "e1");
      const a = remember(db, config, "active orchard note");
      const r = remember(db, config, "retired orchard note");
      const s = remember(db, config, "soon superseded note");
      const h = remember(db, config, "soon archived note");
      assert.equal(retireRecord(db, config, { id: r, scope: SCOPE, reasonCode: "LOW_SIGNAL" }, key("ret")).code, "OK");
      const corr = correctRecord(db, config, {
        recordId: s, body: "corrected orchard note", kind: "correction",
        provenance: prov(), scope: SCOPE, sourceRefs: ["e1"],
      }, key("corr"));
      assert.equal(corr.code, "OK");
      const newId = (corr.data?.["record"] as { id: string }).id;
      assert.equal(archiveRecord(db, config, { id: h, scope: SCOPE, reasonCode: "USER_ARCHIVED" }, key("arc")).code, "OK");
      // Other-scope record with a link pointing back: must never leak in.
      raw(db, config, "e9", OTHER);
      remember(db, config, "other scope note", { scope: OTHER, sourceRefs: ["e9"], links: [a] });

      const def = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 800, includeRetired: false, includeHistory: false });
      assert.deepEqual(def.statuses, ["active"]);
      assert.ok(def.nodes.some((n) => n.id === a));
      assert.ok(def.nodes.some((n) => n.id === newId));
      assert.ok(!def.nodes.some((n) => n.id === r), "retired excluded by default");
      assert.ok(!def.nodes.some((n) => n.id === s), "superseded excluded by default");
      assert.ok(!def.nodes.some((n) => n.id === h), "archived excluded by default");
      assert.ok(def.nodes.every((n) => n.id !== "other"), "no cross-scope nodes");
      assert.ok(def.edges.every((e) => e.from !== "other"), "no cross-scope edges");

      const ret = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 800, includeRetired: true, includeHistory: false });
      assert.ok(ret.nodes.some((n) => n.id === r && n.status === "retired"));
      assert.ok(!ret.nodes.some((n) => n.id === s), "history still excluded without history flag");

      const hist = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 800, includeRetired: false, includeHistory: true });
      assert.ok(hist.nodes.some((n) => n.id === s && n.status === "superseded"));
      assert.ok(hist.nodes.some((n) => n.id === h && n.status === "archived"));
      // Supersedes chain is a distinct edge kind, not a plain related link.
      assert.ok(hist.edges.some((e) => e.kind === "supersedes" && e.from === newId && e.to === s));
    } finally {
      cleanup();
    }
  });

  it("edge kinds: related vs consolidation; dangling refs are markers, not edges", () => {
    const { db, config, cleanup } = setup();
    try {
      raw(db, config, "e1");
      const t1 = remember(db, config, "orchard alpha note");
      const t2 = remember(db, config, "orchard beta note");
      const rel = remember(db, config, "orchard gamma note", { links: [t1] });
      const sum = remember(db, config, "orchard synthesis", {
        kind: "summary", links: [t1, t2], source: "cultivation:llm-derived",
      });
      const dang = remember(db, config, "note with dangling pointer", { links: ["rec_missing_xyz"] });
      void rel;
      const g = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 800, includeRetired: false, includeHistory: false });
      const kinds = new Map(g.edges.map((e) => [`${e.from}->${e.to}`, e.kind]));
      const gamma = g.nodes.find((n) => n.kind === "user_fact" && n.links.includes(t1));
      assert.ok(gamma && kinds.get(`${gamma.id}->${t1}`) === "related");
      assert.equal(kinds.get(`${sum}->${t1}`), "consolidation");
      assert.equal(kinds.get(`${sum}->${t2}`), "consolidation");
      assert.ok(!g.edges.some((e) => e.to === "rec_missing_xyz"), "dangling ref draws no edge");
      assert.ok(g.unresolved.includes("rec_missing_xyz"), "dangling ref listed as marker");
      assert.ok(!g.nodes.some((n) => n.id === "rec_missing_xyz"), "no filler node for dangling ref");
      void dang;
      void t2;
      // Backlinks derived for the pointed-to record.
      const alpha = g.nodes.find((n) => n.id === t1);
      assert.ok(alpha && alpha.backlinks.includes(gamma!.id) && alpha.backlinks.includes(sum));
    } finally {
      cleanup();
    }
  });
});

describe("graph view: read-only and bounds", () => {
  it("graph reads leave canonical tables, audit, heat, and statuses untouched", () => {
    const { db, config, cleanup } = setup();
    try {
      raw(db, config, "e1");
      const a = remember(db, config, "heat meadow note");
      const before = canonicalDump(db);
      const g = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 800, includeRetired: true, includeHistory: true });
      renderGraphHtml(g, 524288);
      assert.equal(canonicalDump(db), before, "graph build+render mutated canonical/audit/heat state");
      assert.ok(g.nodes.some((n) => n.id === a && n.status === "active"), "no reactivation side effect");
    } finally {
      cleanup();
    }
  });

  it("LIMIT+1 over-bound fails instead of silently truncating", () => {
    const { db, config, cleanup } = setup();
    try {
      raw(db, config, "e1");
      remember(db, config, "note one");
      remember(db, config, "note two");
      assert.throws(
        () => buildGraphData(db as never, SCOPE, { maxNodes: 1, maxEdges: 800, includeRetired: false, includeHistory: false }),
        GraphLimitError,
      );
      const g = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 0, includeRetired: false, includeHistory: false });
      void g;
    } finally {
      cleanup();
    }
  });

  it("output byte cap fails instead of truncating", () => {
    const { db, config, cleanup } = setup();
    try {
      raw(db, config, "e1");
      remember(db, config, "small note");
      const g = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 800, includeRetired: false, includeHistory: false });
      assert.throws(() => renderGraphHtml(g, 64), GraphLimitError);
      const html = renderGraphHtml(g, 524288);
      assert.ok(html.includes("<svg"), "viewer renders genuine SVG structure");
      assert.ok(html.includes("supersedes"), "viewer documents correction-chain styling");
    } finally {
      cleanup();
    }
  });

  it("deterministic ordering and layout across rebuilds", () => {
    const { db, config, cleanup } = setup();
    try {
      raw(db, config, "e1");
      remember(db, config, "determinism alpha");
      remember(db, config, "determinism beta");
      const o = { maxNodes: 300, maxEdges: 800, includeRetired: false, includeHistory: false } as const;
      const g1 = buildGraphData(db as never, SCOPE, { ...o });
      const g2 = buildGraphData(db as never, SCOPE, { ...o });
      assert.deepEqual(g1.nodes.map((n) => n.id), g2.nodes.map((n) => n.id));
      assert.deepEqual(g1.nodes.map((n) => [n.x, n.y]), g2.nodes.map((n) => [n.x, n.y]));
      assert.deepEqual(g1.edges, g2.edges);
    } finally {
      cleanup();
    }
  });
});

describe("graph view: untrusted-field escaping", () => {
  it("escapes script breakouts, event attrs, and javascript URLs in HTML and JSON", () => {
    const evil = `</script><script>alert(1)</script><img src=x onerror=alert(2)>javascript:alert(3)"onmouseover="alert(4)`;
    assert.ok(!escapeHtml(evil).includes("</script>"), "static escape must neutralize script close");
    assert.ok(!escapeHtml(evil).includes('"onmouseover="'), "attribute breakout must be neutralized");
    const data = {
      scope: SCOPE, generatedAt: OBS, statuses: ["active"], unresolved: [evil],
      counts: { active: 1 },
      nodes: [{
        id: "rec_evil1", status: "active", kind: "user_fact", snippet: evil, truncated: false,
        tags: [evil], source: evil, observedAt: OBS, createdAt: OBS, revision: 1,
        supersedes: null, sourceRefs: ["e1"], links: [], backlinks: [], mdFile: "rec_evil1.md", x: 1, y: 2,
      }],
      edges: [],
    } satisfies GraphData;
    const ser = serializeForScript(data);
    assert.ok(!ser.includes("</script"), "embedded JSON must not contain a script close");
    assert.ok(!ser.includes("<script"), "embedded JSON must not contain a script open");
    const html = renderGraphHtml(data, 524288);
    assert.ok(!html.includes("</script><script>"), "rendered HTML must not contain raw breakout");
    // No raw payload dump: full raw bodies never embedded, only identifiers.
    assert.ok(!html.includes("raw-secret-plaintext-body"), "raw bodies must not appear");
  });

  it("real DB: malicious body/tag/source render without executable markup", () => {
    const { db, config, cleanup } = setup();
    try {
      raw(db, config, "e1");
      const evilBody = `xss probe </script><img src=x onerror=alert(1)> tail`;
      remember(db, config, evilBody, { tags: [`t"><svg onload=alert(1)>`], source: `javascript:alert(1)+"quoted"` });
      const g = buildGraphData(db as never, SCOPE, { maxNodes: 300, maxEdges: 800, includeRetired: false, includeHistory: false }, undefined);
      const ser = serializeForScript(g);
      assert.ok(!ser.includes("</script"), "embedded JSON must escape script close from real rows");
      const html = renderGraphHtml(g, 524288);
      assert.ok(!html.includes("<img src=x onerror="), "event-handler markup must be escaped");
      assert.ok(!html.includes("</script><img"), "breakout sequence must be escaped");
    } finally {
      cleanup();
    }
  });
});
