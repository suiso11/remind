/**
 * Local memory graph visualization (§14.5): rebuildable read-only projection.
 *
 * The canonical store stays SQLite-only. This module reads canonical rows
 * (records, record_links, record_source_refs) for ONE scope and renders a
 * bounded, self-contained, dependency-free offline HTML graph view:
 * no HTTP server, no remote assets/CDN/fonts, no model, no analytics.
 *
 * Reads are SELECT-only and never touch audit/heat/ops/status: rendering,
 * searching, filtering, or selecting in the viewer cannot reactivate or heat
 * any record (the viewer is a static file with no backend calls).
 *
 * Edge semantics (never drawn all as fact):
 * - "related": canonical outbound [[link]] between two in-view records.
 * - "consolidation": outbound link FROM a summary/correction record (an
 *   integration source pointer), styled distinctly from plain related links.
 * - "supersedes": correction chain (new record supersedes old), from the
 *   canonical `records.supersedes` column, not from links[].
 * - Dangling/out-of-view refs are NOT edges and NOT filler nodes: they are
 *   listed as escaped unresolved markers only, with no cross-scope detail.
 *
 * Status handling: the default induced graph is active-only. Retired and
 * history (superseded/archived) records enter the view only when explicitly
 * requested (--include-retired / --include-history). This is a viewer-side
 * selection and does not broaden the `record.search` protocol
 * (active+retired only; archived revival stays unsupported).
 *
 * Bounds: node reads use LIMIT+1 (never a full-corpus scan), edge reads are
 * bounded by the selected node count rather than the current linksMax,
 * output bytes are capped, ordering is deterministic (createdAt DESC/ASC + id ASC),
 * and the writer replaces only its owned view file atomically (temp+rename).
 * Over-bound builds fail with a fixed error and leave any prior view intact.
 * Raw bodies are never embedded: panels show snippets + source-ref /
 * provenance identifiers only.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { canonicalTime, countCp, hasControl } from "./normalize.js";
import { ok } from "./protocol.js";

export const GRAPH_DEFAULT_MAX_NODES = 300;
export const GRAPH_DEFAULT_MAX_EDGES = 800;
export const GRAPH_DEFAULT_MAX_BYTES = 524288;
export const GRAPH_SNIPPET_CP = 200;

export type GraphEdgeKind = "related" | "consolidation" | "supersedes";

export interface GraphNode {
  id: string;
  status: string;
  kind: string;
  snippet: string;
  truncated: boolean;
  tags: string[];
  /** Opaque provenance pointer (untrusted metadata, escaped at render). */
  source: string;
  observedAt: string;
  createdAt: string;
  revision: number;
  supersedes: string | null;
  /** Canonical source-ref event IDs (identifiers only, never raw bodies). */
  sourceRefs: string[];
  /** Outbound refs that resolve to another in-view record. */
  links: string[];
  /** In-view records linking TO this record (derived backlinks). */
  backlinks: string[];
  /** Relative vault Markdown file when a safe local projection exists. */
  mdFile: string | null;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
  kind: GraphEdgeKind;
}

export interface GraphData {
  scope: string;
  generatedAt: string;
  statuses: string[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  /** Dangling/out-of-view refs: escaped markers only, no cross-scope info. */
  unresolved: string[];
  counts: Record<string, number>;
}

export interface GraphBuildOptions {
  maxNodes: number;
  maxEdges: number;
  includeRetired: boolean;
  includeHistory: boolean;
  snippetMaxCp?: number;
}

export class GraphLimitError extends Error {
  constructor(message = "graph over bound") {
    super(message);
    this.name = "GraphLimitError";
  }
}

/** Centre record exists but belongs to a different scope (no detail leaked). */
export class GraphLocalScopeError extends Error {
  constructor() {
    super("scope mismatch");
    this.name = "GraphLocalScopeError";
  }
}

/** Minimal read surface so tests can stub without a real DB handle. */
export interface GraphDb {
  prepare(sql: string): {
    all(...args: Array<string | number>): Array<Record<string, unknown>>;
  };
}

function str(v: unknown): string {
  return typeof v === "string" ? v : "";
}

function num(v: unknown): number {
  return typeof v === "number" ? v : 0;
}

/** Escape untrusted text for HTML element/attribute contexts. */
export function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function safeMdFile(id: string): string | null {
  if (id.length === 0 || id.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return `${id}.md`;
}

function snippetFor(body: string, maxCp: number): { snippet: string; truncated: boolean } {
  const cps = [...body];
  if (cps.length <= maxCp) return { snippet: body, truncated: false };
  return { snippet: cps.slice(0, maxCp).join(""), truncated: true };
}

/** Statuses selected by the viewer/page. History is excluded from graph.page. */
export function graphStatuses(includeRetired: boolean, includeHistory: boolean): string[] {
  const statuses = ["active"];
  if (includeRetired) statuses.push("retired");
  if (includeHistory) statuses.push("superseded", "archived");
  return statuses;
}

/** Shared outbound-edge classification (graph view and graph.page agree). */
function edgeKindForKind(kind: string): "related" | "consolidation" {
  return kind === "summary" || kind === "correction" ? "consolidation" : "related";
}

function readGraphTags(db: GraphDb, ids: string[]): Map<string, string[]> {
  const tagsById = new Map<string, string[]>();
  for (const id of ids) tagsById.set(id, []);
  if (ids.length === 0) return tagsById;
  const idList = ids.map(() => "?").join(",");
  const tagRows = db
    .prepare(`SELECT recordId, tag FROM record_tags WHERE recordId IN (${idList}) ORDER BY recordId ASC, tag ASC`)
    .all(...ids) as Array<Record<string, unknown>>;
  for (const r of tagRows) {
    const list = tagsById.get(str(r["recordId"]));
    if (list && list.length < 64) list.push(str(r["tag"]));
  }
  return tagsById;
}

/**
 * Read all persisted outbound refs for the given records. The number of
 * source records is already bounded by the caller (page/node limit), so this
 * deliberately has no row LIMIT: a historical row may legitimately hold more
 * links than the current `limits.linksMax`, and treating linksMax as a read
 * bound would reject persisted data. Callers that need an edge budget apply
 * it to the derived edge set or rely on deterministic byte-budget shrinking.
 */
function readGraphLinks(db: GraphDb, ids: string[]): Map<string, string[]> {
  const linksById = new Map<string, string[]>();
  for (const id of ids) linksById.set(id, []);
  if (ids.length === 0) return linksById;
  const idList = ids.map(() => "?").join(",");
  const linkRows = db
    .prepare(`SELECT fromId, toRef FROM record_links WHERE fromId IN (${idList}) ORDER BY fromId ASC, toRef ASC`)
    .all(...ids) as Array<Record<string, unknown>>;
  for (const r of linkRows) {
    const list = linksById.get(str(r["fromId"]));
    if (list) list.push(str(r["toRef"]));
  }
  return linksById;
}

/**
 * Build the graph model with bounded SELECT-only reads. Never writes,
 * never audits, never heats. Throws GraphLimitError when explicit bounds
 * would be exceeded (caller must keep any prior view file intact).
 */
export function buildGraphData(
  db: GraphDb,
  scope: string,
  opts: GraphBuildOptions,
  vaultDir?: string,
): GraphData {
  const statuses = graphStatuses(opts.includeRetired, opts.includeHistory);
  const inList = statuses.map(() => "?").join(",");
  const snippetMax = opts.snippetMaxCp ?? GRAPH_SNIPPET_CP;

  const recRows = db
    .prepare(
      `SELECT id, body, kind, status, source, observedAt, createdAt, revision, supersedes
       FROM records WHERE scope = ? AND status IN (${inList})
       ORDER BY createdAt DESC, id ASC LIMIT ?`,
    )
    .all(scope, ...statuses, opts.maxNodes + 1) as Array<Record<string, unknown>>;
  if (recRows.length > opts.maxNodes) throw new GraphLimitError();
  const ids = recRows.map((r) => str(r["id"]));
  const idSet = new Set(ids);

  const tagsById = readGraphTags(db, ids);
  const refsById = new Map<string, string[]>();
  for (const id of ids) refsById.set(id, []);
  if (ids.length > 0) {
    const idList = ids.map(() => "?").join(",");
    const refRows = db
      .prepare(`SELECT recordId, eventId FROM record_source_refs WHERE recordId IN (${idList}) ORDER BY recordId ASC, eventId ASC`)
      .all(...ids) as Array<Record<string, unknown>>;
    for (const r of refRows) {
      const list = refsById.get(str(r["recordId"]));
      if (list && list.length < 64) list.push(str(r["eventId"]));
    }
  }
  const linksById = readGraphLinks(db, ids);

  const unresolvedSet = new Set<string>();
  const edges: GraphEdge[] = [];
  const backlinksById = new Map<string, string[]>();
  for (const id of ids) backlinksById.set(id, []);
  const kindById = new Map(recRows.map((r) => [str(r["id"]), str(r["kind"])] as [string, string]));
  for (const [from, refs] of linksById) {
    for (const to of refs) {
      if (idSet.has(to)) {
        const kind: GraphEdgeKind = edgeKindForKind(kindById.get(from) ?? "");
        edges.push({ from, to, kind });
        backlinksById.get(to)?.push(from);
      } else {
        unresolvedSet.add(to);
      }
    }
  }
  // Correction supersedes chains (canonical column, not links[]).
  for (const r of recRows) {
    const sup = r["supersedes"];
    const id = str(r["id"]);
    if (typeof sup === "string" && sup.length > 0 && idSet.has(sup)) {
      edges.push({ from: id, to: sup, kind: "supersedes" });
    } else if (typeof sup === "string" && sup.length > 0) {
      unresolvedSet.add(sup);
    }
  }
  if (edges.length > opts.maxEdges) throw new GraphLimitError();
  for (const list of backlinksById.values()) list.sort();

  // Deterministic layout: nodes keep query order (createdAt DESC, id ASC)
  // placed on a circle; no dependencies, no randomness, stable rebuilds.
  const n = ids.length;
  const radius = n <= 1 ? 0 : 220 + Math.min(320, n * 4);
  const cx = 420;
  const cy = 340;
  const nodes: GraphNode[] = recRows.map((r, i) => {
    const id = str(r["id"]);
    const body = str(r["body"]);
    const sn = snippetFor(body, snippetMax);
    const angle = n <= 1 ? 0 : (2 * Math.PI * i) / n - Math.PI / 2;
    const md = safeMdFile(id);
    const mdFile = md && vaultDir && fs.existsSync(path.join(vaultDir, md)) ? md : md && !vaultDir ? md : null;
    return {
      id,
      status: str(r["status"]),
      kind: str(r["kind"]),
      snippet: sn.snippet,
      truncated: sn.truncated,
      tags: tagsById.get(id) ?? [],
      source: str(r["source"]),
      observedAt: str(r["observedAt"]),
      createdAt: str(r["createdAt"]),
      revision: num(r["revision"]),
      supersedes: typeof r["supersedes"] === "string" ? (r["supersedes"] as string) : null,
      sourceRefs: refsById.get(id) ?? [],
      links: (linksById.get(id) ?? []).filter((t) => idSet.has(t)),
      backlinks: backlinksById.get(id) ?? [],
      mdFile,
      x: Math.round((cx + radius * Math.cos(angle)) * 10) / 10,
      y: Math.round((cy + radius * Math.sin(angle)) * 10) / 10,
    };
  });

  const counts: Record<string, number> = { active: 0, retired: 0, superseded: 0, archived: 0 };
  for (const nd of nodes) counts[nd.status] = (counts[nd.status] ?? 0) + 1;

  return {
    scope,
    generatedAt: new Date().toISOString(),
    statuses,
    nodes,
    edges,
    unresolved: [...unresolvedSet].sort().slice(0, 256),
    counts,
  };
}

/* ------------------------------------------------------------------ */
/* graph.page: bounded, cursor-paged linked-memory graph for Companion */
/* ------------------------------------------------------------------ */

export interface GraphPageCursor {
  createdAt: string;
  id: string;
}

export function encodeGraphPageCursor(cursor: GraphPageCursor): string {
  return Buffer.from(JSON.stringify({ c: cursor.createdAt, i: cursor.id }), "utf8").toString("base64url");
}

export function decodeGraphPageCursor(v: unknown): GraphPageCursor | null {
  if (typeof v !== "string" || v.length === 0 || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  if (keys.length !== 2 || !keys.includes("c") || !keys.includes("i")) return null;
  const createdAt = canonicalTime(obj["c"]);
  const id = obj["i"];
  if (createdAt === null) return null;
  if (typeof id !== "string" || id.length === 0 || countCp(id) > 256 || hasControl(id)) return null;
  return { createdAt, id };
}

export interface GraphPageEpisode {
  kind: string;
  episodeKey: string;
  level: "window" | "episode";
}

export interface GraphPageNode {
  id: string;
  status: string;
  kind: string;
  /** First snippetMaxCp code points of whitespace-collapsed body (never full body). */
  label: string;
  tags: string[];
  createdAt: string;
  episode: GraphPageEpisode | null;
  out: Array<{ to: string; kind: "related" | "consolidation" }>;
  /** Outbound refs omitted because they are dangling or out of the filter. */
  danglingOut: number;
}

export interface GraphPageOptions {
  scope: string;
  includeRetired: boolean;
  cursor: GraphPageCursor | null;
  limit: number;
  snippetMaxCp: number;
}

export interface GraphPageData {
  nodes: GraphPageNode[];
  nextCursor: string | null;
}

function pageLabel(body: string, maxCp: number): string {
  const collapsed = body.replace(/\s+/gu, " ").trim();
  const cps = [...collapsed];
  return cps.length <= maxCp ? collapsed : cps.slice(0, maxCp).join("");
}

function readIncludedTargetIds(
  db: GraphDb,
  scope: string,
  statuses: string[],
  candidates: string[],
): Set<string> {
  const included = new Set<string>();
  const unique = [...new Set(candidates)];
  if (unique.length === 0) return included;
  const statusList = statuses.map(() => "?").join(",");
  const chunk = 400;
  for (let i = 0; i < unique.length; i += chunk) {
    const part = unique.slice(i, i + chunk);
    const idList = part.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT id FROM records WHERE scope = ? AND status IN (${statusList}) AND id IN (${idList})`,
      )
      .all(scope, ...statuses, ...part) as Array<Record<string, unknown>>;
    for (const r of rows) included.add(str(r["id"]));
  }
  return included;
}

function readPageEpisodes(
  db: GraphDb,
  scope: string,
  ids: string[],
): Map<string, GraphPageEpisode> {
  const episodes = new Map<string, GraphPageEpisode>();
  if (ids.length === 0) return episodes;
  const idList = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT recordId, kind, episodeKey, level
       FROM episode_summaries
       WHERE scope = ? AND recordId IN (${idList}) AND level IN ('episode','window')
       ORDER BY recordId ASC,
                CASE level WHEN 'episode' THEN 0 ELSE 1 END,
                createdAt DESC, kind ASC, episodeKey ASC`,
    )
    .all(scope, ...ids) as Array<Record<string, unknown>>;
  for (const r of rows) {
    const recordId = str(r["recordId"]);
    if (episodes.has(recordId)) continue;
    const level = r["level"];
    if (level !== "episode" && level !== "window") continue;
    episodes.set(recordId, {
      kind: str(r["kind"]),
      episodeKey: str(r["episodeKey"]),
      level,
    });
  }
  return episodes;
}

/**
 * Build one bounded page of the linked-memory graph. Reads only canonical
 * records/links/tags plus the derived episode ledger. Outbound edges resolve
 * against the whole included (scope+status) set, not just this page, so a
 * paged consumer never sees a false dangling edge; refs outside that set are
 * counted in danglingOut and omitted. Supersedes history is not returned.
 */
export function buildGraphPage(db: GraphDb, opts: GraphPageOptions): GraphPageData {
  const statuses = graphStatuses(opts.includeRetired, false);
  const inList = statuses.map(() => "?").join(",");
  let sql = `SELECT id, body, kind, status, createdAt
             FROM records WHERE scope = ? AND status IN (${inList})`;
  const args: Array<string | number> = [opts.scope, ...statuses];
  if (opts.cursor !== null) {
    sql += ` AND (createdAt < ? OR (createdAt = ? AND id > ?))`;
    args.push(opts.cursor.createdAt, opts.cursor.createdAt, opts.cursor.id);
  }
  sql += ` ORDER BY createdAt DESC, id ASC LIMIT ?`;
  args.push(opts.limit + 1);
  const recRows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  const shown = recRows.slice(0, opts.limit);
  const ids = shown.map((r) => str(r["id"]));

  const tagsById = readGraphTags(db, ids);
  const linksById = readGraphLinks(db, ids);

  const allRefs: string[] = [];
  for (const refs of linksById.values()) allRefs.push(...refs);
  const includedTargets = readIncludedTargetIds(db, opts.scope, statuses, allRefs);
  const episodes = readPageEpisodes(db, opts.scope, ids);

  const nodes: GraphPageNode[] = shown.map((r) => {
    const id = str(r["id"]);
    const outKind = edgeKindForKind(str(r["kind"]));
    const out: GraphPageNode["out"] = [];
    let danglingOut = 0;
    for (const to of linksById.get(id) ?? []) {
      if (includedTargets.has(to)) out.push({ to, kind: outKind });
      else danglingOut++;
    }
    return {
      id,
      status: str(r["status"]),
      kind: str(r["kind"]),
      label: pageLabel(str(r["body"]), opts.snippetMaxCp),
      tags: tagsById.get(id) ?? [],
      createdAt: str(r["createdAt"]),
      episode: episodes.get(id) ?? null,
      out,
      danglingOut,
    };
  });

  const last = shown.length > 0 ? shown[shown.length - 1] : null;
  const nextCursor =
    recRows.length > shown.length && last
      ? encodeGraphPageCursor({ createdAt: str(last["createdAt"]), id: str(last["id"]) })
      : null;
  return { nodes, nextCursor };
}

/* ------------------------------------------------------------------ */
/* graph.local / graph.version: Obsidian-like local graph + freshness  */
/* ------------------------------------------------------------------ */

/**
 * Mutation ops that write an audit row with the affected scope. Only these
 * rows feed the per-scope version: graph/read audit rows (graph.page,
 * record.get, recall, search, ...) must never change a version because
 * version reads must stay stable across pure reads.
 */
const GRAPH_AUDIT_WRITE_OPS = [
  "event.append",
  "record.remember",
  "record.feedback",
  "record.correct",
  "record.archive",
  "record.retire",
  "record.reactivate",
  "maintain.distill",
  "maintain.episodes",
  "maintain.cultivate",
] as const;

function scalarRow(db: GraphDb, sql: string, ...args: Array<string | number>): Record<string, unknown> {
  const rows = db.prepare(sql).all(...args) as Array<Record<string, unknown>>;
  return rows[0] ?? {};
}

/**
 * Opaque, cheap per-scope version. It changes whenever a relevant canonical
 * or derived row is written:
 * - operations rowid (every mutation path writes one; global because the
 *   ledger has no scope column),
 * - records MAX(rowid)/COUNT for the scope (remember/correct/cultivate),
 * - scoped write-audit MAX(rowid) (status transitions retire/reactivate/
 *   archive, replay/state changes),
 * - episode_summaries MAX(rowid)/COUNT/MAX(createdAt) for the scope
 *   (maintain.episodes and direct ledger writes).
 * Reads never insert into any of these sources.
 */
export function buildGraphVersion(db: GraphDb, scope: string): string {
  const ops = scalarRow(db, `SELECT COALESCE(MAX(rowid), 0) AS m FROM operations`);
  const rec = scalarRow(
    db,
    `SELECT COALESCE(MAX(rowid), 0) AS m, COUNT(*) AS c FROM records WHERE scope = ?`,
    scope,
  );
  const aud = scalarRow(
    db,
    `SELECT COALESCE(MAX(rowid), 0) AS m FROM audit
     WHERE scope = ? AND op IN (${GRAPH_AUDIT_WRITE_OPS.map(() => "?").join(",")})`,
    scope,
    ...GRAPH_AUDIT_WRITE_OPS,
  );
  const ep = scalarRow(
    db,
    `SELECT COALESCE(MAX(rowid), 0) AS m, COUNT(*) AS c,
            COALESCE(MAX(createdAt), '') AS t
     FROM episode_summaries WHERE scope = ?`,
    scope,
  );
  return `o${num(ops["m"])}:r${num(rec["m"])}.${num(rec["c"])}:a${num(aud["m"])}:e${num(ep["m"])}.${num(ep["c"])}.${str(ep["t"])}`;
}

export interface GraphLocalNode {
  id: string;
  status: string;
  kind: string;
  /** First snippetMaxCp code points of whitespace-collapsed body. */
  label: string;
  tags: string[];
  createdAt: string;
  episode: GraphPageEpisode | null;
  /** 0 for the centre, 1..depth for BFS hops. */
  hop: number;
}

export interface GraphLocalEdge {
  from: string;
  to: string;
  kind: "related" | "consolidation";
}

export interface GraphLocalData {
  center: string;
  nodes: GraphLocalNode[];
  edges: GraphLocalEdge[];
  truncated: boolean;
  version: string;
}

export interface GraphLocalOptions {
  scope: string;
  id: string;
  depth: 1 | 2;
  includeRetired: boolean;
  limit: number;
  snippetMaxCp: number;
  /** Byte budget for the whole encoded OK envelope (graphResponseMaxBytes). */
  maxBytes: number;
}

interface LocalRow {
  id: string;
  body: string;
  kind: string;
  status: string;
  createdAt: string;
  hop: number;
}

function selectLocalRow(r: Record<string, unknown>, hop: number): LocalRow {
  return {
    id: str(r["id"]),
    body: str(r["body"]),
    kind: str(r["kind"]),
    status: str(r["status"]),
    createdAt: str(r["createdAt"]),
    hop,
  };
}

/** Chunked `NOT IN` clauses so large visited sets stay under SQLite's parameter limit. */
function notInClauses(ids: string[]): { clauses: string[]; args: string[] } {
  const chunk = 400;
  const clauses: string[] = [];
  const args: string[] = [];
  for (let i = 0; i < ids.length; i += chunk) {
    const part = ids.slice(i, i + chunk);
    clauses.push(`(${part.map(() => "?").join(",")})`);
    args.push(...part);
  }
  return { clauses, args };
}

/**
 * Neighbours of `frontier` over undirected record links (outbound AND
 * inbound/backlinks), restricted to the same scope and included statuses.
 * Consolidation links are ordinary record_links rows here; their kind is
 * derived from the source record when edges are emitted.
 *
 * The SQL set is deduplicated (UNION) and already-visited nodes are excluded
 * BEFORE `LIMIT cap` is applied. Bounding the raw link rows first would let a
 * node that links to several frontier nodes consume every slot and hide other
 * reachable neighbours (and make the next-hop truncation probe wrong).
 */
function readLocalNeighbors(
  db: GraphDb,
  scope: string,
  statuses: string[],
  frontier: string[],
  cap: number,
  visited: ReadonlySet<string>,
): Array<Record<string, unknown>> {
  if (frontier.length === 0 || cap < 1) return [];
  const statusList = statuses.map(() => "?").join(",");
  const excluded = notInClauses([...visited]);
  const excludeSql = excluded.clauses.map((c) => ` AND r.id NOT IN ${c}`).join("");
  const out: Array<Record<string, unknown>> = [];
  const chunk = 400;
  for (let i = 0; i < frontier.length; i += chunk) {
    const part = frontier.slice(i, i + chunk);
    const idList = part.map(() => "?").join(",");
    const rows = db
      .prepare(
        `SELECT r.id, r.body, r.kind, r.status, r.createdAt
         FROM records r
         WHERE r.scope = ? AND r.status IN (${statusList})
           AND r.id IN (
             SELECT l.toRef FROM record_links l WHERE l.fromId IN (${idList})
             UNION
             SELECT l.fromId FROM record_links l WHERE l.toRef IN (${idList})
           )${excludeSql}
         ORDER BY r.createdAt DESC, r.id ASC LIMIT ?`,
      )
      .all(scope, ...statuses, ...part, ...part, ...excluded.args, cap) as Array<Record<string, unknown>>;
    out.push(...rows);
  }
  return out;
}

/**
 * Build an Obsidian-like local graph around one record. The centre is
 * returned regardless of status; every other node must be in the included
 * statuses (active, plus retired with includeRetired), and every node must
 * be in the same scope. Order: centre, then hop ascending, then
 * createdAt DESC, id ASC. Bounded by `limit` and by `maxBytes`; shrinking
 * drops the farthest/latest tail deterministically and sets truncated.
 * Returns null when the centre id does not exist; throws
 * GraphLocalScopeError when it exists in another scope.
 */
export function buildGraphLocal(
  db: GraphDb,
  opts: GraphLocalOptions,
): GraphLocalData | null {
  const centerRows = db
    .prepare(`SELECT id, body, kind, status, createdAt, scope FROM records WHERE id = ?`)
    .all(opts.id) as Array<Record<string, unknown>>;
  if (centerRows.length === 0) return null;
  if (str(centerRows[0]["scope"]) !== opts.scope) throw new GraphLocalScopeError();
  const center = selectLocalRow(centerRows[0], 0);
  const statuses = graphStatuses(opts.includeRetired, false);
  const selected: LocalRow[] = [center];
  const visited = new Set<string>([center.id]);
  let frontier = [center.id];
  let truncated = false;

  for (let hop = 1; hop <= opts.depth; hop++) {
    const slots = opts.limit - selected.length;
    const rows = readLocalNeighbors(
      db,
      opts.scope,
      statuses,
      frontier,
      Math.max(1, slots + 1),
      visited,
    );
    const seen = new Set<string>();
    const candidates: LocalRow[] = [];
    for (const r of rows) {
      const row = selectLocalRow(r, hop);
      if (visited.has(row.id) || seen.has(row.id)) continue;
      seen.add(row.id);
      candidates.push(row);
    }
    candidates.sort((a, b) => {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
      return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
    });
    if (candidates.length > slots) truncated = true;
    if (slots <= 0) {
      if (candidates.length > 0) truncated = true;
      break;
    }
    const take = candidates.slice(0, slots);
    for (const row of take) {
      visited.add(row.id);
      selected.push(row);
    }
    frontier = take.map((r) => r.id);
    if (take.length === 0) break;
    if (selected.length >= opts.limit) {
      // The limit is exhausted; probe the next hop so truncated reflects
      // real omitted neighbours without reading a whole extra layer.
      if (hop < opts.depth) {
        const more = readLocalNeighbors(db, opts.scope, statuses, frontier, 1, visited);
        if (more.some((r) => !visited.has(str(r["id"])))) truncated = true;
      }
      break;
    }
  }

  const ids = selected.map((r) => r.id);
  const tagsById = readGraphTags(db, ids);
  const episodes = readPageEpisodes(db, opts.scope, ids);
  const nodes: GraphLocalNode[] = selected.map((r) => ({
    id: r.id,
    status: r.status,
    kind: r.kind,
    label: pageLabel(r.body, opts.snippetMaxCp),
    tags: tagsById.get(r.id) ?? [],
    createdAt: r.createdAt,
    episode: episodes.get(r.id) ?? null,
    hop: r.hop,
  }));

  const idSet = new Set(ids);
  const kindById = new Map(selected.map((r) => [r.id, r.kind] as [string, string]));
  const edgeSeen = new Set<string>();
  const allEdges: GraphLocalEdge[] = [];
  if (ids.length > 0) {
    const chunk = 400;
    for (let i = 0; i < ids.length; i += chunk) {
      const part = ids.slice(i, i + chunk);
      const idList = part.map(() => "?").join(",");
      const rows = db
        .prepare(`SELECT fromId, toRef FROM record_links WHERE fromId IN (${idList})`)
        .all(...part) as Array<Record<string, unknown>>;
      for (const r of rows) {
        const from = str(r["fromId"]);
        const to = str(r["toRef"]);
        if (!idSet.has(from) || !idSet.has(to)) continue;
        const key = `${from}\u0000${to}`;
        if (edgeSeen.has(key)) continue;
        edgeSeen.add(key);
        allEdges.push({ from, to, kind: edgeKindForKind(kindById.get(from) ?? "") });
      }
    }
  }
  allEdges.sort((a, b) => {
    if (a.from !== b.from) return a.from < b.from ? -1 : 1;
    if (a.to !== b.to) return a.to < b.to ? -1 : 1;
    return a.kind < b.kind ? -1 : a.kind > b.kind ? 1 : 0;
  });

  const version = buildGraphVersion(db, opts.scope);
  const assemble = (n: number): { data: GraphLocalData; bytes: number } => {
    const kept = nodes.slice(0, n);
    const keptIds = new Set(kept.map((node) => node.id));
    const data: GraphLocalData = {
      center: center.id,
      nodes: kept,
      edges: allEdges.filter((e) => keptIds.has(e.from) && keptIds.has(e.to)),
      truncated: truncated || n < nodes.length,
      version,
    };
    const envelope = ok({
      center: data.center,
      nodes: data.nodes,
      edges: data.edges,
      truncated: data.truncated,
      version: data.version,
    });
    return { data, bytes: Buffer.byteLength(JSON.stringify(envelope), "utf8") };
  };

  // Monotone shrink: prefixes only, so a binary search finds the largest
  // prefix whose whole envelope fits. The centre alone must fit.
  const whole = assemble(nodes.length);
  if (whole.bytes <= opts.maxBytes) return whole.data;
  let lo = 1;
  let hi = nodes.length;
  let best = -1;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (assemble(mid).bytes <= opts.maxBytes) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  if (best < 1) throw new GraphLimitError();
  return assemble(best).data;
}

/** Serialize embedded JSON so `</script>`/event-handler breakouts cannot escape. */
export function serializeForScript(data: GraphData): string {
  return JSON.stringify(data).replace(/</g, "\\u003c").replace(/\u2028/g, "\\u2028").replace(/\u2029/g, "\\u2029");
}

/**
 * Render the self-contained offline viewer (inline SVG + vanilla script).
 * Renderer choice: inline SVG over canvas/WebGL — zero dependencies,
 * DOM-selectable nodes/edges, deterministic build-time layout, works from
 * file:// with no network. All untrusted fields are escaped at build time
 * (static shell) and inserted via textContent/DOM APIs at runtime.
 */
export function renderGraphHtml(data: GraphData, maxBytes: number): string {
  const embedded = serializeForScript(data);
  const title = `Memory graph — ${data.scope}`;
  const countsLine = ["active", "retired", "superseded", "archived"]
    .map((s) => `${s}: ${data.counts[s] ?? 0}`)
    .join(" · ");
  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:0;display:flex;height:100vh}
#view{flex:1;min-width:0;background:#f7f7f7}
#side{width:340px;max-width:40vw;overflow:auto;border-left:1px solid #ccc;padding:12px;background:#fff}
.node{cursor:pointer;stroke:#333;stroke-width:1.5}
.node.selected{stroke:#000;stroke-width:3}
.edge{stroke-width:1.5}
.edge.related{stroke:#3a7bd5}
.edge.consolidation{stroke:#2e8b57;stroke-dasharray:6 3}
.edge.supersedes{stroke:#c0392b;stroke-dasharray:2 2}
.edge.selected{stroke-width:3.5}
text{font-size:11px;fill:#222}
.legend span{display:inline-block;width:24px;border-top:3px solid;margin-right:6px;vertical-align:middle}
button{margin:2px}
#panel{white-space:pre-wrap;word-break:break-word;font-size:13px}
.meta{color:#555;font-size:12px}
</style>
</head>
<body>
<svg id="view" role="img" aria-label="${escapeHtml(title)}"></svg>
<div id="side">
<h2>Memory graph</h2>
<p class="meta">${escapeHtml(data.scope)} · ${escapeHtml(data.generatedAt)} · ${escapeHtml(countsLine)} · nodes ${data.nodes.length} · edges ${data.edges.length}</p>
<p class="meta">Derived read-only projection. Selecting, searching, or filtering never reactivates or heats records. Raw bodies stay in SQLite; this view carries snippets + source-ref / provenance identifiers only.</p>
<label>Search <input id="q" type="text" placeholder="id, snippet, or tag"></label>
<fieldset><legend>Show statuses (in this build: ${escapeHtml(data.statuses.join(", ") || "none")})</legend>
<label><input type="checkbox" data-st="active" checked> active</label>
<label><input type="checkbox" data-st="retired" checked> retired</label>
<label><input type="checkbox" data-st="superseded" checked> history: superseded</label>
<label><input type="checkbox" data-st="archived" checked> history: archived</label>
</fieldset>
<div class="legend">
<p><span style="border-color:#3a7bd5"></span>related [[link]]</p>
<p><span style="border-color:#2e8b57"></span>consolidation (summary/correction source)</p>
<p><span style="border-color:#c0392b"></span>supersedes (correction chain)</p>
</div>
<div id="panel">Select a node or edge.</div>
${data.unresolved.length > 0 ? `<details><summary>Unresolved refs (${data.unresolved.length}) — markers only, not drawn</summary><p class="meta">${data.unresolved.map(escapeHtml).join("<br>")}</p></details>` : `<p class="meta">No unresolved refs.</p>`}
</div>
<script>
var DATA = ${embedded};
(function(){
var svg = document.getElementById("view");
var panel = document.getElementById("panel");
var NS = "http://www.w3.org/2000/svg";
var colors = {active:"#3a7bd5",retired:"#d4a017",superseded:"#888888",archived:"#333333"};
var byId = {};
DATA.nodes.forEach(function(nd){ byId[nd.id] = nd; });
var sel = {node:null, edge:-1};
var NSVG = svg;
function clear(){ while (NSVG.firstChild) NSVG.removeChild(NSVG.firstChild); }
function visible(nd){
  var box = document.querySelector('input[data-st="'+nd.status+'"]');
  var q = document.getElementById("q").value.toLowerCase();
  if (box && !box.checked) return false;
  if (q) {
    var hay = (nd.id+" "+nd.snippet+" "+nd.tags.join(" ")).toLowerCase();
    if (hay.indexOf(q) === -1) return false;
  }
  return true;
}
function showNode(nd){
  panel.textContent = "";
  function line(k,v){ var p=document.createElement("p"); var b=document.createElement("b"); b.textContent=k+": "; p.appendChild(b); p.appendChild(document.createTextNode(v)); panel.appendChild(p); }
  line("id", nd.id); line("status", nd.status); line("kind", nd.kind);
  line("snippet", nd.snippet + (nd.truncated ? " …(truncated)" : ""));
  line("tags", nd.tags.join(", ") || "(none)");
  line("provenance source", nd.source); line("observedAt", nd.observedAt); line("createdAt", nd.createdAt);
  line("revision", String(nd.revision)); line("supersedes", nd.supersedes || "(none)");
  line("sourceRefs", nd.sourceRefs.join(", ") || "(none)");
  line("outbound", nd.links.join(", ") || "(none)");
  line("backlinks", nd.backlinks.join(", ") || "(none)");
  if (nd.mdFile) {
    var a = document.createElement("a"); a.textContent = "Open projected note " + nd.mdFile;
    a.setAttribute("href", "./" + nd.mdFile); panel.appendChild(a);
  } else { line("note", "(no local projection file)"); }
}
function showEdge(e){
  panel.textContent = "";
  function line(k,v){ var p=document.createElement("p"); var b=document.createElement("b"); b.textContent=k+": "; p.appendChild(b); p.appendChild(document.createTextNode(v)); panel.appendChild(p); }
  line("edge", e.from + " -> " + e.to); line("kind", e.kind);
}
function draw(){
  clear();
  var shown = DATA.nodes.filter(visible);
  var inView = {}; shown.forEach(function(nd){ inView[nd.id] = true; });
  DATA.edges.forEach(function(e, idx){
    if (!inView[e.from] || !inView[e.to]) return;
    var a = byId[e.from], b = byId[e.to];
    var ln = document.createElementNS(NS, "line");
    ln.setAttribute("x1", a.x); ln.setAttribute("y1", a.y);
    ln.setAttribute("x2", b.x); ln.setAttribute("y2", b.y);
    ln.setAttribute("class", "edge " + e.kind + (sel.edge === idx ? " selected" : ""));
    ln.addEventListener("click", function(){ sel.edge = idx; sel.node = null; draw(); showEdge(e); });
    svg.appendChild(ln);
  });
  shown.forEach(function(nd){
    var g = document.createElementNS(NS, "g");
    var c = document.createElementNS(NS, "circle");
    c.setAttribute("cx", nd.x); c.setAttribute("cy", nd.y); c.setAttribute("r", 14);
    c.setAttribute("fill", colors[nd.status] || "#999");
    c.setAttribute("class", "node" + (sel.node === nd.id ? " selected" : ""));
    c.addEventListener("click", function(){ sel.node = nd.id; sel.edge = -1; draw(); showNode(nd); });
    var t = document.createElementNS(NS, "text");
    t.setAttribute("x", nd.x + 17); t.setAttribute("y", nd.y + 4);
    t.textContent = nd.id.slice(0, 18);
    g.appendChild(c); g.appendChild(t); svg.appendChild(g);
  });
}
document.getElementById("q").addEventListener("input", draw);
Array.prototype.forEach.call(document.querySelectorAll("input[data-st]"), function(cb){ cb.addEventListener("change", draw); });
svg.setAttribute("viewBox", "0 0 840 680");
draw();
})();
</script>
</body>
</html>
`;
  const bytes = Buffer.byteLength(html, "utf8");
  if (bytes > maxBytes) throw new GraphLimitError();
  return html;
}
