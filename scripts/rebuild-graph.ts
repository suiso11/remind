/**
 * Build the bounded offline self-contained HTML graph projection (§14.5).
 *
 * Reads ONE scope from the canonical SQLite DB read-only (no schema init,
 * no migrations, no queue drainage, no audit/heat/ops/status writes) and
 * writes ONLY the owned view file (default `<vault>/graph.html`) atomically
 * (temp + rename). Over-bound builds fail with a fixed error and leave any
 * prior view intact. No server, no network, no Obsidian dependency.
 *
 * Bounds rationale (measured on synthetic data, see README):
 * - maxNodes 300 / maxEdges 800: an SVG with ~300 nodes / ~800 edges stays
 *   well under a megabyte and renders instantly in a local browser; the
 *   800-edge cap is ~2.7x the node cap so ordinary link densities (<=8 per
 *   record) never trip it before the node cap does.
 * - maxBytes 524288 (512 KiB): keeps the single self-contained file (inline
 *   data + SVG + script) emailable and file://-friendly; larger corpora must
 *   be scoped/filtered down rather than silently truncated.
 *
 * Usage: node dist/scripts/rebuild-graph.js --config <path> --scope <scope>
 *   [--out <path>] [--max-nodes N] [--max-edges M] [--max-bytes B]
 *   [--include-retired] [--include-history]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, resolveDbPath, resolveVaultPath } from "../src/config.js";
import {
  GRAPH_DEFAULT_MAX_BYTES,
  GRAPH_DEFAULT_MAX_EDGES,
  GRAPH_DEFAULT_MAX_NODES,
  GraphLimitError,
  buildGraphData,
  renderGraphHtml,
} from "../src/graph.js";

function failArgs(): never {
  process.stderr.write("error: bad arguments\n");
  process.exit(2);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  let scope: string | null = null;
  let out: string | null = null;
  let maxNodes = GRAPH_DEFAULT_MAX_NODES;
  let maxEdges = GRAPH_DEFAULT_MAX_EDGES;
  let maxBytes = GRAPH_DEFAULT_MAX_BYTES;
  let includeRetired = false;
  let includeHistory = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if ((a === "--config" || a === "--scope" || a === "--out" || a === "--max-nodes" || a === "--max-edges" || a === "--max-bytes") && i + 1 < args.length) {
      const v = args[++i]!;
      if (a === "--config") configPath = v;
      else if (a === "--scope") scope = v;
      else if (a === "--out") out = v;
      else if (a === "--max-nodes") maxNodes = Number(v);
      else if (a === "--max-edges") maxEdges = Number(v);
      else maxBytes = Number(v);
    } else if (a === "--include-retired") includeRetired = true;
    else if (a === "--include-history") includeHistory = true;
    else if (a === "--help" || a === "-h") {
      process.stderr.write("usage: rebuild-graph --config <path> --scope <scope> [--out <path>] [--max-nodes N] [--max-edges M] [--max-bytes B] [--include-retired] [--include-history]\n");
      process.exit(0);
    } else failArgs();
  }
  if (!configPath || !scope) failArgs();
  for (const [v, min, max] of [[maxNodes, 1, 2000], [maxEdges, 1, 5000], [maxBytes, 65536, 4194304]] as const) {
    if (!Number.isInteger(v) || v < min || v > max) failArgs();
  }
  if (scope.includes("\u0000") || /[\u0000-\u001F\u007F-\u009F]/.test(scope)) failArgs();

  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    process.stderr.write("error: invalid config\n");
    process.exit(2);
  }
  if (!config.allowedScopes.includes(scope)) {
    process.stderr.write("error: forbidden scope\n");
    process.exit(2);
  }
  const dbFile = resolveDbPath(configPath, config.dbPath);
  const vaultDir = resolveVaultPath(configPath, config.vaultPath);
  const outFile = out ? (path.isAbsolute(out) ? out : path.resolve(out)) : path.join(vaultDir, "graph.html");
  // Owned view file only: default lives under the vault; an explicit --out
  // must stay a single .html file (no directory traversal into markdown).
  if (path.extname(outFile) !== ".html" || outFile.includes("\u0000")) failArgs();

  let db: DatabaseSync;
  try {
    db = new DatabaseSync(dbFile, { readOnly: true } as unknown as Record<string, unknown>);
  } catch {
    try {
      db = new DatabaseSync(dbFile);
    } catch {
      process.stderr.write("error: store unavailable\n");
      process.exit(3);
    }
  }
  try {
    try {
      db.exec("PRAGMA query_only = ON");
    } catch {
      /* read-only enforcement is best-effort on top of SELECT-only queries */
    }
    // Scope must be seeded AND authorized: same gate as canonical reads.
    let row: { scope: string } | undefined;
    try {
      row = db.prepare(`SELECT scope FROM scopes WHERE scope = ?`).get(scope) as { scope: string } | undefined;
    } catch {
      process.stderr.write("error: store unavailable\n");
      process.exit(3);
    }
    if (!row) {
      process.stderr.write("error: forbidden scope\n");
      process.exit(2);
    }
    let data;
    try {
      data = buildGraphData(db as never, scope, {
        maxNodes,
        maxEdges,
        includeRetired,
        includeHistory,
        snippetMaxCp: config.limits.snippetMaxCp,
      }, vaultDir);
    } catch (e) {
      if (e instanceof GraphLimitError) {
        // Fixed error, prior view file untouched (no write attempted yet).
        process.stderr.write("error: graph over bound\n");
        process.exit(2);
      }
      throw e;
    }
    let html: string;
    try {
      html = renderGraphHtml(data, maxBytes);
    } catch (e) {
      if (e instanceof GraphLimitError) {
        process.stderr.write("error: graph over bound\n");
        process.exit(2);
      }
      throw e;
    }
    // Atomic replace of the owned view file only: temp + rename in the same
    // directory. Never touches Markdown projections or canonical rows.
    try {
      fs.mkdirSync(path.dirname(outFile), { recursive: true });
      const tmp = path.join(path.dirname(outFile), `.graph.${process.pid}.tmp`);
      fs.writeFileSync(tmp, html, "utf8");
      fs.renameSync(tmp, outFile);
    } catch {
      try {
        fs.rmSync(path.join(path.dirname(outFile), `.graph.${process.pid}.tmp`), { force: true });
      } catch {
        /* ignore */
      }
      process.stderr.write("error: store unavailable\n");
      process.exit(3);
    }
    process.stdout.write(
      JSON.stringify({
        ok: true,
        out: outFile,
        scope,
        nodes: data.nodes.length,
        edges: data.edges.length,
        unresolved: data.unresolved.length,
        counts: data.counts,
        bytes: Buffer.byteLength(html, "utf8"),
      }) + "\n",
    );
  } finally {
    try {
      db!.close();
    } catch {
      /* ignore */
    }
  }
}

void main();
