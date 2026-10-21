/**
 * P2 episodes: episode.list / episode.windows / maintain.episodes.
 *
 * Consumer-visible behavior only: temp SQLite via initDb, deterministic fixed
 * timestamps, and an injected generator (no model, no network). Prompt content
 * is never asserted; the fake generator only infers prompt type from the
 * instruction text so scripted summaries/verdicts stay deterministic.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { countCp, type AppConfig, type EpisodesConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { normalizeBody } from "../src/normalize.js";
import { correctRecord, eventAppend, getRecord, recordSources, retireRecord } from "../src/store.js";
import { listEpisodes } from "../src/store.js";
import {
  EPISODE_FOLD_MAX,
  EPISODE_WINDOW_TAG,
  EPISODE_WINDOW_VERBATIM_TAG,
  anchorTokens,
  buildEpisodeClaimPrompt,
  buildEpisodeVerifyPrompt,
  dominantScript,
  episodeWindows,
  maintainEpisodes,
  missingAnchorTokens,
  promptLanguageFor,
  verificationFits,
  type EpisodesGenerate,
} from "../src/episodes.js";
import {
  acquireCultivationLease,
  releaseCultivationLease,
} from "../src/cultivation.js";
import type { ResponseEnvelope } from "../src/protocol.js";

const SCOPE = "personal/default";
const T0 = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T01:00:00.000Z";
const T2 = "2026-09-01T02:00:00.000Z";
const RUN1 = "2026-09-02T00:00:00.000Z";
const RUN2 = "2026-09-02T01:00:00.000Z";

function baseConfig(dir: string): { config: AppConfig; configPath: string } {
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
  return { config, configPath: path.join(dir, "memory.config.json") };
}

interface Ctx {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
}

function setup(): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "episodes-"));
  const { config, configPath } = baseConfig(dir);
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

function bounds(overrides: Partial<EpisodesConfig> = {}): EpisodesConfig {
  return {
    utcOffsetMinutes: 0,
    windowMaxCp: 200,
    maxNewTokens: 16,
    batchMax: 5,
    ...overrides,
  };
}

function append(
  ctx: Ctx,
  opts: {
    eventId: string;
    body: string;
    observedAt: string;
    createdAt: string;
    sessionId?: string;
    docId?: string;
    privacy?: { sensitivity: "normal" | "sensitive"; origin: "conversation" | "self_activity" };
  },
): void {
  const sessionId = opts.sessionId ?? "s1";
  const params: Record<string, unknown> = {
    eventId: opts.eventId,
    sessionId,
    turnId: `t-${opts.eventId}`,
    body: opts.body,
    provenance: { source: `session:${sessionId}:turn:1`, observedAt: opts.observedAt },
    scope: SCOPE,
  };
  if (opts.docId !== undefined) {
    params["chunk"] = { docId: opts.docId, seq: 0 };
  }
  if (opts.privacy !== undefined) {
    params["privacy"] = opts.privacy;
  }
  const r = eventAppend(ctx.db, ctx.config, params, `ev-${opts.eventId}`, opts.createdAt);
  assert.equal(r.ok, true, JSON.stringify(r));
}

/** Minimal model-file layout so an injected generator is considered usable. */
function enableFakeLlm(ctx: Ctx, maxPromptChars: number): void {
  const modelDir = path.join(ctx.dir, "fake-llm");
  fs.mkdirSync(path.join(modelDir, "onnx"), { recursive: true });
  for (const f of [
    "config.json",
    "generation_config.json",
    "tokenizer.json",
    "tokenizer_config.json",
    "special_tokens_map.json",
    "onnx/model_q4.onnx",
  ]) {
    fs.writeFileSync(path.join(modelDir, f), "{}");
  }
  ctx.config.llm = {
    modelDir,
    timeoutMs: 5000,
    enabled: true,
    maxNewTokens: 48,
    maxPromptChars,
  };
}

/** Deterministic word body long enough to span several windows. */
function longWords(word: string, count: number): string {
  return Array.from({ length: count }, (_, i) => `${word}${i}`).join(" ");
}

/** Citation markers for every note shown by the cited-reduce prompt. */
function citationsFor(prompt: string): string {
  const nums = new Set<number>();
  for (const m of prompt.matchAll(/^\[(\d+)\]\s+"""/gm)) nums.add(Number(m[1]));
  if (nums.size === 0) nums.add(1);
  return [...nums].sort((a, b) => a - b).map((n) => `[${n}]`).join("");
}

/**
 * Prompt-type-aware fake generator. Only the instruction text is inspected;
 * summary content is fixed so record bodies are stable across runs. Reduce
 * output always carries in-range citation markers (unless mergeText is null,
 * which scripts a generation failure).
 */
function makeGen(
  opts: {
    rejectText?: string;
    mergeText?: string | null;
    reduceText?: string | null;
    windowText?: string | null;
    claimVerify?: "YES" | "NO" | null;
  } = {},
): EpisodesGenerate {
  return async (prompt: string): Promise<string | null> => {
    if (/You verify a claim|主張を検証/.test(prompt)) {
      if (opts.claimVerify === null) return null;
      return opts.claimVerify ?? "YES";
    }
    if (/You verify a summary|要約を検証/.test(prompt)) {
      if (opts.rejectText !== undefined && prompt.includes(opts.rejectText)) return "NO";
      return "YES";
    }
    if (/Write 1-3 sentences|1〜3文で書いてください/.test(prompt)) {
      if (opts.reduceText !== undefined) return opts.reduceText;
      if (opts.mergeText === null) return null;
      const text = opts.mergeText ?? "merged episode summary";
      return `${text} ${citationsFor(prompt)}`;
    }
    if (opts.windowText === null) return null;
    return opts.windowText ?? "window summary";
  };
}

async function maintain(
  ctx: Ctx,
  key: string,
  gen: EpisodesGenerate | undefined,
  now: string,
  params: Record<string, unknown> = { scope: SCOPE, kind: "session" },
): Promise<ResponseEnvelope> {
  return maintainEpisodes(ctx.db, ctx.config, ctx.configPath, params, key, gen, now);
}

interface EpisodeResult {
  kind: string;
  episodeKey: string;
  windowsWritten: number;
  windowsVerbatim: number;
  windowsRejected: number;
  episodeRecordId: string | null;
  coveredThrough: string | null;
  sentencesKept: number;
  sentencesDropped: number;
  extractive: boolean;
  reduceDeferred: boolean;
}
interface EpisodesData {
  episodes: EpisodeResult[];
  applied: number;
  degraded: boolean;
}
interface ListItem {
  kind: string;
  episodeKey: string;
  startAt: string;
  endAt: string;
  eventCount: number;
  totalCp: number;
  summaryRecordIds: string[];
  stale: boolean;
}
interface ListData {
  items: ListItem[];
  nextCursor: string | null;
}
interface WindowsItem {
  recordId: string;
  eventId: string;
  span: { start: number; end: number };
  /** Explicit ledger marker; tags may be absent when tagsMax is small. */
  verbatim?: boolean;
  snippet: string;
  truncated: boolean;
}
interface WindowsData {
  items: WindowsItem[];
  nextCursor: string | null;
}
interface Rec {
  id: string;
  body: string;
  kind: string;
  status: string;
  supersedes: string | null;
  tags: string[];
  links: string[];
  sourceRefs: string[];
  privacy: { sensitivity: string; origin: string } | null;
}

function okData<T>(res: ResponseEnvelope): T {
  assert.equal(res.ok, true, JSON.stringify(res));
  return res.data as T;
}

function rec(ctx: Ctx, id: string): Rec {
  const r = getRecord(ctx.db, ctx.config, { id, scope: SCOPE });
  return okData<{ record: Rec }>(r).record;
}

function episodeData(res: ResponseEnvelope): EpisodesData {
  return okData<EpisodesData>(res);
}

function list(ctx: Ctx, params: Record<string, unknown>): ListData {
  return okData<ListData>(listEpisodes(ctx.db, ctx.config, params));
}

function windows(ctx: Ctx, params: Record<string, unknown>): WindowsData {
  return okData<WindowsData>(episodeWindows(ctx.db, ctx.config, params));
}

interface WindowRow {
  recordId: string;
  eventId: string;
  spanStart: number;
  spanEnd: number;
}
function windowRows(ctx: Ctx, eventId?: string): WindowRow[] {
  const sql = `SELECT recordId, eventId, spanStart, spanEnd FROM episode_summaries
               WHERE level = 'window'${eventId === undefined ? "" : " AND eventId = ?"}
               ORDER BY eventId ASC, spanStart ASC`;
  const stmt = ctx.db.prepare(sql);
  return (eventId === undefined ? stmt.all() : stmt.all(eventId)) as unknown as WindowRow[];
}
function episodeRows(ctx: Ctx): Array<{ recordId: string; coveredThrough: string | null }> {
  return ctx.db
    .prepare(`SELECT recordId, coveredThrough FROM episode_summaries WHERE level = 'episode'
              ORDER BY createdAt ASC`)
    .all() as unknown as Array<{ recordId: string; coveredThrough: string | null }>;
}
function counts(ctx: Ctx): { records: number; episodes: number; raw: number; ops: number } {
  const one = (sql: string): number =>
    (ctx.db.prepare(sql).get() as unknown as { n: number }).n;
  return {
    records: one(`SELECT COUNT(*) AS n FROM records`),
    episodes: one(`SELECT COUNT(*) AS n FROM episode_summaries`),
    raw: one(`SELECT COUNT(*) AS n FROM raw_events`),
    ops: one(`SELECT COUNT(*) AS n FROM operations`),
  };
}

/** Canonical + derived state rows only (an idempotency envelope is expected to grow). */
function stateCounts(ctx: Ctx): { records: number; episodes: number; raw: number } {
  const { records, episodes, raw } = counts(ctx);
  return { records, episodes, raw };
}

describe("episode.list grouping, day boundary, and paging", () => {
  it("groups sessions, docs, and local days (utcOffsetMinutes 540)", () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds({ utcOffsetMinutes: 540 });
      // 15:30Z + 9h => 2026-01-02T00:30 local.
      append(ctx, { eventId: "ev-s1", body: "late session", observedAt: "2026-01-01T15:30:00.000Z", createdAt: T0 });
      append(ctx, {
        eventId: "ev-s2",
        sessionId: "s2",
        body: "morning session",
        observedAt: "2026-01-01T10:00:00.000Z",
        createdAt: T1,
      });
      append(ctx, {
        eventId: "ev-d1",
        sessionId: "s3",
        docId: "doc-a",
        body: "doc chunk",
        observedAt: "2026-01-01T09:00:00.000Z",
        createdAt: T2,
      });

      const sessions = list(ctx, { scope: SCOPE, kind: "session", limit: 10 });
      assert.deepEqual(
        sessions.items.map((i) => i.episodeKey),
        ["s3", "s2", "s1"], // ordered by startAt ASC
      );
      assert.equal(sessions.items[2]!.startAt, "2026-01-01T15:30:00.000Z");
      assert.equal(sessions.items[2]!.eventCount, 1);
      assert.equal(sessions.items[2]!.stale, true);
      assert.deepEqual(sessions.items[2]!.summaryRecordIds, []);

      const docs = list(ctx, { scope: SCOPE, kind: "doc", limit: 10 });
      assert.deepEqual(docs.items.map((i) => i.episodeKey), ["doc-a"]);
      assert.equal(docs.items[0]!.eventCount, 1);

      const days = list(ctx, { scope: SCOPE, kind: "day", limit: 10 });
      assert.deepEqual(days.items.map((i) => i.episodeKey), ["2026-01-01", "2026-01-02"]);
      const jan1 = days.items[0]!;
      const jan2 = days.items[1]!;
      assert.equal(jan1.startAt, "2026-01-01T09:00:00.000Z");
      assert.equal(jan1.eventCount, 2);
      // The event at 2026-01-01T15:30Z is 2026-01-02 locally.
      assert.equal(jan2.startAt, "2026-01-01T15:30:00.000Z");
      assert.equal(jan2.endAt, "2026-01-01T15:30:00.000Z");
      assert.equal(jan2.eventCount, 1);
      assert.equal(days.nextCursor, null);
    } finally {
      ctx.cleanup();
    }
  });

  it("pages episode.list by (startAt, episodeKey) with an opaque cursor", () => {
    const ctx = setup();
    try {
      append(ctx, { eventId: "ev-a", sessionId: "sa", body: "first", observedAt: "2026-01-01T00:00:00.000Z", createdAt: T0 });
      append(ctx, { eventId: "ev-b", sessionId: "sb", body: "second", observedAt: "2026-01-01T01:00:00.000Z", createdAt: T1 });
      append(ctx, { eventId: "ev-c", sessionId: "sc", body: "third", observedAt: "2026-01-01T02:00:00.000Z", createdAt: T2 });

      const page1 = list(ctx, { scope: SCOPE, kind: "session", limit: 2 });
      assert.deepEqual(page1.items.map((i) => i.episodeKey), ["sa", "sb"]);
      assert.notEqual(page1.nextCursor, null);

      const page2 = list(ctx, {
        scope: SCOPE,
        kind: "session",
        limit: 2,
        cursor: page1.nextCursor,
      });
      assert.deepEqual(page2.items.map((i) => i.episodeKey), ["sc"]);
      assert.equal(page2.nextCursor, null);

      const bad = listEpisodes(ctx.db, ctx.config, {
        scope: SCOPE,
        kind: "session",
        cursor: "not-a-cursor",
      });
      assert.equal(bad.code, "BAD_REQUEST");
    } finally {
      ctx.cleanup();
    }
  });

  it("stale is true before a summary, false after maintain.episodes, and true on a new event", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-1", body: "alpha event", observedAt: T0, createdAt: T0 });

      const before = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(before.items[0]!.stale, true);
      assert.deepEqual(before.items[0]!.summaryRecordIds, []);

      const run = episodeData(await maintain(ctx, "ep-stale-1", makeGen(), RUN1));
      assert.equal(run.degraded, false);
      assert.equal(run.episodes[0]!.windowsRejected, 0);
      const episodeId = run.episodes[0]!.episodeRecordId;
      assert.notEqual(episodeId, null);

      const after = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(after.items[0]!.stale, false);
      assert.deepEqual(after.items[0]!.summaryRecordIds, [episodeId]);

      append(ctx, { eventId: "ev-2", body: "beta event", observedAt: T1, createdAt: T1 });
      const newer = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(newer.items[0]!.stale, true);
      assert.equal(newer.items[0]!.eventCount, 2);
      assert.deepEqual(newer.items[0]!.summaryRecordIds, [episodeId]);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("maintain.episodes windows, links, and reduce", () => {
  it("writes exact-span window records, links them, and pages episode.windows", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-1", body: "alpha one two three", observedAt: T0, createdAt: T0 });
      append(ctx, { eventId: "ev-2", body: "beta four five six", observedAt: T1, createdAt: T1 });

      const run = episodeData(await maintain(ctx, "ep-happy-1", makeGen(), RUN1));
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 2);
      assert.equal(ep.windowsRejected, 0);
      assert.equal(ep.coveredThrough, T1);
      assert.equal(run.applied, ep.windowsWritten + 1);
      assert.notEqual(ep.episodeRecordId, null);

      const rows = windowRows(ctx);
      assert.equal(rows.length, 2);

      const raw = (eventId: string): string =>
        (ctx.db.prepare(`SELECT body FROM raw_events WHERE eventId = ?`).get(eventId) as unknown as {
          body: string;
        }).body;

      for (const row of rows) {
        const w = rec(ctx, row.recordId);
        assert.ok(w.tags.includes(EPISODE_WINDOW_TAG));
        assert.deepEqual(w.sourceRefs, [row.eventId]);
        const sources = okData<{ sources: Array<{ eventId: string; span: { start: number; end: number } | null; excerpt: string }> }>(
          recordSources(ctx.db, ctx.config, { id: row.recordId, scope: SCOPE }),
        );
        assert.equal(sources.sources.length, 1);
        const src = sources.sources[0]!;
        assert.equal(src.eventId, row.eventId);
        assert.deepEqual(src.span, { start: row.spanStart, end: row.spanEnd });
        const body = raw(row.eventId);
        assert.equal(src.excerpt, Array.from(body).slice(row.spanStart, row.spanEnd).join(""));
        assert.equal(src.excerpt, body); // one window covers each short event
        assert.equal(w.body, "window summary");
      }

      const episodeRec = rec(ctx, ep.episodeRecordId as string);
      assert.equal(episodeRec.body, "merged episode summary");
      assert.equal(episodeRec.kind, "summary");
      assert.deepEqual(
        [...episodeRec.links].sort(),
        rows.map((r) => r.recordId).sort(),
      );

      const page1 = windows(ctx, { scope: SCOPE, kind: "session", episodeKey: "s1", limit: 1 });
      assert.equal(page1.items.length, 1);
      assert.notEqual(page1.nextCursor, null);
      const page2 = windows(ctx, {
        scope: SCOPE,
        kind: "session",
        episodeKey: "s1",
        limit: 1,
        cursor: page1.nextCursor,
      });
      assert.equal(page2.items.length, 1);
      assert.equal(page2.nextCursor, null);
      assert.deepEqual(
        [page1.items[0]!, page2.items[0]!].map((i) => i.recordId),
        rows.map((r) => r.recordId),
      );
      assert.deepEqual(
        [page1.items[0]!, page2.items[0]!].map((i) => i.eventId),
        ["ev-1", "ev-2"],
      );

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, false);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [ep.episodeRecordId]);
    } finally {
      ctx.cleanup();
    }
  });

  it("writes the exact raw span as a verbatim window when verification answers NO", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      const body = "Tanaka repaired the table.";
      append(ctx, { eventId: "ev-verbatim-no", body, observedAt: T0, createdAt: T0 });

      const run1 = episodeData(
        await maintain(ctx, "ep-verbatim-no-1", makeGen({ rejectText: "Tanaka" }), RUN1),
      );
      const ep1 = run1.episodes[0]!;
      assert.equal(ep1.windowsWritten, 0);
      assert.equal(ep1.windowsVerbatim, 1);
      assert.equal(ep1.windowsRejected, 1);
      assert.equal(ep1.coveredThrough, T0);
      assert.notEqual(ep1.episodeRecordId, null);

      const rows = windowRows(ctx);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.equal(row.eventId, "ev-verbatim-no");
      assert.deepEqual([row.spanStart, row.spanEnd], [0, Array.from(body).length]);
      const w = rec(ctx, row.recordId);
      assert.equal(w.body, body);
      assert.deepEqual(w.tags.sort(), [EPISODE_WINDOW_TAG, EPISODE_WINDOW_VERBATIM_TAG].sort());
      assert.deepEqual(w.sourceRefs, ["ev-verbatim-no"]);

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, false);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [ep1.episodeRecordId]);

      // Greedy generation would answer NO again, but the ledger already
      // covers every span, so a re-run writes nothing new.
      const before = stateCounts(ctx);
      const run2 = episodeData(
        await maintain(ctx, "ep-verbatim-no-2", makeGen({ rejectText: "Tanaka" }), RUN2),
      );
      assert.deepEqual(run2.episodes, []);
      assert.equal(run2.applied, 0);
      assert.deepEqual(stateCounts(ctx), before);
      assert.deepEqual(
        windowRows(ctx).map((r) => r.recordId),
        [row.recordId],
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("writes a verbatim window when NFKC expansion would exceed bodyMaxCp", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds({ windowMaxCp: 1200 });
      ctx.config.limits.bodyMaxCp = 200;
      const body = "…".repeat(400);
      append(ctx, { eventId: "ev-verbatim-nfkc", body, observedAt: T0, createdAt: T0 });

      const run = episodeData(
        await maintain(ctx, "ep-verbatim-nfkc-1", makeGen({ rejectText: "…" }), RUN1),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsVerbatim, 1);
      assert.equal(ep.windowsRejected, 1);
      assert.notEqual(ep.episodeRecordId, null);

      const rows = windowRows(ctx);
      assert.equal(rows.length, 1);
      const row = rows[0]!;
      assert.deepEqual([row.spanStart, row.spanEnd], [0, 400]);
      const w = rec(ctx, row.recordId);
      assert.ok(w.tags.includes(EPISODE_WINDOW_VERBATIM_TAG));
      assert.ok(countCp(w.body) > 0);
      assert.ok(countCp(w.body) <= 200, `raw ${countCp(w.body)}`);
      assert.ok(countCp(normalizeBody(w.body)) <= 200, `normalized ${countCp(normalizeBody(w.body))}`);
      assert.equal(w.body, "…".repeat(countCp(w.body)));
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("writes verbatim windows for a failed verification at event 2 and advances", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-a", body: longWords("alpha", 60), observedAt: T0, createdAt: T0 });
      append(ctx, { eventId: "ev-b", body: longWords("beta", 60), observedAt: T1, createdAt: T1 });

      // Every verification prompt for the second event's text answers NO.
      const run1 = episodeData(
        await maintain(ctx, "ep-reject-1", makeGen({ rejectText: "beta" }), RUN1),
      );
      const ep1 = run1.episodes[0]!;
      assert.ok(ep1.windowsWritten > 0);
      assert.ok(ep1.windowsVerbatim > 0);
      assert.equal(ep1.windowsRejected, ep1.windowsVerbatim);
      assert.equal(ep1.coveredThrough, T1); // event 2 is processed verbatim
      assert.notEqual(ep1.episodeRecordId, null);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);

      const rows1 = windowRows(ctx);
      assert.equal(rows1.length, ep1.windowsWritten + ep1.windowsVerbatim);
      const rawBody = (eventId: string): string =>
        (ctx.db.prepare(`SELECT body FROM raw_events WHERE eventId = ?`).get(eventId) as unknown as {
          body: string;
        }).body;
      for (const row of windowRows(ctx, "ev-b")) {
        const w = rec(ctx, row.recordId);
        assert.ok(w.tags.includes(EPISODE_WINDOW_TAG));
        assert.ok(w.tags.includes(EPISODE_WINDOW_VERBATIM_TAG));
        assert.deepEqual(w.sourceRefs, ["ev-b"]);
        const expected = Array.from(rawBody("ev-b"))
          .slice(row.spanStart, row.spanEnd)
          .join("")
          .replace(/\s+/g, " ")
          .trim();
        assert.equal(w.body, expected);
      }
      assert.ok(windowRows(ctx, "ev-a").every((r) => !rec(ctx, r.recordId).tags.includes(EPISODE_WINDOW_VERBATIM_TAG)));

      const epRec1 = rec(ctx, ep1.episodeRecordId as string);
      assert.deepEqual(
        [...epRec1.links].sort(),
        rows1.map((r) => r.recordId).sort(),
      );

      // A re-run has no new events and no new windows to write.
      const before = stateCounts(ctx);
      const run2 = episodeData(await maintain(ctx, "ep-reject-2", makeGen(), RUN2));
      assert.deepEqual(run2.episodes, []);
      assert.equal(run2.applied, 0);
      assert.deepEqual(stateCounts(ctx), before);
      assert.equal(episodeRows(ctx).length, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("writes no episode-level record when reduce generation fails", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-r", body: longWords("gamma", 60), observedAt: T0, createdAt: T0 });

      const run = episodeData(
        await maintain(ctx, "ep-reduce-reject", makeGen({ mergeText: null }), RUN1),
      );
      const ep = run.episodes[0]!;
      assert.ok(ep.windowsWritten > 0);
      assert.equal(ep.episodeRecordId, null);
      assert.equal(ep.reduceDeferred, true);
      assert.equal(ep.coveredThrough, T0); // event is done even though reduce failed
      assert.ok(windowRows(ctx, "ev-r").length > 0);
      assert.equal(episodeRows(ctx).length, 0);

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, true);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, []);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("maintain.episodes cited raw-grounded reduce", () => {
  it("drops a cited sentence whose raw span lacks its proper noun, keeping the other", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-anchor",
        body: "Tanaka repaired the table in Kyoto.",
        observedAt: T0,
        createdAt: T0,
      });

      const run = episodeData(
        await maintain(
          ctx,
          "ep-anchor-1",
          makeGen({ reduceText: "Elena met her husband [1]. Tanaka repaired the table [1]." }),
          RUN1,
        ),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.sentencesKept, 1);
      assert.equal(ep.sentencesDropped, 1);
      assert.equal(ep.extractive, false);
      assert.notEqual(ep.episodeRecordId, null);
      assert.equal(rec(ctx, ep.episodeRecordId as string).body, "Tanaka repaired the table.");
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("falls back to verified window summaries when every cited sentence is dropped", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-extra",
        body: "Tanaka repaired the table in Kyoto.",
        observedAt: T0,
        createdAt: T0,
      });

      const run = episodeData(
        await maintain(
          ctx,
          "ep-extractive-1",
          makeGen({ reduceText: "Elena met her husband [1]." }),
          RUN1,
        ),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.sentencesKept, 0);
      assert.equal(ep.sentencesDropped, 1);
      assert.equal(ep.extractive, true);
      assert.notEqual(ep.episodeRecordId, null);
      const episodeRec = rec(ctx, ep.episodeRecordId as string);
      assert.equal(episodeRec.body, "window summary");
      const row = windowRows(ctx)[0]!;
      assert.deepEqual(episodeRec.sourceRefs, [row.eventId]);
      assert.deepEqual(episodeRec.links, [row.recordId]);
      const sources = okData<{
        sources: Array<{ eventId: string; span: { start: number; end: number } | null }>;
      }>(recordSources(ctx.db, ctx.config, { id: ep.episodeRecordId as string, scope: SCOPE }));
      assert.deepEqual(sources.sources[0]!.span, {
        start: row.spanStart,
        end: row.spanEnd,
      });
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("drops out-of-range and uncited sentences but keeps in-range cited ones", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-cite",
        body: "Valid fact about Tanaka.",
        observedAt: T0,
        createdAt: T0,
      });

      const run = episodeData(
        await maintain(
          ctx,
          "ep-cite-1",
          makeGen({ reduceText: "Ghost fact [99]. Uncited fact. Valid fact [1]." }),
          RUN1,
        ),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.sentencesKept, 1);
      assert.equal(ep.sentencesDropped, 2);
      assert.equal(ep.extractive, false);
      const body = rec(ctx, ep.episodeRecordId as string).body;
      assert.equal(body, "Valid fact.");
      assert.equal(body.includes("Ghost"), false);
      assert.equal(body.includes("Uncited"), false);
    } finally {
      ctx.cleanup();
    }
  });

  it("episode record.sources exposes the raw spans of the cited windows only", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-first", body: "First fact.", observedAt: T0, createdAt: T0 });
      append(ctx, {
        eventId: "ev-second",
        body: "Second fact about Tanaka.",
        observedAt: T1,
        createdAt: T1,
      });

      const run = episodeData(
        await maintain(
          ctx,
          "ep-sources-1",
          makeGen({ reduceText: "Second fact [2]." }),
          RUN1,
        ),
      );
      const ep = run.episodes[0]!;
      const rows = windowRows(ctx);
      const second = rows.find((r) => r.eventId === "ev-second")!;
      const episodeRec = rec(ctx, ep.episodeRecordId as string);
      assert.equal(episodeRec.body, "Second fact.");
      assert.deepEqual(episodeRec.sourceRefs, ["ev-second"]);
      assert.deepEqual(episodeRec.links, [second.recordId]);
      const sources = okData<{
        sources: Array<{ eventId: string; span: { start: number; end: number } | null }>;
      }>(recordSources(ctx.db, ctx.config, { id: episodeRec.id, scope: SCOPE }));
      assert.equal(sources.sources.length, 1);
      assert.equal(sources.sources[0]!.eventId, "ev-second");
      assert.deepEqual(sources.sources[0]!.span, {
        start: second.spanStart,
        end: second.spanEnd,
      });
    } finally {
      ctx.cleanup();
    }
  });

  it("falls back to the exact raw span when a window summary invents a proper noun", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      const body = "Tanaka repaired the table.";
      append(ctx, {
        eventId: "ev-window-guard",
        body,
        observedAt: T0,
        createdAt: T0,
      });

      const run = episodeData(
        await maintain(
          ctx,
          "ep-window-guard-1",
          makeGen({ windowText: "Elena repaired the table." }),
          RUN1,
        ),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 0);
      assert.equal(ep.windowsVerbatim, 1);
      assert.equal(ep.windowsRejected, 1);
      assert.notEqual(ep.episodeRecordId, null);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
      const rows = windowRows(ctx);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0]!.spanStart, rows[0]!.spanEnd], [0, Array.from(body).length]);
      const w = rec(ctx, rows[0]!.recordId);
      assert.equal(w.body, body);
      assert.ok(w.tags.includes(EPISODE_WINDOW_VERBATIM_TAG));
    } finally {
      ctx.cleanup();
    }
  });

  it("writes nothing and stays stale when window generation returns null", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-window-timeout",
        body: "Tanaka repaired the table.",
        observedAt: T0,
        createdAt: T0,
      });

      const run = episodeData(
        await maintain(ctx, "ep-window-timeout-1", makeGen({ windowText: null }), RUN1),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 0);
      assert.equal(ep.windowsVerbatim, 0);
      assert.equal(ep.windowsRejected, 1);
      assert.equal(ep.episodeRecordId, null);
      assert.equal(windowRows(ctx).length, 0);
      assert.equal(episodeRows(ctx).length, 0);
      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, true);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, []);
    } finally {
      ctx.cleanup();
    }
  });

  it("stops concatenating folds before the episode body exceeds bodyMaxCp", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds({ windowMaxCp: 40 });
      ctx.config.limits.bodyMaxCp = 12; // "alpha." + " " + "alpha." = 13 > 12
      append(ctx, {
        eventId: "ev-body-cap",
        body: longWords("omega", 100),
        observedAt: T0,
        createdAt: T0,
      });

      const run = episodeData(
        await maintain(
          ctx,
          "ep-body-cap-1",
          makeGen({ windowText: "w s", reduceText: "alpha [1]." }),
          RUN1,
        ),
      );
      const ep = run.episodes[0]!;
      assert.ok(ep.windowsWritten > EPISODE_FOLD_MAX);
      const folds = Math.ceil(ep.windowsWritten / EPISODE_FOLD_MAX);
      assert.equal(ep.extractive, false);
      assert.equal(ep.sentencesKept, 1);
      assert.equal(ep.sentencesDropped, folds - 1);
      assert.equal(rec(ctx, ep.episodeRecordId as string).body, "alpha.");
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("anchor-token guard", () => {
  it("extracts proper nouns, digit runs, kanji, and katakana (NFKC full-width)", () => {
    const toks = new Set(anchorTokens("In 2026, Ｅｌｅｎａ visited 京都 with エレナ at １２：３０"));
    for (const t of ["2026", "elena", "京都", "エレナ", "12", "30"]) {
      assert.ok(toks.has(t), `missing anchor token ${t}`);
    }
  });

  it("matches case-insensitively and after NFKC", () => {
    assert.deepEqual(missingAnchorTokens("Elena in ２０２６", "ELENA in 2026"), []);
    assert.deepEqual(missingAnchorTokens("Ｅｌｅｎａ", "elena"), []);
  });

  it("requires multi-character kanji/katakana and every digit run", () => {
    assert.deepEqual(
      missingAnchorTokens("田中さんはエレナと京都へ", "田中さんはエレナと京都へ行った"),
      [],
    );
    assert.deepEqual(missingAnchorTokens("田中さんはエレナと京都へ", "田中さんはエレナと大阪へ"), [
      "京都",
    ]);
    assert.deepEqual(missingAnchorTokens("見積もりは12件", "見積もりは13件"), ["12"]);
    assert.deepEqual(anchorTokens("木"), []);
    assert.deepEqual(anchorTokens("木目"), ["木目"]);
    assert.deepEqual(anchorTokens("a"), []);
    assert.ok(anchorTokens("b2").includes("b2"));
    // Citation markers never become anchors.
    assert.deepEqual(anchorTokens("[1][3]"), []);
  });

  it("ignores sentence-initial common capitalized words but keeps names and digits", () => {
    // "The"/"This" are capitalized only because they start a sentence.
    assert.deepEqual(anchorTokens("The text describes Japanese furniture."), ["japanese"]);
    assert.deepEqual(anchorTokens("This is fine. The table is old."), []);
    // A person's name at sentence start is still an anchor.
    assert.ok(anchorTokens("Elena met her husband.").includes("elena"));
    assert.ok(anchorTokens("We met Elena in Kyoto.").includes("elena"));
    assert.ok(anchorTokens("We met Elena in Kyoto.").includes("kyoto"));
    // A mid-sentence capitalized name is still an anchor.
    assert.ok(anchorTokens("The report mentions Osaka.").includes("osaka"));
    // Digit-containing words/digit runs still count even when sentence-initial.
    assert.deepEqual(anchorTokens("In 2026, the plan changed."), ["2026"]);
    // A translated English summary still fails against Japanese raw.
    assert.deepEqual(
      missingAnchorTokens("The text describes Japanese furniture.", "木製の家具。"),
      ["japanese"],
    );
  });
});

describe("prompt language follows the source script", () => {
  const CJK_RAW = "田中さんは京都の工房で椅子を修理した。Elenaも同席した。";
  const LATIN_RAW = "Tanaka repaired the chair in Kyoto with Elena.";

  it("classifies the dominant script (CJK wins ties)", () => {
    assert.equal(dominantScript("日本語のテキストです。"), "cjk");
    assert.equal(dominantScript(CJK_RAW), "cjk");
    assert.equal(dominantScript("This is an English summary."), "latin");
    assert.equal(dominantScript(LATIN_RAW), "latin");
    assert.equal(dominantScript("木a"), "cjk"); // 1 CJK + 1 Latin word => tie => cjk
    // Mixed text: CJK code points are compared against Latin words, not
    // letters, so a Japanese sentence with a few English words stays cjk.
    assert.equal(
      dominantScript("田中さんは京都の工房で chair を修理し、Elena も同席した。"),
      "cjk",
    );
    // ...while an English paragraph with a single kanji word stays latin.
    assert.equal(
      dominantScript(
        "Tanaka repaired the wooden chair in Kyoto with Elena and then wrote a long report about the 木 material used for the frame.",
      ),
      "latin",
    );
    assert.equal(promptLanguageFor(CJK_RAW), "cjk");
    assert.equal(promptLanguageFor(LATIN_RAW), "latin");
  });
});

describe("maintain.episodes rerun, degradation, and idempotency", () => {
  it("second run writes only new windows and supersedes the active episode record", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-1", body: "alpha one", observedAt: T0, createdAt: T0 });

      const run1 = episodeData(await maintain(ctx, "ep-inc-1", makeGen(), RUN1));
      const ep1 = run1.episodes[0]!;
      const firstWindowId = windowRows(ctx)[0]!.recordId;

      append(ctx, { eventId: "ev-2", body: "beta two", observedAt: T1, createdAt: T1 });
      const run2 = episodeData(
        await maintain(ctx, "ep-inc-2", makeGen({ mergeText: "merged episode summary two" }), RUN2),
      );
      const ep2 = run2.episodes[0]!;
      assert.equal(ep2.windowsWritten, 1);
      assert.equal(run2.applied, 2); // one window + one episode revision
      assert.equal(ep2.coveredThrough, T1);

      const rows = windowRows(ctx);
      assert.equal(rows.length, 2);
      assert.equal(rows[0]!.recordId, firstWindowId);

      const old = rec(ctx, ep1.episodeRecordId as string);
      const fresh = rec(ctx, ep2.episodeRecordId as string);
      assert.equal(old.status, "superseded");
      assert.equal(fresh.status, "active");
      assert.equal(fresh.supersedes, ep1.episodeRecordId);

      // The supersede chain is traversable from the active record.
      const chain: string[] = [];
      let cursor: string | null = fresh.id;
      while (cursor !== null) {
        chain.push(cursor);
        cursor = rec(ctx, cursor).supersedes;
      }
      assert.deepEqual(chain, [fresh.id, old.id]);

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, false);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [fresh.id]);
    } finally {
      ctx.cleanup();
    }
  });

  it("retries a failed reduce without new events and does not re-reduce a fresh episode", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-reduce",
        body: longWords("zeta", 60),
        observedAt: T0,
        createdAt: T0,
      });

      // Run 1: every window passes verification, but reduce generation fails
      // (null output), so no episode-level row is written.
      const run1 = episodeData(
        await maintain(
          ctx,
          "ep-reduce-retry-1",
          makeGen({ mergeText: null }),
          RUN1,
        ),
      );
      const ep1 = run1.episodes[0]!;
      assert.ok(ep1.windowsWritten > 0);
      assert.equal(ep1.episodeRecordId, null);
      assert.equal(episodeRows(ctx).length, 0);
      const rowsAfter1 = windowRows(ctx);
      assert.equal(rowsAfter1.length, ep1.windowsWritten);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, true);

      // Run 2: no new raw events and no new windows. The reduce input is
      // re-derived from the ledger, so the episode is finally summarized.
      const run2 = episodeData(await maintain(ctx, "ep-reduce-retry-2", makeGen(), RUN2));
      const ep2 = run2.episodes[0]!;
      assert.equal(ep2.windowsWritten, 0);
      assert.equal(ep2.windowsRejected, 0);
      assert.notEqual(ep2.episodeRecordId, null);
      assert.equal(ep2.coveredThrough, T0);
      assert.equal(run2.applied, 1);
      assert.deepEqual(
        windowRows(ctx).map((r) => r.recordId),
        rowsAfter1.map((r) => r.recordId),
      );
      const listed2 = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed2.items[0]!.stale, false);
      assert.deepEqual(listed2.items[0]!.summaryRecordIds, [ep2.episodeRecordId]);

      // Run 3: zero pending windows and not stale => no reduce, no new
      // correction, and no new ledger rows.
      const before3 = stateCounts(ctx);
      const run3 = episodeData(await maintain(ctx, "ep-reduce-retry-3", makeGen(), RUN2));
      assert.deepEqual(run3.episodes, []);
      assert.equal(run3.applied, 0);
      assert.deepEqual(stateCounts(ctx), before3);
      assert.equal(episodeRows(ctx).length, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("defers the reduce when claim verification returns null instead of writing an extractive episode", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-claim-null",
        body: longWords("sigma", 60),
        observedAt: T0,
        createdAt: T0,
      });

      const run1 = episodeData(
        await maintain(
          ctx,
          "ep-claim-null-1",
          makeGen({ claimVerify: null }),
          RUN1,
        ),
      );
      const ep1 = run1.episodes[0]!;
      assert.ok(ep1.windowsWritten > 0);
      assert.equal(ep1.windowsRejected, 0);
      assert.equal(ep1.episodeRecordId, null);
      assert.equal(ep1.reduceDeferred, true);
      assert.equal(episodeRows(ctx).length, 0);
      const rowsAfter1 = windowRows(ctx);
      assert.equal(rowsAfter1.length, ep1.windowsWritten);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, true);

      // A later pass retries the same reduce (windows are not rewritten) and
      // only then writes the episode-level record.
      const run2 = episodeData(await maintain(ctx, "ep-claim-null-2", makeGen(), RUN2));
      const ep2 = run2.episodes[0]!;
      assert.equal(ep2.windowsWritten, 0);
      assert.equal(ep2.reduceDeferred, false);
      assert.notEqual(ep2.episodeRecordId, null);
      assert.deepEqual(
        windowRows(ctx).map((r) => r.recordId),
        rowsAfter1.map((r) => r.recordId),
      );
      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, false);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [ep2.episodeRecordId]);
    } finally {
      ctx.cleanup();
    }
  });

  it("degrades with an explicitly disabled llm section without changing state", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-deg", body: "degraded body", observedAt: T0, createdAt: T0 });
      const before = stateCounts(ctx);

      ctx.config.llm = {
        modelDir: "models/absent",
        timeoutMs: 1000,
        enabled: false,
        maxNewTokens: 48,
        maxPromptChars: 2000,
      };
      const res = await maintain(ctx, "ep-deg", undefined, RUN1);
      const data = episodeData(res);
      assert.equal(data.applied, 0);
      assert.equal(data.degraded, true);
      assert.deepEqual(data.episodes, []);
      assert.deepEqual(stateCounts(ctx), before);
    } finally {
      ctx.cleanup();
    }
  });

  it("deduplicates replays, conflicts on changed params, and refuses a held lease without writes", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-i", body: "idempotent body", observedAt: T0, createdAt: T0 });
      const params = { scope: SCOPE, kind: "session", limit: 5 };

      const first = await maintain(ctx, "ep-idem", makeGen(), RUN1, params);
      assert.equal(first.ok, true, JSON.stringify(first));
      const afterFirst = counts(ctx);

      const replay = await maintain(ctx, "ep-idem", makeGen(), RUN1, params);
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      assert.deepEqual(counts(ctx), afterFirst);

      const changed = await maintain(ctx, "ep-idem", makeGen(), RUN1, {
        scope: SCOPE,
        kind: "session",
        limit: 4,
      });
      assert.equal(changed.code, "CONFLICT");
      assert.deepEqual(counts(ctx), afterFirst);

      const lease = acquireCultivationLease(ctx.db, ctx.config, {
        owner: "foreign-holder",
        scope: SCOPE,
        now: RUN2,
      });
      assert.equal(lease.acquired, true);
      try {
        const contended = await maintain(ctx, "ep-lease", makeGen(), RUN2);
        assert.equal(contended.code, "CONFLICT");
        assert.deepEqual(counts(ctx), afterFirst);
      } finally {
        assert.equal(releaseCultivationLease(ctx.db, "foreign-holder"), true);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("repairs a missing window ledger row without duplicating records", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-crash", body: longWords("delta", 60), observedAt: T0, createdAt: T0 });

      const run1 = episodeData(await maintain(ctx, "ep-crash-1", makeGen(), RUN1));
      const ep1 = run1.episodes[0]!;
      assert.ok(run1.episodes[0]!.windowsWritten > 1);
      const beforeRows = windowRows(ctx);
      const beforeEpisodeRows = episodeRows(ctx);
      assert.equal(beforeEpisodeRows.length, 1);
      const beforeCounts = stateCounts(ctx);

      // Simulate a crash after the window record committed but before its
      // ledger row, the done marker, and the episode-level ledger row were
      // written (the done marker is atomic with the last window ledger row).
      const lost = beforeRows[0]!;
      ctx.db.prepare(`DELETE FROM episode_summaries WHERE recordId = ? AND level = 'window'`).run(lost.recordId);
      ctx.db.prepare(`DELETE FROM episode_summaries WHERE level = 'episode'`).run();
      ctx.db
        .prepare(`DELETE FROM episode_event_done WHERE scope = ? AND eventId = ?`)
        .run(SCOPE, lost.eventId);
      assert.equal(windowRows(ctx).length, beforeRows.length - 1);
      assert.equal(episodeRows(ctx).length, 0);

      const run2 = episodeData(await maintain(ctx, "ep-crash-2", makeGen(), RUN2));
      assert.equal(run2.episodes[0]!.windowsWritten, 1); // only the lost window
      assert.equal(rec(ctx, lost.recordId).body, "window summary");

      const afterRows = windowRows(ctx);
      assert.equal(afterRows.length, beforeRows.length);
      assert.deepEqual(
        afterRows.map((r) => r.recordId).sort(),
        beforeRows.map((r) => r.recordId).sort(),
      );
      assert.equal(
        afterRows.find((r) => r.spanStart === lost.spanStart && r.eventId === lost.eventId)!.recordId,
        lost.recordId,
      );

      const afterEpisodeRows = episodeRows(ctx);
      assert.equal(afterEpisodeRows.length, 1);
      assert.equal(afterEpisodeRows[0]!.recordId, ep1.episodeRecordId);
      assert.equal(afterEpisodeRows[0]!.coveredThrough, T0);
      // No duplicate canonical records: only ledger rows were repaired.
      assert.deepEqual(stateCounts(ctx), beforeCounts);

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, false);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [ep1.episodeRecordId]);
    } finally {
      ctx.cleanup();
    }
  });

  it("retries an event whose observation order is later than its creation order", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      // Processing order is observedAt ASC: A first (T0), B second (T1).
      // B was created earlier than A, so a createdAt watermark would consider
      // B covered after A succeeded and skip it forever.
      append(ctx, {
        eventId: "ev-order-a",
        body: "alpha was observed first but created last",
        observedAt: T0,
        createdAt: T2,
      });
      append(ctx, {
        eventId: "ev-order-b",
        body: "beta was observed second but created first",
        observedAt: T1,
        createdAt: T1,
      });

      const base = makeGen();
      const flaky: EpisodesGenerate = async (prompt, tokens) => {
        const isReduce = /Write 1-3 sentences|1〜3文で書いてください/.test(prompt);
        if (!isReduce && prompt.includes("beta")) return null;
        return base(prompt, tokens);
      };

      const run1 = episodeData(await maintain(ctx, "ep-order-1", flaky, RUN1));
      const ep1 = run1.episodes[0]!;
      assert.equal(ep1.windowsWritten, 1); // only A
      assert.equal(ep1.windowsRejected, 1); // B timed out
      assert.equal(ep1.coveredThrough, T0); // max observedAt of done events only
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, true);
      assert.deepEqual(
        windowRows(ctx).map((r) => r.eventId),
        ["ev-order-a"],
      );

      const run2 = episodeData(await maintain(ctx, "ep-order-2", makeGen(), RUN2));
      const ep2 = run2.episodes[0]!;
      assert.equal(ep2.windowsWritten, 1); // B is retried, not skipped
      assert.equal(ep2.windowsRejected, 0);
      assert.equal(ep2.coveredThrough, T1);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
      assert.deepEqual(
        windowRows(ctx)
          .map((r) => r.eventId)
          .sort(),
        ["ev-order-a", "ev-order-b"],
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("retries an event after a createdAt tie rather than treating the tie as coverage", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-tie-a",
        body: "alpha tie created equal",
        observedAt: T0,
        createdAt: T0,
      });
      append(ctx, {
        eventId: "ev-tie-b",
        body: "beta tie created equal",
        observedAt: T1,
        createdAt: T0,
      });

      const base = makeGen();
      const flaky: EpisodesGenerate = async (prompt, tokens) => {
        const isReduce = /Write 1-3 sentences|1〜3文で書いてください/.test(prompt);
        if (!isReduce && prompt.includes("beta")) return null;
        return base(prompt, tokens);
      };

      const run1 = episodeData(await maintain(ctx, "ep-tie-1", flaky, RUN1));
      assert.equal(run1.episodes[0]!.windowsWritten, 1);
      assert.equal(run1.episodes[0]!.windowsRejected, 1);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, true);

      const run2 = episodeData(await maintain(ctx, "ep-tie-2", makeGen(), RUN2));
      assert.equal(run2.episodes[0]!.windowsWritten, 1);
      assert.equal(run2.episodes[0]!.coveredThrough, T1);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("does not commit canonical or ledger writes after the lease is stolen", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-fence",
        body: "lease fence body",
        observedAt: T0,
        createdAt: T0,
      });
      const before = counts(ctx);
      const base = makeGen();
      let stolen = false;
      const thief: EpisodesGenerate = async (prompt, tokens) => {
        if (!stolen && /You verify a summary|要約を検証/.test(prompt)) {
          // Force a steal: RUN2 is beyond the lease acquired at RUN1.
          const got = acquireCultivationLease(ctx.db, ctx.config, {
            owner: "thief",
            scope: SCOPE,
            now: RUN2,
          });
          assert.equal(got.acquired, true);
          stolen = true;
        }
        return base(prompt, tokens);
      };

      const res = await maintain(ctx, "ep-fence", thief, RUN1);
      assert.equal(res.code, "CONFLICT");
      assert.equal(stolen, true);
      // The window write transaction rolled back: no canonical record, no
      // window/done/episode ledger rows, and no idempotency envelope.
      assert.deepEqual(counts(ctx), before);
      assert.equal(windowRows(ctx).length, 0);
      assert.equal(episodeRows(ctx).length, 0);
      const done = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM episode_event_done`)
        .get() as unknown as { n: number };
      assert.equal(done.n, 0);
    } finally {
      releaseCultivationLease(ctx.db, "thief");
      ctx.cleanup();
    }
  });

  it("splits a long event into windows whose spans tile the stored body", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds({ windowMaxCp: 200 });
      append(ctx, { eventId: "ev-long", body: longWords("omega", 100), observedAt: T0, createdAt: T0 });
      const body = (ctx.db.prepare(`SELECT body FROM raw_events WHERE eventId = ?`).get("ev-long") as unknown as {
        body: string;
      }).body;
      const cps = Array.from(body);
      assert.ok(cps.length > 200);

      const run = episodeData(await maintain(ctx, "ep-long", makeGen(), RUN1));
      assert.ok(run.episodes[0]!.windowsWritten > 1);

      const rows = windowRows(ctx, "ev-long");
      assert.ok(rows.length > 1);
      assert.equal(rows[0]!.spanStart, 0);
      assert.equal(rows[rows.length - 1]!.spanEnd, cps.length);
      for (let i = 0; i < rows.length; i++) {
        const row = rows[i]!;
        assert.ok(row.spanEnd > row.spanStart);
        assert.ok(row.spanEnd - row.spanStart <= 200);
        if (i > 0) assert.equal(rows[i - 1]!.spanEnd, row.spanStart);
        const segment = cps.slice(row.spanStart, row.spanEnd).join("");
        assert.match(segment, /\S/u);
        const sources = okData<{ sources: Array<{ span: { start: number; end: number } | null; excerpt: string }> }>(
          recordSources(ctx.db, ctx.config, { id: row.recordId, scope: SCOPE }),
        );
        assert.deepEqual(sources.sources[0]!.span, { start: row.spanStart, end: row.spanEnd });
        assert.equal(sources.sources[0]!.excerpt, segment);
      }

      const paged = windows(ctx, {
        scope: SCOPE,
        kind: "session",
        episodeKey: "s1",
        limit: 50,
      });
      assert.equal(paged.items.length, rows.length);
      assert.ok(paged.items.every((i) => i.truncated === false));
      // episode.windows returns summary snippets; spans above are the raw tiles.
      assert.ok(paged.items.every((i) => i.snippet === "window summary"));
    } finally {
      ctx.cleanup();
    }
  });
});

describe("episode ledger follows record.correct revisions", () => {
  function correct(
    ctx: Ctx,
    recordId: string,
    body: string,
    key: string,
  ): string {
    const res = correctRecord(
      ctx.db,
      ctx.config,
      {
        recordId,
        body,
        kind: "correction",
        provenance: { source: "session:s1:turn:1", observedAt: T1 },
        scope: SCOPE,
      },
      key,
      RUN2,
    );
    assert.equal(res.ok, true, JSON.stringify(res));
    return (res.data as { record: { id: string } }).record.id;
  }

  it("carries an episode summary ledger row to the corrected revision", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-ep-correct",
        body: longWords("omega", 60),
        observedAt: T0,
        createdAt: T0,
      });
      const run1 = episodeData(await maintain(ctx, "ep-correct-1", makeGen(), RUN1));
      const oldEpisodeId = run1.episodes[0]!.episodeRecordId as string;
      assert.notEqual(oldEpisodeId, null);

      const newEpisodeId = correct(
        ctx,
        oldEpisodeId,
        "corrected episode summary",
        "ep-correct-summary",
      );

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [newEpisodeId]);
      assert.equal(listed.items[0]!.stale, false);

      // The corrected episode is still fully folded: no new events and no
      // unfolded windows means maintenance has nothing to write.
      const before = stateCounts(ctx);
      const run2 = episodeData(await maintain(ctx, "ep-correct-2", makeGen(), RUN2));
      assert.deepEqual(run2.episodes, []);
      assert.equal(run2.applied, 0);
      assert.deepEqual(stateCounts(ctx), before);
      assert.deepEqual(
        list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.summaryRecordIds,
        [newEpisodeId],
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("carries a window ledger row to the corrected revision without re-staling the episode", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, {
        eventId: "ev-win-correct",
        body: longWords("pi", 60),
        observedAt: T0,
        createdAt: T0,
      });
      const run1 = episodeData(await maintain(ctx, "ep-win-correct-1", makeGen(), RUN1));
      const episodeId = run1.episodes[0]!.episodeRecordId as string;
      const oldWindowId = windowRows(ctx)[0]!.recordId;

      const newWindowId = correct(
        ctx,
        oldWindowId,
        "corrected window summary",
        "ep-correct-window",
      );
      assert.notEqual(newWindowId, oldWindowId);

      const listedWindows = windows(ctx, {
        scope: SCOPE,
        kind: "session",
        episodeKey: "s1",
      });
      const ids = listedWindows.items.map((i) => i.recordId);
      assert.ok(ids.includes(newWindowId), JSON.stringify(ids));
      assert.ok(!ids.includes(oldWindowId), JSON.stringify(ids));

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, false);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [episodeId]);

      const before = stateCounts(ctx);
      const run2 = episodeData(await maintain(ctx, "ep-win-correct-2", makeGen(), RUN2));
      assert.deepEqual(run2.episodes, []);
      assert.equal(run2.applied, 0);
      assert.deepEqual(stateCounts(ctx), before);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("maintain.episodes privacy propagation and verification budgets", () => {
  it("never truncates the candidate and rejects prompts with too little source", () => {
    const source = "alpha source text";
    const longCandidate = Array.from({ length: 120 }, () => "summary").join(" ");
    const shortCandidate = "short summary";

    assert.equal(verificationFits(source, longCandidate, 500), false);
    assert.equal(buildEpisodeVerifyPrompt(source, longCandidate, 500), null);
    assert.equal(buildEpisodeClaimPrompt(source, longCandidate, 500), null);

    assert.equal(verificationFits(source, shortCandidate, 500), true);
    const verify = buildEpisodeVerifyPrompt(source, shortCandidate, 500);
    assert.notEqual(verify, null);
    assert.ok(verify!.includes(shortCandidate)); // full candidate, not a prefix
    const claim = buildEpisodeClaimPrompt(source, shortCandidate, 500);
    assert.notEqual(claim, null);
    assert.ok(claim!.includes(shortCandidate));
  });

  it("stores the window verbatim when the full candidate cannot be verified", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      enableFakeLlm(ctx, 500);
      const rawBody = "alpha source text";
      append(ctx, { eventId: "ev-budget", body: rawBody, observedAt: T0, createdAt: T0 });
      const longCandidate = Array.from({ length: 120 }, () => "summary").join(" ");

      // The generator is willing to answer YES, but the verifier prompt can
      // only fit the candidate by dropping the source, so no YES is requested.
      const run = episodeData(
        await maintain(ctx, "ep-budget-1", makeGen({ windowText: longCandidate }), RUN1),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 0);
      assert.equal(ep.windowsVerbatim, 1);
      assert.notEqual(ep.episodeRecordId, null);

      const rows = windowRows(ctx);
      assert.equal(rows.length, 1);
      const w = rec(ctx, rows[0]!.recordId);
      assert.equal(w.body, rawBody);
      assert.ok(w.tags.includes(EPISODE_WINDOW_VERBATIM_TAG));
      assert.equal(w.body.includes("summary"), false);
    } finally {
      ctx.cleanup();
    }
  });

  it("propagates privacy to windows and the episode record under requirePrivacy", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      ctx.config.requirePrivacy = true;
      append(ctx, {
        eventId: "ev-priv-normal",
        body: "normal private source",
        observedAt: T0,
        createdAt: T0,
        privacy: { sensitivity: "normal", origin: "conversation" },
      });
      append(ctx, {
        eventId: "ev-priv-sensitive",
        body: "sensitive private source",
        observedAt: T1,
        createdAt: T1,
        privacy: { sensitivity: "sensitive", origin: "conversation" },
      });

      const run = episodeData(await maintain(ctx, "ep-priv-1", makeGen(), RUN1));
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 2);
      assert.equal(ep.windowsVerbatim, 0);
      assert.notEqual(ep.episodeRecordId, null);

      for (const row of windowRows(ctx)) {
        const expected = row.eventId === "ev-priv-sensitive" ? "sensitive" : "normal";
        assert.deepEqual(rec(ctx, row.recordId).privacy, {
          sensitivity: expected,
          origin: "self_activity",
        });
      }
      // Any sensitive source dominates: the episode is sensitive too.
      assert.deepEqual(rec(ctx, ep.episodeRecordId as string).privacy, {
        sensitivity: "sensitive",
        origin: "self_activity",
      });
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("leaves an event with unknown privacy pending instead of inventing privacy", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      // Legacy/unknown source written before strict privacy was enabled.
      append(ctx, { eventId: "ev-priv-missing", body: "legacy body", observedAt: T0, createdAt: T0 });
      ctx.config.requirePrivacy = true;

      const before = stateCounts(ctx);
      const run = episodeData(await maintain(ctx, "ep-priv-2", makeGen(), RUN1));
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 0);
      assert.equal(ep.windowsVerbatim, 0);
      assert.equal(ep.episodeRecordId, null);
      assert.equal(run.applied, 0);
      assert.deepEqual(stateCounts(ctx), before);
      assert.equal(windowRows(ctx).length, 0);
      assert.equal(episodeRows(ctx).length, 0);
      const done = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM episode_event_done`)
        .get() as unknown as { n: number };
      assert.equal(done.n, 0);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, true);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("PR #26 round 5 follow-ups", () => {
  it("falls back to a verbatim window when normalization exceeds bodyMaxCp", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds({ windowMaxCp: 1200 });
      ctx.config.limits.bodyMaxCp = 200;
      const body = "…".repeat(100); // raw 100cp, normalizeBody -> 300cp
      append(ctx, { eventId: "ev-normalize-overflow", body, observedAt: T0, createdAt: T0 });

      const run = episodeData(
        await maintain(
          ctx,
          "ep-normalize-overflow-1",
          makeGen({ windowText: "…".repeat(100) }),
          RUN1,
        ),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 0);
      assert.equal(ep.windowsVerbatim, 1);
      assert.equal(ep.windowsRejected, 1);
      assert.notEqual(ep.episodeRecordId, null);

      const rows = windowRows(ctx);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0]!.spanStart, rows[0]!.spanEnd], [0, 100]);
      const w = rec(ctx, rows[0]!.recordId);
      assert.notEqual(w.body, "…".repeat(100));
      assert.ok(w.tags.includes(EPISODE_WINDOW_VERBATIM_TAG));
      assert.ok(countCp(w.body) <= 200);
      assert.ok(countCp(normalizeBody(w.body)) <= 200);
      const ledger = ctx.db
        .prepare(`SELECT verbatim FROM episode_summaries WHERE recordId = ?`)
        .get(rows[0]!.recordId) as { verbatim: number };
      assert.equal(ledger.verbatim, 1);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("bounds window tags by tagsMax 1 and identifies verbatim from the ledger", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      ctx.config.limits.tagsMax = 1;
      append(ctx, {
        eventId: "ev-tags-one",
        body: "Tanaka repaired the table.",
        observedAt: T0,
        createdAt: T0,
      });

      const run = episodeData(
        await maintain(ctx, "ep-tags-one", makeGen({ rejectText: "Tanaka" }), RUN1),
      );
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsVerbatim, 1);
      assert.notEqual(ep.episodeRecordId, null);

      const row = windowRows(ctx)[0]!;
      const w = rec(ctx, row.recordId);
      assert.deepEqual(w.tags, [EPISODE_WINDOW_TAG]);
      assert.deepEqual(rec(ctx, ep.episodeRecordId as string).tags, ["episode"]);

      // episode.windows carries the explicit ledger marker even though the
      // verbatim tag was dropped by the tag budget.
      const listed = windows(ctx, { scope: SCOPE, kind: "session", episodeKey: "s1" });
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0]!.recordId, row.recordId);
      assert.equal(listed.items[0]!.verbatim, true);
      assert.equal(list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.stale, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("writes windows and episode records with no tags when tagsMax is 0", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      ctx.config.limits.tagsMax = 0;
      append(ctx, { eventId: "ev-tags-zero", body: "alpha one", observedAt: T0, createdAt: T0 });

      const run = episodeData(await maintain(ctx, "ep-tags-zero", makeGen(), RUN1));
      const ep = run.episodes[0]!;
      assert.equal(ep.windowsWritten, 1);
      assert.notEqual(ep.episodeRecordId, null);

      const row = windowRows(ctx)[0]!;
      assert.deepEqual(rec(ctx, row.recordId).tags, []);
      assert.deepEqual(rec(ctx, ep.episodeRecordId as string).tags, []);
      const listed = windows(ctx, { scope: SCOPE, kind: "session", episodeKey: "s1" });
      assert.equal(listed.items.length, 1);
      assert.equal(listed.items[0]!.recordId, row.recordId);
      assert.equal(listed.items[0]!.verbatim, false);
      const listData = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listData.items[0]!.stale, false);
      assert.deepEqual(listData.items[0]!.summaryRecordIds, [ep.episodeRecordId]);
    } finally {
      ctx.cleanup();
    }
  });

  it("creates a new episode generation after the prior summary was retired", async () => {
    const ctx = setup();
    try {
      ctx.config.episodes = bounds();
      append(ctx, { eventId: "ev-gen-1", body: "alpha one", observedAt: T0, createdAt: T0 });

      const run1 = episodeData(await maintain(ctx, "ep-gen-1", makeGen(), RUN1));
      const firstId = run1.episodes[0]!.episodeRecordId as string;
      assert.notEqual(firstId, null);

      const retired = retireRecord(
        ctx.db,
        ctx.config,
        { id: firstId, scope: SCOPE, reasonCode: "OUTDATED" },
        "retire-ep-gen-1",
        RUN1,
      );
      assert.equal(retired.ok, true, JSON.stringify(retired));
      assert.equal(rec(ctx, firstId).status, "retired");

      append(ctx, { eventId: "ev-gen-2", body: "beta two", observedAt: T1, createdAt: T1 });
      const run2 = episodeData(await maintain(ctx, "ep-gen-2", makeGen(), RUN2));
      const secondId = run2.episodes[0]!.episodeRecordId as string;
      assert.notEqual(secondId, null);
      assert.notEqual(secondId, firstId);
      assert.equal(rec(ctx, secondId).status, "active");
      assert.equal(rec(ctx, firstId).status, "retired");

      const listed = list(ctx, { scope: SCOPE, kind: "session" });
      assert.equal(listed.items[0]!.stale, false);
      assert.deepEqual(listed.items[0]!.summaryRecordIds, [secondId]);

      // Retrying the same (already folded) generation adds nothing.
      const before = stateCounts(ctx);
      const run3 = episodeData(await maintain(ctx, "ep-gen-3", makeGen(), RUN2));
      assert.deepEqual(run3.episodes, []);
      assert.equal(run3.applied, 0);
      assert.deepEqual(stateCounts(ctx), before);
      assert.deepEqual(
        list(ctx, { scope: SCOPE, kind: "session" }).items[0]!.summaryRecordIds,
        [secondId],
      );
    } finally {
      ctx.cleanup();
    }
  });
});
