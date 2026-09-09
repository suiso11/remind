/**
 * M1 acceptance: compact end-to-end walkthrough over public store + CLI
 * behavior. Covers the implemented M1 surface only:
 * event.append -> record.remember -> record.recall/get/list ->
 * record.feedback -> record.correct -> record.archive, legacy fail-fast,
 * old-op rejection, metadata-only ledgers, and budget enforcement.
 *
 * Explicitly out of scope (asserted absent): M2 vector search and M3
 * distillation. No candidate/approval/TTY behavior exists in M1.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb, M1_USER_VERSION } from "../src/db.js";
import { effectiveBusyMs } from "../src/deadline.js";
import {
  archiveRecord,
  correctRecord,
  eventAppend,
  feedbackRecords,
  getRecord,
  hasLegacyApprovalSchema,
  listRecords,
  recallRecords,
  rememberRecord,
} from "../src/store.js";
import { validateRequest } from "../src/protocol.js";

const OBS = "2026-09-01T00:00:00.000Z";
const SCOPE = "personal/default";

function testConfig(dir: string): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, "accept.db"),
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

function cliRun(cliPath: string, cfgPath: string, line: string): { status: number | null; body: Record<string, unknown> | null } {
  const r = spawnSync(process.execPath, [cliPath, "--config", cfgPath], {
    input: line + "\n",
    encoding: "utf8",
    timeout: 20000,
  });
  const first = (r.stdout || "").split("\n")[0] ?? "";
  let body: Record<string, unknown> | null = null;
  try {
    body = first ? (JSON.parse(first) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: r.status, body };
}

describe("M1 acceptance walkthrough", () => {
  it("A1 fresh v2 store boots with no legacy trace", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-acc-"));
    try {
      const { config, configPath } = testConfig(dir);
      const { db } = initDb(config, configPath);
      try {
        assert.equal((db.prepare(`PRAGMA user_version`).get() as { user_version: number }).user_version, M1_USER_VERSION);
        assert.equal(hasLegacyApprovalSchema(db), false);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A2 legacy approval databases fail fast and are never mutated", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-acc-"));
    try {
      const { config, configPath } = testConfig(dir);
      const legacy = new DatabaseSync(config.dbPath);
      legacy.exec(`CREATE TABLE candidates(id TEXT PRIMARY KEY)`);
      legacy.close();
      assert.throws(() => initDb(config, configPath), /legacy approval schema/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A3 raw ingest, direct remember, immediate recall/get/list", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-acc-"));
    try {
      const { config, configPath } = testConfig(dir);
      const { db } = initDb(config, configPath);
      try {
        const ev = eventAppend(
          db, config,
          { eventId: "e-acc-1", sessionId: "s1", turnId: "t1", body: "acceptance orchard walk notes", provenance: { source: "session:s1:turn:3", observedAt: OBS }, scope: SCOPE },
          "acc-ev-1",
        );
        assert.equal(ev.ok, true);
        const rem = rememberRecord(
          db, config,
          { body: "orchard walk persimmon harvest memo", kind: "user_fact", provenance: { source: "session:s1:turn:3", observedAt: OBS }, scope: SCOPE, sourceRefs: ["e-acc-1"] },
          "acc-rem-1",
        );
        assert.equal(rem.ok, true);
        const id = (rem.data as { record: { id: string } }).record.id;
        const rec = recallRecords(db, config, { query: "persimmon harvest", scope: SCOPE, limit: 10 });
        assert.equal(rec.ok, true);
        const items = (rec.data as { items: Array<{ id: string; snippet: string }> }).items;
        assert.ok(items.some((i) => i.id === id));
        assert.ok(items.every((i) => typeof i.snippet === "string"));
        assert.equal(getRecord(db, config, { id, scope: SCOPE }).ok, true);
        assert.equal(listRecords(db, config, { scope: SCOPE, limit: 10 }).ok, true);
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A4 feedback counts exposed use; correction supersedes; archive excludes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-acc-"));
    try {
      const { config, configPath } = testConfig(dir);
      const { db } = initDb(config, configPath);
      try {
        eventAppend(
          db, config,
          { eventId: "e-acc-4", sessionId: "s1", turnId: "t1", body: "lifecycle raw", provenance: { source: "session:s1:turn:3", observedAt: OBS }, scope: SCOPE },
          "acc-ev-4",
        );
        const rem = rememberRecord(
          db, config,
          { body: "lifecycle cranberry sorting memo", kind: "user_fact", provenance: { source: "session:s1:turn:3", observedAt: OBS }, scope: SCOPE, sourceRefs: ["e-acc-4"] },
          "acc-rem-4",
        );
        const id = (rem.data as { record: { id: string } }).record.id;
        const rec = recallRecords(db, config, { query: "cranberry sorting", scope: SCOPE, limit: 5 });
        const recallId = (rec.data as { recallId: string }).recallId;
        const fb = feedbackRecords(db, config, { recallId, recordIds: [id], scope: SCOPE }, "acc-fb-4");
        assert.equal(fb.ok, true);
        eventAppend(
          db, config,
          { eventId: "e-acc-4b", sessionId: "s1", turnId: "t2", body: "lifecycle raw two", provenance: { source: "session:s1:turn:4", observedAt: OBS }, scope: SCOPE },
          "acc-ev-4b",
        );
        const corr = correctRecord(
          db, config,
          { recordId: id, body: "lifecycle cranberry sorting revised memo", kind: "correction", provenance: { source: "session:s1:turn:9", observedAt: OBS }, scope: SCOPE, sourceRefs: ["e-acc-4b"] },
          "acc-corr-4",
        );
        assert.equal(corr.ok, true);
        const newId = (corr.data as { record: { id: string } }).record.id;
        assert.equal((getRecord(db, config, { id, scope: SCOPE }).data as { record: { status: string } }).record.status, "superseded");
        const arch = archiveRecord(db, config, { id: newId, scope: SCOPE, reasonCode: "USER_ARCHIVED" }, "acc-arc-4");
        assert.equal(arch.ok, true);
        const after = recallRecords(db, config, { query: "cranberry sorting", scope: SCOPE, limit: 10 });
        const ids = ((after.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
        assert.ok(!ids.includes(id) && !ids.includes(newId), JSON.stringify(ids));
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A5 CLI serves M1 ops and rejects approval-era ops", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-acc-"));
    try {
      const { config, configPath } = testConfig(dir);
      fs.writeFileSync(configPath, JSON.stringify(config), "utf8");
      const cliPath = path.resolve(__dirname, "..", "src", "cli.js");
      const good = cliRun(cliPath, configPath, JSON.stringify({ v: 1, op: "record.recall", params: { query: "hello", scope: SCOPE, limit: 5 } }));
      assert.equal(good.status, 0);
      assert.equal(good.body?.["ok"], true);
      for (const op of ["candidate.create", "candidate.get", "approve", "review", "record.correct-request"]) {
        const r = cliRun(cliPath, configPath, JSON.stringify({ v: 1, op, idempotencyKey: "k-old", params: {} }));
        assert.equal(r.status, 0, op);
        assert.equal(r.body?.["code"], "BAD_REQUEST", op);
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A6 ledgers stay metadata-only and budgets stay enforced", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-acc-"));
    try {
      const { config, configPath } = testConfig(dir);
      const { db } = initDb(config, configPath);
      try {
        const marker = "acceptance-ledger-marker-body";
        eventAppend(
          db, config,
          { eventId: "e-acc-6", sessionId: "s1", turnId: "t1", body: `${marker} wren notes`, provenance: { source: "session:s1:turn:3", observedAt: OBS }, scope: SCOPE },
          "acc-ev-6",
        );
        rememberRecord(
          db, config,
          { body: `${marker} wren record`, kind: "user_fact", provenance: { source: "session:s1:turn:3", observedAt: OBS }, scope: SCOPE, sourceRefs: ["e-acc-6"] },
          "acc-rem-6",
        );
        recallRecords(db, config, { query: "wren notes", scope: SCOPE, limit: 5 });
        assert.equal(JSON.stringify(db.prepare(`SELECT * FROM audit`).all()).includes(marker), false);
        assert.equal(JSON.stringify(db.prepare(`SELECT * FROM exposures`).all()).includes(marker), false);
        assert.equal(recallRecords(db, config, { query: "q".repeat(501), scope: SCOPE }).code, "LIMIT_EXCEEDED");
      } finally {
        db.close();
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("A7 M2 vector search and M3 distillation are deferred, not present", () => {
    for (const op of ["record.vector-search", "maintain.distill", "record.recall-semantic"]) {
      const r = validateRequest({ v: 1, op, idempotencyKey: "k-x", params: {} });
      assert.equal(r.ok, false, op);
      if (!r.ok) assert.equal(r.res.code, "BAD_REQUEST");
    }
    assert.ok(effectiveBusyMs(2000, 5000) > 0);
  });
});
