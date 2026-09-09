/**
 * M1 core tests: fresh v2 schema + legacy fail-fast, strict startup config,
 * protocol op allowlist (no approval-era ops), event.append, and
 * record.remember with record.get / record.list.
 *
 * Public store/CLI behavior only. Deterministic, bounded, Windows-safe.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, type AppConfig } from "../src/config.js";
import { initDb, M1_USER_VERSION } from "../src/db.js";
import { eventAppend, getRecord, listRecords, recallRecords, rememberRecord, hasLegacyApprovalSchema } from "../src/store.js";
import { validateRequest, WRITE_OPS, READ_OPS } from "../src/protocol.js";

function baseConfig(dir: string, extraScopes: string[] = []): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: ["personal/default", ...extraScopes],
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

function setup(extraScopes: string[] = []): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-core-"));
  const { config, configPath } = baseConfig(dir, extraScopes);
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

const OBS = "2026-09-01T00:00:00.000Z";
function prov(source = "session:s1:turn:3"): { source: string; observedAt: string } {
  return { source, observedAt: OBS };
}

function appendRaw(
  db: DatabaseSync,
  config: AppConfig,
  overrides: Record<string, unknown> = {},
  key = "ev-k1",
): ReturnType<typeof eventAppend> {
  return eventAppend(
    db,
    config,
    {
      eventId: "e1",
      sessionId: "s1",
      turnId: "t1",
      body: "next wednesday booking check",
      provenance: prov(),
      scope: "personal/default",
      ...overrides,
    },
    key,
  );
}

/** Append a raw event with a unique id, then remember a user_fact citing it. */
function rememberWithRef(
  db: DatabaseSync,
  config: AppConfig,
  eventId: string,
  body: string,
  key: string,
  now?: string,
): { recordId: string } {
  const ev = appendRaw(db, config, { eventId, body: `raw context for ${body}` }, `ev-${eventId}`);
  assert.equal(ev.ok, true);
  const res = rememberRecord(
    db,
    config,
    { body, kind: "user_fact", provenance: prov(), scope: "personal/default", sourceRefs: [eventId] },
    key,
    now,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return { recordId: (res.data as { record: { id: string } }).record.id };
}

describe("m1 schema: fresh v2 and legacy fail-fast", () => {
  it("fresh init stamps user_version=2 with M1 tables and no legacy trace", () => {
    const ctx = setup();
    try {
      const uv = (ctx.db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version;
      assert.equal(uv, M1_USER_VERSION);
      assert.equal(uv, 2);
      for (const t of ["raw_events", "records", "operations", "audit", "exposures", "projection_queue"]) {
        const row = ctx.db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(t) as
          | { name: string }
          | undefined;
        assert.ok(row, `missing table ${t}`);
      }
      assert.equal(hasLegacyApprovalSchema(ctx.db), false);
    } finally {
      ctx.cleanup();
    }
  });

  it("legacy candidates table is detected and init fails without mutating the file", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-legacy-"));
    try {
      const { config, configPath } = baseConfig(dir);
      const legacy = new DatabaseSync(config.dbPath);
      legacy.exec(`CREATE TABLE candidates(id TEXT PRIMARY KEY, body TEXT)`);
      legacy.exec(`INSERT INTO candidates(id, body) VALUES ('c1', 'old')`);
      legacy.close();
      assert.throws(() => initDb(config, configPath), /legacy approval schema/);
      const reopen = new DatabaseSync(config.dbPath);
      try {
        const row = reopen.prepare(`SELECT body FROM candidates WHERE id='c1'`).get() as { body: string };
        assert.equal(row.body, "old");
      } finally {
        reopen.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unexpected user_version and unstamped non-empty files fail fast", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-legacy2-"));
    try {
      const { config, configPath } = baseConfig(dir);
      const f1 = path.join(dir, "v99.db");
      const d1 = new DatabaseSync(f1);
      d1.exec(`PRAGMA user_version = 99`);
      d1.close();
      assert.throws(() => initDb({ ...config, dbPath: f1 }, configPath), /legacy|user_version/i);
      const f2 = path.join(dir, "junk.db");
      const d2 = new DatabaseSync(f2);
      d2.exec(`CREATE TABLE junk(id TEXT PRIMARY KEY)`);
      d2.close();
      assert.throws(() => initDb({ ...config, dbPath: f2 }, configPath), /legacy/i);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("legacy refusal is byte-stable: no WAL/sidecar mutation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-legacy-stable-"));
    try {
      const { config, configPath } = baseConfig(dir);
      const legacy = new DatabaseSync(config.dbPath);
      legacy.exec(`CREATE TABLE candidates(id TEXT PRIMARY KEY, body TEXT)`);
      legacy.exec(`INSERT INTO candidates(id, body) VALUES ('c1', 'old')`);
      legacy.close();
      const before = fs.readFileSync(config.dbPath);
      assert.equal(fs.existsSync(`${config.dbPath}-wal`), false);
      assert.equal(fs.existsSync(`${config.dbPath}-shm`), false);
      assert.throws(() => initDb(config, configPath), /legacy approval schema/);
      assert.deepEqual(fs.readFileSync(config.dbPath), before);
      assert.equal(fs.existsSync(`${config.dbPath}-wal`), false);
      assert.equal(fs.existsSync(`${config.dbPath}-shm`), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("m1 strict startup config", () => {
  function writeConfig(dir: string, obj: unknown): string {
    const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
    fs.writeFileSync(p, JSON.stringify(obj), "utf8");
    return p;
  }

  function validObj(): Record<string, unknown> {
    return {
      dbPath: "./memory.db",
      vaultPath: "./vault",
      allowedScopes: ["personal/default"],
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
  }

  it("requires vaultPath and rejects unknown/missing bounds", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-cfg-"));
    try {
      const noVault = validObj() as Record<string, unknown>;
      delete noVault["vaultPath"];
      assert.throws(() => loadConfig(writeConfig(dir, noVault)), /vaultPath/);
      assert.throws(() => loadConfig(writeConfig(dir, { ...validObj(), vaultPath: "" })), /vaultPath/);
      assert.throws(() => loadConfig(writeConfig(dir, { ...validObj(), candidateTtlSec: 1 })), /unknown config field/);
      const limits = { ...(validObj()["limits"] as Record<string, unknown>) };
      delete limits["linksMax"];
      assert.throws(() => loadConfig(writeConfig(dir, { ...validObj(), limits })), /linksMax/);
      const limits2 = { ...(validObj()["limits"] as Record<string, unknown>) };
      delete limits2["sourceRefsMax"];
      assert.throws(() => loadConfig(writeConfig(dir, { ...validObj(), limits: limits2 })), /sourceRefsMax/);
      const limits3 = { ...(validObj()["limits"] as Record<string, unknown>), limitDefault: 50, limitMax: 10 };
      assert.throws(() => loadConfig(writeConfig(dir, { ...validObj(), limits: limits3 })), /limitDefault/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("shipped example config loads", () => {
    const cfg = loadConfig(path.join(process.cwd(), "memory.config.example.json"));
    assert.ok(cfg.vaultPath.length > 0);
    assert.ok(cfg.limits.linksMax >= 0 && cfg.limits.sourceRefsMax >= 0);
  });
});

describe("m1 protocol op allowlist: no approval-era ops", () => {
  it("accepts exactly the 8 autonomous M1 ops", () => {
    for (const op of WRITE_OPS) {
      const r = validateRequest({ v: 1, op, idempotencyKey: "k-1", params: {} });
      assert.equal(r.ok, true, op);
    }
    for (const op of READ_OPS) {
      const r = validateRequest({ v: 1, op, params: {} });
      assert.equal(r.ok, true, op);
    }
    assert.deepEqual(
      [...WRITE_OPS].sort(),
      ["event.append", "record.archive", "record.correct", "record.feedback", "record.remember"].sort(),
    );
    assert.deepEqual([...READ_OPS].sort(), ["record.get", "record.list", "record.recall"].sort());
  });

  it("rejects candidate/approval/TTY/distill-era ops as BAD_REQUEST", () => {
    const oldOps = [
      "candidate.create",
      "candidate.get",
      "approve",
      "reject",
      "review",
      "archive",
      "record.correct-request",
      "record.vector-search",
      "maintain.distill",
      "admin.export",
    ];
    for (const op of oldOps) {
      const withKey = validateRequest({ v: 1, op, idempotencyKey: "k-1", params: {} });
      assert.equal(withKey.ok, false, op);
      if (!withKey.ok) assert.equal(withKey.res.code, "BAD_REQUEST");
      const bare = validateRequest({ v: 1, op, params: {} });
      assert.equal(bare.ok, false, op);
    }
  });

  it("enforces idempotency-key placement and envelope shape", () => {
    const missing = validateRequest({ v: 1, op: "record.remember", params: {} });
    assert.equal(missing.ok, false);
    const extra = validateRequest({ v: 1, op: "record.recall", idempotencyKey: "k-1", params: {} });
    assert.equal(extra.ok, false);
    if (!extra.ok) assert.equal(extra.res.code, "BAD_REQUEST");
    const badV = validateRequest({ v: 2, op: "record.recall", params: {} });
    assert.equal(badV.ok, false);
  });
});

describe("event.append: idempotency, scope, bounds", () => {
  it("appends, replays deduplicated, conflicts on changed params or reused eventId", () => {
    const ctx = setup();
    try {
      const first = appendRaw(ctx.db, ctx.config);
      assert.equal(first.ok, true);
      assert.equal(first.deduplicated, false);
      const replay = appendRaw(ctx.db, ctx.config);
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true);
      const changed = appendRaw(ctx.db, ctx.config, { body: "different body here" }, "ev-k1");
      assert.equal(changed.ok, false);
      assert.equal(changed.code, "CONFLICT");
      const freshKey = appendRaw(ctx.db, ctx.config, {}, "ev-k2");
      assert.equal(freshKey.ok, false);
      assert.equal(freshKey.code, "CONFLICT");
    } finally {
      ctx.cleanup();
    }
  });

  it("rejects unknown scope, over-budget bodies, and unknown fields", () => {
    const ctx = setup();
    try {
      assert.equal(appendRaw(ctx.db, ctx.config, { scope: "nope/scope" }, "k-scope").code, "FORBIDDEN_SCOPE");
      assert.equal(appendRaw(ctx.db, ctx.config, { body: "x".repeat(2001) }, "k-big").code, "LIMIT_EXCEEDED");
      assert.equal(appendRaw(ctx.db, ctx.config, { body: "   " }, "k-empty").code, "BAD_REQUEST");
      const extra = eventAppend(
        ctx.db,
        ctx.config,
        { eventId: "e9", sessionId: "s1", turnId: "t1", body: "fine", provenance: prov(), scope: "personal/default", bogus: 1 },
        "k-extra",
      );
      assert.equal(extra.code, "BAD_REQUEST");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("record.remember immediate write + get/list", () => {
  it("remember is immediately recallable and get returns the full view", () => {
    const ctx = setup();
    try {
      const { recordId } = rememberWithRef(ctx.db, ctx.config, "e-remember-1", "booking reference alpha bravo", "rem-1");
      const got = getRecord(ctx.db, ctx.config, { id: recordId, scope: "personal/default" });
      assert.equal(got.ok, true);
      const view = (got.data as { record: Record<string, unknown> }).record;
      assert.equal(view["status"], "active");
      assert.equal(view["kind"], "user_fact");
      assert.deepEqual(view["sourceRefs"], ["e-remember-1"]);
      const rec = recallRecords(ctx.db, ctx.config, { query: "booking reference", scope: "personal/default", limit: 10 });
      assert.equal(rec.ok, true);
      const ids = ((rec.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
      assert.ok(ids.includes(recordId), `recall missed ${recordId}: ${JSON.stringify(ids)}`);
    } finally {
      ctx.cleanup();
    }
  });

  it("validates sourceRefs: missing ref NOT_FOUND, cross-scope FORBIDDEN_SCOPE", () => {
    const ctx = setup(["work/default"]);
    try {
      const missing = rememberRecord(
        ctx.db,
        ctx.config,
        { body: "orphan note", kind: "user_fact", provenance: prov(), scope: "personal/default", sourceRefs: ["no-such-event"] },
        "rem-miss",
      );
      assert.equal(missing.code, "NOT_FOUND");
      const ev = eventAppend(
        ctx.db,
        ctx.config,
        { eventId: "e-work-1", sessionId: "s1", turnId: "t1", body: "work raw", provenance: prov(), scope: "work/default" },
        "ev-work-1",
      );
      assert.equal(ev.ok, true);
      const cross = rememberRecord(
        ctx.db,
        ctx.config,
        { body: "cross scope note", kind: "user_fact", provenance: prov(), scope: "personal/default", sourceRefs: ["e-work-1"] },
        "rem-cross",
      );
      assert.equal(cross.code, "FORBIDDEN_SCOPE");
      const empty = rememberRecord(
        ctx.db,
        ctx.config,
        { body: "no refs fact", kind: "user_fact", provenance: prov(), scope: "personal/default", sourceRefs: [] },
        "rem-empty",
      );
      assert.equal(empty.code, "BAD_REQUEST");
      const derived = rememberRecord(
        ctx.db,
        ctx.config,
        { body: "derived summary", kind: "summary", provenance: prov("derived-model:v1"), scope: "personal/default", sourceRefs: [] },
        "rem-derived",
      );
      assert.equal(derived.ok, true);
    } finally {
      ctx.cleanup();
    }
  });

  it("get/list enforce scope, status filter, order, and limits", () => {
    const ctx = setup();
    try {
      const a = rememberWithRef(ctx.db, ctx.config, "e-ord-1", "first note aardvark", "rem-a", "2026-09-01T00:00:00.000Z");
      const b = rememberWithRef(ctx.db, ctx.config, "e-ord-2", "second note aardvark", "rem-b", "2026-09-02T00:00:00.000Z");
      const listed = listRecords(ctx.db, ctx.config, { scope: "personal/default", limit: 10 });
      assert.equal(listed.ok, true);
      const items = (listed.data as { items: Array<{ id: string }> }).items;
      assert.deepEqual(items.map((i) => i.id), [b.recordId, a.recordId]);
      assert.equal(getRecord(ctx.db, ctx.config, { id: a.recordId, scope: "work/missing" }).code, "FORBIDDEN_SCOPE");
      assert.equal(getRecord(ctx.db, ctx.config, { id: "rec_does_not_exist", scope: "personal/default" }).code, "NOT_FOUND");
      assert.equal(listRecords(ctx.db, ctx.config, { scope: "personal/default", status: "bogus" }).code, "BAD_REQUEST");
      assert.equal(listRecords(ctx.db, ctx.config, { scope: "personal/default", limit: 999 }).code, "LIMIT_EXCEEDED");
      const archived = listRecords(ctx.db, ctx.config, { scope: "personal/default", status: "archived" });
      assert.equal(archived.ok, true);
      assert.deepEqual((archived.data as { items: unknown[] }).items, []);
    } finally {
      ctx.cleanup();
    }
  });
});
