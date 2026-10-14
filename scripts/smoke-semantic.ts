/**
 * M2 CLI semantic smoke (real local model, synthetic temp data only).
 *
 * Seeds two paraphrase memories with (almost) no shared tokens plus one
 * distractor, rebuilds the derived vector index via the real model, then
 * proves through the actual CLI that a paraphrase query cites the right
 * record, while the lexical-only baseline (vectors removed) misses it.
 * Prints ok/FAIL per check; exits 1 on failure. Temp dir removed afterwards.
 *
 * Usage: node dist/scripts/smoke-semantic.js --config <path> --model-dir <dir>
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { bodyHashFor, normalizeBody } from "../src/normalize.js";
import { eventAppend, rememberRecord, upsertRecordVector } from "../src/store.js";
import { embedTexts, VECTOR_DIM } from "../src/vectors.js";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";
const TARGET_BODY = "the orchard workers gathered ripe persimmons at dawn";
const TARGET_RAW = "orchard dawn shift raw log alpha";
const DISTRACT_BODY = "the server migration finished without data loss";
// Paraphrase query: shares only stopwords ("the/in") with the target, so the
// lexical path has (almost) no signal while the embedding path does.
const QUERY = "fruit pickers collected the autumn crop in the early morning";

function cliRecall(cli: string, cfg: string, query: string): { status: number | null; ids: string[]; raw: string } {
  const line = JSON.stringify({ v: 1, op: "record.recall", params: { query, scope: SCOPE, limit: 5 } }) + "\n";
  const r = spawnSync(process.execPath, [cli, "--config", cfg], {
    input: line + "\n",
    encoding: "utf8",
    timeout: 90000,
  });
  const raw = ((r.stdout || "").split("\n")[0] ?? "").trim();
  let ids: string[] = [];
  try {
    const body = JSON.parse(raw) as { data?: { items?: Array<{ id?: string }> } };
    ids = (body.data?.items ?? []).map((i) => String(i.id));
  } catch {
    ids = [];
  }
  return { status: r.status, ids, raw };
}

function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "ok" : "FAIL"} ${name} ${detail}`);
  if (!cond) {
    console.error(`semantic smoke FAILED at ${name}: ${detail}`);
    process.exit(1);
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  let modelDir = "";
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i]!;
    else if (args[i] === "--model-dir" && i + 1 < args.length) modelDir = args[++i]!;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: smoke-semantic --config <path> --model-dir <dir>\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }
  if (!configPath || !modelDir) {
    process.stderr.write("error: bad arguments\n");
    process.exit(2);
  }
  // Resolve against CWD now: the temp config below lives in os.tmpdir, so a
  // relative --model-dir must not be re-resolved against that temp dir by the
  // CLI worker (which would miss the model and silently fall back).
  modelDir = path.resolve(modelDir);
  let base;
  try {
    base = loadConfig(configPath);
  } catch {
    process.stderr.write("error: invalid config\n");
    process.exit(2);
  }
  const repoRoot = path.resolve(__dirname, "..", "..");
  const cli = path.join(repoRoot, "dist", "src", "cli.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-m2-smoke-"));
  let db: DatabaseSync | null = null;
  try {
    const config = {
      ...base,
      dbPath: path.join(dir, "smoke.db"),
      vaultPath: path.join(dir, "vault"),
      timeouts: { cliMs: 60000, busyMs: base.timeouts.busyMs },
      vectors: { modelDir, topK: 20, timeoutMs: 60000, enabled: true },
    };
    const cfg = path.join(dir, "memory.config.json");
    fs.writeFileSync(cfg, JSON.stringify(config));
    ({ db } = initDb(config, cfg));
    check("model files", fs.existsSync(path.join(modelDir, "onnx", "model_quantized.onnx")), modelDir);
    const ev = eventAppend(db, config, {
      eventId: "e-sem-1", sessionId: "s1", turnId: "t1", body: TARGET_RAW,
      provenance: { source: "session:s1:turn:1", observedAt: OBS }, scope: SCOPE,
    }, "sem-ev-1");
    check("seed event", ev.ok === true, JSON.stringify(ev.code));
    const rem = rememberRecord(db, config, {
      body: TARGET_BODY, kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: OBS }, scope: SCOPE, sourceRefs: ["e-sem-1"],
    }, "sem-rem-1");
    check("seed target", rem.ok === true, JSON.stringify(rem.code));
    const targetId = (rem.data as { record: { id: string } }).record.id;
    const ev2 = eventAppend(db, config, {
      eventId: "e-sem-2", sessionId: "s1", turnId: "t2", body: "ops night raw log",
      provenance: { source: "session:s1:turn:2", observedAt: OBS }, scope: SCOPE,
    }, "sem-ev-2");
    check("seed distractor event", ev2.ok === true, JSON.stringify(ev2.code));
    const rem2 = rememberRecord(db, config, {
      body: DISTRACT_BODY, kind: "user_fact",
      provenance: { source: "session:s1:turn:2", observedAt: OBS }, scope: SCOPE, sourceRefs: ["e-sem-2"],
    }, "sem-rem-2");
    check("seed distractor", rem2.ok === true, JSON.stringify(rem2.code));

    // Real-model derived index (offline, local files only).
    const t0 = Date.now();
    const vecs = await embedTexts(
      [normalizeBody(TARGET_BODY), normalizeBody(DISTRACT_BODY)], modelDir, 60000,
    );
    check("real-model embed", !!vecs && vecs.length === 2, `ms=${Date.now() - t0}`);
    const now = new Date().toISOString();
    check("index target", upsertRecordVector(db, targetId, vecs![0]!, bodyHashFor(normalizeBody(TARGET_BODY)), now, VECTOR_DIM), targetId);
    const distId = (rem2.data as { record: { id: string } }).record.id;
    check("index distractor", upsertRecordVector(db, distId, vecs![1]!, bodyHashFor(normalizeBody(DISTRACT_BODY)), now, VECTOR_DIM), distId);
    try {
      db.close();
    } catch {
      /* ignore */
    }
    db = null;

    // CLI leg 1: fused semantic recall cites the paraphrase target first.
    const fused = cliRecall(cli, cfg, QUERY);
    check("cli fused status", fused.status === 0, fused.raw.slice(0, 200));
    check("cli fused cites target@1", fused.ids[0] === targetId, JSON.stringify(fused.ids));

    // CLI leg 2: lexical-only baseline (vectors removed) on the SAME query
    // must not rank the paraphrase target first (no shared content tokens).
    const reopen = new DatabaseSync(config.dbPath);
    try {
      reopen.exec(`DELETE FROM vec_notes`);
    } finally {
      try {
        reopen.close();
      } catch {
        /* ignore */
      }
    }
    const lex = cliRecall(cli, cfg, QUERY);
    check("cli baseline status", lex.status === 0, lex.raw.slice(0, 200));
    check("cli baseline misses target@1", lex.ids[0] !== targetId, JSON.stringify(lex.ids));
    console.log("semantic smoke OK");
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main();
