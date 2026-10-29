/**
 * F-I01-05 privacy metadata tests (deterministic, hand-decided where a model
 * is involved):
 * - fresh schema carries nullable privacy columns (raw_events + records);
 * - valid/invalid `privacy` shapes on event.append / record.remember
 *   (BAD_REQUEST with NO persistence on invalid);
 * - requirePrivacy=true rejects missing privacy with no side effects;
 * - record.correct inherits the superseded record's privacy when absent and
 *   overrides when present (inherit includes null);
 * - record.get / record.search return privacy; legacy rows (NULL) read null;
 * - maintain.distill consolidation propagates source sensitivity via the
 *   single deriveConsolidationPrivacy helper (stub-decided, no model);
 * - migration of an existing DB without the columns (rows kept, NULL).
 *
 * P4a: record.recall output is unchanged (privacy is stored/returned only,
 * never part of recall).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig, requirePrivacyEnabled, type AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { requestHashFor } from "../src/normalize.js";
import { correctRecord, ensureM1Schema, eventAppend, getRecord, recallRecords, rememberRecord, searchRecords } from "../src/store.js";
import { deriveConsolidationPrivacy, parsePrivacyParam } from "../src/privacy.js";
import { maintainDistill } from "../src/distill.js";

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-"));
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
function prov(source = "derived:llm"): { source: string; observedAt: string } {
  return { source, observedAt: OBS };
}

/** remember a model_inference with empty sourceRefs (derived marker source). */
function remember(
  db: DatabaseSync,
  config: AppConfig,
  body: string,
  key: string,
  privacy?: Record<string, unknown>,
): { ok: boolean; id: string | null } {
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "model_inference",
      provenance: prov(),
      scope: "personal/default",
      ...(privacy !== undefined ? { privacy } : {}),
    },
    key,
    OBS, // fixed clock: queue nextAt stays before the distill timestamp T3
  );
  const id = res.ok
    ? ((res.data as { record: { id: string } }).record.id as string)
    : null;
  return { ok: res.ok, id };
}

describe("privacy metadata: schema", () => {
  it("fresh schema carries nullable privacy columns on raw_events and records", () => {
    const ctx = setup();
    try {
      for (const table of ["raw_events", "records"]) {
        const cols = (ctx.db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(cols.includes("privacySensitivity"), `${table}.privacySensitivity`);
        assert.ok(cols.includes("privacyOrigin"), `${table}.privacyOrigin`);
      }
    } finally {
      ctx.cleanup();
    }
  });

  it("migration: an existing DB without the columns keeps rows and adds NULL columns", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-mig-"));
    try {
      const { config } = baseConfig(dir);
      const db = new DatabaseSync(path.join(dir, "old.db"));
      try {
        db.exec(`CREATE TABLE scopes(scope TEXT PRIMARY KEY)`);
        db.prepare(`INSERT INTO scopes(scope) VALUES (?)`).run("personal/default");
        // Current-era records shape (retired allowed) WITHOUT privacy columns.
        db.exec(`CREATE TABLE records(
          id TEXT PRIMARY KEY, body TEXT NOT NULL, bodyNorm TEXT NOT NULL, bodyHash TEXT NOT NULL,
          kind TEXT NOT NULL CHECK(kind IN ('user_fact','model_inference','summary','correction')),
          source TEXT NOT NULL, observedAt TEXT NOT NULL, scope TEXT NOT NULL,
          status TEXT NOT NULL CHECK(status IN ('active','superseded','archived','retired')),
          supersedes TEXT NULL, revision INTEGER NOT NULL, createdAt TEXT NOT NULL)`);
        db.prepare(
          `INSERT INTO records(id, body, bodyNorm, bodyHash, kind, source, observedAt, scope, status, supersedes, revision, createdAt)
           VALUES ('rec_legacy1', 'legacy body', 'legacy body', 'sha256:x', 'user_fact', 's', ?, 'personal/default', 'active', NULL, 1, ?)`,
        ).run(OBS, OBS);
        ensureM1Schema(db); // F-I01-05 additive migration (ALTER TABLE ADD COLUMN)
        // Stamp the M1 version (initDb refuses a version-0 file that already
        // holds tables; a real pre-privacy DB was stamped this way).
        db.exec(`PRAGMA user_version = 2`);
        const cols = (db.prepare(`PRAGMA table_info(records)`).all() as Array<{ name: string }>).map((c) => c.name);
        assert.ok(cols.includes("privacySensitivity"));
        assert.ok(cols.includes("privacyOrigin"));
        const row = db.prepare(`SELECT privacySensitivity, privacyOrigin FROM records WHERE id='rec_legacy1'`).get() as {
          privacySensitivity: string | null;
          privacyOrigin: string | null;
        };
        assert.equal(row.privacySensitivity, null, "legacy row privacy stays NULL");
        assert.equal(row.privacyOrigin, null, "legacy row privacy stays NULL");
        // New writes with privacy still work on the migrated table.
        const res = remember(db, config, "new note after migration", "pm-mig-w1", {
          sensitivity: "sensitive",
          origin: "conversation",
        });
        assert.equal(res.ok, true, "write on migrated table works");
      } finally {
        try {
          db.close();
        } catch {
          /* ignore */
        }
      }
      // Reopen through initDb: the migrated DB stays compatible (no legacy refusal).
      const configPath = path.join(dir, "memory.config.json");
      fs.writeFileSync(configPath, JSON.stringify({ dbPath: "./old.db", vaultPath: "./vault", allowedScopes: ["personal/default"], limits: baseConfig(dir).config.limits, timeouts: baseConfig(dir).config.timeouts, dbMaxBytes: 104857600 }));
      const reopened = initDb(loadConfig(configPath), configPath);
      reopened.db.close();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("privacy metadata: param validation", () => {
  it("parsePrivacyParam: strict shape, absent is null, explicit null and anything else invalid", () => {
    assert.equal(parsePrivacyParam(undefined), null);
    // P2: explicit JSON null is BAD_REQUEST; only absence means "omitted".
    assert.equal(parsePrivacyParam(null), "invalid");
    assert.deepEqual(parsePrivacyParam({ sensitivity: "normal", origin: "conversation" }), {
      sensitivity: "normal",
      origin: "conversation",
    });
    assert.deepEqual(parsePrivacyParam({ sensitivity: "sensitive", origin: "self_activity" }), {
      sensitivity: "sensitive",
      origin: "self_activity",
    });
    // Wrong/extra/missing keys, bad enums, non-objects.
    assert.equal(parsePrivacyParam({ sensitivity: "normal" }), "invalid");
    assert.equal(parsePrivacyParam({ origin: "conversation" }), "invalid");
    assert.equal(parsePrivacyParam({ sensitivity: "normal", origin: "conversation", extra: 1 }), "invalid");
    assert.equal(parsePrivacyParam({ sensitivity: "public", origin: "conversation" }), "invalid");
    assert.equal(parsePrivacyParam({ sensitivity: "normal", origin: "derived" }), "invalid");
    assert.equal(parsePrivacyParam("sensitive"), "invalid");
    assert.equal(parsePrivacyParam(7), "invalid");
    assert.equal(parsePrivacyParam({ sensitivity: 1, origin: "conversation" }), "invalid");
  });

  it("deriveConsolidationPrivacy: single propagation rule (sensitive wins, all-known normal, unknown null)", () => {
    assert.deepEqual(deriveConsolidationPrivacy(["sensitive", "sensitive"]), { sensitivity: "sensitive", origin: "self_activity" });
    assert.deepEqual(deriveConsolidationPrivacy(["sensitive", "normal"]), { sensitivity: "sensitive", origin: "self_activity" });
    assert.deepEqual(deriveConsolidationPrivacy(["sensitive", null]), { sensitivity: "sensitive", origin: "self_activity" });
    assert.deepEqual(deriveConsolidationPrivacy(["normal", "normal"]), { sensitivity: "normal", origin: "self_activity" });
    assert.equal(deriveConsolidationPrivacy(["normal", null]), null);
    assert.equal(deriveConsolidationPrivacy([null]), null);
    assert.equal(deriveConsolidationPrivacy([]), null);
  });

  it("event.append: valid privacy is stored; invalid shapes are BAD_REQUEST with no persistence", () => {
    const ctx = setup();
    try {
      const ok1 = eventAppend(ctx.db, ctx.config, {
        eventId: "e-ok", sessionId: "s1", turnId: "t1", body: "private context note",
        provenance: prov(), scope: "personal/default",
        privacy: { origin: "conversation", sensitivity: "sensitive" },
      }, "pm-ev-ok");
      assert.equal(ok1.ok, true, JSON.stringify(ok1));
      const row = ctx.db.prepare(`SELECT privacySensitivity, privacyOrigin FROM raw_events WHERE eventId='e-ok'`).get() as {
        privacySensitivity: string; privacyOrigin: string;
      };
      assert.deepEqual([row.privacySensitivity, row.privacyOrigin], ["sensitive", "conversation"]);

      const badShapes: unknown[] = [
        { sensitivity: "normal" }, // missing origin
        { origin: "conversation" }, // missing sensitivity
        { sensitivity: "normal", origin: "conversation", extra: true }, // extra key
        { sensitivity: "public", origin: "conversation" }, // bad enum
        { sensitivity: "normal", origin: "derived" }, // bad enum
        "sensitive", // non-object
      ];
      const before = {
        raw: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM raw_events`).get() as { n: number }).n,
        ops: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM operations`).get() as { n: number }).n,
      };
      for (const [i, privacy] of badShapes.entries()) {
        const res = eventAppend(ctx.db, ctx.config, {
          eventId: `e-bad-${i}`, sessionId: "s1", turnId: "t1", body: "bad privacy body",
          provenance: prov(), scope: "personal/default", privacy,
        }, `pm-ev-bad-${i}`);
        assert.equal(res.ok, false, `shape ${i} must be rejected`);
        assert.equal((res as { code: string }).code, "BAD_REQUEST", `shape ${i} code`);
      }
      const after = {
        raw: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM raw_events`).get() as { n: number }).n,
        ops: (ctx.db.prepare(`SELECT COUNT(*) AS n FROM operations`).get() as { n: number }).n,
      };
      assert.deepEqual(after, before, "invalid privacy persists nothing");
    } finally {
      ctx.cleanup();
    }
  });

  it("record.remember: valid privacy stored + returned by get; invalid shapes BAD_REQUEST with no persistence", () => {
    const ctx = setup();
    try {
      const good = remember(ctx.db, ctx.config, "the api key rotates weekly", "pm-rem-ok", {
        sensitivity: "sensitive",
        origin: "conversation",
      });
      assert.equal(good.ok, true);
      const got = getRecord(ctx.db, ctx.config, { id: good.id, scope: "personal/default" });
      const rec = (got.data as { record: { privacy: { sensitivity: string; origin: string } | null } }).record;
      assert.deepEqual(rec.privacy, { sensitivity: "sensitive", origin: "conversation" });

      const before = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      const badRememberShapes: unknown[] = [
        { sensitivity: "normal", origin: "unknown" }, // bad enum
        { sensitivity: 3, origin: "conversation" }, // non-string sensitivity
        [], // non-object
      ];
      for (const [i, privacy] of badRememberShapes.entries()) {
        const res = rememberRecord(
          ctx.db, ctx.config,
          {
            body: `bad privacy body ${i}`, kind: "model_inference", provenance: prov(),
            scope: "personal/default", privacy,
          },
          `pm-rem-bad-${i}`,
        );
        assert.equal(res.ok, false, `shape ${i} must be rejected`);
        assert.equal((res as { code: string }).code, "BAD_REQUEST", `shape ${i} maps to BAD_REQUEST`);
      }
      const after = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      assert.equal(after, before, "invalid privacy persists nothing");
    } finally {
      ctx.cleanup();
    }
  });

  it("requirePrivacy=true: append/remember without privacy are BAD_REQUEST with no side effects", () => {
    const ctx = setup();
    try {
      ctx.config.requirePrivacy = true;
      assert.equal(requirePrivacyEnabled(ctx.config), true);

      const ev = eventAppend(ctx.db, ctx.config, {
        eventId: "e-np", sessionId: "s1", turnId: "t1", body: "no privacy here",
        provenance: prov(), scope: "personal/default",
      }, "pm-rp-ev");
      assert.equal(ev.ok, false);
      assert.equal((ev as { code: string }).code, "BAD_REQUEST");
      assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM raw_events`).get() as { n: number }).n, 0, "no raw persisted");

      const rem = remember(ctx.db, ctx.config, "no privacy note", "pm-rp-rem");
      assert.equal(rem.ok, false);
      assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n, 0, "no record persisted");

      const evOk = eventAppend(ctx.db, ctx.config, {
        eventId: "e-wp", sessionId: "s1", turnId: "t1", body: "privacy supplied",
        provenance: prov(), scope: "personal/default",
        privacy: { sensitivity: "normal", origin: "self_activity" },
      }, "pm-rp-ev-ok");
      assert.equal(evOk.ok, true, JSON.stringify(evOk));

      const remOk = remember(ctx.db, ctx.config, "privacy supplied note", "pm-rp-rem-ok", {
        sensitivity: "normal",
        origin: "self_activity",
      });
      assert.equal(remOk.ok, true);
    } finally {
      ctx.cleanup();
    }
  });

  it("config: requirePrivacy must be a boolean; true loads; absent default false", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "privacy-cfg-"));
    try {
      const write = (obj: unknown): string => {
        const p = path.join(dir, `cfg-${Math.random().toString(36).slice(2)}.json`);
        fs.writeFileSync(p, JSON.stringify(obj));
        return p;
      };
      const minimal = { dbPath: "./t.db", vaultPath: "./v", allowedScopes: ["personal/default"], limits: baseConfig(dir).config.limits, timeouts: baseConfig(dir).config.timeouts, dbMaxBytes: 104857600 };
      const withTrue = loadConfig(write({ ...minimal, requirePrivacy: true }));
      assert.equal(requirePrivacyEnabled(withTrue), true);
      const withFalse = loadConfig(write({ ...minimal, requirePrivacy: false }));
      assert.equal(requirePrivacyEnabled(withFalse), false);
      const without = loadConfig(write(minimal));
      assert.equal(requirePrivacyEnabled(without), false, "default false");
      assert.throws(() => loadConfig(write({ ...minimal, requirePrivacy: "yes" })), /requirePrivacy must be a boolean/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("privacy metadata: correct + reads", () => {
  it("record.correct inherits the superseded record's privacy when absent, overrides when present", () => {
    const ctx = setup();
    try {
      // remember sensitive/conversation -> correct (no privacy) inherits it.
      const a = remember(ctx.db, ctx.config, "the safe combo is stored separately", "pm-cc-a", {
        sensitivity: "sensitive",
        origin: "conversation",
      });
      assert.equal(a.ok, true);
      const c1 = correctRecord(ctx.db, ctx.config, {
        recordId: a.id, body: "the safe combo is kept in a sealed envelope", kind: "correction",
        provenance: prov(), scope: "personal/default",
      }, "pm-cc-c1");
      assert.equal(c1.ok, true, JSON.stringify(c1));
      const newId1 = (c1.data as { record: { id: string } }).record.id;
      const got1 = (getRecord(ctx.db, ctx.config, { id: newId1, scope: "personal/default" }).data as { record: { privacy: { sensitivity: string; origin: string } | null } }).record;
      assert.deepEqual(got1.privacy, { sensitivity: "sensitive", origin: "conversation" }, "inherit when absent");

      // correct with explicit privacy overrides.
      const c2 = correctRecord(ctx.db, ctx.config, {
        recordId: newId1, body: "the safe combo is engraved inside", kind: "correction",
        provenance: prov(), scope: "personal/default",
        privacy: { sensitivity: "normal", origin: "self_activity" },
      }, "pm-cc-c2");
      assert.equal(c2.ok, true, JSON.stringify(c2));
      const newId2 = (c2.data as { record: { id: string } }).record.id;
      const got2 = (getRecord(ctx.db, ctx.config, { id: newId2, scope: "personal/default" }).data as { record: { privacy: { sensitivity: string; origin: string } | null } }).record;
      assert.deepEqual(got2.privacy, { sensitivity: "normal", origin: "self_activity" }, "explicit override");

      // Legacy (no privacy) -> correct without privacy inherits null.
      const b = remember(ctx.db, ctx.config, "legacy privacy note", "pm-cc-b");
      assert.equal(b.ok, true);
      const c3 = correctRecord(ctx.db, ctx.config, {
        recordId: b.id, body: "legacy privacy corrected", kind: "correction",
        provenance: prov(), scope: "personal/default",
      }, "pm-cc-c3");
      assert.equal(c3.ok, true, JSON.stringify(c3));
      const newId3 = (c3.data as { record: { id: string } }).record.id;
      const got3 = (getRecord(ctx.db, ctx.config, { id: newId3, scope: "personal/default" }).data as { record: { privacy: { sensitivity: string; origin: string } | null } }).record;
      assert.equal(got3.privacy, null, "inherit null for legacy");
    } finally {
      ctx.cleanup();
    }
  });

  it("record.get and record.search return privacy; legacy rows return null; invalid correct privacy is BAD_REQUEST", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "sensitive searchable note", "pm-gs-a", {
        sensitivity: "sensitive",
        origin: "conversation",
      });
      const legacy = remember(ctx.db, ctx.config, "legacy searchable note", "pm-gs-l");

      const got = (getRecord(ctx.db, ctx.config, { id: a.id, scope: "personal/default" }).data as { record: { privacy: unknown } }).record;
      assert.deepEqual(got.privacy, { sensitivity: "sensitive", origin: "conversation" });
      const gotL = (getRecord(ctx.db, ctx.config, { id: legacy.id, scope: "personal/default" }).data as { record: { privacy: unknown } }).record;
      assert.equal(gotL.privacy, null, "legacy row reads null");

      const srch = searchRecords(ctx.db, ctx.config, { query: "searchable note", scope: "personal/default" });
      assert.equal(srch.ok, true, JSON.stringify(srch));
      const items = (srch.data as { items: Array<{ id: string; privacy: unknown }> }).items;
      const byId = new Map(items.map((it) => [it.id, it.privacy]));
      assert.ok(a.id && legacy.id, "remember produced ids");
      if (!a.id || !legacy.id) return;
      assert.deepEqual(byId.get(a.id), { sensitivity: "sensitive", origin: "conversation" });
      assert.equal(byId.get(legacy.id), null);

      // record.recall output unchanged: recall items carry no privacy key (P4a).
      const { recallRecords } = require("../src/store.js") as typeof import("../src/store.js");
      const rec = recallRecords(ctx.db, ctx.config, { query: "searchable note", scope: "personal/default" }, undefined, undefined);
      assert.equal(rec.ok, true, JSON.stringify(rec));
      const rItems = (rec.data as { items: Array<Record<string, unknown>> }).items;
      assert.ok(rItems.length > 0, "recall finds the notes");
      for (const it of rItems) assert.equal("privacy" in it, false, "recall items carry no privacy");
    } finally {
      ctx.cleanup();
    }
  });

  it("idempotency replay unchanged: same key + same params replays with deduplicated flag", () => {
    const ctx = setup();
    try {
      const params = {
        body: "stable replay note", kind: "model_inference", provenance: prov(),
        scope: "personal/default", privacy: { sensitivity: "sensitive", origin: "conversation" },
      };
      const r1 = rememberRecord(ctx.db, ctx.config, params, "pm-idem-1");
      assert.equal(r1.ok, true);
      assert.equal(r1.deduplicated, false);
      const r2 = rememberRecord(ctx.db, ctx.config, params, "pm-idem-1");
      assert.equal(r2.ok, true);
      assert.equal(r2.deduplicated, true, "replay deduplicated");
      assert.deepEqual(r2.data, r1.data, "same envelope replayed");
      // Different privacy under the same key is a different request: CONFLICT.
      const r3 = rememberRecord(ctx.db, ctx.config, { ...params, privacy: { sensitivity: "normal", origin: "conversation" } }, "pm-idem-1");
      assert.equal(r3.ok, false);
      assert.equal((r3 as { code: string }).code, "CONFLICT");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("privacy metadata: cultivation propagation", () => {
  function fakeLlmDir(dir: string): string {
    const modelDir = path.join(dir, "fake-llm");
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
    return modelDir;
  }

  const T3 = "2026-10-01T03:00:00.000Z";

  it("maintain.distill: sensitive source propagates to the consolidated summary", async () => {
    const ctx = setup();
    try {
      ctx.config.llm = {
        modelDir: fakeLlmDir(ctx.dir), timeoutMs: 5000, enabled: true,
        maxNewTokens: 48, maxPromptChars: 2000,
      };
      const a = remember(ctx.db, ctx.config, "the cabin spare key hangs inside the woodshed on a blue hook", "pm-di-a", {
        sensitivity: "sensitive",
        origin: "conversation",
      });
      assert.equal(a.ok, true);
      const b = remember(ctx.db, ctx.config, "the cabin spare key is on the blue hook in the woodshed", "pm-di-b", {
        sensitivity: "normal",
        origin: "self_activity",
      });
      assert.equal(b.ok, true);
      const c = remember(ctx.db, ctx.config, "the boathouse oar rests against the north wall", "pm-di-c");
      assert.equal(c.ok, true);
      const decide = async (prompt: string): Promise<string | null> => {
        if (prompt.includes("What lasting fact")) return "the cabin spare key is a lasting fact";
        if (prompt.includes("Other memories in the same scope")) {
          const head = prompt.split("Other memories")[0] ?? "";
          if (!/cabin|blue hook|woodshed/i.test(head)) return "KEEP";
          const peerRe = /^\s*(\d+)\.\s+"""(.*)"""\s*$/gm;
          let m: RegExpExecArray | null;
          while ((m = peerRe.exec(prompt)) !== null) {
            if (/cabin|blue hook|woodshed/i.test(m[2] ?? "")) return `MERGE ${m[1]}`;
          }
          return "KEEP";
        }
        if (prompt.includes("What single fact do both memories")) {
          return "the cabin spare key is on the blue hook in the woodshed";
        }
        if (prompt.includes("Merge these related memories")) {
          return "the cabin spare key hangs on the blue hook in the woodshed";
        }
        return "KEEP";
      };
      const res = await maintainDistill(
        ctx.db, ctx.config, ctx.configPath,
        { scope: "personal/default", limit: 10 },
        "pm-distill-k1", decide, T3,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const sums = ctx.db.prepare(`SELECT id, privacySensitivity, privacyOrigin FROM records WHERE kind='summary'`).all() as Array<{
        id: string; privacySensitivity: string | null; privacyOrigin: string | null;
      }>;
      assert.equal(sums.length, 1, `expected one summary, got ${sums.length}`);
      assert.deepEqual(
        { sensitivity: sums[0]!.privacySensitivity, origin: sums[0]!.privacyOrigin },
        { sensitivity: "sensitive", origin: "self_activity" },
        "sensitive source propagates; origin is self_activity",
      );
    } finally {
      ctx.cleanup();
    }
  });

  it("maintain.distill: two all-normal sources yield a normal summary; unknown-privacy source yields null", async () => {
    const ctx = setup();
    try {
      ctx.config.llm = {
        modelDir: fakeLlmDir(ctx.dir), timeoutMs: 5000, enabled: true,
        maxNewTokens: 48, maxPromptChars: 2000,
      };
      // Normal pair in scope personal/default -> normal summary.
      remember(ctx.db, ctx.config, "the kayak paddle leans by the side door", "pm-dn-a", {
        sensitivity: "normal", origin: "self_activity",
      });
      remember(ctx.db, ctx.config, "the kayak paddle is by the side door", "pm-dn-b", {
        sensitivity: "normal", origin: "self_activity",
      });
      // Third unrelated legacy record keeps peers available and stays unmerged.
      remember(ctx.db, ctx.config, "a wholly unrelated legacy note", "pm-dn-c");
      const decide = async (prompt: string): Promise<string | null> => {
        if (prompt.includes("What lasting fact")) return "the kayak paddle location is a lasting fact";
        if (prompt.includes("Other memories in the same scope")) {
          const head = prompt.split("Other memories")[0] ?? "";
          if (!/kayak|paddle/i.test(head)) return "KEEP";
          const peerRe = /^\s*(\d+)\.\s+"""(.*)"""\s*$/gm;
          let m: RegExpExecArray | null;
          while ((m = peerRe.exec(prompt)) !== null) {
            if (/kayak|paddle/i.test(m[2] ?? "")) return `MERGE ${m[1]}`;
          }
          return "KEEP";
        }
        if (prompt.includes("What single fact do both memories")) {
          return "the kayak paddle leans by the side door";
        }
        if (prompt.includes("Merge these related memories")) {
          return "the kayak paddle is stored by the side door";
        }
        return "KEEP";
      };
      const res = await maintainDistill(
        ctx.db, ctx.config, ctx.configPath,
        { scope: "personal/default", limit: 10 },
        "pm-distill-n1", decide, T3,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const sums = ctx.db.prepare(`SELECT id, privacySensitivity, privacyOrigin FROM records WHERE kind='summary'`).all() as Array<{
        id: string; privacySensitivity: string | null; privacyOrigin: string | null;
      }>;
      assert.equal(sums.length, 1, `expected one summary, got ${sums.length}`);
      assert.deepEqual(
        { sensitivity: sums[0]!.privacySensitivity, origin: sums[0]!.privacyOrigin },
        { sensitivity: "normal", origin: "self_activity" },
        "all-normal sources propagate normal; origin is self_activity",
      );
    } finally {
      ctx.cleanup();
    }
  });
});

describe("privacy metadata: legacy idempotency hashes + explicit null", () => {
  it("event.append without privacy stores the pre-PR hash (no privacy key) and replays deduplicated", () => {
    const ctx = setup();
    try {
      const params = {
        eventId: "ev-legacy-hash",
        sessionId: "s1",
        turnId: "t1",
        body: "legacy hash body",
        provenance: prov("user_input"),
        scope: "personal/default",
      };
      const res = eventAppend(ctx.db, ctx.config, { ...params }, "pm-hash-append", OBS);
      assert.equal(res.ok, true, JSON.stringify(res));
      const row = ctx.db
        .prepare(`SELECT requestHash FROM operations WHERE idempotencyKey = ?`)
        .get("pm-hash-append") as { requestHash: string };
      // Pre-PR normalization: params object with NO privacy key at all.
      const expected = requestHashFor("event.append", {
        body: params.body,
        eventId: params.eventId,
        observedAt: OBS,
        runId: null,
        scope: params.scope,
        sessionId: params.sessionId,
        source: "user_input",
        turnId: params.turnId,
      });
      assert.equal(row.requestHash, expected, "stored hash omits absent privacy");
      const replay = eventAppend(ctx.db, ctx.config, { ...params }, "pm-hash-append", OBS);
      assert.equal(replay.ok, true);
      assert.equal(replay.deduplicated, true, "replay without privacy is deduplicated, not CONFLICT");
    } finally {
      ctx.cleanup();
    }
  });

  it("record.remember without privacy stores the pre-PR hash (no privacy key)", () => {
    const ctx = setup();
    try {
      const res = rememberRecord(
        ctx.db,
        ctx.config,
        { body: "remember legacy hash", kind: "model_inference", provenance: prov(), scope: "personal/default" },
        "pm-hash-remember",
        OBS,
      );
      assert.equal(res.ok, true, JSON.stringify(res));
      const row = ctx.db
        .prepare(`SELECT requestHash FROM operations WHERE idempotencyKey = ?`)
        .get("pm-hash-remember") as { requestHash: string };
      const expected = requestHashFor("record.remember", {
        body: "remember legacy hash",
        kind: "model_inference",
        links: [],
        observedAt: OBS,
        runId: null,
        scope: "personal/default",
        source: "derived:llm",
        sourceRefs: [],
        tags: [],
      });
      assert.equal(row.requestHash, expected, "stored hash omits absent privacy");
    } finally {
      ctx.cleanup();
    }
  });

  it("record.correct without privacy stores the pre-PR hash (no privacy key)", () => {
    const ctx = setup();
    try {
      const a = remember(ctx.db, ctx.config, "record to correct for hash", "pm-hash-correct-base");
      assert.equal(a.ok, true);
      const params = {
        recordId: a.id as string,
        body: "corrected legacy hash body",
        kind: "correction" as const,
        provenance: prov(),
        scope: "personal/default",
      };
      const res = correctRecord(ctx.db, ctx.config, { ...params }, "pm-hash-correct", OBS);
      assert.equal(res.ok, true, JSON.stringify(res));
      const row = ctx.db
        .prepare(`SELECT requestHash FROM operations WHERE idempotencyKey = ?`)
        .get("pm-hash-correct") as { requestHash: string };
      const expected = requestHashFor("record.correct", {
        body: params.body,
        kind: "correction",
        links: [],
        observedAt: OBS,
        recordId: params.recordId,
        runId: null,
        scope: params.scope,
        source: "derived:llm",
        sourceRefs: [],
      });
      assert.equal(row.requestHash, expected, "stored hash omits absent privacy");
    } finally {
      ctx.cleanup();
    }
  });

  it("explicit privacy: null is BAD_REQUEST with no side effects (append/remember/correct)", () => {
    const ctx = setup();
    try {
      // event.append with privacy: null
      const ea = eventAppend(
        ctx.db,
        ctx.config,
        {
          eventId: "ev-null-privacy",
          sessionId: "s1",
          turnId: "t1",
          body: "explicit null body",
          provenance: prov("user_input"),
          scope: "personal/default",
          privacy: null,
        },
        "pm-null-append",
      );
      assert.equal(ea.ok, false);
      assert.equal(ea.code, "BAD_REQUEST");
      const rawRow = ctx.db.prepare(`SELECT COUNT(*) AS c FROM raw_events WHERE eventId = ?`).get("ev-null-privacy") as { c: number };
      assert.equal(rawRow.c, 0, "no raw_events side effect");
      assert.equal(ctx.db.prepare(`SELECT COUNT(*) AS c FROM operations`).get()?.c, 0, "no op stored");

      // record.remember with privacy: null
      const rr = rememberRecord(
        ctx.db,
        ctx.config,
        { body: "remember explicit null", kind: "model_inference", provenance: prov(), scope: "personal/default", privacy: null },
        "pm-null-remember",
      );
      assert.equal(rr.ok, false);
      assert.equal(rr.code, "BAD_REQUEST");
      const recRow = ctx.db.prepare(`SELECT COUNT(*) AS c FROM records`).get() as { c: number };
      assert.equal(recRow.c, 0, "no records side effect");

      // record.correct with privacy: null (existing record untouched)
      const a = remember(ctx.db, ctx.config, "record before null correct", "pm-null-correct-base");
      assert.equal(a.ok, true);
      const opsBefore = ctx.db.prepare(`SELECT COUNT(*) AS c FROM operations`).get() as { c: number };
      const cr = correctRecord(
        ctx.db,
        ctx.config,
        { recordId: a.id, body: "corrected with null", kind: "correction", provenance: prov(), scope: "personal/default", privacy: null },
        "pm-null-correct",
      );
      assert.equal(cr.ok, false);
      assert.equal(cr.code, "BAD_REQUEST");
      const opsAfter = ctx.db.prepare(`SELECT COUNT(*) AS c FROM operations`).get() as { c: number };
      assert.equal(opsAfter.c, opsBefore.c, "no op stored for correct");
    } finally {
      ctx.cleanup();
    }
  });
});
