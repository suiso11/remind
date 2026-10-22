/**
 * Rebuild the derived vector index from canonical records (offline).
 *
 * Reads active records' normalized bodies, embeds them with the pinned local
 * model (no network), and upserts vec_notes. Missing/invalid model => reports
 * degraded with zero writes and exits 0 (recall keeps lexical+graph fallback).
 * Never mutates canonical tables. Bounded batches keep memory flat.
 *
 * Usage: node dist/scripts/rebuild-vectors.js --config <path> [--limit N] [--batch N]
 */
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { bodyHashFor } from "../src/normalize.js";
import { upsertRecordVector } from "../src/store.js";
import {
  VECTOR_DIM,
  embedTexts,
  resolveModelDir,
  vectorTimeoutMs,
  vectorsEnabled,
} from "../src/vectors.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  let limit = 10000;
  let batch = 16;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i]!;
    else if (args[i] === "--limit" && i + 1 < args.length) limit = Number(args[++i]!);
    else if (args[i] === "--batch" && i + 1 < args.length) batch = Number(args[++i]!);
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: rebuild-vectors --config <path> [--limit N] [--batch N]\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }
  if (!configPath) {
    process.stderr.write("error: bad arguments\n");
    process.exit(2);
  }
  if (!Number.isInteger(limit) || limit < 1 || limit > 100000) {
    process.stderr.write("error: bad arguments\n");
    process.exit(2);
  }
  if (!Number.isInteger(batch) || batch < 1 || batch > 64) {
    process.stderr.write("error: bad arguments\n");
    process.exit(2);
  }
  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    process.stderr.write("error: invalid config\n");
    process.exit(2);
  }
  if (!vectorsEnabled(config)) {
    process.stdout.write(JSON.stringify({ ok: true, degraded: true, reason: "vectors disabled", indexed: 0, total: 0 }) + "\n");
    return;
  }
  const modelDir = resolveModelDir(config, configPath);
  const timeoutMs = vectorTimeoutMs(config);
  let db: DatabaseSync;
  try {
    ({ db } = initDb(config, configPath));
  } catch {
    process.stderr.write("error: store unavailable\n");
    process.exit(3);
  }
  // A rebuild replaces every active vector, so every record must be rescanned
  // by the next maintain.associate. Clearing the dirty-state table (derived,
  // rebuildable) is enough; incident edges are replaced on that rescan.
  try {
    db.exec(`DELETE FROM associate_state`);
  } catch {
    /* table absent on a pre-association file: nothing to clear */
  }
  try {
    const rows = db
      .prepare(
        `SELECT id, bodyNorm, bodyHash FROM records WHERE scope IN (SELECT scope FROM scopes) AND status = 'active'
         ORDER BY createdAt ASC, id ASC LIMIT ?`,
      )
      .all(limit) as Array<{ id: string; bodyNorm: string; bodyHash: string }>;
    if (rows.length === 0) {
      process.stdout.write(JSON.stringify({ ok: true, degraded: false, indexed: 0, total: 0, modelDir }) + "\n");
      return;
    }
    // Probe the model once before touching the derived table.
    const probe = await embedTexts([rows[0]!.bodyNorm], modelDir, timeoutMs);
    if (!probe || probe.length !== 1 || !probe[0]) {
      process.stdout.write(
        JSON.stringify({ ok: true, degraded: true, reason: "model unavailable", indexed: 0, total: rows.length, modelDir }) + "\n",
      );
      return;
    }
    let indexed = 0;
    let skipped = 0;
    for (let i = 0; i < rows.length; i += batch) {
      const slice = rows.slice(i, i + batch);
      const vecs = await embedTexts(slice.map((r) => r.bodyNorm), modelDir, timeoutMs);
      if (!vecs || vecs.length !== slice.length) {
        skipped += slice.length;
        continue;
      }
      const now = new Date().toISOString();
      for (let j = 0; j < slice.length; j++) {
        const r = slice[j]!;
        const v = vecs[j]!;
        // Refresh the content hash from the canonical normalized body.
        const hash = bodyHashFor(r.bodyNorm);
        if (upsertRecordVector(db, r.id, v, hash, now, VECTOR_DIM)) indexed++;
        else skipped++;
      }
    }
    process.stdout.write(
      JSON.stringify({ ok: true, degraded: false, indexed, skipped, total: rows.length, modelDir, dim: VECTOR_DIM }) + "\n",
    );
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }
}

void main();
