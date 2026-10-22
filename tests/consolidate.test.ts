/**
 * P3 maintain.consolidate: one grounded summary per topic cluster.
 *
 * Uses a deterministic injected generator (no model, no network) and an
 * in-memory temp SQLite DB. Prompt content is only inspected to choose the
 * fake answer; answers carry in-range citation markers like the real prompt
 * asks for.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { eventAppend, getRecord, rememberRecord } from "../src/store.js";
import { acquireCultivationLease, releaseCultivationLease } from "../src/cultivation.js";
import { topicSet } from "../src/associate.js";
import {
  CLUSTER_SUMMARY_SOURCE,
  CONSOLIDATE_OP,
  maintainConsolidate,
  parseConsolidateParams,
  type ConsolidateGenerate,
} from "../src/consolidate.js";
import type { ResponseEnvelope } from "../src/protocol.js";

const SCOPE = "personal/default";
const TOPIC = "orchard";
const T0 = "2026-09-01T00:00:00.000Z";
const RUN1 = "2026-09-02T00:00:00.000Z";
const RUN2 = "2026-09-02T01:00:00.000Z";

interface Ctx {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consolidate-"));
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
    consolidate: { minMembers: 3, batchMax: 5 },
  };
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

let ctr = 0;

/** Remember one member with a raw sourceRef, then give it the cluster topic. */
function member(
  ctx: Ctx,
  key: string,
  body: string,
  createdAt: string = T0,
): { id: string; eventId: string } {
  const eventId = `ev-${key}`;
  const er = eventAppend(
    ctx.db,
    ctx.config,
    {
      eventId,
      sessionId: "s1",
      turnId: `t-${key}`,
      body: `raw ${key}`,
      provenance: { source: "session:s1:turn:1", observedAt: createdAt },
      scope: SCOPE,
    },
    `evk-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(er.ok, true, JSON.stringify(er));
  const rr = rememberRecord(
    ctx.db,
    ctx.config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: createdAt },
      scope: SCOPE,
      sourceRefs: [eventId],
      privacy: { sensitivity: "normal", origin: "conversation" },
    },
    `rem-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(rr.ok, true, JSON.stringify(rr));
  const id = (rr.data as { record: { id: string } }).record.id;
  const row = ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(id) as {
    bodyHash: string;
  };
  const tr = topicSet(
    ctx.db,
    ctx.config,
    { scope: SCOPE, id, bodyHash: row.bodyHash, topics: [TOPIC] },
    `ts-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(tr.ok, true, JSON.stringify(tr));
  return { id, eventId };
}

function citationsFor(prompt: string): string {
  const nums = new Set<number>();
  for (const m of prompt.matchAll(/^\[(\d+)\]\s+"""/gm)) nums.add(Number(m[1]));
  if (nums.size === 0) nums.add(1);
  return [...nums].sort((a, b) => a - b).map((n) => `[${n}]`).join("");
}

function makeGen(
  opts: {
    reduce?: (prompt: string) => string | null;
    claim?: "YES" | "NO" | null;
    onCall?: () => void;
  } = {},
): ConsolidateGenerate {
  return async (prompt: string): Promise<string | null> => {
    opts.onCall?.();
    if (/You verify a claim|主張を検証/.test(prompt)) {
      if (opts.claim === null) return null;
      return opts.claim ?? "YES";
    }
    if (opts.reduce !== undefined) return opts.reduce(prompt);
    return `Orchard work continued ${citationsFor(prompt)}`;
  };
}

async function run(
  ctx: Ctx,
  key: string,
  gen: ConsolidateGenerate | undefined,
  now: string = RUN1,
  params: Record<string, unknown> = { scope: SCOPE },
): Promise<ResponseEnvelope> {
  return maintainConsolidate(ctx.db, ctx.config, ctx.configPath, params, key, gen, now);
}

interface ClusterData {
  topic: string;
  members: number;
  sentencesKept: number;
  sentencesDropped: number;
  recordId: string | null;
  outcome: string;
}
interface ConsolidateData {
  clusters: ClusterData[];
  applied: number;
  degraded: boolean;
}

function data(res: ResponseEnvelope): ConsolidateData {
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.data as unknown as ConsolidateData;
}

interface Rec {
  id: string;
  body: string;
  kind: string;
  status: string;
  tags: string[];
  links: string[];
  sourceRefs: string[];
  privacy: { sensitivity: string; origin: string } | null;
}

function rec(ctx: Ctx, id: string): Rec {
  const r = getRecord(ctx.db, ctx.config, { id, scope: SCOPE });
  assert.equal(r.ok, true, JSON.stringify(r));
  return (r.data as { record: Rec }).record;
}

function ledger(ctx: Ctx): Array<{
  topic: string;
  recordId: string;
  memberFingerprint: string;
}> {
  return ctx.db
    .prepare(`SELECT topic, recordId, memberFingerprint FROM cluster_summaries ORDER BY topic`)
    .all() as unknown as Array<{
    topic: string;
    recordId: string;
    memberFingerprint: string;
  }>;
}

function counts(ctx: Ctx): { records: number; summaries: number; ledger: number } {
  const one = (sql: string): number =>
    (ctx.db.prepare(sql).get() as unknown as { n: number }).n;
  return {
    records: one(`SELECT COUNT(*) AS n FROM records`),
    summaries: one(
      `SELECT COUNT(*) AS n FROM records WHERE source = '${CLUSTER_SUMMARY_SOURCE}'`,
    ),
    ledger: one(`SELECT COUNT(*) AS n FROM cluster_summaries`),
  };
}

function addThreeMembers(ctx: Ctx): Array<{ id: string; eventId: string }> {
  return [
    member(ctx, "a1", "Alice tended the orchard."),
    member(ctx, "a2", "Bob pruned the orchard trees."),
    member(ctx, "a3", "Carol harvested the orchard apples."),
  ];
}

describe("maintain.consolidate topic clusters", () => {
  it("writes one cited summary with links and sourceRefs", async () => {
    const ctx = setup();
    try {
      const members = addThreeMembers(ctx);
      const res = await run(ctx, "c-1", makeGen());
      const d = data(res);
      assert.equal(d.applied, 1);
      assert.equal(d.degraded, false);
      assert.equal(d.clusters.length, 1);
      const c = d.clusters[0]!;
      assert.equal(c.topic, TOPIC);
      assert.equal(c.members, 3);
      assert.equal(c.outcome, "written");
      assert.equal(c.sentencesKept, 1);
      assert.equal(typeof c.recordId, "string");

      const summary = rec(ctx, c.recordId as string);
      assert.equal(summary.kind, "summary");
      assert.equal(summary.status, "active");
      assert.equal(summary.body, "Orchard work continued");
      assert.deepEqual(summary.tags, [TOPIC]);
      assert.deepEqual(summary.links, members.map((m) => m.id).sort());
      assert.deepEqual(summary.sourceRefs, members.map((m) => m.eventId).sort());
      assert.deepEqual(summary.privacy, {
        sensitivity: "normal",
        origin: "self_activity",
      });

      const rows = ledger(ctx);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.topic, TOPIC);
      assert.equal(rows[0]!.recordId, c.recordId);
      assert.ok(rows[0]!.memberFingerprint.length > 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("drops an ungrounded sentence even when the model says YES", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const res = await run(
        ctx,
        "c-2",
        makeGen({
          reduce: (prompt) => `Elena tended the orchard. ${citationsFor(prompt)}`,
          claim: "YES",
        }),
      );
      const d = data(res);
      assert.equal(d.applied, 0);
      assert.equal(d.clusters[0]!.outcome, "no_grounded_sentences");
      assert.equal(d.clusters[0]!.recordId, null);
      assert.ok(d.clusters[0]!.sentencesDropped >= 1);
      const state = counts(ctx);
      assert.equal(state.records, 3);
      assert.equal(state.summaries, 0);
      assert.equal(state.ledger, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("skips an unchanged member fingerprint without model calls", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = await run(ctx, "c-3a", makeGen());
      assert.equal(data(first).applied, 1);

      let calls = 0;
      const second = await run(
        ctx,
        "c-3b",
        makeGen({ onCall: () => calls++ }),
        RUN2,
      );
      const d = data(second);
      assert.equal(calls, 0);
      assert.equal(d.clusters.length, 1);
      assert.equal(d.clusters[0]!.outcome, "unchanged");
      assert.equal(d.applied, 0);
      assert.equal(counts(ctx).records, 4);
    } finally {
      ctx.cleanup();
    }
  });

  it("supersedes the previous summary when a member is added", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = await run(ctx, "c-4a", makeGen());
      const firstId = data(first).clusters[0]!.recordId as string;

      member(ctx, "a4", "Dana joined the orchard.");
      const second = await run(
        ctx,
        "c-4b",
        makeGen({
          reduce: (prompt) =>
            /Dana/.test(prompt)
              ? `Dana joined the orchard work ${citationsFor(prompt)}`
              : `Orchard work continued ${citationsFor(prompt)}`,
        }),
        RUN2,
      );
      const d = data(second);
      assert.equal(d.applied, 1);
      assert.equal(d.clusters[0]!.members, 4);
      assert.equal(d.clusters[0]!.outcome, "written");
      assert.notEqual(d.clusters[0]!.recordId, firstId);

      assert.equal(rec(ctx, firstId).status, "superseded");
      const now = rec(ctx, d.clusters[0]!.recordId as string);
      assert.equal(now.status, "active");
      assert.equal(now.body, "Dana joined the orchard work");

      const rows = ledger(ctx);
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.recordId, now.id);
      assert.equal(
        (
          ctx.db
            .prepare(`SELECT COUNT(*) AS n FROM records WHERE source = ? AND status = 'active'`)
            .get(CLUSTER_SUMMARY_SOURCE) as { n: number }
        ).n,
        1,
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("defers the cluster on a transient model failure", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const res = await run(
        ctx,
        "c-5",
        makeGen({ reduce: () => null }),
      );
      const d = data(res);
      assert.equal(d.applied, 0);
      assert.equal(d.clusters[0]!.outcome, "deferred");
      assert.equal(d.clusters[0]!.recordId, null);
      const state = counts(ctx);
      assert.equal(state.records, 3);
      assert.equal(state.summaries, 0);
      assert.equal(state.ledger, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("does not count its own summaries as cluster members", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = await run(ctx, "c-6a", makeGen());
      const summaryId = data(first).clusters[0]!.recordId as string;

      // Simulate maintain.associate deriving the tag topic onto the summary.
      const bodyHash = (
        ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(summaryId) as {
          bodyHash: string;
        }
      ).bodyHash;
      ctx.db
        .prepare(
          `INSERT OR REPLACE INTO record_topics(recordId, topic, bodyHash, origin)
           VALUES (?, ?, ?, 'tag')`,
        )
        .run(summaryId, TOPIC, bodyHash);

      member(ctx, "a5", "Erin watered the orchard.");
      const second = await run(
        ctx,
        "c-6b",
        makeGen({
          reduce: (prompt) =>
            `Orchard work expanded ${citationsFor(prompt)}`,
        }),
        RUN2,
      );
      const d = data(second);
      assert.equal(d.clusters[0]!.members, 4);
    } finally {
      ctx.cleanup();
    }
  });

  it("returns CONFLICT while a foreign cultivation lease is live", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const lease = acquireCultivationLease(ctx.db, ctx.config, {
        owner: "foreign-owner",
        scope: SCOPE,
        now: RUN1,
      });
      assert.equal(lease.acquired, true);
      try {
        const res = await run(ctx, "c-7", makeGen());
        assert.equal(res.ok, false);
        assert.equal(res.code, "CONFLICT");
      } finally {
        releaseCultivationLease(ctx.db, "foreign-owner");
      }
      const state = counts(ctx);
      assert.equal(state.records, 3);
      assert.equal(state.summaries, 0);
      assert.equal(state.ledger, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("replays the stored envelope for the same key and params", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = await run(ctx, "c-8", makeGen());
      assert.equal(data(first).applied, 1);
      const before = counts(ctx);

      let calls = 0;
      const second = await run(
        ctx,
        "c-8",
        makeGen({ onCall: () => calls++ }),
        RUN2,
      );
      assert.equal(second.deduplicated, true);
      assert.deepEqual(second.data, first.data);
      assert.equal(calls, 0);
      assert.deepEqual(counts(ctx), before);
    } finally {
      ctx.cleanup();
    }
  });

  it("validates params and the consolidate config bounds", () => {
    const ctx = setup();
    try {
      const bad = parseConsolidateParams(ctx.config, { scope: SCOPE, limit: 99 });
      assert.equal(bad.ok, false);
      if (!bad.ok) assert.equal(bad.res.code, "LIMIT_EXCEEDED");
      const unknown = parseConsolidateParams(ctx.config, { scope: SCOPE, extra: 1 });
      assert.equal(unknown.ok, false);
      const negative = parseConsolidateParams(ctx.config, { scope: SCOPE, limit: 0 });
      assert.equal(negative.ok, false);
      const good = parseConsolidateParams(ctx.config, { scope: SCOPE });
      assert.equal(good.ok, true);
      if (good.ok) assert.equal(good.value.limit, 5);
      assert.equal(CONSOLIDATE_OP, "maintain.consolidate");

      const base = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "memory.config.example.json"), "utf8"),
      ) as Record<string, unknown>;
      const write = (name: string, consolidate: unknown): string => {
        const file = path.join(ctx.dir, name);
        fs.writeFileSync(file, JSON.stringify({ ...base, consolidate }));
        return file;
      };
      const loaded = loadConfig(
        write("ok.json", { minMembers: 4, batchMax: 2 }),
      );
      assert.deepEqual(loaded.consolidate, { minMembers: 4, batchMax: 2 });
      assert.throws(() => loadConfig(write("low.json", { minMembers: 1 })), /minMembers/);
      assert.throws(
        () => loadConfig(write("unknown.json", { minMembers: 3, extra: 1 })),
        /unknown consolidate field/,
      );
      assert.throws(() => loadConfig(write("high.json", { batchMax: 99 })), /batchMax/);
    } finally {
      ctx.cleanup();
    }
  });
});
