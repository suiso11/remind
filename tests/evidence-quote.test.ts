/**
 * v13 optional evidence quote on record.remember (user_fact only).
 *
 * Covers the exact contract: NFC + trim, 1..400 code points, no control
 * characters, kind=user_fact only (BAD_REQUEST otherwise), part of the
 * request hash (idempotent replay / CONFLICT on change), persisted through
 * the v13 additive migration, returned by get/list/search/recall, never used
 * for ranking, and never copied to a correction successor (record.correct
 * changes the body and creates kind=correction; callers cannot pass evidence).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb, SCHEMA_VERSION } from "../src/db.js";
import {
  correctRecord,
  EVIDENCE_MAX_CP,
  eventAppend,
  getRecord,
  listRecords,
  recallRecords,
  rememberRecord,
  searchRecords,
} from "../src/store.js";

const SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";

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

function setup(): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-"));
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

function rawEvent(ctx: { db: DatabaseSync; config: AppConfig }, key: string): string {
  const eventId = `e-${key}`;
  const ev = eventAppend(
    ctx.db,
    ctx.config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: `raw context ${key}`,
      provenance: prov(),
      scope: SCOPE,
    },
    `ev-${key}`,
  );
  assert.equal(ev.ok, true, JSON.stringify(ev));
  return eventId;
}

function rememberParams(
  ctx: { db: DatabaseSync; config: AppConfig },
  key: string,
  body: string,
  evidence?: unknown,
): Record<string, unknown> {
  const eventId = rawEvent(ctx, key);
  return {
    body,
    kind: "user_fact",
    provenance: prov(),
    scope: SCOPE,
    sourceRefs: [eventId],
    ...(evidence !== undefined ? { evidence } : {}),
  };
}

function itemById(data: unknown, id: string): Record<string, unknown> | undefined {
  return (data as { items: Array<Record<string, unknown>> }).items.find((i) => i.id === id);
}

describe("evidence quote: validation and persistence", () => {
  it("valid evidence is NFC-normalized, trimmed, persisted, and returned by get/list/search/recall", () => {
    const ctx = setup();
    try {
      const raw = "  Cafe\u0301 quote  ";
      const expected = "Café quote";
      const res = rememberRecord(
        ctx.db,
        ctx.config,
        rememberParams(ctx, "ev-ok", "orchard persimmon harvest memo", raw),
        "ev-ok",
        OBS,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const id = (res.data as { record: { id: string } }).record.id;

      const row = ctx.db.prepare(`SELECT evidence FROM records WHERE id = ?`).get(id) as {
        evidence: string | null;
      };
      assert.equal(row.evidence, expected, "persisted value is NFC + trimmed");

      const got = getRecord(ctx.db, ctx.config, { id, scope: SCOPE });
      assert.equal(got.ok, true, JSON.stringify(got));
      assert.equal((got.data as { record: { evidence: string | null } }).record.evidence, expected);

      const listed = listRecords(ctx.db, ctx.config, { scope: SCOPE, limit: 10 });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      assert.equal(itemById(listed.data, id)?.["evidence"], expected);

      const searched = searchRecords(ctx.db, ctx.config, { query: "persimmon", scope: SCOPE, limit: 10 });
      assert.equal(searched.ok, true, JSON.stringify(searched));
      assert.equal(itemById(searched.data, id)?.["evidence"], expected);

      const recalled = recallRecords(ctx.db, ctx.config, { query: "persimmon", scope: SCOPE, limit: 10 });
      assert.equal(recalled.ok, true, JSON.stringify(recalled));
      assert.equal(itemById(recalled.data, id)?.["evidence"], expected);

      // Absent evidence is an explicit null everywhere (legacy-compatible).
      const plain = rememberRecord(
        ctx.db,
        ctx.config,
        rememberParams(ctx, "ev-plain", "orchard apple memo"),
        "ev-plain",
        OBS,
      );
      assert.equal(plain.ok, true, JSON.stringify(plain));
      const plainId = (plain.data as { record: { id: string } }).record.id;
      const plainGot = getRecord(ctx.db, ctx.config, { id: plainId, scope: SCOPE });
      assert.equal((plainGot.data as { record: { evidence: string | null } }).record.evidence, null);
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects non-user_fact kinds, malformed values, and >400 code points with no persistence", () => {
    const ctx = setup();
    try {
      const before = {
        records: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n,
        ops: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM operations WHERE op='record.remember'`).get() as { n: number }).n,
      };

      // kind restriction: only user_fact may carry evidence.
      const summary = rememberRecord(
        ctx.db,
        ctx.config,
        {
          body: "derived summary note",
          kind: "summary",
          provenance: { source: "derived:llm", observedAt: OBS },
          scope: SCOPE,
          sourceRefs: [],
          evidence: "a verbatim user quote",
        },
        "ev-bad-kind",
        OBS,
      );
      assert.equal(summary.code, "BAD_REQUEST", JSON.stringify(summary));

      const malformed: unknown[] = [null, 7, true, "", "   ", "bad\u0000quote", "bad\nquote", "bad\u007fquote"];
      for (const [i, evidence] of malformed.entries()) {
        const res = rememberRecord(
          ctx.db,
          ctx.config,
          rememberParams(ctx, `ev-bad-${i}`, `bad evidence body ${i}`, evidence),
          `ev-bad-${i}`,
          OBS,
        );
        assert.equal(res.code, "BAD_REQUEST", `malformed ${i}: ${JSON.stringify(res)}`);
      }

      const tooLong = "é".repeat(EVIDENCE_MAX_CP + 1);
      const over = rememberRecord(
        ctx.db,
        ctx.config,
        rememberParams(ctx, "ev-over", "over long evidence body", tooLong),
        "ev-over",
        OBS,
      );
      assert.equal(over.code, "LIMIT_EXCEEDED", JSON.stringify(over));

      const after = {
        records: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n,
        ops: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM operations WHERE op='record.remember'`).get() as { n: number }).n,
      };
      assert.deepEqual(after, before, "invalid evidence persists no record/operation");
      assert.equal(EVIDENCE_MAX_CP, 400);
    } finally {
      ctx.cleanup();
    }
  });

  it("accepts exactly 400 code points and returns all 400", () => {
    const ctx = setup();
    try {
      const exact = "é".repeat(400);
      const res = rememberRecord(
        ctx.db,
        ctx.config,
        rememberParams(ctx, "ev-exact", "exact bound evidence body", exact),
        "ev-exact",
        OBS,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const id = (res.data as { record: { id: string } }).record.id;
      const got = getRecord(ctx.db, ctx.config, { id, scope: SCOPE });
      const evidence = (got.data as { record: { evidence: string | null } }).record.evidence;
      assert.equal(evidence, exact);
      assert.equal([...(evidence as string)].length, 400);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("evidence quote: idempotency and ranking", () => {
  it("evidence participates in the request hash (replay, dedup, CONFLICT on change)", () => {
    const ctx = setup();
    try {
      const params = rememberParams(ctx, "ev-replay", "replay evidence orchard note", "  the exact words  ");
      const first = rememberRecord(ctx.db, ctx.config, params, "ev-replay", OBS);
      assert.equal(first.ok, true, JSON.stringify(first));
      const firstId = (first.data as { record: { id: string } }).record.id;

      const replay = rememberRecord(ctx.db, ctx.config, params, "ev-replay", OBS);
      assert.equal(replay.ok, true, JSON.stringify(replay));
      assert.equal(replay.deduplicated, true, "same params replay is deduplicated");
      assert.equal((replay.data as { record: { id: string } }).record.id, firstId);

      // Whitespace-only difference normalizes to the same evidence and hash.
      const padded = { ...params, evidence: "the exact words" };
      const normalizedReplay = rememberRecord(ctx.db, ctx.config, padded, "ev-replay", OBS);
      assert.equal(normalizedReplay.ok, true, JSON.stringify(normalizedReplay));
      assert.equal(normalizedReplay.deduplicated, true, "NFC/trim-equivalent evidence keeps the same hash");

      const changed = rememberRecord(
        ctx.db,
        ctx.config,
        { ...params, evidence: "different exact words" },
        "ev-replay",
        OBS,
      );
      assert.equal(changed.code, "CONFLICT", JSON.stringify(changed));

      const dropped = rememberRecord(
        ctx.db,
        ctx.config,
        { body: params["body"], kind: params["kind"], provenance: params["provenance"], scope: params["scope"], sourceRefs: params["sourceRefs"] },
        "ev-replay",
        OBS,
      );
      assert.equal(dropped.code, "CONFLICT", "removing evidence changes the hash");

      assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM records WHERE kind='user_fact'`).get() as { n: number }).n, 1);
    } finally {
      ctx.cleanup();
    }
  });

  it("evidence is stored/returned but never indexed for recall or search ranking", () => {
    const ctx = setup();
    try {
      // A token that shares no bigram with the raw event bodies or the other
      // record: recall's raw-descent fallback cannot pull the evidence-only
      // record in by an unrelated bigram overlap.
      const secret = "zzqxvbnm zanzibar";
      const withEvidence = rememberRecord(
        ctx.db,
        ctx.config,
        rememberParams(ctx, "ev-rank-a", "weekly grocery list", secret),
        "ev-rank-a",
        OBS,
      );
      assert.equal(withEvidence.ok, true, JSON.stringify(withEvidence));
      const withEvidenceId = (withEvidence.data as { record: { id: string } }).record.id;

      const bodyMatch = rememberRecord(
        ctx.db,
        ctx.config,
        rememberParams(ctx, "ev-rank-b", "zzqxvbnm travel notes"),
        "ev-rank-b",
        OBS,
      );
      assert.equal(bodyMatch.ok, true, JSON.stringify(bodyMatch));
      const bodyMatchId = (bodyMatch.data as { record: { id: string } }).record.id;

      for (const result of [
        recallRecords(ctx.db, ctx.config, { query: "zzqxvbnm", scope: SCOPE, limit: 10 }),
        searchRecords(ctx.db, ctx.config, { query: "zzqxvbnm", scope: SCOPE, limit: 10 }),
      ]) {
        assert.equal(result.ok, true, JSON.stringify(result));
        const items = (result.data as { items: Array<{ id: string }> }).items;
        assert.ok(items.some((i) => i.id === bodyMatchId), "body match remains findable");
        assert.equal(items.some((i) => i.id === withEvidenceId), false, "evidence text is not a ranking signal");
      }
    } finally {
      ctx.cleanup();
    }
  });
});

describe("evidence quote: migration and successors", () => {
  it("migrates an existing v12 DB in place: rows kept, NULL evidence, new writes work", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "evidence-mig-"));
    try {
      const { config, configPath } = baseConfig(dir);
      const dbFile = path.join(dir, "t.db");
      const old = new DatabaseSync(dbFile);
      try {
        old.exec(`CREATE TABLE scopes(scope TEXT PRIMARY KEY)`);
        old.prepare(`INSERT INTO scopes(scope) VALUES (?)`).run(SCOPE);
        old.exec(`CREATE TABLE records(
          id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
          source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','superseded','archived','retired')),
          supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL,
          privacySensitivity TEXT NULL CHECK(privacySensitivity IN ('normal','sensitive')),
          privacyOrigin TEXT NULL CHECK(privacyOrigin IN ('conversation','self_activity')))`);
        old.prepare(
          `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
           VALUES ('rec_v12', 'legacy v12 body', 'legacy v12 body', 'sha256:x', 'user_fact', 's', ?, ?, 'active', NULL, 1, ?)`,
        ).run(OBS, SCOPE, OBS);
        old.exec(`PRAGMA user_version = 12`);
      } finally {
        old.close();
      }

      const { db } = initDb(config, configPath);
      try {
        assert.equal((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, SCHEMA_VERSION);
        assert.equal(SCHEMA_VERSION, 13);
        const cols = (db.prepare(`PRAGMA table_info(records)`).all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(cols.includes("evidence"), "evidence column added");
        const legacy = db.prepare(`SELECT evidence FROM records WHERE id='rec_v12'`).get() as { evidence: string | null };
        assert.equal(legacy.evidence, null, "legacy row keeps NULL evidence");

        const ctx = { db, config };
        const res = rememberRecord(
          db,
          config,
          rememberParams(ctx, "ev-after-mig", "post migration evidence body", "post migration quote"),
          "ev-after-mig",
          OBS,
        );
        assert.equal(res.ok, true, JSON.stringify(res));
        const id = (res.data as { record: { id: string } }).record.id;
        const got = getRecord(db, config, { id, scope: SCOPE });
        assert.equal((got.data as { record: { evidence: string | null } }).record.evidence, "post migration quote");
      } finally {
        db.close();
      }

      // Close/reopen through initDb: the migrated file stays current.
      const reopened = initDb(config, configPath);
      try {
        assert.equal((reopened.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, 13);
      } finally {
        reopened.db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("record.correct does not copy evidence to its correction successor and rejects an evidence param", () => {
    const ctx = setup();
    try {
      const res = rememberRecord(
        ctx.db,
        ctx.config,
        rememberParams(ctx, "ev-correct", "original fact body", "the original user quote"),
        "ev-correct",
        OBS,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const id = (res.data as { record: { id: string } }).record.id;

      const corr = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: id,
          body: "revised fact body",
          kind: "correction",
          provenance: prov(),
          scope: SCOPE,
        },
        "ev-correct-1",
        OBS,
      );
      assert.equal(corr.ok, true, JSON.stringify(corr));
      const newId = (corr.data as { record: { id: string } }).record.id;
      const got = getRecord(ctx.db, ctx.config, { id: newId, scope: SCOPE });
      assert.equal((got.data as { record: { kind: string; evidence: string | null } }).record.kind, "correction");
      assert.equal((got.data as { record: { evidence: string | null } }).record.evidence, null, "evidence is not copied");

      // The original row keeps its evidence (history is not rewritten).
      const oldRow = ctx.db.prepare(`SELECT evidence FROM records WHERE id = ?`).get(id) as { evidence: string | null };
      assert.equal(oldRow.evidence, "the original user quote");

      // record.correct has no evidence parameter: it is an unknown field.
      const rejected = correctRecord(
        ctx.db,
        ctx.config,
        {
          recordId: newId,
          body: "another revision",
          kind: "correction",
          provenance: prov(),
          scope: SCOPE,
          evidence: "caller supplied quote",
        },
        "ev-correct-2",
        OBS,
      );
      assert.equal(rejected.code, "BAD_REQUEST", JSON.stringify(rejected));
    } finally {
      ctx.cleanup();
    }
  });
});
