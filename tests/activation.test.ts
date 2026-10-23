/**
 * Activation model tests: hand-computed ACT-R values, monotonicity, weights,
 * hysteresis/min-age, and the read-only activation.preview op.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, initDb } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import { loadConfig, type ActivationConfig } from "../src/config.js";
import { eventAppend, correctRecord, rememberRecord, retireRecord } from "../src/store.js";
import { acquireCultivationLease, releaseCultivationLease } from "../src/cultivation.js";
import { maintainDistill } from "../src/distill.js";
import {
  ACTIVATION_DEFAULTS,
  activationAgeHours,
  activationPreview,
  buildImportancePrompt,
  computeActivation,
  loadActivationInputs,
  maintainActivation,
  parseImportance,
  retireDecision,
  type ActivationInput,
} from "../src/activation.js";

const SCOPE = "personal/default";
const OBS = "2026-01-01T00:00:00.000Z";
const NOW = "2026-01-11T00:00:00.000Z";

function baseConfig(dir: string, activation?: Partial<ActivationConfig>): { config: AppConfig; configPath: string } {
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
      responseMaxBytes: 65536,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
    ...(activation ? { activation: activation as ActivationConfig } : {}),
  };
  return { config, configPath: path.join(dir, "memory.config.json") };
}

function setup(activation?: Partial<ActivationConfig>): {
  dir: string;
  config: AppConfig;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activation-"));
  const { config, configPath } = baseConfig(dir, activation);
  const { db } = initDb(config, configPath);
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
function raw(db: DatabaseSync, config: AppConfig, eventId: string): void {
  const r = eventAppend(
    db,
    config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: `raw context ${eventId}`,
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope: SCOPE,
    },
    `ev-${eventId}-${ctr++}`,
  );
  assert.equal(r.ok, true, JSON.stringify(r));
}

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  key: string,
  createdAt: string,
  kind = "user_fact",
): string {
  const ref = `auto-${key}`;
  raw(db, config, ref);
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind,
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope: SCOPE,
      sourceRefs: [ref],
    },
    key,
    createdAt,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function addUsage(db: DatabaseSync, id: string, ts: string): void {
  db.prepare(`INSERT INTO usage(ts, recallId, recordId, scope, runId) VALUES (?, ?, ?, ?, NULL)`).run(
    ts,
    `recall-${ctr++}`,
    id,
    SCOPE,
  );
  db.prepare(`INSERT OR IGNORE INTO note_heat(recordId, usedCount, lastUsedAt) VALUES (?, 0, ?)`).run(id, ts);
  db.prepare(`UPDATE note_heat SET usedCount = usedCount + 1, lastUsedAt = ? WHERE recordId = ?`).run(ts, id);
}

function input(overrides: Partial<ActivationInput> = {}): ActivationInput {
  return {
    recordId: "rec_x",
    kind: "user_fact",
    status: "active",
    createdAt: "2026-01-10T00:00:00.000Z",
    body: "x",
    importance: null,
    uses: 0,
    eventTimes: [],
    retireReason: null,
    ...overrides,
  };
}

describe("activation: pure ACT-R formula", () => {
  it("matches a hand-computed single-event value", () => {
    // 24h old, d=0.5 => 24^-0.5; +1.0 kind +2.0*0.5 importance.
    const A = computeActivation(input(), ACTIVATION_DEFAULTS, NOW);
    const expected = Math.log(Math.pow(24, -0.5)) + 1.0 + 2.0 * 0.5;
    assert.ok(Math.abs(A - expected) < 1e-12, `${A} vs ${expected}`);
  });

  it("uses the one-hour floor and log-of-sum for multiple events", () => {
    const A = computeActivation(
      input({ eventTimes: ["2026-01-11T00:00:00.000Z", "2026-01-10T22:00:00.000Z"] }),
      ACTIVATION_DEFAULTS,
      NOW,
    );
    // createdAt 24h, event 0h floors to 1, event 2h.
    const expected = Math.log(Math.pow(24, -0.5) + 1 + Math.pow(2, -0.5)) + 1 + 1;
    assert.ok(Math.abs(A - expected) < 1e-12, `${A} vs ${expected}`);
  });

  it("is monotonic in recency and frequency", () => {
    const fresh = computeActivation(input({ createdAt: "2026-01-10T23:00:00.000Z" }), ACTIVATION_DEFAULTS, NOW);
    const stale = computeActivation(input({ createdAt: "2026-01-01T00:00:00.000Z" }), ACTIVATION_DEFAULTS, NOW);
    assert.ok(fresh > stale);

    const one = computeActivation(input(), ACTIVATION_DEFAULTS, NOW);
    const two = computeActivation(
      input({ eventTimes: ["2026-01-11T00:00:00.000Z"] }),
      ACTIVATION_DEFAULTS,
      NOW,
    );
    assert.ok(two > one);
  });

  it("applies per-kind and importance weights; missing importance is 0.5", () => {
    const base = computeActivation(input({ kind: "model_inference" }), ACTIVATION_DEFAULTS, NOW);
    const fact = computeActivation(input({ kind: "user_fact" }), ACTIVATION_DEFAULTS, NOW);
    const summary = computeActivation(input({ kind: "summary" }), ACTIVATION_DEFAULTS, NOW);
    const correction = computeActivation(input({ kind: "correction" }), ACTIVATION_DEFAULTS, NOW);
    assert.ok(Math.abs(fact - base - 1.0) < 1e-12);
    assert.ok(Math.abs(summary - base - 0.3) < 1e-12);
    assert.ok(Math.abs(correction - base - 1.0) < 1e-12);

    const neutral = computeActivation(input({ kind: "model_inference", importance: null }), ACTIVATION_DEFAULTS, NOW);
    const high = computeActivation(input({ kind: "model_inference", importance: 1 }), ACTIVATION_DEFAULTS, NOW);
    const zero = computeActivation(input({ kind: "model_inference", importance: 0 }), ACTIVATION_DEFAULTS, NOW);
    assert.ok(Math.abs(high - neutral - 1.0) < 1e-12);
    assert.ok(Math.abs(neutral - zero - 1.0) < 1e-12);
  });

  it("reports age in hours with a zero floor", () => {
    assert.equal(activationAgeHours("2026-01-10T00:00:00.000Z", NOW), 24);
    assert.equal(activationAgeHours("2026-01-12T00:00:00.000Z", NOW), 0);
  });
});

describe("activation: hysteresis and min-age", () => {
  it("retires only below tauRetire after minAgeHours", () => {
    assert.equal(ACTIVATION_DEFAULTS.minAgeHours, 72);
    assert.equal(retireDecision(-2, "active", null, 400, ACTIVATION_DEFAULTS), "retire");
    assert.equal(retireDecision(-2, "active", null, 50, ACTIVATION_DEFAULTS), "keep");
    assert.equal(retireDecision(-2, "active", null, 72, ACTIVATION_DEFAULTS), "retire");
    assert.equal(retireDecision(-1, "active", null, 400, ACTIVATION_DEFAULTS), "keep");
    assert.equal(retireDecision(-1.5, "active", null, 400, ACTIVATION_DEFAULTS), "keep");
  });

  it("reactivates only activation-driven retirements at or above tauReactivate", () => {
    assert.equal(retireDecision(0, "retired", "LOW_ACTIVATION", 10, ACTIVATION_DEFAULTS), "reactivate");
    assert.equal(retireDecision(-1, "retired", "LOW_ACTIVATION", 10, ACTIVATION_DEFAULTS), "keep");
    assert.equal(retireDecision(-0.5, "retired", "LOW_ACTIVATION", 10, ACTIVATION_DEFAULTS), "reactivate");
    assert.equal(retireDecision(0, "retired", "LOW_SIGNAL", 10, ACTIVATION_DEFAULTS), "reactivate");
    assert.equal(
      retireDecision(0, "retired", "LOW_SIGNAL", 10, { ...ACTIVATION_DEFAULTS, reconsiderLegacy: false }),
      "keep",
    );
    assert.equal(retireDecision(0, "retired", "OUTDATED", 10, ACTIVATION_DEFAULTS), "keep");
  });
});

describe("activation: data loading", () => {
  it("folds usage, corrections, reactivations, and predecessor usage into an input", () => {
    const ctx = setup();
    try {
      const oldId = remember(ctx.db, ctx.config, "old orchard note", "a-old", "2026-01-01T00:00:00.000Z");
      addUsage(ctx.db, oldId, "2026-01-02T00:00:00.000Z");
      const ref = "auto-a-old";
      const corrected = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: oldId,
          body: "old orchard note revised",
          kind: "correction",
          provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: SCOPE,
          sourceRefs: [ref],
        },
        "a-corr",
        "2026-01-03T00:00:00.000Z",
      );
      assert.equal(corrected.ok, true, JSON.stringify(corrected));
      const newId = (corrected.data as { record: { id: string } }).record.id;
      addUsage(ctx.db, newId, "2026-01-04T00:00:00.000Z");

      const loaded = loadActivationInputs(ctx.db, SCOPE);
      const row = loaded.find((r) => r.recordId === newId);
      assert.ok(row);
      assert.ok(row.eventTimes.includes("2026-01-04T00:00:00.000Z"), "own usage");
      assert.ok(row.eventTimes.includes("2026-01-02T00:00:00.000Z"), "predecessor usage via supersedes");
      assert.equal(row.uses, 1);
      // The superseded predecessor is not a preview candidate.
      assert.equal(loaded.some((r) => r.recordId === oldId), false);
    } finally {
      ctx.cleanup();
    }
  });

  it("upgrades a v6 database in place and creates record_importance", () => {
    const ctx = setup();
    try {
      ctx.db.exec(`DROP TABLE record_importance`);
      ctx.db.exec(`PRAGMA user_version = 6`);
      ctx.db.close();
      const reopened = initDb(ctx.config, path.join(ctx.dir, "memory.config.json"));
      assert.equal(
        (reopened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version,
        SCHEMA_VERSION,
      );
      assert.ok(
        reopened.db
          .prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name='record_importance'`)
          .get(),
      );
      reopened.db.close();
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });

  it("trusts importance only while bodyHash matches and reads the versioned table", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "importance probe", "a-imp", "2026-01-05T00:00:00.000Z");
      const row = ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(id) as { bodyHash: string };
      ctx.db
        .prepare(
          `INSERT INTO record_importance(recordId, importance, bodyHash, source, scoredAt) VALUES (?, ?, ?, 'llm', ?)`,
        )
        .run(id, 0.9, row.bodyHash, NOW);
      let loaded = loadActivationInputs(ctx.db, SCOPE);
      assert.equal(loaded.find((r) => r.recordId === id)?.importance, 0.9);

      ctx.db
        .prepare(`UPDATE record_importance SET bodyHash = 'sha256:stale' WHERE recordId = ?`)
        .run(id);
      loaded = loadActivationInputs(ctx.db, SCOPE);
      assert.equal(loaded.find((r) => r.recordId === id)?.importance, null);

      assert.equal(SCHEMA_VERSION, 7);
      assert.throws(
        () =>
          ctx.db
            .prepare(
              `INSERT INTO record_importance(recordId, importance, bodyHash, source, scoredAt) VALUES ('x', 0.5, 'h', 'bogus', ?)`,
            )
            .run(NOW),
        /CHECK constraint failed/,
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("activation.preview", () => {
  it("orders by A ascending, reports summary counts, and pages", () => {
    const ctx = setup();
    try {
      const oldId = remember(ctx.db, ctx.config, "very old note", "p-old", "2025-06-01T00:00:00.000Z");
      const midId = remember(ctx.db, ctx.config, "mid note", "p-mid", "2026-01-01T00:00:00.000Z");
      const newId = remember(ctx.db, ctx.config, "new note", "p-new", "2026-01-10T23:00:00.000Z");
      const res = activationPreview(ctx.db, ctx.config, { scope: SCOPE, limit: 2 }, NOW);
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as {
        items: Array<{ id: string; A: number; decision: string; ageHours: number; uses: number }>;
        summary: { total: number; active: number; retired: number; keep: number; retire: number; reactivate: number };
        nextCursor: string | null;
      };
      assert.equal(data.items.length, 2);
      assert.equal(data.summary.total, 3);
      assert.equal(data.summary.active, 3);
      assert.equal(data.summary.retired, 0);
      assert.equal(data.summary.retire, 1);
      assert.equal(data.summary.keep, 2);
      assert.equal(data.summary.reactivate, 0);
      assert.equal(data.items[0].id, oldId);
      assert.equal(data.items[0].decision, "retire");
      assert.ok(data.items[0].A < data.items[1].A);
      assert.ok(data.nextCursor);

      // Recompute the expected A values independently for the page order.
      const inputs = loadActivationInputs(ctx.db, SCOPE);
      const expected = inputs
        .map((i) => ({ id: i.recordId, A: computeActivation(i, ACTIVATION_DEFAULTS, NOW) }))
        .sort((a, b) => (a.A === b.A ? (a.id < b.id ? -1 : 1) : a.A - b.A));
      assert.deepEqual(
        data.items.map((i) => i.id),
        expected.slice(0, 2).map((i) => i.id),
      );

      const page2 = activationPreview(
        ctx.db,
        ctx.config,
        { scope: SCOPE, limit: 2, cursor: data.nextCursor as string },
        NOW,
      );
      assert.equal(page2.ok, true);
      const items2 = (page2.data as { items: Array<{ id: string }> }).items;
      assert.equal(items2.length, 1);
      assert.equal(items2[0].id, expected[2].id);
      assert.ok(newId === items2[0].id || midId === items2[0].id);
    } finally {
      ctx.cleanup();
    }
  });

  it("pins the scoring clock in the cursor so tied pages do not vanish", () => {
    const ctx = setup();
    try {
      const ids = ["a", "b", "c"].map((k) =>
        remember(ctx.db, ctx.config, `tied note ${k}`, `p-tie-${k}`, "2026-01-01T00:00:00.000Z"),
      );
      const first = activationPreview(ctx.db, ctx.config, { scope: SCOPE, limit: 1 }, NOW);
      assert.equal(first.ok, true, JSON.stringify(first));
      const firstData = first.data as { items: Array<{ id: string }>; nextCursor: string | null };
      assert.equal(firstData.items.length, 1);
      assert.ok(firstData.nextCursor);

      // A later wall-clock must not re-score against the previous page's A:
      // the cursor's pinned `now` is authoritative.
      const later = "2026-01-11T00:00:01.000Z";
      const second = activationPreview(
        ctx.db,
        ctx.config,
        { scope: SCOPE, limit: 1, cursor: firstData.nextCursor as string },
        later,
      );
      const secondData = second.data as { items: Array<{ id: string }>; nextCursor: string | null };
      assert.equal(secondData.items.length, 1, "continuation must not be empty after clock drift");
      assert.ok(secondData.nextCursor);
      const third = activationPreview(
        ctx.db,
        ctx.config,
        { scope: SCOPE, limit: 1, cursor: secondData.nextCursor as string },
        later,
      );
      const thirdData = third.data as { items: Array<{ id: string }> };
      assert.equal(thirdData.items.length, 1);
      assert.deepEqual(
        [firstData.items[0].id, secondData.items[0].id, thirdData.items[0].id].sort(),
        [...ids].sort(),
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects a cursor without its pinned scoring timestamp", () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "cursor note", "p-cursor", "2026-01-01T00:00:00.000Z");
      const legacy = Buffer.from(JSON.stringify({ a: -1, id: "rec_x" }), "utf8").toString("base64url");
      assert.equal(
        activationPreview(ctx.db, ctx.config, { scope: SCOPE, cursor: legacy }, NOW).code,
        "BAD_REQUEST",
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("reactivates a recently retired LOW_ACTIVATION record and honors includeRetired", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "recent retired note", "p-ret", "2026-01-10T00:00:00.000Z");
      const ret = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: SCOPE, reasonCode: "LOW_ACTIVATION" },
        "p-ret-k",
        NOW,
      );
      assert.equal(ret.ok, true, JSON.stringify(ret));

      const res = activationPreview(ctx.db, ctx.config, { scope: SCOPE }, NOW);
      const data = res.data as {
        items: Array<{ id: string; status: string; decision: string; A: number }>;
        summary: { retired: number; reactivate: number };
      };
      assert.equal(data.summary.retired, 1);
      assert.equal(data.summary.reactivate, 1);
      assert.equal(data.items[0].decision, "reactivate");
      assert.ok(data.items[0].A >= -0.5);

      const hidden = activationPreview(ctx.db, ctx.config, { scope: SCOPE, includeRetired: false }, NOW);
      const hiddenData = hidden.data as { items: unknown[]; summary: { total: number } };
      assert.equal(hiddenData.items.length, 0);
      assert.equal(hiddenData.summary.total, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("is read-only: no record/heat/usage/exposure/audit/importance writes", () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "read only note", "p-ro", "2026-01-01T00:00:00.000Z");
      const counts = (): Record<string, number> => {
        const out: Record<string, number> = {};
        for (const t of ["records", "note_heat", "usage", "exposures", "audit", "record_importance"]) {
          out[t] = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get() as { n: number }).n;
        }
        return out;
      };
      const before = counts();
      const statusBefore = ctx.db.prepare(`SELECT id, status FROM records ORDER BY id`).all();

      const res = activationPreview(ctx.db, ctx.config, { scope: SCOPE }, NOW);
      assert.equal(res.ok, true, JSON.stringify(res));

      assert.deepEqual(counts(), before);
      assert.deepEqual(ctx.db.prepare(`SELECT id, status FROM records ORDER BY id`).all(), statusBefore);
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects bad params and unauthorized scopes", () => {
    const ctx = setup();
    try {
      assert.equal(activationPreview(ctx.db, ctx.config, {}, NOW).code, "BAD_REQUEST");
      assert.equal(activationPreview(ctx.db, ctx.config, { scope: "other/scope" }, NOW).code, "FORBIDDEN_SCOPE");
      assert.equal(activationPreview(ctx.db, ctx.config, { scope: SCOPE, limit: 0 }, NOW).code, "BAD_REQUEST");
      assert.equal(
        activationPreview(ctx.db, ctx.config, { scope: SCOPE, limit: 26 }, NOW).code,
        "LIMIT_EXCEEDED",
      );
      assert.equal(
        activationPreview(ctx.db, ctx.config, { scope: SCOPE, cursor: "not-a-cursor" }, NOW).code,
        "BAD_REQUEST",
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("activation config", () => {
  it("validates strict fields and rejects non-hysteretic thresholds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activation-cfg-"));
    try {
      const { config } = baseConfig(dir);
      const write = (obj: Record<string, unknown>): string => {
        const p = path.join(dir, `cfg-${ctr++}.json`);
        fs.writeFileSync(p, JSON.stringify(obj), "utf8");
        return p;
      };
      const base = { ...config };
      const loaded = loadConfig(write({ ...base, activation: {} }));
      assert.equal(loaded.activation?.decay, 0.5);
      assert.equal(loaded.activation?.minAgeHours, 72);
      assert.equal(loaded.activation?.wKind.correction, 1);
      assert.equal(loaded.activation?.reconsiderLegacy, true);

      assert.throws(
        () => loadConfig(write({ ...base, activation: { tauRetire: -0.5, tauReactivate: -1.5 } })),
        /tauRetire must be < activation.tauReactivate/,
      );
      assert.throws(
        () => loadConfig(write({ ...base, activation: { wKind: { bogus: 1 } } })),
        /unknown activation.wKind field/,
      );
      assert.throws(
        () => loadConfig(write({ ...base, activation: { decay: 3 } })),
        /activation.decay/,
      );
      assert.throws(
        () => loadConfig(write({ ...base, activation: { reconsiderLegacy: "yes" } })),
        /reconsiderLegacy must be a boolean/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("activation: importance prompt and strict parsing", () => {
  it("builds a bounded Japanese ChatML prompt with generic few-shots", () => {
    const prompt = buildImportancePrompt("コーヒーはブラックが好き", 1200);
    assert.ok(prompt.startsWith("<|im_start|>system\n"));
    assert.ok(prompt.includes("重要度評価器"));
    assert.ok(prompt.includes("コーヒーはブラックが好き"));
    assert.ok(prompt.endsWith("<|im_end|>\n<|im_start|>assistant\n"));
    assert.ok(prompt.includes("→ 3"));
    const short = buildImportancePrompt("あ".repeat(5000), 700);
    assert.ok([...short].length <= 700);
  });

  it("accepts exactly one digit 0..3 and rejects everything else", () => {
    assert.equal(parseImportance("0"), 0);
    assert.equal(parseImportance("3"), 3);
    assert.equal(parseImportance(" 2\n"), 2);
    for (const raw of ["", "4", "-1", "2.0", "two", "2点", "1 2", "importance: 3", null, undefined]) {
      assert.equal(parseImportance(raw as string | null | undefined), null, String(raw));
    }
  });
});

describe("activation: maintain.activation", () => {
  it("scores missing importance once and skips current rows", async () => {
    const ctx = setup({ apply: false });
    try {
      const a = remember(ctx.db, ctx.config, "lasting preference alpha", "s-a", "2026-01-01T00:00:00.000Z");
      const b = remember(ctx.db, ctx.config, "minor chatter beta", "s-b", "2026-01-02T00:00:00.000Z");
      let calls = 0;
      const generate = async (prompt: string): Promise<string> => {
        calls++;
        assert.ok(prompt.includes("重要度"));
        return "3";
      };
      const first = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-score-1",
        generate,
        NOW,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      const d1 = first.data as {
        scored: number;
        scoreFailed: number;
        retired: number;
        wouldRetire: number;
        degraded: boolean;
      };
      assert.equal(d1.scored, 2);
      assert.equal(d1.scoreFailed, 0);
      assert.equal(d1.degraded, false);
      assert.equal(d1.retired, 0);
      assert.equal(calls, 2);

      const rows = ctx.db
        .prepare(`SELECT recordId, importance, source, bodyHash FROM record_importance ORDER BY recordId`)
        .all() as unknown as Array<{ recordId: string; importance: number; source: string; bodyHash: string }>;
      assert.equal(rows.length, 2);
      assert.deepEqual(rows.map((r) => r.recordId).sort(), [a, b].sort());
      for (const row of rows) {
        assert.equal(row.importance, 1);
        assert.equal(row.source, "llm");
        const hash = (ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(row.recordId) as { bodyHash: string }).bodyHash;
        assert.equal(row.bodyHash, hash);
      }

      const second = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-score-2",
        generate,
        NOW,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal((second.data as { scored: number }).scored, 0);
      assert.equal(calls, 2, "current importance rows are not re-scored");
    } finally {
      ctx.cleanup();
    }
  });

  it("apply=false reports wouldRetire and makes no status changes (default)", async () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "very old low signal note", "m-old", "2025-06-01T00:00:00.000Z");
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-preview-1",
        undefined,
        NOW,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as {
        retired: number;
        reactivated: number;
        wouldRetire: number;
        wouldReactivate: number;
        degraded: boolean;
      };
      assert.equal(data.retired, 0);
      assert.equal(data.reactivated, 0);
      assert.equal(data.wouldRetire, 1);
      assert.equal(data.degraded, true);
      const status = (ctx.db.prepare(`SELECT status FROM records WHERE id = ?`).get(id) as { status: string }).status;
      assert.equal(status, "active");
    } finally {
      ctx.cleanup();
    }
  });

  it("apply=true retires low-activation old records with LOW_ACTIVATION audit", async () => {
    const ctx = setup({ apply: true });
    try {
      const id = remember(ctx.db, ctx.config, "stale durable note", "m-ret", "2025-06-01T00:00:00.000Z");
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-apply-retire",
        undefined,
        NOW,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as { retired: number; reactivated: number; wouldRetire: number };
      assert.equal(data.retired, 1);
      assert.equal(data.reactivated, 0);
      const status = (ctx.db.prepare(`SELECT status FROM records WHERE id = ?`).get(id) as { status: string }).status;
      assert.equal(status, "retired");
      const audit = ctx.db
        .prepare(
          `SELECT reasonCode FROM audit WHERE op = 'record.retire' AND targetId = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(id) as { reasonCode: string } | undefined;
      assert.equal(audit?.reasonCode, "LOW_ACTIVATION");
    } finally {
      ctx.cleanup();
    }
  });

  it("apply=true reactivates legacy LOW_SIGNAL records above tauReactivate", async () => {
    const ctx = setup({ apply: true });
    try {
      const id = remember(ctx.db, ctx.config, "recent legacy retired note", "m-legacy", "2026-01-10T12:00:00.000Z");
      const ret = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: SCOPE, reasonCode: "LOW_SIGNAL" },
        "act-legacy-retire",
        NOW,
      );
      assert.equal(ret.ok, true, JSON.stringify(ret));
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-apply-react",
        undefined,
        NOW,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as { retired: number; reactivated: number; wouldReactivate: number };
      assert.equal(data.reactivated, 1);
      assert.equal(data.retired, 0);
      const status = (ctx.db.prepare(`SELECT status FROM records WHERE id = ?`).get(id) as { status: string }).status;
      assert.equal(status, "active");
      const audit = ctx.db
        .prepare(
          `SELECT reasonCode FROM audit WHERE op = 'record.reactivate' AND targetId = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(id) as { reasonCode: string } | undefined;
      assert.equal(audit?.reasonCode, "STILL_USEFUL");
    } finally {
      ctx.cleanup();
    }
  });

  it("reactivates a record retired by the real distill apply path (LOW_SIGNAL provenance)", async () => {
    const ctx = setup({ apply: true });
    try {
      const id = remember(
        ctx.db,
        ctx.config,
        "passing mood with no lasting content",
        "m-distill-retire",
        "2026-01-10T23:00:00.000Z",
      );
      // maintain.distill needs a provisioned model to dequeue; the actual
      // decisions are injected, so the files only satisfy the presence check.
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
        maxPromptChars: 2000,
        // master gates auto-retirement on the OpenAI-compatible backend; the
        // decisions are still injected, so loopback+model just satisfy the
        // usability gate.
        backend: "openai",
        baseUrl: "http://127.0.0.1:1234/v1",
        model: "test-model",
      };
      // master's #35 grace period defaults to 24h; this fixture retires a
      // one-hour-old record on purpose, so disable only the delay.
      ctx.config.cultivation = { retireMinAgeMs: 0 } as unknown as NonNullable<
        AppConfig["cultivation"]
      >;
      const decide = async (prompt: string): Promise<string | null> =>
        prompt.includes("You classify one memory") ? "TRANSIENT" : "KEEP";
      const distilled = await maintainDistill(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE, limit: 5 },
        "act-distill-retire",
        decide,
        NOW,
      );
      assert.equal(distilled.ok, true, JSON.stringify(distilled));
      assert.equal(
        (distilled.data as { distill: { applied: number } }).distill.applied,
        1,
      );
      const retired = ctx.db
        .prepare(`SELECT status FROM records WHERE id = ?`)
        .get(id) as { status: string };
      assert.equal(retired.status, "retired");
      const retAudit = ctx.db
        .prepare(
          `SELECT op, reasonCode FROM audit WHERE targetId = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(id) as { op: string; reasonCode: string } | undefined;
      assert.equal(retAudit?.op, "maintain.cultivate");
      assert.equal(retAudit?.reasonCode, "LOW_SIGNAL");

      // The loader must read provenance from the cultivate apply audit row,
      // not only from record.retire.
      const loaded = loadActivationInputs(ctx.db, SCOPE);
      assert.equal(loaded.find((r) => r.recordId === id)?.retireReason, "LOW_SIGNAL");

      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-distill-reactivate",
        async () => "3",
        NOW,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as { reactivated: number; wouldReactivate: number; retired: number };
      assert.equal(data.reactivated, 1);
      assert.equal(data.wouldReactivate, 1);
      assert.equal(data.retired, 0);
      const status = ctx.db
        .prepare(`SELECT status FROM records WHERE id = ?`)
        .get(id) as { status: string };
      assert.equal(status.status, "active");
      const reactAudit = ctx.db
        .prepare(
          `SELECT reasonCode FROM audit WHERE op = 'record.reactivate' AND targetId = ? ORDER BY rowid DESC LIMIT 1`,
        )
        .get(id) as { reasonCode: string } | undefined;
      assert.equal(reactAudit?.reasonCode, "STILL_USEFUL");
    } finally {
      ctx.cleanup();
    }
  });

  it("protectImportance keeps high-importance records unless well below tauRetire", () => {
    const p = ACTIVATION_DEFAULTS;
    assert.equal(retireDecision(-2, "active", null, 400, p, 0.7), "keep");
    assert.equal(retireDecision(-2, "active", null, 400, p, 0.7, 0.66), "keep");
    assert.equal(retireDecision(-2.6, "active", null, 400, p, 0.7, 0.66), "retire");
    assert.equal(retireDecision(-2, "active", null, 400, p, 0.5, 0.66), "retire");
    assert.equal(retireDecision(-2, "active", null, 400, p, 0.66, 0.66), "keep");
  });

  it("shares the cultivation lease: contention is CONFLICT", async () => {
    const ctx = setup();
    try {
      const held = acquireCultivationLease(ctx.db, ctx.config, {
        owner: "other-owner",
        scope: SCOPE,
        now: NOW,
      });
      assert.equal(held.acquired, true);
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-lease",
        undefined,
        NOW,
      );
      assert.equal(res.ok, false);
      assert.equal(res.code, "CONFLICT");
      releaseCultivationLease(ctx.db, "other-owner");
    } finally {
      ctx.cleanup();
    }
  });

  it("fences importance writes against the current lease clock, not the pre-inference time", async () => {
    const ctx = setup();
    try {
      ctx.config.cultivation = { leaseTtlMs: 1000 } as unknown as NonNullable<
        AppConfig["cultivation"]
      >;
      remember(ctx.db, ctx.config, "slow scoring note", "m-lease-clock", "2025-06-01T00:00:00.000Z");
      const generate = async (): Promise<string> => {
        await new Promise((r) => setTimeout(r, 1100));
        return "3";
      };
      // No nowOverride: renewNow() uses the wall clock, so the 1s lease is
      // expired by the time the slow inference returns.
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-lease-clock",
        generate,
      );
      assert.equal(res.ok, false);
      assert.equal(res.code, "CONFLICT");
      const rows = ctx.db.prepare(`SELECT COUNT(*) AS n FROM record_importance`).get() as { n: number };
      assert.equal(rows.n, 0, "expired lease must not commit importance");
    } finally {
      ctx.cleanup();
    }
  });

  it("aborts activation writes over dbMaxBytes with STORE_UNAVAILABLE", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "cap probe note", "m-cap", "2025-06-01T00:00:00.000Z");
      ctx.config.dbMaxBytes = 1;
      const scored = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-cap-score",
        async () => "3",
        NOW,
      );
      assert.equal(scored.ok, false);
      assert.equal(scored.code, "STORE_UNAVAILABLE");
      const importance = ctx.db.prepare(`SELECT COUNT(*) AS n FROM record_importance`).get() as {
        n: number;
      };
      assert.equal(importance.n, 0, "importance rows roll back with the cap rejection");

      // Preview-only (model disabled) must also refuse the operations/audit
      // write when the cap is already exceeded.
      const previewOnly = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-cap-preview",
        undefined,
        NOW,
      );
      assert.equal(previewOnly.ok, false);
      assert.equal(previewOnly.code, "STORE_UNAVAILABLE");
      const ops = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM operations WHERE op = 'maintain.activation'`)
        .get() as { n: number };
      assert.equal(ops.n, 0);
      const audit = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM audit WHERE op = 'maintain.activation'`)
        .get() as { n: number };
      assert.equal(audit.n, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("advances the bounded maintenance scan past the oldest 2,000 records and wraps", async () => {
    const ctx = setup();
    try {
      // 2,000 older retired rows fill the window; the newer active row is
      // only reachable via the persisted (createdAt, id) continuation.
      const insert = ctx.db.prepare(
        `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
         VALUES (?, ?, ?, ?, 'user_fact', 'test', ?, ?, 'retired', NULL, 1, ?)`,
      );
      ctx.db.exec("BEGIN");
      for (let i = 0; i < 2000; i++) {
        const id = `rec-old-${String(i).padStart(4, "0")}`;
        const body = `old retired ${i}`;
        insert.run(id, body, body, `hash-${i}`, OBS, SCOPE, "2020-01-01T00:00:00.000Z");
      }
      ctx.db.exec("COMMIT");
      const newId = remember(ctx.db, ctx.config, "new low signal note", "m-scan-new", "2025-06-01T00:00:00.000Z");

      const run = (key: string) =>
        maintainActivation(
          ctx.db,
          ctx.config,
          path.join(ctx.dir, "memory.config.json"),
          { scope: SCOPE },
          key,
          undefined,
          NOW,
        );
      const first = await run("act-scan-1");
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal((first.data as { wouldRetire: number }).wouldRetire, 0);

      const second = await run("act-scan-2");
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(
        (second.data as { wouldRetire: number }).wouldRetire,
        1,
        "newer record must be examined after the cursor advances",
      );

      const third = await run("act-scan-3");
      assert.equal(third.ok, true, JSON.stringify(third));
      assert.equal(
        (third.data as { wouldRetire: number }).wouldRetire,
        0,
        "scan wraps to the oldest window after reaching the end",
      );
      const status = (ctx.db.prepare(`SELECT status FROM records WHERE id = ?`).get(newId) as {
        status: string;
      }).status;
      assert.equal(status, "active");
    } finally {
      ctx.cleanup();
    }
  });

  it("replays the same key and rejects changed params", async () => {
    const ctx = setup();
    try {
      remember(ctx.db, ctx.config, "replay probe", "m-replay", "2025-06-01T00:00:00.000Z");
      const first = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-replay",
        undefined,
        NOW,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal(first.deduplicated, false);
      const second = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-replay",
        undefined,
        NOW,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal(second.deduplicated, true);
      assert.deepEqual(second.data, first.data);
      const conflict = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE, limit: 5 },
        "act-replay",
        undefined,
        NOW,
      );
      assert.equal(conflict.ok, false);
      assert.equal(conflict.code, "CONFLICT");
    } finally {
      ctx.cleanup();
    }
  });

  it("validates activation batchMax/apply/protectImportance", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activation-cfg2-"));
    try {
      const { config } = baseConfig(dir);
      const write = (obj: Record<string, unknown>, name: string): string => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, JSON.stringify(obj), "utf8");
        return p;
      };
      const loaded = loadConfig(write({ ...config, activation: {} }, "a.json"));
      assert.equal(loaded.activation?.batchMax, 20);
      assert.equal(loaded.activation?.apply, false);
      assert.equal(loaded.activation?.protectImportance, 0.66);
      assert.throws(
        () => loadConfig(write({ ...config, activation: { batchMax: 201 } }, "b.json")),
        /activation.batchMax/,
      );
      assert.throws(
        () => loadConfig(write({ ...config, activation: { apply: "yes" } }, "c.json")),
        /activation.apply must be a boolean/,
      );
      assert.throws(
        () => loadConfig(write({ ...config, activation: { protectImportance: 1.5 } }, "d.json")),
        /activation.protectImportance/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
