/**
 * record.stats: read-only per-scope aggregate counts.
 *
 * Covers kind/status counts, importance buckets with fresh/stale/missing
 * ledger rows, strict params, the scope gate, protocol registration, the
 * metadata-only audit row, and the real CLI round trip.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { bodyHashFor, normalizeBody } from "../src/normalize.js";
import { validateRequest } from "../src/protocol.js";
import {
  archiveRecord,
  correctRecord,
  eventAppend,
  recordStats,
  rememberRecord,
  retireRecord,
} from "../src/store.js";

const SCOPE = "personal/default";
const OTHER = "work/other";
const OBS = "2026-09-01T00:00:00.000Z";
const NOW = "2026-09-10T00:00:00.000Z";
let keyCtr = 0;

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
      responseMaxBytes: 65536,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  return { config, configPath: path.join(dir, "memory.config.json") };
}

function setup(): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "record-stats-"));
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

function prov(): { source: string; observedAt: string } {
  return { source: "session:s1:turn:1", observedAt: OBS };
}

function appendRaw(db: DatabaseSync, config: AppConfig): void {
  const res = eventAppend(
    db,
    config,
    {
      eventId: "e1",
      sessionId: "s1",
      turnId: "t1",
      body: "raw context for stats",
      provenance: prov(),
      scope: SCOPE,
    },
    "ev-stats",
  );
  assert.equal(res.ok, true, JSON.stringify(res));
}

function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  kind: string,
  scope = SCOPE,
): string {
  const derived = kind === "model_inference" || kind === "summary";
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind,
      provenance: derived ? { source: "derived:test", observedAt: OBS } : prov(),
      scope,
      sourceRefs: derived ? [] : ["e1"],
    },
    `stats-${keyCtr++}`,
    NOW,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

describe("record.stats", () => {
  it("counts active kinds and every status inside one scope", () => {
    const ctx = setup();
    try {
      appendRaw(ctx.db, ctx.config);
      remember(ctx.db, ctx.config, "active user fact", "user_fact");
      remember(ctx.db, ctx.config, "active model inference", "model_inference");
      remember(ctx.db, ctx.config, "active summary", "summary");
      remember(ctx.db, ctx.config, "active correction", "correction");

      const archived = remember(ctx.db, ctx.config, "to archive", "user_fact");
      const a = archiveRecord(
        ctx.db,
        ctx.config,
        { id: archived, scope: SCOPE, reasonCode: "USER_ARCHIVED" },
        `archive-${keyCtr++}`,
        NOW,
      );
      assert.equal(a.ok, true, JSON.stringify(a));

      const retired = remember(ctx.db, ctx.config, "to retire", "user_fact");
      const r = retireRecord(
        ctx.db,
        ctx.config,
        { id: retired, scope: SCOPE, reasonCode: "NO_LONGER_USEFUL" },
        `retire-${keyCtr++}`,
        NOW,
      );
      assert.equal(r.ok, true, JSON.stringify(r));

      const superseded = remember(ctx.db, ctx.config, "to correct", "user_fact");
      const c = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: superseded,
          body: "corrected body",
          kind: "correction",
          provenance: prov(),
          scope: SCOPE,
          sourceRefs: ["e1"],
        },
        `correct-${keyCtr++}`,
        NOW,
      );
      assert.equal(c.ok, true, JSON.stringify(c));

      const res = recordStats(ctx.db, ctx.config, { scope: SCOPE }, NOW);
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as {
        scope: string;
        byKind: Record<string, number>;
        byStatus: Record<string, number>;
        importance: { scored: number; unscored: number; buckets: Array<{ lt: number; count: number }> };
        computedAt: string;
      };
      assert.equal(data.scope, SCOPE);
      assert.deepEqual(data.byKind, {
        user_fact: 1,
        model_inference: 1,
        summary: 1,
        correction: 2,
      });
      assert.deepEqual(data.byStatus, {
        active: 5,
        superseded: 1,
        archived: 1,
        retired: 1,
      });
      assert.equal(data.importance.scored, 0);
      assert.equal(data.importance.unscored, 5);
      assert.deepEqual(
        data.importance.buckets.map((b) => [b.lt, b.count]),
        [[0.2, 0], [0.4, 0], [0.6, 0], [0.8, 0], [1.0001, 0]],
      );
      assert.equal(data.computedAt, NOW);
      assert.equal("body" in data, false);
      const audits = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM audit WHERE op = 'record.stats'`)
        .get() as { n: number };
      assert.equal(audits.n, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("buckets fresh importance and counts stale or missing rows as unscored", () => {
    const ctx = setup();
    try {
      appendRaw(ctx.db, ctx.config);
      const ids = [
        remember(ctx.db, ctx.config, "bucket 02", "user_fact"),
        remember(ctx.db, ctx.config, "bucket 04", "user_fact"),
        remember(ctx.db, ctx.config, "bucket 06", "user_fact"),
        remember(ctx.db, ctx.config, "bucket 08", "user_fact"),
        remember(ctx.db, ctx.config, "bucket 10", "user_fact"),
        remember(ctx.db, ctx.config, "stale importance", "user_fact"),
        remember(ctx.db, ctx.config, "missing importance", "user_fact"),
      ];
      const retired = remember(ctx.db, ctx.config, "retired scored", "user_fact");
      const r = retireRecord(
        ctx.db,
        ctx.config,
        { id: retired, scope: SCOPE, reasonCode: "NO_LONGER_USEFUL" },
        `retire-${keyCtr++}`,
        NOW,
      );
      assert.equal(r.ok, true, JSON.stringify(r));

      const insert = ctx.db.prepare(
        `INSERT INTO record_importance(recordId, importance, bodyHash, nature, source, scoredAt)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      const values = [0.2, 0.4, 0.6, 0.8, 1.0];
      const bodies = ["bucket 02", "bucket 04", "bucket 06", "bucket 08", "bucket 10"];
      for (let i = 0; i < values.length; i++) {
        insert.run(ids[i]!, values[i]!, bodyHashFor(normalizeBody(bodies[i]!)), "FACT", "external", NOW);
      }
      insert.run(ids[5]!, 0.9, "stale-body-hash", "FACT", "external", NOW);
      insert.run(retired, 0.9, bodyHashFor(normalizeBody("retired scored")), "FACT", "external", NOW);

      const res = recordStats(ctx.db, ctx.config, { scope: SCOPE }, NOW);
      assert.equal(res.ok, true, JSON.stringify(res));
      const data = res.data as {
        byKind: Record<string, number>;
        byStatus: Record<string, number>;
        importance: { scored: number; unscored: number; buckets: Array<{ lt: number; count: number }> };
      };
      assert.equal(data.byKind["user_fact"], 7);
      assert.deepEqual(data.byStatus, {
        active: 7,
        superseded: 0,
        archived: 0,
        retired: 1,
      });
      assert.equal(data.importance.scored, 5);
      assert.equal(data.importance.unscored, 2);
      assert.deepEqual(
        data.importance.buckets.map((b) => b.count),
        [0, 1, 1, 1, 2],
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("is strict on params, gated by scope, and registered as a read op", () => {
    const ctx = setup();
    try {
      const bad = (params: Record<string, unknown>): void => {
        const res = recordStats(ctx.db, ctx.config, params);
        assert.equal(res.ok, false);
        assert.equal(res.code, "BAD_REQUEST");
      };
      bad({});
      bad({ scope: SCOPE, limit: 1 });
      bad({ scope: 5 });
      bad({ scope: "x".repeat(257) });
      const denied = recordStats(ctx.db, ctx.config, { scope: OTHER });
      assert.equal(denied.ok, false);
      assert.equal(denied.code, "FORBIDDEN_SCOPE");
      const audits = ctx.db
        .prepare(`SELECT COUNT(*) AS n FROM audit WHERE op = 'record.stats'`)
        .get() as { n: number };
      assert.equal(audits.n, 0);

      assert.equal(validateRequest({ v: 1, op: "record.stats", params: { scope: SCOPE } }).ok, true);
      assert.equal(
        validateRequest({ v: 1, op: "record.stats", idempotencyKey: "k1", params: { scope: SCOPE } }).ok,
        false,
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("returns the same shape through the real CLI child process", () => {
    const ctx = setup();
    try {
      appendRaw(ctx.db, ctx.config);
      remember(ctx.db, ctx.config, "cli user fact", "user_fact");
      remember(ctx.db, ctx.config, "cli summary", "summary");
      ctx.db.close();
      fs.writeFileSync(ctx.configPath, JSON.stringify(ctx.config), "utf8");
      const cli = path.resolve(__dirname, "..", "src", "cli.js");
      const line = JSON.stringify({ v: 1, op: "record.stats", params: { scope: SCOPE } });
      const r = spawnSync(process.execPath, [cli, "--config", ctx.configPath], {
        input: line + "\n",
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(r.status, 0, r.stderr);
      const first = (r.stdout || "").split("\n")[0] ?? "";
      const body = JSON.parse(first) as {
        ok: boolean;
        code: string;
        data: {
          scope: string;
          byKind: Record<string, number>;
          byStatus: Record<string, number>;
          importance: { scored: number; unscored: number; buckets: Array<{ lt: number; count: number }> };
          computedAt: string;
        };
      };
      assert.equal(body.ok, true);
      assert.equal(body.code, "OK");
      assert.equal(body.data.scope, SCOPE);
      assert.equal(body.data.byKind["user_fact"], 1);
      assert.equal(body.data.byKind["summary"], 1);
      assert.equal(body.data.byKind["model_inference"], 0);
      assert.equal(body.data.byStatus["active"], 2);
      assert.equal(body.data.importance.unscored, 2);
      assert.equal(body.data.importance.buckets.length, 5);
      assert.equal(typeof body.data.computedAt, "string");

      const badLine = JSON.stringify({ v: 1, op: "record.stats", params: { scope: SCOPE, extra: true } });
      const bad = spawnSync(process.execPath, [cli, "--config", ctx.configPath], {
        input: badLine + "\n",
        encoding: "utf8",
        timeout: 20000,
      });
      assert.equal(bad.status, 0, bad.stderr);
      const badBody = JSON.parse((bad.stdout || "").split("\n")[0] ?? "") as { ok: boolean; code: string };
      assert.equal(badBody.ok, false);
      assert.equal(badBody.code, "BAD_REQUEST");
    } finally {
      try {
        ctx.db.close();
      } catch {
        /* already closed */
      }
      fs.rmSync(ctx.dir, { recursive: true, force: true });
    }
  });
});
