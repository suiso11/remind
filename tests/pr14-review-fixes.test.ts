/**
 * PR14 review fixes: behavior regressions for the 13 Codex findings.
 *
 * No model, no network. Deterministic fixed timestamps except the live-CLI
 * maintenance-budget case, which uses wall-clock startup latency against a
 * tiny cliMs (old code rewrote the CONFLICT to TIMEOUT; fixed code keeps it).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  correctRecord,
  eventAppend,
  feedbackRecords,
  getRecord,
  recallRecords,
  rememberRecord,
  searchRecords,
} from "../src/store.js";
import {
  acquireCultivationLease,
  applyCultivationBatch,
  completeCultivationReview,
  countOpenCultivationReviews,
  dequeueCultivationBatch,
  enqueueCultivationReview,
} from "../src/cultivation.js";
import { maintainDistill, DISTILL_SUMMARY_SOURCE } from "../src/distill.js";
import { isLlmPoisoned, resetLlmRuntime } from "../src/llm.js";
import { vectorEmbedBudgetMs, vectorsEnabled } from "../src/vectors.js";

const OBS = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T00:00:01.000Z";
const T2 = "2026-09-01T00:00:02.000Z";
const T3 = "2026-09-01T00:00:03.000Z";
const SCOPE = "personal/default";
/** Drain clock after wall-clock queue nextAt values (temp DBs use nowIso). */
const DRAIN_NOW = "2026-12-01T00:00:00.000Z";
let ctr = 0;

function baseConfig(dir: string, extra?: Partial<AppConfig>): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE],
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      linksMax: 10,
      sourceRefsMax: 10,
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 8192,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
    ...extra,
  };
  return { config, configPath: path.join(dir, "memory.config.json") };
}

function setup(extra?: Partial<AppConfig>): { dir: string; config: AppConfig; configPath: string; db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr14-"));
  const { config, configPath } = baseConfig(dir, extra);
  const { db } = initDb(config, configPath);
  return {
    dir, config, configPath, db,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function raw(db: DatabaseSync, config: AppConfig, eventId: string): void {
  const r = eventAppend(db, config, {
    eventId, sessionId: "s1", turnId: "t1",
    body: `raw context ${eventId}`,
    provenance: { source: "session:s1", observedAt: OBS },
    scope: SCOPE,
  }, `pr14-ev-${eventId}-${ctr++}`);
  assert.equal(r.ok, true, JSON.stringify(r));
}

function remember(db: DatabaseSync, config: AppConfig, body: string, key: string, extra: Record<string, unknown> = {}): string {
  const ref = `pr14-auto-${key}`;
  raw(db, config, ref);
  const res = rememberRecord(db, config, {
    body, kind: "user_fact",
    provenance: { source: "session:s1", observedAt: OBS },
    scope: SCOPE, sourceRefs: [ref], ...extra,
  }, key);
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function fakeLlmDir(dir: string): string {
  const modelDir = path.join(dir, "fake-llm");
  fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
  for (const f of ["config.json", "generation_config.json", "tokenizer.json", "tokenizer_config.json", "special_tokens_map.json", "onnx/model_q4.onnx"]) {
    fs.writeFileSync(path.join(modelDir, f), "{}");
  }
  return modelDir;
}

function enableFakeLlm(config: AppConfig, modelDir: string): void {
  config.llm = { modelDir, timeoutMs: 5000, enabled: true, maxNewTokens: 48, maxPromptChars: 2000 };
}

function summaries(db: DatabaseSync): Array<{ id: string; body: string }> {
  return db.prepare(`SELECT id, body FROM records WHERE kind='summary'`).all() as Array<{ id: string; body: string }>;
}

describe("pr14: vectorsEnabled requires explicit opt-in; embed budget honors remaining deadline", () => {
  it("absent vectors section stays lexical (no silent semantic enable)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr14-vec-"));
    try {
      const { config } = baseConfig(dir);
      assert.equal(vectorsEnabled(config), false);
      assert.equal(vectorsEnabled({ ...config, vectors: { enabled: true } as never }), true);
      assert.equal(vectorsEnabled({ ...config, vectors: { enabled: false } as never }), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("embed budget caps by remaining-minus-reserve, skips when fallback would not fit", () => {
    assert.equal(vectorEmbedBudgetMs(15000, undefined, 0), 15000);
    assert.equal(vectorEmbedBudgetMs(15000, 20000, 0), 15000);
    assert.equal(vectorEmbedBudgetMs(15000, 3000, 0), 2250);
    assert.equal(vectorEmbedBudgetMs(15000, 1000, 0), null);
    assert.equal(vectorEmbedBudgetMs(15000, 5000, 4600), null);
    assert.equal(vectorEmbedBudgetMs(0, undefined, 0), null);
  });
});

describe("pr14: queue cap and lease single-flight boundaries", () => {
  it("queueMax=2 drops the third concurrent enqueue, duplicates stay duplicates", () => {
    const ctx = setup({ cultivation: { queueMax: 2 } as never });
    try {
      const a = remember(ctx.db, ctx.config, "queue cap alpha note", "pr14-q-1");
      const b = remember(ctx.db, ctx.config, "queue cap beta note", "pr14-q-2");
      const c = remember(ctx.db, ctx.config, "queue cap gamma note", "pr14-q-3");
      void a; void b;
      // remember() auto-enqueues the first two; the third must drop.
      const dup = enqueueCultivationReview(ctx.db, ctx.config, { recordId: c, scope: SCOPE, trigger: "remember", now: T1 });
      assert.ok(dup === "dropped_full" || dup === "duplicate", `unexpected ${dup}`);
      assert.ok(countOpenCultivationReviews(ctx.db) <= 2, "queue exceeded its cap");
    } finally {
      ctx.cleanup();
    }
  });

  it("live lease refuses a second owner; expiry steals; same-owner renewal extends", () => {
    const ctx = setup();
    try {
      const first = acquireCultivationLease(ctx.db, ctx.config, { owner: "pr14-A", now: T1 });
      assert.equal(first.acquired, true);
      const second = acquireCultivationLease(ctx.db, ctx.config, { owner: "pr14-B", now: T2 });
      assert.equal(second.acquired, false);
      const renew = acquireCultivationLease(ctx.db, ctx.config, { owner: "pr14-A", now: T2 });
      assert.equal(renew.acquired, true);
      assert.ok((renew.lease?.expiresAt ?? "") >= (first.lease?.expiresAt ?? ""), "renewal must not shorten the lease");
      const steal = acquireCultivationLease(ctx.db, ctx.config, { owner: "pr14-C", now: "2027-01-01T00:00:00.000Z" });
      assert.equal(steal.acquired, true);
      assert.equal(steal.lease?.owner, "pr14-C");
    } finally {
      ctx.cleanup();
    }
  });

  it("llm poison starts clear and reset clears runtime state", () => {
    resetLlmRuntime();
    assert.equal(isLlmPoisoned("some-dir"), false);
  });
});

describe("pr14: idempotent replay recovers lost cultivation enqueue", () => {
  it("remember/correct/feedback replays re-enqueue after a lost post-commit enqueue", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "replay recovery probe note", "pr14-rp-1");
      ctx.db.prepare(`DELETE FROM cultivation_queue WHERE recordId=?`).run(id);
      assert.equal(countOpenCultivationReviews(ctx.db), 0);
      const ref = `pr14-auto-pr14-rp-1`;
      const replay = rememberRecord(ctx.db, ctx.config, {
        body: "replay recovery probe note", kind: "user_fact",
        provenance: { source: "session:s1", observedAt: OBS },
        scope: SCOPE, sourceRefs: [ref],
      }, "pr14-rp-1");
      assert.equal(replay.ok, true, JSON.stringify(replay));
      const rows = ctx.db.prepare(`SELECT queueId FROM cultivation_queue WHERE recordId=? AND status IN ('pending','leased')`).all(id) as Array<{ queueId: string }>;
      assert.equal(rows.length, 1, "replay must restore the lost cultivation review");

      const c = correctRecord(ctx.db, ctx.config, {
        recordId: id, body: "replay recovery corrected note", kind: "correction",
        provenance: { source: "session:s1", observedAt: OBS }, scope: SCOPE,
      }, "pr14-rp-c1");
      assert.equal(c.ok, true, JSON.stringify(c));
      const correctedId = (c.data as { record: { id: string } }).record.id;
      ctx.db.prepare(`DELETE FROM cultivation_queue WHERE recordId=?`).run(correctedId);
      const cReplay = correctRecord(ctx.db, ctx.config, {
        recordId: id, body: "replay recovery corrected note", kind: "correction",
        provenance: { source: "session:s1", observedAt: OBS }, scope: SCOPE,
      }, "pr14-rp-c1");
      assert.equal(cReplay.ok, true, JSON.stringify(cReplay));
      const cRows = ctx.db.prepare(`SELECT queueId FROM cultivation_queue WHERE recordId=? AND status IN ('pending','leased')`).all(correctedId) as Array<{ queueId: string }>;
      assert.equal(cRows.length, 1, "correct replay must restore the lost review");

      const id2 = remember(ctx.db, ctx.config, "feedback replay second note", "pr14-rp-2");
      const rec = recallRecords(ctx.db, ctx.config, { query: "feedback replay second", scope: SCOPE, limit: 5 });
      assert.equal(rec.ok, true, JSON.stringify(rec));
      const recallId = (rec.data as { recallId: string }).recallId;
      const fb = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id2], scope: SCOPE }, "pr14-rp-f1");
      assert.equal(fb.ok, true, JSON.stringify(fb));
      ctx.db.prepare(`DELETE FROM cultivation_queue WHERE recordId=?`).run(id2);
      const fbReplay = feedbackRecords(ctx.db, ctx.config, { recallId, recordIds: [id2], scope: SCOPE }, "pr14-rp-f1");
      assert.equal(fbReplay.ok, true, JSON.stringify(fbReplay));
      const fRows = ctx.db.prepare(`SELECT queueId FROM cultivation_queue WHERE recordId=? AND status IN ('pending','leased')`).all(id2) as Array<{ queueId: string }>;
      assert.equal(fRows.length, 1, "feedback replay must restore the lost review");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("pr14: mutual-agreement merge, provenance cap, peer guard", () => {
  function cabinSetup(ctx: { dir: string; config: AppConfig; db: DatabaseSync }): { idA: string; idB: string; idC: string; configPath: string } {
    const modelDir = fakeLlmDir(ctx.dir);
    enableFakeLlm(ctx.config, modelDir);
    const idA = remember(ctx.db, ctx.config, "the cabin spare key hangs inside the woodshed on a blue hook", "pr14-m-a");
    const idB = remember(ctx.db, ctx.config, "the cabin spare key rests on the blue hook inside the woodshed", "pr14-m-b");
    const idC = remember(ctx.db, ctx.config, "the boathouse oar rests against the north wall", "pr14-m-c");
    return { idA, idB, idC, configPath: path.join(ctx.dir, "memory.config.json") };
  }

  function mergeDecide(oneSidedForA: boolean): (prompt: string) => Promise<string | null> {
    return async (prompt: string): Promise<string | null> => {
      if (prompt.includes("What lasting fact")) return "a lasting key fact is recorded";
      if (prompt.includes("Other memories in the same scope")) {
        const head = prompt.split("Other memories")[0] ?? "";
        if (!/cabin|blue hook|woodshed/i.test(head)) return "KEEP";
        if (oneSidedForA && !/hangs inside/i.test(head)) return "KEEP";
        const peerRe = /^\s*(\d+)\.\s+"""(.*)"""\s*$/gm;
        let m: RegExpExecArray | null;
        while ((m = peerRe.exec(prompt)) !== null) {
          if (/cabin|blue hook|woodshed/i.test(m[2] ?? "")) return `MERGE ${m[1]}`;
        }
        return "KEEP";
      }
      if (prompt.includes("What single fact do both memories")) return "the cabin spare key is on the blue hook in the woodshed";
      if (prompt.includes("Merge these related memories")) return "the cabin spare key hangs on the blue hook in the woodshed";
      return "KEEP";
    };
  }

  it("one-sided merge (peer KEEP) becomes an audited keep: no summary", async () => {
    const ctx = setup();
    try {
      const { idA, idB, idC, configPath } = cabinSetup(ctx);
      const res = await maintainDistill(ctx.db, ctx.config, configPath, { scope: SCOPE, limit: 10 }, "pr14-one-sided", mergeDecide(true), DRAIN_NOW);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal((res.data as { distill: { reviewed: number } }).distill.reviewed, 3, "drain must actually review all three");
      assert.equal(summaries(ctx.db).length, 0, "one-sided pick must not create a summary");
      for (const id of [idA, idB, idC]) {
        const v = getRecord(ctx.db, ctx.config, { id, scope: SCOPE });
        assert.equal((v.data as { record: { status: string } }).record.status, "active");
      }
      const d = (res.data as { distill: { failed: number } }).distill;
      assert.equal(d.failed, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("over-limit provenance union becomes an audited keep: no truncated summary", async () => {
    const ctx = setup();
    try {
      const modelDir = fakeLlmDir(ctx.dir);
      enableFakeLlm(ctx.config, modelDir);
      const configPath = path.join(ctx.dir, "memory.config.json");
      const refsA: string[] = [];
      const refsB: string[] = [];
      for (let i = 0; i < 6; i++) { const e = `pr14-ov-a${i}`; raw(ctx.db, ctx.config, e); refsA.push(e); }
      for (let i = 0; i < 6; i++) { const e = `pr14-ov-b${i}`; raw(ctx.db, ctx.config, e); refsB.push(e); }
      const mk = (body: string, refs: string[], key: string): string => {
        const r = rememberRecord(ctx.db, ctx.config, {
          body, kind: "user_fact",
          provenance: { source: "session:s1", observedAt: OBS },
          scope: SCOPE, sourceRefs: refs,
        }, key);
        assert.equal(r.ok, true, JSON.stringify(r));
        return (r.data as { record: { id: string } }).record.id;
      };
      const idA = mk("the cabin spare key hangs inside the woodshed on a blue hook", refsA, "pr14-ov-ra");
      const idB = mk("the cabin spare key rests on the blue hook inside the woodshed", refsB, "pr14-ov-rb");
      const idC = remember(ctx.db, ctx.config, "the boathouse oar rests against the north wall", "pr14-ov-c");
      void idC;
      const res = await maintainDistill(ctx.db, ctx.config, configPath, { scope: SCOPE, limit: 10 }, "pr14-overrefs", mergeDecide(false), DRAIN_NOW);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal((res.data as { distill: { reviewed: number } }).distill.reviewed, 3, "drain must actually review all three");
      assert.equal(summaries(ctx.db).length, 0, "12 distinct refs over sourceRefsMax=10 must skip, not truncate");
      for (const id of [idA, idB]) {
        const v = getRecord(ctx.db, ctx.config, { id, scope: SCOPE });
        assert.equal((v.data as { record: { status: string } }).record.status, "active");
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("stale peer revision turns consolidate into a per-action CONFLICT (no summary)", () => {
    const ctx = setup();
    try {
      const idA = remember(ctx.db, ctx.config, "peer guard alpha memory", "pr14-pg-a");
      const idB = remember(ctx.db, ctx.config, "peer guard beta memory", "pr14-pg-b");
      const revB = (getRecord(ctx.db, ctx.config, { id: idB, scope: SCOPE }).data as { record: { revision: number } }).record.revision;
      const c = correctRecord(ctx.db, ctx.config, {
        recordId: idB, body: "peer guard beta memory revised", kind: "correction",
        provenance: { source: "session:s1", observedAt: OBS }, scope: SCOPE,
      }, "pr14-pg-c1");
      assert.equal(c.ok, true, JSON.stringify(c));
      const refA = `pr14-auto-pr14-pg-a`;
      const res = applyCultivationBatch(ctx.db, ctx.config, {
        scope: SCOPE,
        idempotencyKey: "pr14-pg-batch-1",
        actions: [{
          recordId: idA, action: "consolidate",
          expectedRevision: 1, expectedStatus: "active",
          peer: { recordId: idB, expectedRevision: revB, expectedStatus: "active" },
          summary: {
            body: "peer guard summary from stale bodies",
            provenance: { source: DISTILL_SUMMARY_SOURCE, observedAt: OBS },
            sourceRefs: [refA], links: [idA, idB],
          },
        }],
      }, T3);
      assert.equal(res.ok, true, JSON.stringify(res));
      const cult = (res.data as { cultivation: { applied: number; results: Array<{ code: string; applied: boolean }> } }).cultivation;
      assert.equal(cult.applied, 0);
      assert.equal(cult.results[0]?.code, "CONFLICT");
      assert.equal(cult.results[0]?.applied, false);
      assert.equal(summaries(ctx.db).length, 0, "stale peer must not produce a summary");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("pr14: uncancelled-inference latch and stale-lease settle guard", () => {
  it("first inference failure stops further model calls; rest go to bounded retry", async () => {
    const ctx = setup();
    try {
      const modelDir = fakeLlmDir(ctx.dir);
      enableFakeLlm(ctx.config, modelDir);
      remember(ctx.db, ctx.config, "poison probe alpha note", "pr14-ps-1");
      remember(ctx.db, ctx.config, "poison probe beta note", "pr14-ps-2");
      remember(ctx.db, ctx.config, "poison probe gamma note", "pr14-ps-3");
      let calls = 0;
      const decide = async (_prompt: string): Promise<string | null> => { calls++; return null; };
      const res = await maintainDistill(ctx.db, ctx.config, path.join(ctx.dir, "memory.config.json"), { scope: SCOPE, limit: 10 }, "pr14-poison", decide, DRAIN_NOW);
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(calls, 1, `poisoned drain must issue exactly one model call, issued ${calls}`);
      const d = (res.data as { distill: { failed: number; reviewed: number } }).distill;
      assert.equal(d.reviewed, 3);
      assert.equal(d.failed, 3);
      assert.equal(countOpenCultivationReviews(ctx.db), 3, "all three stay queued for bounded retry");
    } finally {
      ctx.cleanup();
    }
  });

  it("guarded settle touches only rows still leased under the caller's batch", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "settle guard probe note", "pr14-sg-1");
      void id;
      const held = acquireCultivationLease(ctx.db, ctx.config, { owner: "pr14-owner-1", scope: SCOPE, now: DRAIN_NOW });
      assert.equal(held.acquired, true);
      const batch = dequeueCultivationBatch(ctx.db, ctx.config, { owner: "pr14-owner-1", scope: SCOPE, limit: 5, now: DRAIN_NOW });
      assert.equal(batch.items.length, 1);
      const qid = batch.items[0]!.queueId;
      const row = ctx.db.prepare(`SELECT batchId FROM cultivation_queue WHERE queueId=?`).get(qid) as { batchId: string | null };
      assert.ok(row.batchId, "dequeue must lease under a batch");
      assert.equal(completeCultivationReview(ctx.db, ctx.config, qid, "failed", T2, { batchId: "some-other-batch" }), false);
      const still = ctx.db.prepare(`SELECT status, batchId FROM cultivation_queue WHERE queueId=?`).get(qid) as { status: string; batchId: string | null };
      assert.equal(still.status, "leased");
      assert.equal(still.batchId, row.batchId);
      assert.equal(completeCultivationReview(ctx.db, ctx.config, qid, "done", T2, { batchId: row.batchId as string }), true);
      const done = ctx.db.prepare(`SELECT status FROM cultivation_queue WHERE queueId=?`).get(qid) as { status: string };
      assert.equal(done.status, "done");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("pr14: search always merges canonical candidates", () => {
  it("exact canonical match survives when a derived-index hit exists but its index rows were lost", () => {
    const ctx = setup();
    try {
      const idDecoy = remember(ctx.db, ctx.config, "lighthouse keeper logs mention the northern beacon schedule", "pr14-sc-decoy");
      void idDecoy;
      const body = "quarry ledger records seven sandstone shipments";
      const idExact = remember(ctx.db, ctx.config, body, "pr14-sc-exact");
      // Simulate a best-effort index failure: the exact record's derived
      // rows never landed, while the decoy's did (nonempty derived ranks).
      ctx.db.prepare(`DELETE FROM fts_notes WHERE recordId=?`).run(idExact);
      ctx.db.prepare(`DELETE FROM char_bigrams WHERE kind='note' AND id=?`).run(idExact);
      const res = searchRecords(ctx.db, ctx.config, { query: body, scope: SCOPE, limit: 10 });
      assert.equal(res.ok, true, JSON.stringify(res));
      const ids = ((res.data as { items: Array<{ id: string }> }).items ?? []).map((r) => r.id);
      assert.ok(ids.includes(idExact), `canonical exact match missing from ${JSON.stringify(ids)}`);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("pr14: maintain.distill keeps its maintenance budget through CLI finalization", () => {
  it("CONFLICT inside maintenance window is not rewritten to TIMEOUT by a tiny cliMs", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pr14-cli-"));
    try {
      const config: AppConfig = {
        dbPath: path.join(dir, "t.db"),
        vaultPath: path.join(dir, "vault"),
        allowedScopes: [SCOPE],
        limits: {
          bodyMaxCp: 2000, queryMaxCp: 500, tagsMax: 5, linksMax: 10,
          sourceRefsMax: 10, limitDefault: 10, limitMax: 25,
          snippetMaxCp: 200, responseMaxBytes: 8192,
        },
        timeouts: { cliMs: 200, busyMs: 2000 },
        dbMaxBytes: 104857600,
      };
      const configPath = path.join(dir, "memory.config.json");
      fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
      const { db } = initDb(config, configPath);
      const held = acquireCultivationLease(db, config, { owner: "pr14-cli-holder", scope: SCOPE, now: new Date().toISOString() });
      assert.equal(held.acquired, true);
      db.close();
      const cli = path.resolve(__dirname, "..", "src", "cli.js");
      const line = JSON.stringify({ v: 1, op: "maintain.distill", params: { scope: SCOPE, limit: 5 }, idempotencyKey: "pr14-cli-budget-1" });
      const r = spawnSync(process.execPath, [cli, "--config", configPath], { input: line + "\n", encoding: "utf8", timeout: 60000 });
      assert.equal(r.status, 0, "stderr=" + (r.stderr?.toString() ?? "").slice(0, 300));
      const body = JSON.parse(r.stdout.toString().split("\n").filter((l) => l.trim().length > 0)[0] ?? "{}") as Record<string, unknown>;
      assert.equal(body["code"], "CONFLICT", `maintenance-budget failure rewritten: ${JSON.stringify(body).slice(0, 200)}`);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
