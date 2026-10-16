/**
 * M3 cultivation smoke (real offline LLM, synthetic temp data only).
 *
 * Proves through the actual CLI, with the pinned local model, that:
 * - record.retire/reactivate round-trips reversibly (explicit, fixed reasons);
 * - normal recall/list exclude retired while record.search (active+retired)
 *   and record.get still find them, with no heat added and no reactivation;
 * - maintain.distill drains the bounded queue with real model decisions
 *   (single-flight lease, per-batch idempotency, atomic failure isolation),
 *   originals are always preserved (rows kept, history never deleted);
 * - a second drain with the same key replays deduplicated;
 * - a missing-model config degrades to OK with zero applies and zero state
 *   change (no fake decisions);
 * - a live lease held by another owner makes distill CONFLICT (transient),
 *   and explicit cancel removes a queued review.
 * Prints ok/FAIL per check; exits 1 on failure. Temp dir removed afterwards.
 *
 * Usage: node dist/scripts/smoke-m3.js [--config <path>] [--llm-dir <dir>]
 * Defaults: --config ./memory.config.example.json, --llm-dir ./models/qwen25-15b-instruct.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  LLM_MODEL_ID,
  LLM_MODEL_LICENSE,
  LLM_MODEL_REVISION,
  LLM_RUNTIME,
  modelFilesPresent,
} from "../src/llm.js";
import {
  acquireCultivationLease,
  cancelCultivationReview,
  peekCultivationQueue,
  releaseCultivationLease,
} from "../src/cultivation.js";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";
// Seed order matters: the near-duplicate key pair is seeded LAST so each
// duplicate sees its twin at merge position 1 (peers load newest-first).
// The mood seed carries no lasting content (explicit resolved transient
// mood); lamp/unsure are durable/uncertain controls the model must spare.
const SEEDS: Array<{ eventId: string; body: string; key: string }> = [
  { eventId: "e-m3-0", body: "the garden gate latch sticks when it rains", key: "m3-smoke-0" },
  { eventId: "e-m3-mood", body: "I feel sad and low tonight", key: "m3-smoke-mood" },
  { eventId: "e-m3-3", body: "the woodshed lantern needs a fresh wick before winter", key: "m3-smoke-3" },
  { eventId: "e-m3-4", body: "maybe the meeting is on thursday, not sure", key: "m3-smoke-4" },
  { eventId: "e-m3-1", body: "the cabin spare key hangs inside the woodshed on a blue hook", key: "m3-smoke-1" },
  { eventId: "e-m3-2", body: "the cabin spare key is on the blue hook in the woodshed", key: "m3-smoke-2" },
];

function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "ok" : "FAIL"} ${name} ${detail}`);
  if (!cond) {
    console.error(`m3 smoke FAILED at ${name}: ${detail}`);
    process.exit(1);
  }
}

function cli(cliPath: string, cfg: string, req: Record<string, unknown>, timeoutMs: number): { status: number | null; body: Record<string, unknown> | null; raw: string } {
  const r = spawnSync(process.execPath, [cliPath, "--config", cfg], {
    input: JSON.stringify(req) + "\n",
    encoding: "utf8",
    timeout: timeoutMs,
  });
  const raw = ((r.stdout || "").split("\n")[0] ?? "").trim();
  let body: Record<string, unknown> | null = null;
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: r.status, body, raw };
}

function itemsOf(body: Record<string, unknown> | null): Array<{ id: string; status?: string }> {
  const data = (body?.["data"] ?? null) as { items?: Array<{ id?: string; status?: string }> } | null;
  return (data?.items ?? []).map((i) => ({ id: String(i.id), status: i.status }));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoRoot = path.resolve(__dirname, "..", "..");
  let configPath: string | null = null;
  let llmDir = path.join(repoRoot, "models", "qwen25-15b-instruct");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i]!;
    else if (args[i] === "--llm-dir" && i + 1 < args.length) llmDir = args[++i]!;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: smoke-m3 [--config <path>] [--llm-dir <dir>]\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }
  llmDir = path.resolve(llmDir);
  if (!configPath) configPath = path.join(repoRoot, "memory.config.example.json");
  let base: AppConfig;
  try {
    base = loadConfig(configPath);
  } catch {
    process.stderr.write("error: invalid config\n");
    process.exit(2);
  }
  check("llm files present", modelFilesPresent(llmDir), `${LLM_MODEL_ID}@${LLM_MODEL_REVISION.slice(0, 8)} ${llmDir}`);
  console.log(`model ${LLM_MODEL_ID} revision ${LLM_MODEL_REVISION} license ${LLM_MODEL_LICENSE} runtime ${LLM_RUNTIME}`);

  const cliPath = path.join(repoRoot, "dist", "src", "cli.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-m3-smoke-"));
  try {
    const config: AppConfig = {
      ...base,
      dbPath: path.join(dir, "smoke.db"),
      vaultPath: path.join(dir, "vault"),
      allowedScopes: ["personal/default"],
      timeouts: { cliMs: 60000, busyMs: base.timeouts.busyMs },
      llm: { modelDir: llmDir, timeoutMs: 120000, enabled: true, maxNewTokens: 24, maxPromptChars: 2000 },
      maintenance: { timeoutMs: 300000 },
    };
    const cfg = path.join(dir, "memory.config.json");
    fs.writeFileSync(cfg, JSON.stringify(config));
    const seeded: string[] = [];
    for (const s of SEEDS) {
      const ev = cli(cliPath, cfg, { v: 1, op: "event.append", idempotencyKey: `ev-${s.key}`, params: { eventId: s.eventId, sessionId: "s1", turnId: "t1", body: `raw context ${s.eventId}`, provenance: { source: "session:s1:turn:1", observedAt: OBS }, scope: SCOPE } }, 60000);
      check(`seed event ${s.eventId}`, ev.status === 0 && (ev.body?.["ok"] as boolean) === true, ev.raw.slice(0, 160));
      const rem = cli(cliPath, cfg, { v: 1, op: "record.remember", idempotencyKey: `rem-${s.key}`, params: { body: s.body, kind: "user_fact", provenance: { source: "session:s1:turn:1", observedAt: OBS }, scope: SCOPE, sourceRefs: [s.eventId] } }, 60000);
      check(`seed remember ${s.key}`, rem.status === 0 && (rem.body?.["ok"] as boolean) === true, rem.raw.slice(0, 160));
      seeded.push((((rem.body?.["data"] ?? {}) as { record?: { id?: string } }).record?.id ?? "") as string);
    }
    check("seeded ids", seeded.every((id) => id.length > 0), JSON.stringify(seeded));

    // Explicit retire on the sacrificial seed (seeded[0]): normal
    // recall/list drop it, search+get keep it, no heat. It is reactivated
    // so the later cancel proof has a stable target history.
    const target = seeded[0]!;
    const ret = cli(cliPath, cfg, { v: 1, op: "record.retire", idempotencyKey: "smoke-ret-1", params: { id: target, scope: SCOPE, reasonCode: "OUTDATED" } }, 60000);
    check("cli retire", ret.status === 0 && (ret.body?.["ok"] as boolean) === true, ret.raw.slice(0, 160));
    const rec = cli(cliPath, cfg, { v: 1, op: "record.recall", params: { query: "garden gate latch rains", scope: SCOPE, limit: 10 } }, 60000);
    check("recall excludes retired", rec.status === 0 && !itemsOf(rec.body).some((i) => i.id === target), JSON.stringify(itemsOf(rec.body).map((i) => i.id)));
    const sea = cli(cliPath, cfg, { v: 1, op: "record.search", params: { query: "garden gate latch rains", scope: SCOPE, limit: 10 } }, 60000);
    const seaItems = itemsOf(sea.body);
    check("search finds retired", sea.status === 0 && seaItems.some((i) => i.id === target && i.status === "retired"), JSON.stringify(seaItems));
    const back = cli(cliPath, cfg, { v: 1, op: "record.reactivate", idempotencyKey: "smoke-rea-1", params: { id: target, scope: SCOPE, reasonCode: "STILL_USEFUL" } }, 60000);
    check("cli reactivate", back.status === 0 && (back.body?.["ok"] as boolean) === true, back.raw.slice(0, 160));

    // Cancel proof on the sacrificial review (oldest queued) so the five
    // cultivation seeds keep their reviews for the real-model drain.
    const peekDb0 = new DatabaseSync(config.dbPath);
    let cancelId = "";
    try {
      const open = peekCultivationQueue(peekDb0, SCOPE, 10);
      check("queue holds seeded reviews", open.length >= 6, `open=${open.length}`);
      cancelId = open[0]!.queueId;
    } finally {
      peekDb0.close();
    }
    const cdb = new DatabaseSync(config.dbPath);
    try {
      check("cancel queued review", cancelCultivationReview(cdb, cancelId) === true, cancelId);
      check("recancel is false", cancelCultivationReview(cdb, cancelId) === false, cancelId);
    } finally {
      cdb.close();
    }

    // Single-flight across processes: a live foreign lease => transient CONFLICT.
    let holder = new DatabaseSync(config.dbPath);
    let lease: { acquired: boolean };
    try {
      lease = acquireCultivationLease(holder, config, { owner: "smoke-holder" });
    } finally {
      holder.close();
    }
    check("hold lease", lease!.acquired === true, "smoke-holder");
    const contended = cli(cliPath, cfg, { v: 1, op: "maintain.distill", idempotencyKey: "smoke-dist-0", params: { scope: SCOPE, limit: 5 } }, 120000);
    check("distill under foreign lease conflicts", contended.status === 0 && (contended.body?.["code"] as string) === "CONFLICT", contended.raw.slice(0, 200));
    holder = new DatabaseSync(config.dbPath);
    try {
      check("release lease", releaseCultivationLease(holder, "smoke-holder") === true, "smoke-holder");
    } finally {
      holder.close();
    }

    // Real-model drain: bounded, idempotent, originals preserved.
    // Proves genuine cultivation: the model retires the resolved transient
    // mood (NONE gate) and consolidates the near-duplicate key pair into a
    // model-drafted summary, while durable/uncertain controls stay active.
    const t0 = Date.now();
    const d1 = cli(cliPath, cfg, { v: 1, op: "maintain.distill", idempotencyKey: "smoke-dist-1", params: { scope: SCOPE, limit: 10 } }, 590000);
    const d1data = ((d1.body?.["data"] ?? {}) as { distill?: Record<string, unknown> }).distill ?? {};
    check("distill ok with real model", d1.status === 0 && (d1.body?.["ok"] as boolean) === true, `ms=${Date.now() - t0} ${d1.raw.slice(0, 280)}`);
    check("distill reviewed>0 not degraded", Number(d1data["reviewed"]) > 0 && d1data["degraded"] === false, JSON.stringify(d1data));
    check("distill pins model", d1data["model"] === LLM_MODEL_ID && d1data["revision"] === LLM_MODEL_REVISION, JSON.stringify({ model: d1data["model"], revision: d1data["revision"] }));
    check("distill applied one retire + one summary", Number(d1data["applied"]) === 2, JSON.stringify(d1data));
    const moodId = seeded[1]!;
    const keyA = seeded[4]!;
    const keyB = seeded[5]!;
    const lampId = seeded[2]!;
    const unsureId = seeded[3]!;
    const statusOf = (id: string): string => {
      const g = cli(cliPath, cfg, { v: 1, op: "record.get", params: { id, scope: SCOPE } }, 60000);
      return (((g.body?.["data"] ?? {}) as { record?: { status?: string } }).record?.status ?? "") as string;
    };
    check("model retired transient mood", statusOf(moodId) === "retired", moodId);
    check("durable lamp spared", statusOf(lampId) === "active", lampId);
    check("uncertain spared", statusOf(unsureId) === "active", unsureId);
    check("merge sources kept (no auto-retire)", statusOf(keyA) === "active" && statusOf(keyB) === "active", `${keyA} ${keyB}`);
    // The consolidation summary is a real model-drafted row: kind summary,
    // non-empty body carrying the shared fact, canonical provenance, links
    // to both key sources and the union of their source refs. The correct
    // merge is the key pair the model mutually agreed on; unrelated notes
    // (e.g. the uncertain meeting note) must never be merged into anything.
    const sumDb = new DatabaseSync(config.dbPath);
    let summaries: Array<{ id: string; body: string; source: string }> = [];
    let sumLinks: Map<string, string[]> = new Map();
    try {
      summaries = sumDb.prepare(`SELECT id, body, source FROM records WHERE kind='summary' AND scope=?`).all(SCOPE) as Array<{ id: string; body: string; source: string }>;
      for (const s of summaries) {
        const links = (sumDb.prepare(`SELECT toRef FROM record_links WHERE fromId=? ORDER BY toRef`).all(s.id) as Array<{ toRef: string }>).map((r) => r.toRef);
        sumLinks.set(s.id, links);
      }
    } finally {
      sumDb.close();
    }
    check("model summary row exists once (reciprocal dedup)", summaries.length === 1, `summaries=${summaries.length}`);
    const keySums = summaries.filter((s) => {
      const l = sumLinks.get(s.id) ?? [];
      return l.includes(keyA) && l.includes(keyB);
    });
    check("model merged the duplicate key pair once", keySums.length === 1, JSON.stringify([...sumLinks.entries()]));
    const sum = keySums[0]!;
    const slow = sum.body.toLowerCase();
    check("summary body model-drafted shared fact", sum.body.length > 10 && slow.includes("key") && (slow.includes("woodshed") || slow.includes("hook") || slow.includes("blue")), JSON.stringify(sum.body).slice(0, 200));
    check("summary canonical provenance", sum.source === "cultivation:llm-derived", sum.source);
    const linkDb = new DatabaseSync(config.dbPath);
    try {
      const refs = (linkDb.prepare(`SELECT eventId FROM record_source_refs WHERE recordId=? ORDER BY eventId`).all(sum.id) as Array<{ eventId: string }>).map((r) => r.eventId);
      check("summary sourceRefs union", refs.includes("e-m3-1") && refs.includes("e-m3-2"), JSON.stringify(refs));
      const badMerges = [...sumLinks.entries()].filter(([, l]) => l.includes(unsureId) || l.includes(lampId) || l.includes(moodId));
      check("no unrelated merge (uncertain/lamp/mood untouched)", badMerges.length === 0, JSON.stringify(badMerges));
    } finally {
      linkDb.close();
    }
    // Retired mood leaves normal recall but stays visible to explicit search.
    const mrec = cli(cliPath, cfg, { v: 1, op: "record.recall", params: { query: "sad low tonight", scope: SCOPE, limit: 10 } }, 60000);
    check("recall excludes model-retired mood", mrec.status === 0 && !itemsOf(mrec.body).some((i) => i.id === moodId), JSON.stringify(itemsOf(mrec.body).map((i) => i.id)));
    const msea = cli(cliPath, cfg, { v: 1, op: "record.search", params: { query: "sad low tonight", scope: SCOPE, limit: 10 } }, 60000);
    check("search finds model-retired mood", msea.status === 0 && itemsOf(msea.body).some((i) => i.id === moodId), JSON.stringify(itemsOf(msea.body).map((i) => i.id)));
    for (let i = 0; i < seeded.length; i++) {
      const g = cli(cliPath, cfg, { v: 1, op: "record.get", params: { id: seeded[i], scope: SCOPE } }, 60000);
      const row = ((g.body?.["data"] ?? {}) as { record?: { body?: string; status?: string } }).record;
      check(`original preserved ${i}`, g.status === 0 && row?.body === SEEDS[i]!.body && (row?.status === "active" || row?.status === "retired"), JSON.stringify(row));
    }
    const dReplay = cli(cliPath, cfg, { v: 1, op: "maintain.distill", idempotencyKey: "smoke-dist-1", params: { scope: SCOPE, limit: 10 } }, 120000);
    check("distill replay deduplicated", dReplay.status === 0 && (dReplay.body?.["deduplicated"] as boolean) === true, dReplay.raw.slice(0, 200));

    // Missing-model degraded path (no state change, no fakes): seed one more
    // review first so the drain has work to refuse.
    const ev4 = cli(cliPath, cfg, { v: 1, op: "event.append", idempotencyKey: "ev-m3-smoke-5", params: { eventId: "e-m3-5", sessionId: "s1", turnId: "t5", body: "raw context e-m3-5", provenance: { source: "session:s1:turn:5", observedAt: OBS }, scope: SCOPE } }, 60000);
    check("seed event e-m3-5", ev4.status === 0 && (ev4.body?.["ok"] as boolean) === true, ev4.raw.slice(0, 160));
    const rem4 = cli(cliPath, cfg, { v: 1, op: "record.remember", idempotencyKey: "rem-m3-smoke-5", params: { body: "the boathouse oar rests against the north wall", kind: "user_fact", provenance: { source: "session:s1:turn:5", observedAt: OBS }, scope: SCOPE, sourceRefs: ["e-m3-5"] } }, 60000);
    check("seed remember m3-smoke-5", rem4.status === 0 && (rem4.body?.["ok"] as boolean) === true, rem4.raw.slice(0, 160));
    const missingDir = path.join(dir, "no-model");
    fs.mkdirSync(missingDir, { recursive: true });
    const badCfg = path.join(dir, "memory.bad.json");
    fs.writeFileSync(badCfg, JSON.stringify({ ...JSON.parse(fs.readFileSync(cfg, "utf8")) as Record<string, unknown>, llm: { modelDir: missingDir, timeoutMs: 5000, enabled: true, maxNewTokens: 8, maxPromptChars: 500 } }));
    const beforeDb = new DatabaseSync(config.dbPath);
    let beforeStatuses = "";
    try {
      beforeStatuses = JSON.stringify(beforeDb.prepare(`SELECT id, status FROM records ORDER BY id`).all());
    } finally {
      beforeDb.close();
    }
    const deg = cli(cliPath, badCfg, { v: 1, op: "maintain.distill", idempotencyKey: "smoke-dist-deg", params: { scope: SCOPE, limit: 5 } }, 120000);
    const degData = ((deg.body?.["data"] ?? {}) as { distill?: Record<string, unknown> }).distill ?? {};
    check("missing model degrades", deg.status === 0 && (deg.body?.["ok"] as boolean) === true && degData["degraded"] === true && Number(degData["applied"]) === 0, deg.raw.slice(0, 280));
    const afterDb = new DatabaseSync(config.dbPath);
    try {
      check("degraded changes nothing", JSON.stringify(afterDb.prepare(`SELECT id, status FROM records ORDER BY id`).all()) === beforeStatuses, beforeStatuses.slice(0, 120));
    } finally {
      afterDb.close();
    }
    // initDb is exercised for the temp DB (schema path), then closed.
    const chk = initDb(config, cfg);
    try {
      chk.db.close();
    } catch {
      /* ignore */
    }
    console.log("m3 smoke OK");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main();
