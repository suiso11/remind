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
import { RETENTION_LEARN_DEFAULTS, loadConfig, type ActivationConfig } from "../src/config.js";
import { eventAppend, correctRecord, rememberRecord, retireRecord } from "../src/store.js";
import { acquireCultivationLease, applyCultivationBatch, releaseCultivationLease } from "../src/cultivation.js";
import { chatMlToMessages } from "../src/llm.js";
import { maintainDistill } from "../src/distill.js";
import {
  ACTIVATION_DEFAULTS,
  activationAgeHours,
  activationPreview,
  CLASSIFIER_SOURCE,
  CLASSIFIER_VERSION,
  NATURE_LABELS,
  buildClassifierPrompt,
  computeActivation,
  loadActivationInputs,
  maintainActivation,
  parseNatureClassification,
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
    nature: null,
    links: 0,
    expired: false,
    consolidated: false,
    latestReactivationReason: null,
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
    assert.equal(retireDecision(0, "retired", "OUTDATED", 10, ACTIVATION_DEFAULTS), "reactivate");
    assert.equal(retireDecision(0, "retired", "CONSOLIDATED", 10, ACTIVATION_DEFAULTS), "reactivate");
    assert.equal(retireDecision(0, "retired", "NO_LONGER_USEFUL", 10, ACTIVATION_DEFAULTS), "keep");
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

  it("upgrades a v9 database in place: keeps importance and adds nullable nature", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "v9 migration probe", "a-v9", "2026-01-06T00:00:00.000Z");
      const row = ctx.db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(id) as { bodyHash: string };
      ctx.db.prepare(`INSERT INTO record_importance(recordId, importance, nature, bodyHash, source, scoredAt) VALUES (?, 0.75, 'FACT', ?, 'llm', ?)`).run(id, row.bodyHash, NOW);
      // Simulate the pre-v10 ledger: no nature column, version stamp 9.
      ctx.db.exec(`CREATE TABLE ri_old(recordId TEXT PRIMARY KEY, importance REAL NOT NULL, bodyHash TEXT NOT NULL, source TEXT NOT NULL CHECK(source IN ('llm','external')), scoredAt TEXT NOT NULL)`);
      ctx.db.exec(`INSERT INTO ri_old SELECT recordId, importance, bodyHash, source, scoredAt FROM record_importance`);
      ctx.db.exec(`DROP TABLE record_importance`);
      ctx.db.exec(`ALTER TABLE ri_old RENAME TO record_importance`);
      ctx.db.exec(`PRAGMA user_version = 9`);
      ctx.db.close();
      const reopened = initDb(ctx.config, path.join(ctx.dir, "memory.config.json"));
      assert.equal((reopened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
      const cols = reopened.db.prepare(`PRAGMA table_info(record_importance)`).all() as Array<{ name: string; notnull: number }>;
      const nature = cols.find((c) => c.name === "nature");
      assert.ok(nature);
      assert.equal(nature?.notnull, 0, "nature is nullable");
      const kept = reopened.db.prepare(`SELECT importance, nature FROM record_importance WHERE recordId = ?`).get(id) as { importance: number; nature: string | null };
      assert.equal(kept.importance, 0.75);
      assert.equal(kept.nature, null);
      // The v9 source CHECK is rebuilt so the versioned classifier source fits.
      reopened.db
        .prepare(`UPDATE record_importance SET source = ? WHERE recordId = ?`)
        .run(CLASSIFIER_SOURCE, id);
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

      assert.equal(SCHEMA_VERSION, 12);
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
      assert.equal(loaded.activation?.wNature.GREETING, -2.5);
      assert.equal(loaded.activation?.wNature.CHATOPS, -2.0);
      assert.equal(loaded.activation?.wLinks, 0.8);
      assert.equal(loaded.activation?.expiryGraceDays, 3);
      assert.equal(loaded.activation?.wExpired, 2.0);
      assert.equal(loaded.activation?.wConsolidated, 0.5);
      assert.equal(loaded.activation?.minAgeHoursByNature.GREETING, 24);

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
        () => loadConfig(write({ ...base, activation: { reconsiderLegacy: true } })),
        /unknown activation field: reconsiderLegacy/,
      );
      assert.throws(
        () => loadConfig(write({ ...base, activation: { wNature: { BOGUS: 1 } } })),
        /unknown activation.wNature field/,
      );
      assert.throws(
        () => loadConfig(write({ ...base, activation: { minAgeHoursByNature: { GREETING: -1 } } })),
        /activation.minAgeHoursByNature.GREETING/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts fractional learner coefficients and continuous activation fields", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "activation-cfg-frac-"));
    try {
      const { config } = baseConfig(dir);
      const write = (obj: Record<string, unknown>, name: string): string => {
        const p = path.join(dir, name);
        fs.writeFileSync(p, JSON.stringify(obj), "utf8");
        return p;
      };
      const fractional = loadConfig(
        write({ ...config, activation: { learn: { maxDrift: 1.5, lambda: 0.5 } } }, "f.json"),
      );
      assert.equal(fractional.activation?.learn?.maxDrift, 1.5);
      assert.equal(fractional.activation?.learn?.lambda, 0.5);

      // Default-filled configs must load: maxDrift defaults to 1.5.
      const defaults = loadConfig(write({ ...config, activation: { learn: {} } }, "d.json"));
      assert.equal(defaults.activation?.learn?.enabled, RETENTION_LEARN_DEFAULTS.enabled);
      assert.equal(defaults.activation?.learn?.maxDrift, RETENTION_LEARN_DEFAULTS.maxDrift);
      assert.equal(defaults.activation?.learn?.lambda, RETENTION_LEARN_DEFAULTS.lambda);

      // The documented rollback shape (enabled:false) also keeps defaults.
      const rollback = loadConfig(
        write({ ...config, activation: { learn: { enabled: false } } }, "r.json"),
      );
      assert.equal(rollback.activation?.learn?.enabled, false);
      assert.equal(rollback.activation?.learn?.maxDrift, 1.5);

      const continuous = loadConfig(
        write(
          {
            ...config,
            activation: {
              minAgeHours: 0.5,
              expiryGraceDays: 0.25,
              minAgeHoursByNature: { GREETING: 0.5 },
              wLinks: 0.8,
              wNature: { GREETING: -2.25 },
            },
          },
          "c.json",
        ),
      );
      assert.equal(continuous.activation?.minAgeHours, 0.5);
      assert.equal(continuous.activation?.expiryGraceDays, 0.25);
      assert.equal(continuous.activation?.minAgeHoursByNature?.GREETING, 0.5);
      assert.equal(continuous.activation?.wLinks, 0.8);
      assert.equal(continuous.activation?.wNature?.GREETING, -2.25);

      assert.throws(
        () => loadConfig(write({ ...config, activation: { learn: { lambda: -1 } } }, "e.json")),
        /activation.learn.lambda must be a number in 0..10/,
      );
      assert.throws(
        () => loadConfig(write({ ...config, activation: { learn: { maxDrift: "1.5" } } }, "s.json")),
        /activation.learn.maxDrift must be a number in 0..100/,
      );
      assert.throws(
        () => loadConfig(write({ ...config, activation: { minAgeHours: -0.5 } }, "n.json")),
        /activation.minAgeHours must be a number in 0..87600/,
      );
      // Counts and caps stay integer-only.
      assert.throws(
        () => loadConfig(write({ ...config, activation: { learn: { minExamples: 1.5 } } }, "i.json")),
        /activation.learn.minExamples must be an integer/,
      );
      assert.throws(
        () => loadConfig(write({ ...config, activation: { batchMax: 1.5 } }, "b.json")),
        /activation.batchMax must be an integer/,
      );
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("activation: combined classifier prompt and strict parsing", () => {
  it("builds a bounded Japanese ChatML prompt with the nature contract", () => {
    const prompt = buildClassifierPrompt("コーヒーはブラックが好き", 2000);
    assert.ok(prompt.startsWith("<|im_start|>system\n"));
    assert.ok(prompt.includes("分類器"));
    assert.ok(prompt.includes("コーヒーはブラックが好き"));
    assert.ok(prompt.endsWith("<|im_end|>\n<|im_start|>assistant\n"));
    for (const label of NATURE_LABELS) assert.ok(prompt.includes(label), label);
    assert.ok(prompt.includes("\"nature\""));
    for (const max of [500, 1200]) {
      // Below the fixed instruction size the contract wins over the cap: the
      // prompt keeps all instructions plus at least 200 body code points.
      const clipped = buildClassifierPrompt("あ".repeat(5000), max);
      assert.ok(clipped.startsWith("<|im_start|>system\n"), `keeps system at ${max}`);
      assert.ok(clipped.includes("分類器"), `keeps instructions at ${max}`);
      assert.ok(clipped.includes("あ".repeat(200)), `keeps 200cp body at ${max}`);
      assert.ok(!clipped.includes("あ".repeat(201)), `clips body at ${max}`);
      assert.ok(clipped.endsWith("<|im_start|>assistant\n"), "keeps assistant cue");
      // The ChatML must always split into real roles (never cue-only).
      const conv = chatMlToMessages(clipped);
      assert.ok(conv, `converts at ${max}`);
      // The trailing assistant cue is an empty prefill: the conversion must
      // still yield real system+user messages (never null / cue-only).
      assert.deepEqual(conv.messages.map((m) => m.role), ["system", "user"]);
      assert.equal(conv.prefill, "");
      assert.ok(conv.messages[0]!.content.includes("分類器"));
      assert.ok(conv.messages[1]!.content.includes("あ".repeat(200)));
    }
  });

  it("parses strict combined JSON and tolerates surrounding text", () => {
    assert.deepEqual(parseNatureClassification('{"nature":"FACT","importance":3}'), { nature: "FACT", importance: 3 });
    assert.deepEqual(
      parseNatureClassification('説明です。\n{"nature":"TRANSIENT","importance":0}\n以上'),
      { nature: "TRANSIENT", importance: 0 },
    );
    assert.deepEqual(
      parseNatureClassification('{"nature":"PREFERENCE","importance":2}'),
      { nature: "PREFERENCE", importance: 2 },
    );
    // Thinking blocks are stripped before the first JSON object is taken.
    assert.deepEqual(
      parseNatureClassification('<think>{"nature":"GREETING","importance":0}</think>{"nature":"PLAN","importance":3}'),
      { nature: "PLAN", importance: 3 },
    );
  });

  it("rejects wrong labels, out-of-range/non-integer importance, and malformed output", () => {
    for (const raw of [
      "",
      null,
      undefined,
      "not json",
      '{"nature":"UNKNOWN","importance":2}',
      '{"nature":"fact","importance":2}',
      '{"nature":"FACT","importance":4}',
      '{"nature":"FACT","importance":-1}',
      '{"nature":"FACT","importance":2.5}',
      '{"nature":"FACT","importance":"2"}',
      '{"nature":"FACT"}',
      '{"nature":"FACT","importance":2,"extra":true}',
      '["FACT",2]',
      '{"nature":"FACT","importance":2',
    ]) {
      assert.equal(parseNatureClassification(raw as string | null | undefined), null, String(raw));
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
        assert.ok(prompt.includes("分類器"));
        return '{"nature":"FACT","importance":3}';
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
        assert.equal(row.source, CLASSIFIER_SOURCE);
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

  it("rescans rows whose classifier version is stale and stamps the current version", async () => {
    const ctx = setup({ apply: false });
    try {
      const id = remember(ctx.db, ctx.config, "version probe note", "s-ver", "2026-01-01T00:00:00.000Z");
      let calls = 0;
      const generate = async (): Promise<string> => {
        calls++;
        return calls === 1 ? '{"nature":"FACT","importance":3}' : '{"nature":"PREFERENCE","importance":2}';
      };
      const first = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-ver-1",
        generate,
        NOW,
      );
      assert.equal(first.ok, true, JSON.stringify(first));
      assert.equal((first.data as { scored: number }).scored, 1);
      assert.equal(CLASSIFIER_VERSION, "v2");

      // Simulate a row written by the v1 prompt: same body hash and nature,
      // but an older source. selectUnscored must pick it up exactly once.
      ctx.db.prepare(`UPDATE record_importance SET source = 'llm' WHERE recordId = ?`).run(id);
      const second = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-ver-2",
        generate,
        NOW,
      );
      assert.equal(second.ok, true, JSON.stringify(second));
      assert.equal((second.data as { scored: number }).scored, 1);
      const stored = ctx.db
        .prepare(`SELECT source, nature, importance FROM record_importance WHERE recordId = ?`)
        .get(id) as { source: string; nature: string; importance: number };
      assert.equal(stored.source, CLASSIFIER_SOURCE);
      assert.equal(stored.nature, "PREFERENCE");
      assert.equal(stored.importance, 2 / 3);

      const third = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-ver-3",
        generate,
        NOW,
      );
      assert.equal(third.ok, true, JSON.stringify(third));
      assert.equal((third.data as { scored: number }).scored, 0, "current version is not rescored");
      assert.equal(calls, 2);
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

  it("reactivates a retired LOW_SIGNAL record while the classifier scores it", async () => {
    const ctx = setup({ apply: true });
    try {
      const id = remember(ctx.db, ctx.config, "passing mood with no lasting content", "m-retire-probe", "2026-01-10T23:00:00.000Z");
      // Retirement itself is no longer a distill concern; it is decided by the
      // combined retention score in maintain.activation. Seed a retired row to
      // exercise the reactivation path.
      const ret = retireRecord(ctx.db, ctx.config, { id, scope: SCOPE, reasonCode: "LOW_SIGNAL" }, "act-retire-probe", NOW);
      assert.equal(ret.ok, true, JSON.stringify(ret));
      let prompts = 0;
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-retire-reactivate",
        async () => {
          prompts++;
          return '{"nature":"EMOTION","importance":3}';
        },
        NOW,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.ok(prompts >= 1);
      const stored = ctx.db.prepare(`SELECT importance, nature FROM record_importance WHERE recordId = ?`).get(id) as { importance: number; nature: string } | undefined;
      assert.equal(stored?.importance, 1);
      assert.equal(stored?.nature, "EMOTION");
      const data = res.data as { reactivated: number; wouldReactivate: number; retired: number };
      assert.equal(data.reactivated, 1);
      assert.equal(data.wouldReactivate, 1);
      assert.equal(data.retired, 0);
      const status = ctx.db.prepare(`SELECT status FROM records WHERE id = ?`).get(id) as { status: string };
      assert.equal(status.status, "active");
      const reactAudit = ctx.db
        .prepare(`SELECT reasonCode FROM audit WHERE op = 'record.reactivate' AND targetId = ? ORDER BY rowid DESC LIMIT 1`)
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

  it("heartbeats the lease through inference longer than leaseTtlMs", async () => {
    const ctx = setup();
    try {
      ctx.config.cultivation = { leaseTtlMs: 1000 } as unknown as NonNullable<
        AppConfig["cultivation"]
      >;
      remember(ctx.db, ctx.config, "slow scoring note", "m-lease-clock", "2025-06-01T00:00:00.000Z");
      const generate = async (): Promise<string> => {
        // Longer than the 1s lease: without the heartbeat the fenced write
        // would be rejected as CONFLICT even though no other process ran.
        await new Promise((r) => setTimeout(r, 1100));
        return '{"nature":"FACT","importance":3}';
      };
      // No nowOverride: renewNow() uses the wall clock.
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-lease-clock",
        generate,
      );
      const data = res.data as { scored: number };
      assert.equal(res.ok, true, JSON.stringify(res));
      assert.equal(data.scored, 1);
      const rows = ctx.db.prepare(`SELECT COUNT(*) AS n FROM record_importance`).get() as { n: number };
      assert.equal(rows.n, 1, "heartbeat keeps the lease live for the commit");
    } finally {
      ctx.cleanup();
    }
  });

  it("writes nothing when the lease is stolen mid-inference", async () => {
    const ctx = setup();
    try {
      ctx.config.cultivation = { leaseTtlMs: 1000 } as unknown as NonNullable<
        AppConfig["cultivation"]
      >;
      remember(ctx.db, ctx.config, "stolen lease note", "m-lease-steal", "2025-06-01T00:00:00.000Z");
      let signal: AbortSignal | undefined;
      const generate = async (_p: string, _t: number, s?: AbortSignal): Promise<string> => {
        signal = s;
        // Steal by presenting a clock past the current expiry; the heartbeat
        // then renews under a foreign owner and must abort.
        const stolen = acquireCultivationLease(ctx.db, ctx.config, {
          owner: "thief",
          scope: SCOPE,
          now: new Date(Date.now() + 60000).toISOString(),
        });
        assert.equal(stolen.acquired, true);
        await new Promise((r) => setTimeout(r, 900));
        return '{"nature":"FACT","importance":3}';
      };
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "act-lease-steal",
        generate,
      );
      assert.equal(res.ok, false);
      assert.equal(res.code, "CONFLICT");
      assert.equal(signal?.aborted, true, "lost lease aborts the in-flight generation");
      const rows = ctx.db.prepare(`SELECT COUNT(*) AS n FROM record_importance`).get() as { n: number };
      assert.equal(rows.n, 0, "a stolen lease must not commit importance");
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
        async () => '{"nature":"FACT","importance":3}',
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

/* ------------------------------------------------------------------ */
/* Multi-factor retention score                                        */
/* ------------------------------------------------------------------ */

function setScore(
  db: DatabaseSync,
  id: string,
  importance: number,
  nature: string | null,
): void {
  const row = db.prepare(`SELECT bodyHash FROM records WHERE id = ?`).get(id) as { bodyHash: string };
  db.prepare(
    `INSERT INTO record_importance(recordId, importance, nature, bodyHash, source, scoredAt)
     VALUES (?, ?, ?, ?, 'llm', ?)
     ON CONFLICT(recordId) DO UPDATE SET
       importance = excluded.importance, nature = excluded.nature,
       bodyHash = excluded.bodyHash, source = excluded.source, scoredAt = excluded.scoredAt`,
  ).run(id, importance, nature, row.bodyHash, NOW);
}

function linkRecord(db: DatabaseSync, from: string, to: string): void {
  db.prepare(`INSERT OR IGNORE INTO record_links(fromId, toRef) VALUES (?, ?)`).run(from, to);
}

function similarEdge(db: DatabaseSync, x: string, y: string): void {
  const [a, b] = x < y ? [x, y] : [y, x];
  db.prepare(
    `INSERT OR REPLACE INTO similar_edges(scope, a, b, score, computedAt) VALUES (?, ?, ?, 0.9, ?)`,
  ).run(SCOPE, a, b, NOW);
}

function previewItems(ctx: { db: DatabaseSync; config: AppConfig }, now = NOW) {
  const res = activationPreview(ctx.db, ctx.config, { scope: SCOPE }, now);
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as {
    items: Array<{
      id: string;
      nature: string | null;
      A: number;
      importance: number | null;
      decision: string;
      reason: string | null;
      factors: Record<string, number>;
    }>;
  }).items;
}

function decide(ctx: { db: DatabaseSync; config: AppConfig }, id: string, now = NOW) {
  return previewItems(ctx, now).find((i) => i.id === id);
}

/** Stage one transition through applyCultivationBatch (audited as maintain.cultivate). */
function cultivate(
  ctx: { db: DatabaseSync; config: AppConfig },
  key: string,
  recordId: string,
  action: "retire" | "reactivate",
  reasonCode: string,
  now: string,
): void {
  const res = applyCultivationBatch(
    ctx.db,
    ctx.config,
    {
      scope: SCOPE,
      idempotencyKey: key,
      actions: [{ recordId, action, reasonCode }],
    },
    now,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
}

describe("activation: multi-factor retention score", () => {
  it("retires an unlinked 30h-old greeting but keeps an old durable FACT", () => {
    const ctx = setup();
    try {
      const greet = remember(ctx.db, ctx.config, "おはよう", "r-greet", "2026-01-09T18:00:00.000Z");
      setScore(ctx.db, greet, 0, "GREETING");
      const fact = remember(
        ctx.db,
        ctx.config,
        "東京在住、自転車通勤",
        "r-fact",
        "2026-01-01T00:00:00.000Z",
      );
      setScore(ctx.db, fact, 1, "FACT");

      const greeting = decide(ctx, greet);
      const durable = decide(ctx, fact);
      assert.equal(greeting?.decision, "retire");
      assert.equal(greeting?.reason, "LOW_ACTIVATION");
      assert.equal(durable?.decision, "keep");
      assert.equal(durable?.importance, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("keeps linked EMOTION but retires the same unlinked EMOTION", () => {
    const ctx = setup();
    try {
      const unlinked = remember(ctx.db, ctx.config, "少し寂しい", "r-emo-u", "2026-01-01T00:00:00.000Z");
      const linked = remember(ctx.db, ctx.config, "少し寂しい", "r-emo-l", "2026-01-01T00:00:00.000Z");
      const friend = remember(ctx.db, ctx.config, "親友のA", "r-friend", "2026-01-01T00:00:00.000Z");
      setScore(ctx.db, unlinked, 0.5, "EMOTION");
      setScore(ctx.db, linked, 0.5, "EMOTION");
      setScore(ctx.db, friend, 1, "RELATIONSHIP");
      linkRecord(ctx.db, linked, friend);

      const u = decide(ctx, unlinked);
      const l = decide(ctx, linked);
      assert.equal(u?.decision, "retire");
      assert.equal(l?.decision, "keep");
      assert.ok((l?.factors.links ?? 0) > 0);
      assert.ok((l?.A ?? 0) > (u?.A ?? 0));
    } finally {
      ctx.cleanup();
    }
  });

  it("counts a cross-chunk canonical edge once per endpoint (301 candidates)", () => {
    const ctx = setup();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 301; i++) {
        ids.push(
          remember(ctx.db, ctx.config, `chunk memory ${i}`, `r-chunk-${i}`, "2026-01-01T00:00:00.000Z"),
        );
      }
      // ids[0] and ids[300] land in different SQL chunks (SQL_CHUNK = 300).
      linkRecord(ctx.db, ids[0]!, ids[300]!);
      const inputs = loadActivationInputs(ctx.db, SCOPE, { includeRetired: false });
      const first = inputs.find((i) => i.recordId === ids[0]);
      const last = inputs.find((i) => i.recordId === ids[300]);
      assert.equal(first?.links, 1, "edge counted once for from endpoint");
      assert.equal(last?.links, 1, "edge counted once for to endpoint");
    } finally {
      ctx.cleanup();
    }
  });

  it("ignores similar edges whose neighbour is no longer active", () => {
    const ctx = setup();
    try {
      const stale = remember(ctx.db, ctx.config, "古い隣人と似ている", "r-sim-stale", "2026-01-01T00:00:00.000Z");
      const fresh = remember(ctx.db, ctx.config, "今も使う隣人と似ている", "r-sim-fresh", "2026-01-01T00:00:00.000Z");
      const retiredPeer = remember(ctx.db, ctx.config, "もう使わない記憶", "r-sim-peer-r", "2026-01-01T00:00:00.000Z");
      const activePeer = remember(ctx.db, ctx.config, "現役の記憶", "r-sim-peer-a", "2026-01-01T00:00:00.000Z");
      similarEdge(ctx.db, stale, retiredPeer);
      similarEdge(ctx.db, fresh, activePeer);
      const ret = retireRecord(
        ctx.db,
        ctx.config,
        { id: retiredPeer, scope: SCOPE, reasonCode: "LOW_SIGNAL" },
        "r-sim-retire",
        NOW,
      );
      assert.equal(ret.ok, true, JSON.stringify(ret));
      // The derived row survives until maintain.associate prunes it.
      const rows = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM similar_edges WHERE scope = ?`)
        .get(SCOPE) as { n: number };
      assert.equal(rows.n, 2);

      const inputs = loadActivationInputs(ctx.db, SCOPE, { includeRetired: false });
      const staleInput = inputs.find((i) => i.recordId === stale);
      const freshInput = inputs.find((i) => i.recordId === fresh);
      assert.equal(staleInput?.links, 0, "edge to a retired neighbour contributes 0");
      assert.equal(freshInput?.links, 0.5, "edge to an active neighbour still counts");
    } finally {
      ctx.cleanup();
    }
  });

  it("counts a cross-chunk similar edge once per endpoint (301 candidates)", () => {
    const ctx = setup();
    try {
      const ids: string[] = [];
      for (let i = 0; i < 301; i++) {
        ids.push(
          remember(ctx.db, ctx.config, `similar chunk memory ${i}`, `r-simchunk-${i}`, "2026-01-01T00:00:00.000Z"),
        );
      }
      // ids[0] and ids[300] land in different SQL chunks (SQL_CHUNK = 300).
      similarEdge(ctx.db, ids[0]!, ids[300]!);
      const inputs = loadActivationInputs(ctx.db, SCOPE, { includeRetired: false });
      const first = inputs.find((i) => i.recordId === ids[0]);
      const last = inputs.find((i) => i.recordId === ids[300]);
      assert.equal(first?.links, 0.5, "edge counted once for endpoint a");
      assert.equal(last?.links, 0.5, "edge counted once for endpoint b");
    } finally {
      ctx.cleanup();
    }
  });

  it("retires a dated PLAN as OUTDATED and keeps the same plan with a future date", () => {
    const ctx = setup();
    try {
      const past = remember(
        ctx.db,
        ctx.config,
        "旅行は2026-01-01に行く",
        "r-plan-past",
        "2026-01-08T00:00:00.000Z",
        "model_inference",
      );
      const future = remember(
        ctx.db,
        ctx.config,
        "旅行は2026-02-01に行く",
        "r-plan-future",
        "2026-01-08T00:00:00.000Z",
        "model_inference",
      );
      setScore(ctx.db, past, 1 / 3, "PLAN");
      setScore(ctx.db, future, 1 / 3, "PLAN");

      const p = decide(ctx, past);
      const f = decide(ctx, future);
      assert.equal(p?.decision, "retire");
      assert.equal(p?.reason, "OUTDATED");
      assert.ok((p?.factors.expired ?? 0) < 0);
      assert.equal(f?.decision, "keep");
      assert.equal(f?.factors.expired, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("never reactivates a user-driven NO_LONGER_USEFUL retirement", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "古い住所", "r-user-ret", "2026-01-10T00:00:00.000Z");
      setScore(ctx.db, id, 1, "FACT");
      const ret = retireRecord(
        ctx.db,
        ctx.config,
        { id, scope: SCOPE, reasonCode: "NO_LONGER_USEFUL" },
        "r-user-ret-k",
        NOW,
      );
      assert.equal(ret.ok, true, JSON.stringify(ret));
      const item = decide(ctx, id);
      assert.equal(item?.decision, "keep");
      assert.equal(item?.reason, null);
    } finally {
      ctx.cleanup();
    }
  });

  it("never auto-retires after a USER_REQUESTED reactivation", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "また呼んで", "r-user-req", "2026-01-09T18:00:00.000Z");
      setScore(ctx.db, id, 0, "GREETING");
      ctx.db
        .prepare(
          `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
           VALUES (?, 'record.reactivate', ?, 'OK', ?, NULL, NULL, NULL, NULL, 'USER_REQUESTED')`,
        )
        .run("2026-01-10T00:00:00.000Z", id, SCOPE);
      const item = decide(ctx, id);
      assert.ok((item?.A ?? 0) < -1.5, "score is below tauRetire");
      assert.equal(item?.decision, "keep");
    } finally {
      ctx.cleanup();
    }
  });

  it("never auto-retires after a USER_REQUESTED reactivation applied by cultivate", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "また呼んで", "r-cult-req", "2026-01-09T18:00:00.000Z");
      setScore(ctx.db, id, 0, "GREETING");
      cultivate(ctx, "r-cult-req-ret", id, "retire", "NO_LONGER_USEFUL", "2026-01-10T00:00:00.000Z");
      cultivate(ctx, "r-cult-req-rea", id, "reactivate", "USER_REQUESTED", "2026-01-10T01:00:00.000Z");
      const item = decide(ctx, id);
      assert.ok((item?.A ?? 0) < -1.5, "score is below tauRetire");
      assert.equal(item?.decision, "keep");
    } finally {
      ctx.cleanup();
    }
  });

  it("never reactivates a NO_LONGER_USEFUL retirement applied by cultivate", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "古い住所", "r-cult-ret", "2026-01-10T00:00:00.000Z");
      setScore(ctx.db, id, 1, "FACT");
      cultivate(ctx, "r-cult-ret-k", id, "retire", "NO_LONGER_USEFUL", "2026-01-10T01:00:00.000Z");
      const item = decide(ctx, id);
      assert.ok((item?.A ?? 0) >= -0.5, "score alone would reactivate");
      assert.equal(item?.decision, "keep");
    } finally {
      ctx.cleanup();
    }
  });

  it("latest transition wins: a later LOW_ACTIVATION retirement is reconsiderable", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "また使う事実", "r-cult-latest", "2026-01-01T00:00:00.000Z");
      setScore(ctx.db, id, 1, "FACT");
      cultivate(ctx, "r-cult-latest-ret0", id, "retire", "NO_LONGER_USEFUL", "2026-01-10T00:00:00.000Z");
      cultivate(ctx, "r-cult-latest-rea", id, "reactivate", "USER_REQUESTED", "2026-01-10T01:00:00.000Z");
      // While the user reactivation is the latest event it protects the row.
      assert.equal(decide(ctx, id)?.decision, "keep");
      cultivate(ctx, "r-cult-latest-ret1", id, "retire", "LOW_ACTIVATION", "2026-01-10T02:00:00.000Z");
      const item = decide(ctx, id);
      assert.ok((item?.A ?? 0) >= -0.5, "score alone would reactivate");
      assert.equal(item?.decision, "reactivate");
    } finally {
      ctx.cleanup();
    }
  });

  it("reconsiders legacy LOW_SIGNAL: greeting stays retired, FACT reactivates", () => {
    const ctx = setup();
    try {
      const greet = remember(ctx.db, ctx.config, "こんにちは", "r-leg-g", "2026-01-09T18:00:00.000Z");
      const fact = remember(ctx.db, ctx.config, "猫を飼っている", "r-leg-f", "2026-01-09T18:00:00.000Z");
      setScore(ctx.db, greet, 0, "GREETING");
      setScore(ctx.db, fact, 1, "FACT");
      for (const id of [greet, fact]) {
        const ret = retireRecord(
          ctx.db,
          ctx.config,
          { id, scope: SCOPE, reasonCode: "LOW_SIGNAL" },
          `r-leg-${id}`,
          NOW,
        );
        assert.equal(ret.ok, true, JSON.stringify(ret));
      }
      assert.equal(decide(ctx, greet)?.decision, "keep");
      assert.equal(decide(ctx, fact)?.decision, "reactivate");
    } finally {
      ctx.cleanup();
    }
  });

  it("marks a penalty-only retirement as CONSOLIDATED when a cluster summary cites it", () => {
    const ctx = setup();
    try {
      const member = remember(
        ctx.db,
        ctx.config,
        "今日は少し疲れた",
        "r-cons-m",
        "2025-12-29T12:00:00.000Z",
      );
      setScore(ctx.db, member, 0.5, "EMOTION");
      const summary = remember(
        ctx.db,
        ctx.config,
        "近況の要約",
        "r-cons-s",
        "2026-01-05T00:00:00.000Z",
        "summary",
      );
      ctx.db
        .prepare(`UPDATE records SET source = 'cultivation:llm-derived-cluster' WHERE id = ?`)
        .run(summary);
      linkRecord(ctx.db, summary, member);

      const item = decide(ctx, member);
      assert.equal(item?.decision, "retire");
      assert.equal(item?.reason, "CONSOLIDATED");
      assert.equal(item?.factors.consolidated, -0.5);
    } finally {
      ctx.cleanup();
    }
  });

  it("preview factors sum to the reported total A", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "設計プロジェクト", "r-factors", "2026-01-01T00:00:00.000Z");
      setScore(ctx.db, id, 1, "PROJECT");
      const item = decide(ctx, id);
      assert.ok(item);
      const f = item.factors;
      const sum =
        f.base + f.kind + f.importance + f.nature + f.links + f.expired + f.consolidated;
      assert.ok(Math.abs(sum - f.total) < 1e-12);
      assert.ok(Math.abs(f.total - item.A) < 1e-12);
      assert.equal(item.nature, "PROJECT");
      assert.equal(item.importance, 1);
    } finally {
      ctx.cleanup();
    }
  });
});
