/**
 * Recall-time cluster compression: a recalled cluster summary stands in for
 * the members it links, without changing any record state.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { topicSet } from "../src/associate.js";
import { CLUSTER_SUMMARY_SOURCE } from "../src/consolidate.js";
import type { ResponseEnvelope } from "../src/protocol.js";
import {
  eventAppend,
  recallRecords,
  rememberRecord,
  retireRecord,
  upsertClusterSummary,
} from "../src/store.js";

const SCOPE = "personal/default";
const TOPIC = "orchard";
const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T01:00:00.000Z";
const T2 = "2026-09-01T02:00:00.000Z";
const T3 = "2026-09-01T03:00:00.000Z";

interface Ctx {
  dir: string;
  config: AppConfig;
  db: DatabaseSync;
  cleanup: () => void;
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "recall-compression-"));
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
  };
  const { db } = initDb(config, path.join(dir, "memory.config.json"));
  return {
    dir,
    config,
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

function recordIdOf(res: ResponseEnvelope): string {
  const data = res.data;
  if (data === null || typeof data !== "object" || !("record" in data)) {
    throw new Error("missing record envelope");
  }
  const record = data.record;
  if (record === null || typeof record !== "object" || !("id" in record) || typeof record.id !== "string") {
    throw new Error("missing record id");
  }
  return record.id;
}

function bodyHashOf(ctx: Ctx, id: string): string {
  const row = ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(id);
  if (row === null || typeof row !== "object" || !("bodyHash" in row) || typeof row.bodyHash !== "string") {
    throw new Error("missing body hash");
  }
  return row.bodyHash;
}

function member(
  ctx: Ctx,
  key: string,
  body: string,
  createdAt: string = T0,
  tags?: string[],
): string {
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
      ...(tags === undefined ? {} : { tags }),
    },
    `rem-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(rr.ok, true, JSON.stringify(rr));
  const id = recordIdOf(rr);
  const tr = topicSet(
    ctx.db,
    ctx.config,
    { scope: SCOPE, id, bodyHash: bodyHashOf(ctx, id), topics: [TOPIC] },
    `ts-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(tr.ok, true, JSON.stringify(tr));
  return id;
}

function summary(
  ctx: Ctx,
  key: string,
  body: string,
  links: string[],
  createdAt: string = T1,
): string {
  const rr = rememberRecord(
    ctx.db,
    ctx.config,
    {
      body,
      kind: "summary",
      provenance: { source: CLUSTER_SUMMARY_SOURCE, observedAt: createdAt },
      scope: SCOPE,
      links,
    },
    `sum-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(rr.ok, true, JSON.stringify(rr));
  const id = recordIdOf(rr);
  upsertClusterSummary(ctx.db, {
    scope: SCOPE,
    topic: TOPIC,
    recordId: id,
    memberFingerprint: `fp-${key}`,
    createdAt,
  });
  return id;
}

function recall(
  ctx: Ctx,
  params: Record<string, unknown> = {},
): { ids: string[]; recallId: string; foldedCandidates?: number } {
  const res = recallRecords(
    ctx.db,
    ctx.config,
    { scope: SCOPE, query: "apple orchard harvest", limit: 10, ...params },
    T3,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  const data = res.data;
  if (data === null || typeof data !== "object" || !("items" in data) || !Array.isArray(data.items)) {
    throw new Error("missing recall items");
  }
  const ids: string[] = [];
  for (const item of data.items) {
    if (item === null || typeof item !== "object" || !("id" in item) || typeof item.id !== "string") {
      throw new Error("missing recall item id");
    }
    ids.push(item.id);
  }
  if (!("recallId" in data) || typeof data.recallId !== "string") {
    throw new Error("missing recall id");
  }
  const foldedCandidates =
    "foldedCandidates" in data && typeof data.foldedCandidates === "number"
      ? data.foldedCandidates
      : undefined;
  return {
    ids,
    recallId: data.recallId,
    ...(foldedCandidates === undefined ? {} : { foldedCandidates }),
  };
}

function statusOf(ctx: Ctx, id: string): string {
  const row = ctx.db.prepare(`SELECT status FROM records WHERE id = ?`).get(id);
  if (row === null || typeof row !== "object" || !("status" in row) || typeof row.status !== "string") {
    throw new Error("missing status");
  }
  return row.status;
}

function exposedIds(ctx: Ctx, recallId: string): string[] {
  const rows = ctx.db
    .prepare(`SELECT recordId FROM exposures WHERE recallId = ? ORDER BY recordId ASC`)
    .all(recallId) as Array<{ recordId: string }>;
  return rows.map((row) => row.recordId);
}

describe("recall cluster compression", () => {
  it("folds linked members into the recalled summary", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      const b = member(ctx, "b", "apple orchard harvest two");
      const s = summary(ctx, "s", "apple orchard harvest summary", [a, b]);
      const { ids, recallId, foldedCandidates } = recall(ctx);
      assert.deepEqual(ids, [s]);
      assert.equal(foldedCandidates, 2);
      // Non-destructive: sources stay active; only the summary is exposed.
      assert.equal(statusOf(ctx, a), "active");
      assert.equal(statusOf(ctx, b), "active");
      assert.deepEqual(exposedIds(ctx, recallId), [s]);
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps an uncited member literal", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      member(ctx, "b", "banana orchard harvest two");
      summary(ctx, "s", "orchard harvest summary", []);
      const { ids, foldedCandidates } = recall(ctx, { query: "apple" });
      assert.deepEqual(ids, [a]);
      assert.equal(foldedCandidates, undefined);
    } finally {
      ctx.cleanup();
    }
  });

  it("dedupes when the summary itself is a candidate", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      const s = summary(ctx, "s", "apple orchard harvest summary", [a]);
      const { ids } = recall(ctx);
      assert.deepEqual(ids, [s]);
    } finally {
      ctx.cleanup();
    }
  });

  it("does not use a summary outside the since/until window", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      const b = member(ctx, "b", "apple orchard harvest two");
      summary(ctx, "s", "apple orchard harvest summary", [a, b], T2);
      const { ids } = recall(ctx, { until: T1 });
      assert.deepEqual(ids.sort(), [a, b].sort());
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps members when the summary is retired", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      const b = member(ctx, "b", "apple orchard harvest two");
      const s = summary(ctx, "s", "apple orchard harvest summary", [a, b]);
      const retired = retireRecord(
        ctx.db,
        ctx.config,
        { id: s, scope: SCOPE, reasonCode: "CONSOLIDATED" },
        `retire-${ctr++}`,
        T2,
      );
      assert.equal(retired.ok, true, JSON.stringify(retired));
      const { ids } = recall(ctx);
      assert.deepEqual(ids.sort(), [a, b].sort());
    } finally {
      ctx.cleanup();
    }
  });

  it("folds a long summary when it links two members", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      const b = member(ctx, "b", "apple orchard harvest two");
      const s = summary(ctx, "s", `apple orchard harvest ${"x".repeat(220)}`, [a, b]);
      const { ids, foldedCandidates } = recall(ctx);
      // Two duplicates are worth folding even though the summary exceeds the
      // snippet cap.
      assert.deepEqual(ids, [s]);
      assert.equal(foldedCandidates, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps a lone member under a long summary literal", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      const s = summary(ctx, "s", `apple orchard harvest ${"x".repeat(220)}`, [a]);
      const { ids } = recall(ctx);
      // A lone specific hit stays literal when the long summary could truncate
      // the fact it matched.
      assert.equal(ids.includes(a), true);
      assert.equal(ids.includes(s), true);
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps an explicit link target literal", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one");
      const b = member(ctx, "b", "apple orchard harvest two");
      summary(ctx, "s", "apple orchard harvest summary", [a, b]);
      const { ids, foldedCandidates } = recall(ctx, { link: a });
      assert.equal(ids.includes(a), true);
      // b may still be folded; the explicit target must not be.
      assert.equal(ids.includes(b), false);
      assert.equal(foldedCandidates, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("still compresses when tags are used as seeds", () => {
    const ctx = setup();
    try {
      const a = member(ctx, "a", "apple orchard harvest one", T0, ["fruit"]);
      const b = member(ctx, "b", "apple orchard harvest two", T0, ["fruit"]);
      const s = summary(ctx, "s", "apple orchard harvest summary", [a, b]);
      const { ids } = recall(ctx, { tags: ["fruit"] });
      assert.deepEqual(ids, [s]);
    } finally {
      ctx.cleanup();
    }
  });
});
