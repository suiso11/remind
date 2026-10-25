/**
 * Retention learner PART A: schema migration, harvest labeling/idempotency,
 * user-transition labels, leak-free feature snapshots, and the table cap.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { SCHEMA_VERSION, initDb } from "../src/db.js";
import type { AppConfig } from "../src/config.js";
import {
  RETENTION_LEARN_DEFAULTS,
  activationBounds,
  type ActivationConfig,
  type RetentionLearnConfig,
} from "../src/config.js";
import { eventAppend, rememberRecord } from "../src/store.js";
import {
  HARVEST_MAX_NEW,
  RETENTION_EXAMPLES_MAX,
  fitRetentionWeights,
  harvestRetentionExamples,
  loadActiveRetentionWeights,
  maybeLearn,
  retentionFeatures,
  weightsFromParams,
  type RetentionTrainingExample,
  type RetentionWeights,
} from "../src/retention_learn.js";
import { ACTIVATION_DEFAULTS, activationPreview, maintainActivation } from "../src/activation.js";

const SCOPE = "personal/default";
const OBS = "2026-01-01T00:00:00.000Z";

function baseConfig(dir: string): AppConfig {
  return {
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
  };
}

function setup(): { dir: string; config: AppConfig; db: DatabaseSync; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-learn-"));
  const config = baseConfig(dir);
  const { db } = initDb(config, path.join(dir, "memory.config.json"));
  return {
    dir,
    config,
    db,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

let ctr = 0;
function remember(db: DatabaseSync, config: AppConfig, key: string, createdAt: string): string {
  const ref = `ref-${key}-${ctr}`;
  const raw = eventAppend(
    db,
    config,
    {
      eventId: ref,
      sessionId: "s1",
      turnId: "t1",
      body: `raw ${ref}`,
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: SCOPE,
    },
    `ev-${key}-${ctr++}`,
  );
  assert.equal(raw.ok, true, JSON.stringify(raw));
  const res = rememberRecord(
    db,
    config,
    {
      body: `record ${key}`,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: SCOPE,
      sourceRefs: [ref],
    },
    `remember-${key}-${ctr++}`,
    createdAt,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function exposure(db: DatabaseSync, recallId: string, recordId: string, ts: string): void {
  db.prepare(
    `INSERT INTO exposures(ts, recallId, runId, scope, recordId, snippetBytes, truncated, limitN)
     VALUES (?, ?, NULL, ?, ?, 10, 0, 10)`,
  ).run(ts, recallId, SCOPE, recordId);
}

function usage(db: DatabaseSync, recallId: string, recordId: string, ts: string): void {
  db.prepare(
    `INSERT INTO usage(ts, recallId, recordId, scope, runId) VALUES (?, ?, ?, ?, NULL)`,
  ).run(ts, recallId, recordId, SCOPE);
}

function audit(
  db: DatabaseSync,
  op: string,
  recordId: string,
  reasonCode: string,
  ts: string,
): void {
  db.prepare(
    `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
     VALUES (?, ?, ?, 'ok', ?, NULL, NULL, NULL, NULL, ?)`,
  ).run(ts, op, recordId, SCOPE, reasonCode);
}

describe("retention learner: schema", () => {
  it("creates both ledgers on a fresh database", () => {
    const ctx = setup();
    try {
      const uv = (ctx.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
      assert.equal(uv, SCHEMA_VERSION);
      for (const name of ["retention_examples", "retention_weights"]) {
        assert.ok(
          ctx.db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`).get(name),
          name,
        );
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("migrates a v10 database in place and is idempotent", () => {
    const ctx = setup();
    try {
      ctx.db.exec(`DROP TABLE retention_examples`);
      ctx.db.exec(`DROP TABLE retention_weights`);
      ctx.db.exec(`PRAGMA user_version = 10`);
      ctx.db.close();
      const configPath = path.join(ctx.dir, "memory.config.json");
      const reopened = initDb(ctx.config, configPath);
      assert.equal(
        (reopened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version,
        SCHEMA_VERSION,
      );
      for (const name of ["retention_examples", "retention_weights"]) {
        assert.ok(
          reopened.db.prepare(`SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?`).get(name),
          name,
        );
      }
      reopened.db.close();
      // Second open must not fail or re-run destructive DDL.
      const again = initDb(ctx.config, configPath);
      assert.equal(
        (again.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version,
        SCHEMA_VERSION,
      );
      again.db.close();
    } finally {
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});

describe("retention learner: harvest", () => {
  it("labels exposures only after the horizon and is idempotent", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "h1", "2026-01-01T00:00:00.000Z");
      const t0 = "2026-01-01T00:30:00.000Z";
      exposure(ctx.db, "recall-old-used", id, t0);
      usage(ctx.db, "recall-old-used", id, "2026-01-01T02:00:00.000Z");
      exposure(ctx.db, "recall-new", id, "2026-01-01T06:30:00.000Z");
      const now = "2026-01-01T07:00:00.000Z"; // old exposure 6h old, new one only 30m

      const first = harvestRetentionExamples(ctx.db, ctx.config, SCOPE, now);
      assert.equal(first.harvested, 1);
      assert.equal(first.examples, 1);
      assert.equal(first.positives, 1);
      const rows = ctx.db
        .prepare(`SELECT recallId, label FROM retention_examples ORDER BY recallId`)
        .all() as Array<{ recallId: string; label: number }>;
      assert.deepEqual(
        rows.map((r) => ({ recallId: r.recallId, label: r.label })),
        [{ recallId: "recall-old-used", label: 1 }],
      );

      const second = harvestRetentionExamples(ctx.db, ctx.config, SCOPE, now);
      assert.equal(second.harvested, 0);
      assert.equal(second.examples, 1);

      const later = harvestRetentionExamples(ctx.db, ctx.config, SCOPE, "2026-01-01T12:31:00.000Z");
      assert.equal(later.harvested, 1);
      assert.equal(later.examples, 2);
      assert.equal(later.positives, 1); // new exposure has no usage
    } finally {
      ctx.cleanup();
    }
  });

  it("labels user retire/reactivate transitions with weight 5", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "u1", "2026-01-01T00:00:00.000Z");
      audit(ctx.db, "record.retire", id, "NO_LONGER_USEFUL", "2026-01-02T00:00:00.000Z");
      audit(ctx.db, "maintain.cultivate", id, "USER_REQUESTED", "2026-01-03T00:00:00.000Z");
      const res = harvestRetentionExamples(ctx.db, ctx.config, SCOPE, "2026-01-04T00:00:00.000Z");
      assert.equal(res.harvested, 2);
      assert.equal(res.positives, 1);
      const rows = ctx.db
        .prepare(`SELECT recallId, source, label, weight FROM retention_examples ORDER BY ts`)
        .all() as Array<{ recallId: string; source: string; label: number; weight: number }>;
      assert.deepEqual(
        rows.map((r) => ({ source: r.source, label: r.label, weight: r.weight })),
        [
          { source: "user_retire", label: 0, weight: 5 },
          { source: "user_reactivate", label: 1, weight: 5 },
        ],
      );
      assert.ok(rows.every((r) => /^audit:\d+$/.test(r.recallId)));
      // Idempotent across calls: audit rowid identity prevents relabeling.
      const again = harvestRetentionExamples(ctx.db, ctx.config, SCOPE, "2026-01-05T00:00:00.000Z");
      assert.equal(again.harvested, 0);
      assert.equal(again.examples, 2);
    } finally {
      ctx.cleanup();
    }
  });

  it("does not leak the labeled usage into the base feature", () => {
    const ctx = setup();
    try {
      const createdAt = "2026-01-01T00:00:00.000Z";
      const exposureTs = "2026-01-01T01:00:00.000Z";
      const id = remember(ctx.db, ctx.config, "noleak", createdAt);
      exposure(ctx.db, "recall-leak", id, exposureTs);
      // Usage at the same recall but 29h AFTER the exposure snapshot.
      usage(ctx.db, "recall-leak", id, "2026-01-02T06:00:00.000Z");
      const now = "2026-01-02T07:00:00.000Z";
      harvestRetentionExamples(ctx.db, ctx.config, SCOPE, now);
      const row = ctx.db
        .prepare(`SELECT features FROM retention_examples WHERE recallId='recall-leak'`)
        .get() as { features: string } | undefined;
      assert.ok(row);
      const features = JSON.parse(row.features) as { base: number };
      // Only createdAt is before the snapshot: ln(max(1h,1)^-0.5) = 0.
      assert.ok(Math.abs(features.base - 0) < 1e-9, String(features.base));

      const direct = retentionFeatures(ctx.db, ctx.config, SCOPE, id, exposureTs);
      assert.ok(direct);
      assert.ok(Math.abs((direct.base ?? Number.NaN) - 0) < 1e-9);
      assert.equal(direct.expired, false);
    } finally {
      ctx.cleanup();
    }
  });

  it("caps the table to the newest rows", () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "cap", "2026-01-01T00:00:00.000Z");
      const insert = ctx.db.prepare(
        `INSERT INTO retention_examples(recallId, recordId, source, ts, label, weight, features, createdAt)
         VALUES (?, ?, 'exposure', ?, 0, 1, '{}', ?)`,
      );
      ctx.db.exec("BEGIN");
      for (let i = 1; i <= RETENTION_EXAMPLES_MAX + 5; i++) {
        const pad = String(i).padStart(5, "0");
        insert.run(`x${pad}`, id, `2026-01-01T00:00:${pad}.000Z`, "2026-01-02T00:00:00.000Z");
      }
      ctx.db.exec("COMMIT");
      const res = harvestRetentionExamples(ctx.db, ctx.config, SCOPE, "2026-01-03T00:00:00.000Z");
      assert.equal(res.examples, RETENTION_EXAMPLES_MAX);
      const oldest = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM retention_examples WHERE recallId IN ('x00001','x00002','x00003','x00004','x00005')`)
        .get() as { n: number };
      assert.equal(oldest.n, 0);
      assert.equal(HARVEST_MAX_NEW, 2000);
    } finally {
      ctx.cleanup();
    }
  });

  it("harvests at the start of maintain.activation and reports learn counts", async () => {
    const ctx = setup();
    try {
      const id = remember(ctx.db, ctx.config, "wired", "2026-01-01T00:00:00.000Z");
      exposure(ctx.db, "recall-wired", id, "2026-01-01T01:00:00.000Z");
      usage(ctx.db, "recall-wired", id, "2026-01-01T01:30:00.000Z");
      const res = await maintainActivation(
        ctx.db,
        ctx.config,
        path.join(ctx.dir, "memory.config.json"),
        { scope: SCOPE },
        "learn-wire-1",
        async () => null,
        "2026-01-01T08:00:00.000Z",
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as {
        learn: { harvested: number; examples: number; positives: number };
      };
      assert.equal(data.learn.harvested, 1);
      assert.equal(data.learn.examples, 1);
      assert.equal(data.learn.positives, 1);
    } finally {
      ctx.cleanup();
    }
  });
});

/* ------------------------------------------------------------------ */
/* PART B: optimizer, acceptance gate, scoring integration             */
/* ------------------------------------------------------------------ */

function learnConfig(dir: string, learn: Partial<RetentionLearnConfig>): AppConfig {
  const config = baseConfig(dir);
  return {
    ...config,
    activation: {
      learn: { ...RETENTION_LEARN_DEFAULTS, ...learn },
    } as unknown as ActivationConfig,
  };
}

function setupLearn(learn: Partial<RetentionLearnConfig>): {
  dir: string;
  config: AppConfig;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "retention-learn-b-"));
  const config = learnConfig(dir, learn);
  const { db } = initDb(config, path.join(dir, "memory.config.json"));
  return {
    dir,
    config,
    db,
    cleanup: () => {
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function example(
  i: number,
  opts: Partial<RetentionTrainingExample> = {},
): RetentionTrainingExample {
  return {
    base: 0,
    kind: "user_fact",
    nature: "FACT",
    importance: 0.5,
    links: 1,
    expired: false,
    consolidated: false,
    label: 0,
    weight: 1,
    ts: new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString(),
    ...opts,
  };
}

function insertExample(
  db: DatabaseSync,
  i: number,
  opts: {
    label: number;
    links?: number;
    nature?: string;
    kind?: string;
    createdAt?: string;
    weight?: number;
    importance?: number;
    expired?: boolean;
    consolidated?: boolean;
  },
): void {
  const ts = new Date(Date.UTC(2026, 0, 1, 0, 0, i)).toISOString();
  const features = {
    base: 0,
    kind: opts.kind ?? "user_fact",
    nature: opts.nature ?? "FACT",
    importance: opts.importance ?? 0.5,
    links: opts.links ?? 0,
    expired: opts.expired ?? false,
    consolidated: opts.consolidated ?? false,
  };
  db.prepare(
    `INSERT INTO retention_examples(
       recallId, recordId, source, ts, label, weight, features, createdAt)
     VALUES (?, ?, 'exposure', ?, ?, ?, ?, ?)`,
  ).run(
    `recall-${i}`,
    `record-${i}`,
    ts,
    opts.label,
    opts.weight ?? 1,
    JSON.stringify(features),
    opts.createdAt ?? "2026-01-02T00:00:00.000Z",
  );
}

function insertPredictiveExamples(db: DatabaseSync, count = 60): void {
  for (let i = 0; i < count; i++) {
    const positive = i % 2 === 0;
    insertExample(db, i, { label: positive ? 1 : 0, links: positive ? 3 : 0 });
  }
}

const LEARN_NOW = "2026-01-03T00:00:00.000Z";

describe("retention learner: optimizer", () => {
  it("increases wLinks on synthetic data where links predict usage", () => {
    const prior = weightsFromParams(ACTIVATION_DEFAULTS);
    const examples: RetentionTrainingExample[] = [];
    for (let i = 0; i < 60; i++) {
      const positive = i % 2 === 0;
      examples.push(example(i, { label: positive ? 1 : 0, links: positive ? 3 : 0 }));
    }
    const fit = fitRetentionWeights(examples, prior, { lambda: 0.01, maxDrift: 10 });
    assert.ok(fit.weights.wLinks > prior.wLinks, String(fit.weights.wLinks));
    assert.ok(fit.weights.wLinks > 0);
    assert.ok(fit.scale >= 0.05);
    assert.ok(Number.isFinite(fit.logLoss));
  });

  it("is deterministic for identical input", () => {
    const prior = weightsFromParams(ACTIVATION_DEFAULTS);
    const examples: RetentionTrainingExample[] = [];
    for (let i = 0; i < 40; i++) {
      examples.push(
        example(i, {
          label: i % 3 === 0 ? 1 : 0,
          links: i % 3,
          importance: (i % 5) / 5,
          nature: i % 4 === 0 ? "GREETING" : "FACT",
        }),
      );
    }
    const a = fitRetentionWeights(examples, prior, { lambda: 0.5, maxDrift: 1.5 });
    const b = fitRetentionWeights(examples, prior, { lambda: 0.5, maxDrift: 1.5 });
    assert.deepEqual(a, b);
  });

  it("keeps adversarial weights inside the guardrail box", () => {
    const prior = weightsFromParams(ACTIVATION_DEFAULTS);
    const examples: RetentionTrainingExample[] = [];
    for (let i = 0; i < 40; i++) {
      examples.push(
        example(i, {
          label: 1,
          nature: "GREETING",
          links: 2,
          importance: 1,
          expired: true,
          consolidated: true,
          weight: 5,
        }),
      );
    }
    const maxDrift = 0.5;
    const fit = fitRetentionWeights(examples, prior, { lambda: 0, maxDrift });
    const w = fit.weights;
    assert.ok(w.wImportance >= 0);
    assert.ok(w.wLinks >= 0);
    assert.ok(w.wExpired >= 0);
    assert.ok(w.wConsolidated >= 0);
    for (const label of ["GREETING", "CHATOPS", "TRANSIENT", "EMOTION"] as const) {
      assert.ok(w.wNature[label] <= 0, `${label} ${w.wNature[label]}`);
    }
    assert.ok(Math.abs(w.wNature.GREETING - prior.wNature.GREETING) <= maxDrift + 1e-9);
    assert.ok(Math.abs(w.wImportance - prior.wImportance) <= maxDrift + 1e-9);
    assert.ok(Math.abs(w.wLinks - prior.wLinks) <= maxDrift + 1e-9);
  });
});

describe("retention learner: gating and acceptance", () => {
  it("skips tiny data before minExamples and records no attempt row", () => {
    const ctx = setupLearn({});
    try {
      insertExample(ctx.db, 0, { label: 1 });
      insertExample(ctx.db, 1, { label: 0 });
      const out = maybeLearn(ctx.db, ctx.config, SCOPE, LEARN_NOW);
      assert.equal(out.attempted, false);
      assert.equal(out.skipped, "no-new-examples");
      const rows = ctx.db.prepare(`SELECT COUNT(*) AS n FROM retention_weights`).get() as { n: number };
      assert.equal(rows.n, 0);
    } finally {
      ctx.cleanup();
    }
  });

  it("skips min-examples and min-positives without a row", () => {
    const ctx = setupLearn({ minExamples: 300, minPositives: 30 });
    try {
      insertPredictiveExamples(ctx.db, 60);
      const minExamples = maybeLearn(ctx.db, ctx.config, SCOPE, LEARN_NOW);
      assert.equal(minExamples.attempted, false);
      assert.equal(minExamples.skipped, "min-examples");

      const ctx2 = setupLearn({ minExamples: 40, minPositives: 31 });
      try {
        insertPredictiveExamples(ctx2.db, 60);
        const minPositives = maybeLearn(ctx2.db, ctx2.config, SCOPE, LEARN_NOW);
        assert.equal(minPositives.attempted, false);
        assert.equal(minPositives.skipped, "min-positives");
        const rows = ctx2.db.prepare(`SELECT COUNT(*) AS n FROM retention_weights`).get() as { n: number };
        assert.equal(rows.n, 0);
      } finally {
        ctx2.cleanup();
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("accepts a link-predictive fit and previews the new version", () => {
    const ctx = setupLearn({
      minExamples: 20,
      minPositives: 10,
      maxDrift: 10,
      lambda: 0.01,
      learnIntervalMs: 0,
    });
    try {
      insertPredictiveExamples(ctx.db, 60);
      const prior = weightsFromParams(activationBounds(ctx.config));
      const out = maybeLearn(ctx.db, ctx.config, SCOPE, LEARN_NOW);
      assert.equal(out.attempted, true);
      assert.equal(out.accepted, true, JSON.stringify(out));
      assert.ok(out.version !== null);
      assert.ok(out.holdoutLoss !== null && out.baselineHoldoutLoss !== null);
      assert.ok(out.holdoutLoss < out.baselineHoldoutLoss - 1e-4);
      const row = ctx.db
        .prepare(`SELECT weights, accepted FROM retention_weights WHERE version = ?`)
        .get(out.version) as { weights: string; accepted: number };
      assert.equal(row.accepted, 1);
      const stored = JSON.parse(row.weights) as RetentionWeights;
      assert.ok(stored.wLinks > prior.wLinks);

      remember(ctx.db, ctx.config, "preview", "2026-01-01T00:00:00.000Z");
      const preview = activationPreview(
        ctx.db,
        ctx.config,
        { scope: SCOPE },
        "2026-01-03T00:00:00.000Z",
      );
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const data = preview.data as {
        weightsVersion: number | null;
        weights: RetentionWeights;
      };
      assert.equal(data.weightsVersion, out.version);
      assert.equal(data.weights.wLinks, stored.wLinks);

      const active = loadActiveRetentionWeights(ctx.db, ctx.config);
      assert.equal(active.version, out.version);
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects a candidate that loses on the time-ordered holdout", () => {
    const ctx = setupLearn({
      minExamples: 20,
      minPositives: 10,
      maxDrift: 10,
      lambda: 0,
      learnIntervalMs: 0,
    });
    try {
      for (let i = 0; i < 60; i++) {
        if (i < 48) {
          const positive = i % 2 === 0;
          insertExample(ctx.db, i, { label: positive ? 1 : 0, links: positive ? 3 : 0 });
        } else {
          // Holdout contradicts the train signal: low links are labeled useful.
          insertExample(ctx.db, i, { label: 1, links: 0 });
        }
      }
      const out = maybeLearn(ctx.db, ctx.config, SCOPE, LEARN_NOW);
      assert.equal(out.attempted, true);
      assert.equal(out.accepted, false, JSON.stringify(out));
      const row = ctx.db
        .prepare(`SELECT accepted FROM retention_weights WHERE version = ?`)
        .get(out.version) as { accepted: number };
      assert.equal(row.accepted, 0);
      const active = loadActiveRetentionWeights(ctx.db, ctx.config);
      assert.equal(active.version, null);
      assert.equal(active.weights.wLinks, weightsFromParams(activationBounds(ctx.config)).wLinks);
    } finally {
      ctx.cleanup();
    }
  });

  it("gates on the interval and on new examples", () => {
    const ctx = setupLearn({
      minExamples: 20,
      minPositives: 10,
      maxDrift: 10,
      learnIntervalMs: 86_400_000,
    });
    try {
      insertPredictiveExamples(ctx.db, 60);
      const first = maybeLearn(ctx.db, ctx.config, SCOPE, LEARN_NOW);
      assert.equal(first.attempted, true);
      const second = maybeLearn(ctx.db, ctx.config, SCOPE, "2026-01-03T01:00:00.000Z");
      assert.equal(second.attempted, false);
      assert.equal(second.skipped, "interval");
      const rows = ctx.db.prepare(`SELECT COUNT(*) AS n FROM retention_weights`).get() as { n: number };
      assert.equal(rows.n, 1);
    } finally {
      ctx.cleanup();
    }

    const ctx2 = setupLearn({
      minExamples: 20,
      minPositives: 10,
      maxDrift: 10,
      learnIntervalMs: 0,
    });
    try {
      insertPredictiveExamples(ctx2.db, 60);
      assert.equal(maybeLearn(ctx2.db, ctx2.config, SCOPE, LEARN_NOW).attempted, true);
      const noNew = maybeLearn(ctx2.db, ctx2.config, SCOPE, LEARN_NOW);
      assert.equal(noNew.attempted, false);
      assert.equal(noNew.skipped, "no-new-examples");
    } finally {
      ctx2.cleanup();
    }
  });

  it("ignores learned weights for scoring when learning is disabled", () => {
    const ctx = setupLearn({
      minExamples: 20,
      minPositives: 10,
      maxDrift: 10,
      lambda: 0.01,
      learnIntervalMs: 0,
    });
    try {
      insertPredictiveExamples(ctx.db, 60);
      const out = maybeLearn(ctx.db, ctx.config, SCOPE, LEARN_NOW);
      assert.equal(out.accepted, true, JSON.stringify(out));
      const id = remember(ctx.db, ctx.config, "rollback", "2026-01-01T00:00:00.000Z");
      const enabled = activationPreview(ctx.db, ctx.config, { scope: SCOPE }, "2026-01-03T00:00:00.000Z");
      assert.equal((enabled.data as { weightsVersion: number | null }).weightsVersion, out.version);

      const disabledConfig = learnConfig(ctx.dir, { enabled: false });
      const disabled = loadActiveRetentionWeights(ctx.db, disabledConfig);
      assert.equal(disabled.version, null);
      assert.deepEqual(disabled.weights, weightsFromParams(activationBounds(disabledConfig)));
      const preview = activationPreview(
        ctx.db,
        disabledConfig,
        { scope: SCOPE },
        "2026-01-03T00:00:00.000Z",
      );
      assert.equal(preview.ok, true, JSON.stringify(preview));
      const data = preview.data as { weightsVersion: number | null; weights: RetentionWeights };
      assert.equal(data.weightsVersion, null);
      assert.equal(data.weights.wLinks, ACTIVATION_DEFAULTS.wLinks);
      const item = (preview.data as { items: Array<{ id: string }> }).items.find((i) => i.id === id);
      assert.ok(item);
    } finally {
      ctx.cleanup();
    }
  });
});
