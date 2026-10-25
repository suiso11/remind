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
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig, type LlmConfig } from "../src/config.js";
import { initDb, SCHEMA_VERSION } from "../src/db.js";
import {
  LEGACY_SCHEMA_VERSION_6,
  LEGACY_SCHEMA_VERSION_7,
  LEGACY_SCHEMA_VERSION_8,
  correctRecord,
  eventAppend,
  getRecord,
  rememberRecord,
  retireRecord,
} from "../src/store.js";
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
import { countCp, normalizeBody } from "../src/normalize.js";

const SCOPE = "personal/default";
const TOPIC = "orchard";
const T0 = "2026-09-01T00:00:00.000Z";
const RUN1 = "2026-09-02T00:00:00.000Z";
const RUN2 = "2026-09-02T01:00:00.000Z";
const RUN3 = "2026-09-02T02:00:00.000Z";
const RUN4 = "2026-09-02T03:00:00.000Z";

interface Ctx {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
}

function setup(opts: { bodyMaxCp?: number; llm?: LlmConfig } = {}): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "consolidate-"));
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE],
    limits: {
      bodyMaxCp: opts.bodyMaxCp ?? 2000,
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
    ...(opts.llm === undefined ? {} : { llm: opts.llm }),
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
  topic: string = TOPIC,
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
    { scope: SCOPE, id, bodyHash: row.bodyHash, topics: [topic] },
    `ts-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(tr.ok, true, JSON.stringify(tr));
  return { id, eventId };
}

/** Member with legacy/unknown privacy (rememberRecord without the param). */
function memberUnknown(
  ctx: Ctx,
  key: string,
  body: string,
  createdAt: string = T0,
  topic: string = TOPIC,
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
    { scope: SCOPE, id, bodyHash: row.bodyHash, topics: [topic] },
    `ts-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(tr.ok, true, JSON.stringify(tr));
  return { id, eventId };
}

function openAiLlm(baseUrl: string): LlmConfig {
  return {
    backend: "openai",
    modelDir: path.join("/nonexistent", "onnx-model"),
    baseUrl,
    model: "ornith-test",
    enabled: true,
    timeoutMs: 5000,
    maxNewTokens: 48,
    maxPromptChars: 2000,
  };
}

/** Loopback OpenAI-compatible server (pattern from tests/llm-openai.test.ts). */
async function withLlmServer<T>(
  script: (prompt: string) => string,
  fn: (baseUrl: string, prompts: string[]) => Promise<T>,
): Promise<T> {
  const prompts: string[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as { messages?: Array<{ content: string }> };
      const prompt = (body.messages ?? []).map((m) => m.content).join("\n");
      prompts.push(prompt);
      res.statusCode = 200;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ choices: [{ message: { content: script(prompt) } }] }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, prompts);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
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
  source: string;
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

  it("follows a user-corrected summary revision instead of creating a duplicate", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = await run(ctx, "c-9a", makeGen());
      const firstId = data(first).clusters[0]!.recordId as string;

      // The user corrects the generated summary through record.correct; the
      // cluster ledger still points at the now-superseded revision.
      const fixed = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: firstId,
          body: "Alice and Bob still tend the orchard.",
          kind: "correction",
          provenance: { source: CLUSTER_SUMMARY_SOURCE, observedAt: RUN1 },
          scope: SCOPE,
        },
        "c-9-user-fix",
        RUN1,
      );
      assert.equal(fixed.ok, true, JSON.stringify(fixed));
      const correctedId = (fixed.data as { record: { id: string } }).record.id;
      assert.equal(rec(ctx, correctedId).status, "active");
      assert.equal(rec(ctx, firstId).status, "superseded");
      assert.equal(ledger(ctx)[0]!.recordId, firstId);

      member(ctx, "a4", "Dana joined the orchard.");
      const second = await run(ctx, "c-9b", makeGen(), RUN2);
      const d = data(second);
      assert.equal(d.applied, 1);
      assert.equal(d.clusters[0]!.outcome, "written");
      const newId = d.clusters[0]!.recordId as string;

      // The corrected revision is superseded, not left active next to a new
      // summary: exactly one active cluster summary remains.
      assert.equal(rec(ctx, correctedId).status, "superseded");
      assert.equal(rec(ctx, newId).status, "active");
      assert.equal(
        (
          ctx.db
            .prepare(`SELECT COUNT(*) AS n FROM records WHERE source = ? AND status = 'active'`)
            .get(CLUSTER_SUMMARY_SOURCE) as { n: number }
        ).n,
        1,
      );
      assert.equal(ledger(ctx)[0]!.recordId, newId);
    } finally {
      ctx.cleanup();
    }
  });

  it("reports the active corrected revision for an unchanged cluster", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = await run(ctx, "c-10a", makeGen());
      const firstId = data(first).clusters[0]!.recordId as string;

      // User correction keeps the member set identical but supersedes the
      // ledger's record; the ledger still points at the old revision.
      const fixed = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: firstId,
          body: "Alice, Bob, and Carol still tend the orchard.",
          kind: "correction",
          provenance: { source: "user:annotation", observedAt: RUN1 },
          scope: SCOPE,
        },
        "c-10-user-fix",
        RUN1,
      );
      assert.equal(fixed.ok, true, JSON.stringify(fixed));
      const correctedId = (fixed.data as { record: { id: string } }).record.id;
      assert.equal(ledger(ctx)[0]!.recordId, firstId);

      let calls = 0;
      const second = await run(
        ctx,
        "c-10b",
        makeGen({ onCall: () => calls++ }),
        RUN2,
      );
      const d = data(second);
      assert.equal(calls, 0);
      assert.equal(d.clusters[0]!.outcome, "unchanged");
      // The unchanged path must resolve through the supersedes chain exactly
      // like the replacement path: never return the obsolete revision id.
      assert.equal(d.clusters[0]!.recordId, correctedId);
      assert.notEqual(d.clusters[0]!.recordId, firstId);
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps a user-corrected summary revision out of its own cluster", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = await run(ctx, "c-11a", makeGen());
      const firstId = data(first).clusters[0]!.recordId as string;

      // The user rewrites the summary with their own provenance (so the
      // generated source is gone) and restores its topic.
      const fixed = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: firstId,
          body: "Alice, Bob, and Carol still tend the orchard.",
          kind: "correction",
          provenance: { source: "user:annotation", observedAt: RUN1 },
          scope: SCOPE,
        },
        "c-11-user-fix",
        RUN1,
      );
      assert.equal(fixed.ok, true, JSON.stringify(fixed));
      const correctedId = (fixed.data as { record: { id: string } }).record.id;
      const row = ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(correctedId) as {
        bodyHash: string;
      };
      const tr = topicSet(
        ctx.db,
        ctx.config,
        { scope: SCOPE, id: correctedId, bodyHash: row.bodyHash, topics: [TOPIC] },
        "c-11-topic",
        RUN1,
      );
      assert.equal(tr.ok, true, JSON.stringify(tr));

      let calls = 0;
      const second = await run(
        ctx,
        "c-11b",
        makeGen({ onCall: () => calls++ }),
        RUN2,
      );
      const d = data(second);
      // Membership is still the three original records; the corrected
      // revision belongs to the cluster's supersedes chain, not its inputs.
      assert.equal(d.clusters[0]!.members, 3);
      assert.equal(d.clusters[0]!.outcome, "unchanged");
      assert.equal(d.clusters[0]!.recordId, correctedId);
      assert.equal(calls, 0);
      assert.equal(ledger(ctx)[0]!.recordId, firstId);
    } finally {
      ctx.cleanup();
    }
  });

  it("rotates past a permanently ungrounded topic under a small limit", async () => {
    const ctx = setup();
    try {
      for (const [i, body] of [
        "Alice sorted the apples.",
        "Bob stored the apples.",
        "Carol washed the apples.",
      ].entries()) {
        member(ctx, `p${i}`, body, T0, "apple");
      }
      for (const [i, body] of [
        "Nina tended the zeta orchard.",
        "Omar pruned the zeta orchard.",
        "Pia watered the zeta orchard.",
      ].entries()) {
        member(ctx, `z${i}`, body, T0, "zeta");
      }
      const gen = makeGen({
        reduce: (prompt) =>
          /apples/.test(prompt)
            ? `Zelda tended the apple orchard ${citationsFor(prompt)}`
            : `Zeta orchard work continued ${citationsFor(prompt)}`,
      });

      const first = await run(ctx, "c-10a", gen, RUN1, { scope: SCOPE, limit: 1 });
      const d1 = data(first);
      assert.equal(d1.applied, 0);
      assert.equal(d1.clusters.length, 1);
      assert.equal(d1.clusters[0]!.topic, "apple");
      assert.equal(d1.clusters[0]!.outcome, "no_grounded_sentences");
      assert.equal(counts(ctx).summaries, 0);

      // Same bounded limit, fresh key: the cursor must move past the rejected
      // topic instead of burning the budget on it again.
      const second = await run(ctx, "c-10b", gen, RUN2, { scope: SCOPE, limit: 1 });
      const d2 = data(second);
      assert.equal(d2.applied, 1);
      assert.equal(d2.clusters.length, 1);
      assert.equal(d2.clusters[0]!.topic, "zeta");
      assert.equal(d2.clusters[0]!.outcome, "written");
      assert.equal(ledger(ctx)[0]!.topic, "zeta");
    } finally {
      ctx.cleanup();
    }
  });

  it("defers when cluster membership changes during inference", async () => {
    const ctx = setup();
    try {
      const members = addThreeMembers(ctx);
      let retired = false;
      const gen = makeGen({
        reduce: (prompt) => {
          if (!retired) {
            retired = true;
            // Ordinary record writes do not take the cultivation lease, so a
            // concurrent retirement is possible while inference is running.
            const r = retireRecord(
              ctx.db,
              ctx.config,
              { id: members[0]!.id, scope: SCOPE, reasonCode: "OUTDATED" },
              "c-11-retire",
              RUN1,
            );
            assert.equal(r.ok, true, JSON.stringify(r));
          }
          return `Orchard work continued ${citationsFor(prompt)}`;
        },
      });
      const res = await run(ctx, "c-11", gen, RUN1);
      const d = data(res);
      assert.equal(d.applied, 0);
      assert.equal(d.clusters[0]!.outcome, "deferred");
      assert.equal(d.clusters[0]!.recordId, null);
      const state = counts(ctx);
      assert.equal(state.summaries, 0);
      assert.equal(state.ledger, 0);
      assert.equal(rec(ctx, members[0]!.id).status, "retired");
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

  it("heartbeats the lease through verification longer than leaseTtlMs", async () => {
    const ctx = setup();
    try {
      ctx.config.cultivation = { leaseTtlMs: 1000 } as unknown as NonNullable<
        AppConfig["cultivation"]
      >;
      addThreeMembers(ctx);
      const base = makeGen();
      const gen: ConsolidateGenerate = async (prompt, tokens, signal) => {
        // The claim check is the last inference before the fenced write:
        // without a heartbeat the 1s lease is expired when it returns.
        if (/You verify a claim|主張を検証/.test(prompt)) {
          await new Promise((r) => setTimeout(r, 1600));
        }
        return base(prompt, tokens, signal);
      };
      // No nowOverride: renewal uses the wall clock, so the lease expires
      // during the slow call unless it is heartbeaten.
      const res = await maintainConsolidate(
        ctx.db,
        ctx.config,
        ctx.configPath,
        { scope: SCOPE },
        "c-heartbeat",
        gen,
      );
      const d = data(res);
      assert.equal(d.applied, 1);
      assert.equal(d.clusters[0]!.outcome, "written");
      const state = counts(ctx);
      assert.equal(state.summaries, 1);
      assert.equal(state.ledger, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("aborts and writes nothing when the lease is stolen mid-inference", async () => {
    const ctx = setup();
    try {
      ctx.config.cultivation = { leaseTtlMs: 1000 } as unknown as NonNullable<
        AppConfig["cultivation"]
      >;
      addThreeMembers(ctx);
      const base = makeGen();
      let signal: AbortSignal | undefined;
      const gen: ConsolidateGenerate = async (prompt, tokens, s) => {
        if (/You verify a claim|主張を検証/.test(prompt)) {
          signal = s;
          // Steal with a clock past the current expiry; the heartbeat's next
          // renewal then fails under a foreign owner and aborts this call.
          const stolen = acquireCultivationLease(ctx.db, ctx.config, {
            owner: "thief",
            scope: SCOPE,
            now: new Date(Date.now() + 60000).toISOString(),
          });
          assert.equal(stolen.acquired, true);
          await new Promise((r) => setTimeout(r, 900));
        }
        return base(prompt, tokens, s);
      };
      const res = await maintainConsolidate(
        ctx.db,
        ctx.config,
        ctx.configPath,
        { scope: SCOPE },
        "c-heartbeat-steal",
        gen,
      );
      assert.equal(res.ok, false);
      assert.equal(res.code, "CONFLICT");
      assert.equal(signal?.aborted, true, "lost lease aborts the in-flight generation");
      const state = counts(ctx);
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

  it("upgrades a v6 database directly to v9 with importance, cluster, and cursor ledgers", () => {
    const ctx = setup();
    try {
      // Simulate a production v6 file: none of the later derived ledgers
      // exists (record_importance arrived in v7, the cluster ledger in v8,
      // and the rotation cursor in v9).
      ctx.db.exec(`DROP TABLE record_importance`);
      ctx.db.exec(`DROP TABLE cluster_summaries`);
      ctx.db.exec(`DROP TABLE consolidate_scope_state`);
      ctx.db.exec(`PRAGMA user_version = ${LEGACY_SCHEMA_VERSION_6}`);
      ctx.db.close();

      const reopened = initDb(ctx.config, ctx.configPath);
      const uv = (reopened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
      assert.equal(uv, SCHEMA_VERSION);
      assert.equal(SCHEMA_VERSION, 11);
      for (const table of ["record_importance", "cluster_summaries", "consolidate_scope_state"]) {
        const row = reopened.db
          .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name = ?`)
          .get(table) as { found: number } | undefined;
        assert.ok(row, `${table} created by the v6->v9 migration`);
      }
      reopened.db.close();
    } finally {
      ctx.cleanup();
    }
  });

  it("upgrades a v7 database with stored importance to v9, keeping the row and adding cluster_summaries", () => {
    const ctx = setup();
    try {
      // PR32 lineage: v7 already has record_importance and its data.
      const stored = member(ctx, "schema7", "schema seven importance");
      const row = ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(stored.id) as {
        bodyHash: string;
      };
      ctx.db
        .prepare(
          `INSERT INTO record_importance(recordId, importance, bodyHash, source, scoredAt) VALUES (?, ?, ?, 'llm', ?)`,
        )
        .run(stored.id, 0.75, row.bodyHash, T0);
      // A PR32 v7 file has record_importance but neither consolidation
      // ledger (and it never had the v9 rotation cursor).
      ctx.db.exec(`DROP TABLE cluster_summaries`);
      ctx.db.exec(`DROP TABLE consolidate_scope_state`);
      ctx.db.exec(`PRAGMA user_version = ${LEGACY_SCHEMA_VERSION_7}`);
      ctx.db.close();

      const reopened = initDb(ctx.config, ctx.configPath);
      const uv = (reopened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
      assert.equal(uv, SCHEMA_VERSION);
      // record_importance is defined once by the unified chain; the v7 rows
      // survive and the table has a single canonical definition.
      const defs = reopened.db
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = 'record_importance'`)
        .get() as { n: number };
      assert.equal(defs.n, 1);
      const kept = reopened.db
        .prepare(`SELECT recordId, importance, source FROM record_importance WHERE recordId = ?`)
        .get(stored.id) as { recordId: string; importance: number; source: string } | undefined;
      assert.equal(kept?.recordId, stored.id);
      assert.equal(kept?.importance, 0.75);
      assert.equal(kept?.source, "llm");
      assert.ok(
        reopened.db
          .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name = 'cluster_summaries'`)
          .get(),
      );
      assert.ok(
        reopened.db
          .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name = 'consolidate_scope_state'`)
          .get(),
      );
      // Re-running the migration sequence is idempotent (every CREATE is IF
      // NOT EXISTS) and the second open takes the no-DDL fast path.
      const schemaBefore = (reopened.db.prepare(`PRAGMA schema_version`).get() as { schema_version: number }).schema_version;
      reopened.db.close();
      const again = initDb(ctx.config, ctx.configPath);
      const schemaAfter = (again.db.prepare(`PRAGMA schema_version`).get() as { schema_version: number }).schema_version;
      assert.equal(schemaAfter, schemaBefore);
      const keptAgain = again.db
        .prepare(`SELECT importance FROM record_importance WHERE recordId = ?`)
        .get(stored.id) as { importance: number } | undefined;
      assert.equal(keptAgain?.importance, 0.75);
      again.db.close();
    } finally {
      ctx.cleanup();
    }
  });

  it("upgrades a v8 database by adding the consolidate rotation cursor", () => {
    const ctx = setup();
    try {
      // A PR33 v8 file has cluster_summaries but no rotation cursor yet.
      ctx.db.exec(`DROP TABLE consolidate_scope_state`);
      ctx.db.exec(`PRAGMA user_version = ${LEGACY_SCHEMA_VERSION_8}`);
      ctx.db.close();

      const reopened = initDb(ctx.config, ctx.configPath);
      const uv = (reopened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
      assert.equal(uv, SCHEMA_VERSION);
      assert.ok(
        reopened.db
          .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name = 'consolidate_scope_state'`)
          .get(),
      );
      reopened.db.close();
    } finally {
      ctx.cleanup();
    }
  });

  it("a second open of the current schema takes the no-migration fast path", () => {
    const ctx = setup();
    try {
      const before = (ctx.db.prepare(`PRAGMA schema_version`).get() as { schema_version: number }).schema_version;
      ctx.db.close();
      const reopened = initDb(ctx.config, ctx.configPath);
      const after = (reopened.db.prepare(`PRAGMA schema_version`).get() as { schema_version: number }).schema_version;
      assert.equal(after, before, "already-current open must not run DDL");
      for (const table of ["record_importance", "cluster_summaries", "consolidate_scope_state"]) {
        assert.ok(
          reopened.db
            .prepare(`SELECT 1 AS found FROM sqlite_master WHERE type='table' AND name = ?`)
            .get(table),
        );
      }
      reopened.db.close();
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

describe("maintain.consolidate review regressions", () => {
  it("uses the configured openai backend without local ONNX files", async () => {
    await withLlmServer(
      (prompt) => {
        if (/You verify a claim/.test(prompt)) return "YES";
        return `Orchard work continued ${citationsFor(prompt)}`;
      },
      async (baseUrl, prompts) => {
        const ctx = setup({ llm: openAiLlm(baseUrl) });
        try {
          addThreeMembers(ctx);
          const d = data(await run(ctx, "c-openai", undefined));
          assert.equal(d.degraded, false);
          assert.equal(d.applied, 1);
          assert.ok(prompts.length >= 2, "consolidation must call the loopback backend");
          assert.equal(d.clusters[0]!.outcome, "written");
        } finally {
          ctx.cleanup();
        }
      },
    );
  });

  it("stores unknown privacy when replacing a summary with an unknown-privacy member", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = data(await run(ctx, "c-priv-1", makeGen(), RUN1));
      const prior = first.clusters[0]!.recordId as string;
      assert.deepEqual(rec(ctx, prior).privacy, {
        sensitivity: "normal",
        origin: "self_activity",
      });

      memberUnknown(ctx, "a4", "Dora inspected the orchard.");
      const second = data(await run(ctx, "c-priv-2", makeGen(), RUN2));
      assert.equal(second.applied, 1);
      const replaced = second.clusters[0]!.recordId as string;
      assert.notEqual(replaced, prior);
      assert.equal(rec(ctx, prior).status, "superseded");
      assert.equal(rec(ctx, replaced).privacy, null);
    } finally {
      ctx.cleanup();
    }
  });

  it("preserves the cluster topic tag on a replacement summary", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = data(await run(ctx, "c-tag-1", makeGen(), RUN1));
      const firstId = first.clusters[0]!.recordId as string;
      assert.deepEqual(rec(ctx, firstId).tags, [TOPIC]);

      member(ctx, "a-tag-4", "Dana joined the orchard.");
      const second = data(await run(ctx, "c-tag-2", makeGen(), RUN2));
      assert.equal(second.applied, 1);
      const newId = second.clusters[0]!.recordId as string;
      assert.notEqual(newId, firstId);
      assert.equal(rec(ctx, firstId).status, "superseded");
      const replacement = rec(ctx, newId);
      assert.equal(replacement.status, "active");
      // Same metadata as the create path: the bounded topic tag is the
      // recall/search seed and must not be dropped by the replacement.
      assert.deepEqual(replacement.tags, [TOPIC]);
      assert.equal(ledger(ctx)[0]!.recordId, newId);
    } finally {
      ctx.cleanup();
    }
  });

  it("never replays a retired historical summary when membership returns", async () => {
    const ctx = setup();
    try {
      addThreeMembers(ctx);
      const first = data(await run(ctx, "c-gen-1", makeGen(), RUN1));
      const firstId = first.clusters[0]!.recordId as string;

      const fourth = member(ctx, "a-gen-4", "Dana joined the orchard.");
      const second = data(await run(ctx, "c-gen-2", makeGen(), RUN2));
      const secondId = second.clusters[0]!.recordId as string;
      assert.notEqual(secondId, firstId);

      // Retire the replacement and the fourth member: membership and model
      // output return to the exact state of the first consolidation, so the
      // internal generation key collides with the historical operation.
      const rs = retireRecord(
        ctx.db,
        ctx.config,
        { id: secondId, scope: SCOPE, reasonCode: "OUTDATED" },
        "c-gen-retire-summary",
        RUN2,
      );
      assert.equal(rs.ok, true, JSON.stringify(rs));
      const rm = retireRecord(
        ctx.db,
        ctx.config,
        { id: fourth.id, scope: SCOPE, reasonCode: "OUTDATED" },
        "c-gen-retire-member",
        RUN2,
      );
      assert.equal(rm.ok, true, JSON.stringify(rm));

      const third = data(await run(ctx, "c-gen-3", makeGen(), RUN3));
      assert.equal(third.applied, 1);
      assert.equal(third.clusters[0]!.outcome, "written");
      const thirdId = third.clusters[0]!.recordId as string;
      // A fresh active generation, never the now-superseded first summary.
      assert.notEqual(thirdId, firstId);
      assert.equal(rec(ctx, thirdId).status, "active");
      assert.equal(rec(ctx, thirdId).source, CLUSTER_SUMMARY_SOURCE);
      assert.equal(ledger(ctx)[0]!.recordId, thirdId);
      assert.equal(
        (
          ctx.db
            .prepare(
              `SELECT COUNT(*) AS n FROM records WHERE source = ? AND status = 'active'`,
            )
            .get(CLUSTER_SUMMARY_SOURCE) as { n: number }
        ).n,
        1,
      );

      // A genuine retry of the same pass must still be idempotent: the
      // unchanged fingerprint reports the active replacement, never null.
      const fourthRun = data(await run(ctx, "c-gen-4", makeGen(), RUN4));
      assert.equal(fourthRun.applied, 0);
      assert.equal(fourthRun.clusters[0]!.outcome, "unchanged");
      assert.equal(fourthRun.clusters[0]!.recordId, thirdId);
    } finally {
      ctx.cleanup();
    }
  });

  it("drops a verified sentence that exceeds the normalized body budget instead of clipping it", async () => {
    // Raw 90 cp, NFKC 109 cp: fits the raw budget but not the normalized one.
    const claimText =
      "Oﬃce staﬀ aﬀected ﬁles, oﬃce staﬀ aﬀected ﬁles, oﬃce staﬀ aﬀected ﬁles and oﬃce staﬀ ﬁles.";
    assert.ok(countCp(claimText) <= 100);
    assert.ok(countCp(normalizeBody(claimText)) > 100);

    const ctx = setup({ bodyMaxCp: 100 });
    try {
      member(ctx, "b1", "Office staff affected files.");
      member(ctx, "b2", "Office staff affected files.");
      member(ctx, "b3", "Office staff affected files.");
      const d = data(
        await run(
          ctx,
          "c-budget",
          makeGen({ reduce: () => `${claimText} [1]`, claim: "YES" }),
        ),
      );
      assert.equal(d.applied, 0);
      assert.equal(d.clusters[0]!.outcome, "no_grounded_sentences");
      assert.equal(d.clusters[0]!.recordId, null);
      assert.ok(d.clusters[0]!.sentencesDropped >= 1);
      assert.equal(counts(ctx).summaries, 0);
    } finally {
      ctx.cleanup();
    }
  });
});
