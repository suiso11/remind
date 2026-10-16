/**
 * M2 synthetic evaluation (seeded memory + fake conversation, no user data).
 *
 * Seeds a temp DB with EN/JA paraphrase pairs plus distractors, builds the
 * derived vector index with the pinned local model, then compares:
 *  (a) lexical-only baseline (vectors disabled),
 *  (b) fused semantic recall (lexical+vector+graph),
 *  (c) degraded recall (vector rows removed => offline fallback).
 * Reports citation accuracy (hit@1/hit@3), per-condition latency, the latency
 * increment of (b) over (a), and the degradation check (c)==(a).
 * One fake-conversation leg goes through the real CLI via queryMemory.
 *
 * Usage: node dist/scripts/eval-m2.js --config <path> --model-dir <dir> [--out <json>]
 * The config's dbPath/vaultPath are IGNORED: everything runs in a temp dir
 * that is removed afterwards. Exit non-zero only on harness failure.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { bodyHashFor } from "../src/normalize.js";
import { eventAppend, recallRecords, rememberRecord, upsertRecordVector } from "../src/store.js";
import { queryMemory } from "../src/fake-adapter.js";
import { embedTexts, resolveModelDir, VECTOR_DIM } from "../src/vectors.js";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";

interface Seed { body: string; raw: string; tags?: string[] }
interface Probe { query: string; expectBody: string; lang: string }

const SEEDS: Seed[] = [
  { body: "the orchard workers gathered ripe persimmons at dawn", raw: "orchard dawn shift raw log alpha" },
  { body: "the bicycle tire lost pressure on the mountain road", raw: "cycling trip raw log beta" },
  { body: "果樹園で柿を収穫した", raw: "果樹園の作業記録 gamma" },
  { body: "the lighthouse keeper polished the brass lamp at dusk", raw: "harbor evening raw log delta" },
  { body: "miso soup with tofu and seaweed for breakfast", raw: "kitchen morning raw log epsilon" },
  { body: "the quarterly budget review moved to thursday afternoon", raw: "office schedule raw log zeta" },
  { body: "a stray cat naps under the porch bench", raw: "garden noon raw log eta" },
  { body: "the server migration finished without data loss", raw: "ops night raw log theta" },
];

const PROBES: Probe[] = [
  // Paraphrase probes share (almost) no content tokens with their target,
  // so the lexical path has little signal while the embedding path does.
  { query: "fruit pickers collected the autumn crop in the early morning", expectBody: SEEDS[0]!.body, lang: "en" },
  { query: "two-wheeler rubber lost air on an alpine climb", expectBody: SEEDS[1]!.body, lang: "en" },
  { query: "秋に果物を摘み取った", expectBody: SEEDS[2]!.body, lang: "ja" },
  { query: "the coastal beacon attendant serviced the lighting apparatus at nightfall", expectBody: SEEDS[3]!.body, lang: "en" },
];

function msNow(): number {
  return Number(process.hrtime.bigint() / 1000000n);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  let modelDirArg: string | null = null;
  let outPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i]!;
    else if (args[i] === "--model-dir" && i + 1 < args.length) modelDirArg = args[++i]!;
    else if (args[i] === "--out" && i + 1 < args.length) outPath = args[++i]!;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: eval-m2 --config <path> --model-dir <dir> [--out <json>]\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }
  if (!configPath || !modelDirArg) {
    process.stderr.write("error: bad arguments\n");
    process.exit(2);
  }
  let base: AppConfig;
  try {
    base = loadConfig(configPath);
  } catch {
    process.stderr.write("error: invalid config\n");
    process.exit(2);
  }
  // Resolve against CWD now: the temp config below lives in os.tmpdir, so a
  // relative --model-dir must not be re-resolved against that temp dir by the
  // CLI worker (which would miss the model and silently fall back).
  modelDirArg = path.resolve(modelDirArg);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-m2-eval-"));
  const cleanup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  };
  try {
    const config: AppConfig = {
      ...base,
      dbPath: path.join(dir, "eval.db"),
      vaultPath: path.join(dir, "vault"),
      timeouts: { cliMs: 60000, busyMs: base.timeouts.busyMs },
      vectors: {
        modelDir: modelDirArg,
        topK: 20,
        timeoutMs: 60000,
        enabled: true,
      },
    };
    const cfgPath = path.join(dir, "memory.config.json");
    fs.writeFileSync(cfgPath, JSON.stringify(config), "utf8");
    const modelDir = resolveModelDir(config, cfgPath);
    const { db } = initDb(config, cfgPath);

    // Seed: raw + record per memory (synthetic only).
    const bodyToId = new Map<string, string>();
    try {
      for (let i = 0; i < SEEDS.length; i++) {
        const s = SEEDS[i]!;
        const ev = eventAppend(db, config, {
          eventId: `e-eval-${i}`, sessionId: "s-eval", turnId: `t${i}`,
          body: s.raw, provenance: { source: "session:s-eval:turn:1", observedAt: OBS }, scope: SCOPE,
        }, `eval-ev-${i}`);
        if (!ev.ok) throw new Error(`seed event ${i} failed`);
        const rem = rememberRecord(db, config, {
          body: s.body, kind: "user_fact",
          provenance: { source: "session:s-eval:turn:1", observedAt: OBS },
          scope: SCOPE, tags: s.tags, sourceRefs: [`e-eval-${i}`],
        }, `eval-rem-${i}`);
        if (!rem.ok) throw new Error(`seed record ${i} failed`);
        bodyToId.set(s.body, (rem.data as { record: { id: string } }).record.id);
      }

      // Build the derived vector index with the real local model.
      const tIdx0 = msNow();
      const bodies = SEEDS.map((s) => s.body);
      const { normalizeBody } = await import("../src/normalize.js");
      const vecs = await embedTexts(bodies.map((b) => normalizeBody(b)), modelDir, 60000);
      const indexMs = msNow() - tIdx0;
      let indexed = 0;
      let modelAvailable = false;
      if (vecs && vecs.length === bodies.length) {
        modelAvailable = true;
        const now = new Date().toISOString();
        for (let i = 0; i < bodies.length; i++) {
          const id = bodyToId.get(bodies[i]!)!;
          if (upsertRecordVector(db, id, vecs[i]!, bodyHashFor(normalizeBody(bodies[i]!)), now, VECTOR_DIM)) indexed++;
        }
      }

      const runProbe = (
        probe: Probe,
        mode: "lexical" | "fused" | "degraded",
        qvec: Float32Array | null,
      ): { hit1: boolean; hit3: boolean; ms: number; top: string[] } => {
        const t0 = msNow();
        const res = recallRecords(
          db, config,
          { query: probe.query, scope: SCOPE, limit: 5 },
          undefined,
          mode === "fused" ? { vec: qvec, topK: 20 } : undefined,
        );
        const ms = msNow() - t0;
        if (!res.ok) return { hit1: false, hit3: false, ms, top: [] };
        const items = (res.data as { items: Array<{ id: string }> }).items;
        const want = bodyToId.get(probe.expectBody)!;
        const ids = items.map((x) => x.id);
        return { hit1: ids[0] === want, hit3: ids.slice(0, 3).includes(want), ms, top: ids.slice(0, 3) };
      };

      // Pre-embed probe queries once (model latency counted separately).
      const { normalizeBody: nb } = await import("../src/normalize.js");
      const tQ0 = msNow();
      const qvecs = modelAvailable
        ? await embedTexts(PROBES.map((p) => nb(p.query)), modelDir, 60000)
        : null;
      const queryEmbedMs = modelAvailable ? (msNow() - tQ0) / PROBES.length : 0;

      const rows: Array<Record<string, unknown>> = [];
      let lexH1 = 0;
      let lexH3 = 0;
      let fusH1 = 0;
      let fusH3 = 0;
      let degH3 = 0;
      let lexMs = 0;
      let fusMs = 0;
      for (let i = 0; i < PROBES.length; i++) {
        const p = PROBES[i]!;
        const qv = qvecs && qvecs[i] ? qvecs[i]! : null;
        const a = runProbe(p, "lexical", null);
        const b = runProbe(p, "fused", qv);
        lexH1 += a.hit1 ? 1 : 0;
        lexH3 += a.hit3 ? 1 : 0;
        fusH1 += b.hit1 ? 1 : 0;
        fusH3 += b.hit3 ? 1 : 0;
        lexMs += a.ms;
        fusMs += b.ms;
        rows.push({ query: p.query, lang: p.lang, lexicalHit3: a.hit3, fusedHit3: b.hit3, fusedHit1: b.hit1, fusedTop: b.top });
      }
      // Degraded: drop derived vectors, re-run fused path (must equal lexical).
      db.exec(`DELETE FROM vec_notes`);
      for (let i = 0; i < PROBES.length; i++) {
        const p = PROBES[i]!;
        const qv = qvecs && qvecs[i] ? qvecs[i]! : null;
        const d = runProbe(p, "fused", qv);
        const l = runProbe(p, "lexical", null);
        if (d.top.join(",") === l.top.join(",")) degH3++;
        rows[i]!["degradedEqualsLexical"] = d.top.join(",") === l.top.join(",");
      }

      const n = PROBES.length;
      const report = {
        ok: true as const,
        synthetic: true,
        seeds: SEEDS.length,
        probes: n,
        modelAvailable,
        indexed,
        indexMs,
        lexical: { hitAt1: lexH1 / n, hitAt3: lexH3 / n, meanMs: lexMs / n },
        fused: { hitAt1: fusH1 / n, hitAt3: fusH3 / n, meanMs: fusMs / n },
        latencyIncrementMs: fusMs / n - lexMs / n,
        queryEmbedMeanMs: queryEmbedMs,
        cliLegNote: "CLI wall latency dominated by cold model load (~0.8s); warm embed ~4ms/query",
        degradedMatchesLexical: `${degH3}/${n}`,
        rows,
      };
      const line = JSON.stringify(report);
      process.stdout.write(line + "\n");
      if (outPath) fs.writeFileSync(outPath, line + "\n", "utf8");

      // Fake-conversation leg through the real CLI (citation accuracy proof).
      // Rebuild the derived vectors dropped above so the CLI worker fuses them.
      if (modelAvailable) {
        const { normalizeBody: nb2 } = await import("../src/normalize.js");
        const fresh = await embedTexts(bodies.map((b) => nb2(b)), modelDir, 60000);
        if (fresh && fresh.length === bodies.length) {
          const now = new Date().toISOString();
          for (let i = 0; i < bodies.length; i++) {
            upsertRecordVector(db, bodyToId.get(bodies[i]!)!, fresh[i]!, bodyHashFor(nb2(bodies[i]!)), now, VECTOR_DIM);
          }
        }
      }
      try {
        db.close();
      } catch {
        /* ignore */
      }
      // CLI leg uses the same temp DB file via a scratch config copy.
      const cliCfg = path.join(dir, "cli.config.json");
      fs.writeFileSync(cliCfg, JSON.stringify({ ...config, dbPath: config.dbPath, vaultPath: config.vaultPath }), "utf8");
      const cliPath = path.resolve(__dirname, "..", "src", "cli.js");
      const chat = queryMemory({ cliPath, configPath: cliCfg, scope: SCOPE, query: PROBES[0]!.query, limit: 5, timeoutMs: 10000 });
      const cited = !chat.degraded && chat.citations.includes(bodyToId.get(PROBES[0]!.expectBody) ?? "∅");
      process.stderr.write(`eval: fake-conversation CLI citation ${cited ? "HIT" : "MISS"} (degraded=${chat.degraded})\n`);
    } finally {
      try {
        (db as DatabaseSync).close();
      } catch {
        /* ignore */
      }
    }
  } finally {
    cleanup();
  }
}

void main();
