/**
 * M1 hardening tests: response/input budgets, lone-surrogate rejection,
 * metadata-only audit/exposures, Markdown projection retry/rebuild, worker
 * deadline contract, CLI subprocess behavior, and fake-adapter recall with
 * degraded fallback.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { effectiveBusyMs, runStoreOpWithDeadline } from "../src/deadline.js";
import { queryMemory, isCitationExposed, FAKE_FALLBACK_TEXT } from "../src/fake-adapter.js";
import { drainProjection, projectOneRecord, projectionBackoffMs, rebuildVault } from "../src/projection.js";
import { applyResponseBudget, checkRawSize, fail, ok, validateRequest } from "../src/protocol.js";
import { archiveRecord, eventAppend, getRecord, listRecords, recallRecords, rememberRecord } from "../src/store.js";

function makeConfig(dir: string, dbName = "t.db"): { config: AppConfig; configPath: string } {
  const config: AppConfig = {
    dbPath: path.join(dir, dbName),
    vaultPath: path.join(dir, "vault"),
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
  return { config, configPath: path.join(dir, "memory.config.json") };
}

function setup(tag: string): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `m1-hard-${tag}-`));
  const { config, configPath } = makeConfig(dir);
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

function seedRecord(db: DatabaseSync, config: AppConfig, eventId: string, body: string, key: string, links?: string[]): string {
  const ev = eventAppend(
    db,
    config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: `raw seed context ${eventId}`,
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope: "personal/default",
    },
    `seed-ev-${key}`,
  );
  assert.equal(ev.ok, true, JSON.stringify(ev));
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:3", observedAt: OBS },
      scope: "personal/default",
      links,
      sourceRefs: [eventId],
    },
    `seed-${key}`,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

describe("budgets: response, input, and field limits", () => {
  it("response budget never truncates: over-budget becomes LIMIT_EXCEEDED", () => {
    const big = ok({ blob: "x".repeat(4000) });
    assert.equal(big.ok, true);
    const cut = applyResponseBudget(big, 1024);
    assert.equal(cut.ok, false);
    assert.equal(cut.code, "LIMIT_EXCEEDED");
    assert.equal(cut.data, null);
    assert.equal(applyResponseBudget(ok({ a: 1 }), 8192).ok, true);
  });

  it("raw input size guard trips only past 32768 bytes", () => {
    assert.equal(checkRawSize("x".repeat(32768)), null);
    const over = checkRawSize("x".repeat(32769));
    assert.ok(over !== null);
    assert.equal(over?.code, "LIMIT_EXCEEDED");
  });

  it("over-limit query and body fail closed without writes", () => {
    const ctx = setup("budget");
    try {
      assert.equal(
        recallRecords(ctx.db, ctx.config, { query: "q".repeat(501), scope: "personal/default" }).code,
        "LIMIT_EXCEEDED",
      );
      const before = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      assert.equal(
        eventAppend(
          ctx.db,
          ctx.config,
          {
            eventId: "e-big",
            sessionId: "s1",
            turnId: "t1",
            body: "z".repeat(2001),
            provenance: { source: "session:s1:turn:3", observedAt: OBS },
            scope: "personal/default",
          },
          "k-big",
        ).code,
        "LIMIT_EXCEEDED",
      );
      assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n, before);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("lone surrogates rejected; valid astral text passes", () => {
  it("unpaired halves are BAD_REQUEST at envelope and domain levels", () => {
    const ctx = setup("surr");
    try {
      const lone = "half surrogate \uD800 here";
      assert.equal(
        validateRequest({ v: 1, op: "record.recall", params: { query: lone, scope: "personal/default" } }).ok,
        false,
      );
      assert.equal(
        eventAppend(
          ctx.db,
          ctx.config,
          {
            eventId: "e-surr",
            sessionId: "s1",
            turnId: "t1",
            body: lone,
            provenance: { source: "session:s1:turn:3", observedAt: OBS },
            scope: "personal/default",
          },
          "k-surr",
        ).code,
        "BAD_REQUEST",
      );
      assert.equal(recallRecords(ctx.db, ctx.config, { query: lone, scope: "personal/default" }).code, "BAD_REQUEST");
      // A well-formed astral pair (emoji) is accepted end to end.
      const emoji = eventAppend(
        ctx.db,
        ctx.config,
        {
          eventId: "e-emoji",
          sessionId: "s1",
          turnId: "t1",
          body: "tea party \u{1F375} notes",
          provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: "personal/default",
        },
        "k-emoji",
      );
      assert.equal(emoji.ok, true);
    } finally {
      ctx.cleanup();
    }
  });

  it("error envelopes are fixed text with no input echo", () => {
    const bad = fail("BAD_REQUEST");
    assert.equal(bad.message, "bad request");
    assert.equal(bad.data, null);
    const ctx = setup("echo");
    try {
      const secret = "echo-marker-secret-body-text";
      const res = recallRecords(ctx.db, ctx.config, { query: "q".repeat(501), scope: "personal/default" });
      assert.equal(JSON.stringify(res).includes(secret), false);
      assert.equal(res.message, "limit exceeded");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("audit/exposures carry metadata only", () => {
  it("no body or query text lands in the ledgers", () => {
    const ctx = setup("ledger");
    try {
      const marker = "ledger-marker-unique-body";
      const id = seedRecord(ctx.db, ctx.config, "e-ledger-1", `${marker} about owls`, "ledger-1");
      const rec = recallRecords(ctx.db, ctx.config, { query: "owls ledger", scope: "personal/default", limit: 5 });
      assert.equal(rec.ok, true);
      assert.ok(JSON.stringify(rec.data).includes(id));
      const audit = ctx.db.prepare(`SELECT * FROM audit`).all();
      const exposures = ctx.db.prepare(`SELECT * FROM exposures`).all();
      assert.ok(audit.length > 0 && exposures.length > 0);
      assert.equal(JSON.stringify(audit).includes(marker), false, JSON.stringify(audit).slice(0, 500));
      assert.equal(JSON.stringify(exposures).includes(marker), false);
    } finally {
      ctx.cleanup();
    }
  });
});

describe("Markdown projection: write, retry, rebuild", () => {
  it("projects links/backlinks atomically and rebuilds deleted files", () => {
    const ctx = setup("vault");
    try {
      const a = seedRecord(ctx.db, ctx.config, "e-vault-a", "vault alpha lighthouse log", "vault-a");
      const b = seedRecord(ctx.db, ctx.config, "e-vault-b", "vault beta harbor notes", "vault-b", [a]);
      const drained = drainProjection(ctx.db, ctx.config, ctx.configPath);
      assert.equal(drained.failed, 0);
      assert.ok(drained.projected >= 2);
      const fileA = path.join(ctx.config.vaultPath, `${a}.md`);
      const fileB = path.join(ctx.config.vaultPath, `${b}.md`);
      assert.ok(fs.existsSync(fileA) && fs.existsSync(fileB));
      const textB = fs.readFileSync(fileB, "utf8");
      assert.ok(textB.includes(`[[${a}]]`), textB.slice(0, 400));
      assert.ok(textB.includes("vault beta harbor notes"));
      // Backlinks are derived: A links nobody, but B points at A.
      const textA = fs.readFileSync(fileA, "utf8");
      assert.ok(textA.includes(`[[${b}]]`), textA.slice(0, 600));
      // Queue is empty after a clean drain; rebuild restores a deleted file.
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM projection_queue`).get() as { n: number }).n,
        0,
      );
      fs.rmSync(fileA);
      const rebuilt = rebuildVault(ctx.db, ctx.config, ctx.configPath);
      assert.ok(rebuilt >= 2);
      assert.ok(fs.existsSync(fileA));
      assert.ok(fs.readFileSync(fileA, "utf8").includes("vault alpha lighthouse log"));
    } finally {
      ctx.cleanup();
    }
  });

  it("projection failure keeps the queue row for retry and never hides memory", () => {
    const ctx = setup("retry");
    let brokenConfig: AppConfig | null = null;
    try {
      const id = seedRecord(ctx.db, ctx.config, "e-retry-1", "retry notebook entry", "retry-1");
      const blocker = path.join(ctx.dir, "blocker-file");
      fs.writeFileSync(blocker, "not a dir", "utf8");
      brokenConfig = { ...ctx.config, vaultPath: blocker };
      const out = drainProjection(ctx.db, brokenConfig, ctx.configPath);
      assert.equal(out.projected, 0);
      assert.ok(out.failed >= 1);
      const row = ctx.db.prepare(`SELECT attempts FROM projection_queue WHERE recordId=?`).get(id) as
        | { attempts: number }
        | undefined;
      assert.ok(row && row.attempts >= 1);
      // Canonical memory is intact despite the projection failure.
      const rec = recallRecords(ctx.db, ctx.config, { query: "retry notebook", scope: "personal/default", limit: 5 });
      assert.ok(JSON.stringify(rec.data).includes(id));
      // Unknown ids are a no-op, never a throw.
      projectOneRecord(ctx.db, ctx.config.vaultPath, "rec_does_not_exist");
      void brokenConfig;
    } finally {
      ctx.cleanup();
    }
  });
});

describe("projection consistency: backlinks and retry retention", () => {
  it("target Markdown backlink appears after linking and disappears after archive", () => {
    const ctx = setup("backlink");
    try {
      const a = seedRecord(ctx.db, ctx.config, "e-bl-a", "backlink alpha lighthouse log", "bl-a");
      assert.equal(drainProjection(ctx.db, ctx.config, ctx.configPath).failed, 0);
      const fileA = path.join(ctx.config.vaultPath, `${a}.md`);
      assert.ok(fs.existsSync(fileA));
      assert.equal(fs.readFileSync(fileA, "utf8").includes("## Backlinks"), false);
      // Link B -> A: post-commit must enqueue the target A for backlink refresh.
      const b = seedRecord(ctx.db, ctx.config, "e-bl-b", "backlink beta harbor notes", "bl-b", [a]);
      const queuedA = ctx.db.prepare(`SELECT recordId FROM projection_queue WHERE recordId=?`).get(a) as
        | { recordId: string }
        | undefined;
      assert.ok(queuedA, "linking must enqueue the same-scope target for backlink refresh");
      assert.equal(drainProjection(ctx.db, ctx.config, ctx.configPath).failed, 0);
      assert.ok(fs.readFileSync(fileA, "utf8").includes(`[[${b}]]`));
      assert.ok(fs.readFileSync(path.join(ctx.config.vaultPath, `${b}.md`), "utf8").includes(`[[${a}]]`));
      // Dangling refs stay canonical links but never enqueue a file row.
      const c = seedRecord(ctx.db, ctx.config, "e-bl-c", "backlink dangling entry", "bl-c", ["rec_missing_target_xyz"]);
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM projection_queue WHERE recordId=?`).get("rec_missing_target_xyz") as { n: number }).n,
        0,
      );
      drainProjection(ctx.db, ctx.config, ctx.configPath);
      assert.ok(!fs.existsSync(path.join(ctx.config.vaultPath, "rec_missing_target_xyz.md")));
      void c;
      // Archive B: post-commit must enqueue target A again; its backlink vanishes.
      const arc = archiveRecord(ctx.db, ctx.config, { id: b, scope: "personal/default", reasonCode: "USER_ARCHIVED" }, "bl-arc-1");
      assert.equal(arc.ok, true, JSON.stringify(arc));
      const queuedA2 = ctx.db.prepare(`SELECT recordId FROM projection_queue WHERE recordId=?`).get(a) as
        | { recordId: string }
        | undefined;
      assert.ok(queuedA2, "archive must enqueue the outbound target for backlink refresh");
      assert.equal(drainProjection(ctx.db, ctx.config, ctx.configPath).failed, 0);
      assert.equal(fs.readFileSync(fileA, "utf8").includes(`[[${b}]]`), false);
    } finally {
      ctx.cleanup();
    }
  });

  it("failed projection stays queued with backoff and succeeds after due reset", () => {
    const ctx = setup("retain");
    try {
      assert.ok(projectionBackoffMs(1) >= 1000 && projectionBackoffMs(100) <= 300_000);
      const id = seedRecord(ctx.db, ctx.config, "e-retain-1", "retain notebook entry", "retain-1");
      const blocker = path.join(ctx.dir, "blocker-file");
      fs.writeFileSync(blocker, "not a dir", "utf8");
      const broken = { ...ctx.config, vaultPath: blocker };
      const first = drainProjection(ctx.db, broken, ctx.configPath);
      assert.equal(first.projected, 0);
      assert.ok(first.failed >= 1);
      let row = ctx.db.prepare(`SELECT attempts, nextAt FROM projection_queue WHERE recordId=?`).get(id) as
        | { attempts: number; nextAt: string }
        | undefined;
      assert.ok(row && row.attempts >= 1);
      assert.ok(Date.parse(row.nextAt) > Date.now() - 2000, `nextAt should be backed off: ${row.nextAt}`);
      // Not-due rows are skipped: an immediate retry does no work but keeps the row.
      const skipped = drainProjection(ctx.db, broken, ctx.configPath);
      assert.equal(skipped.projected, 0);
      assert.equal(skipped.failed, 0);
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM projection_queue WHERE recordId=?`).get(id) as { n: number }).n,
        1,
      );
      // Permanent failures are never forgotten: force due + fail past the old drop count.
      for (let i = 0; i < 6; i++) {
        ctx.db.prepare(`UPDATE projection_queue SET nextAt=? WHERE recordId=?`).run("2000-01-01T00:00:00.000Z", id);
        const out = drainProjection(ctx.db, broken, ctx.configPath);
        assert.equal(out.failed, 1, `iteration ${i}`);
      }
      row = ctx.db.prepare(`SELECT attempts, nextAt FROM projection_queue WHERE recordId=?`).get(id) as
        | { attempts: number; nextAt: string }
        | undefined;
      assert.ok(row && row.attempts >= 7, JSON.stringify(row));
      // Newer due work is not starved by the backed-off row: enqueue a fresh
      // record, drain with the valid vault, and only the due row projects.
      const id2 = seedRecord(ctx.db, ctx.config, "e-retain-2", "retain second entry", "retain-2");
      ctx.db.prepare(`UPDATE projection_queue SET nextAt=? WHERE recordId=?`).run("2999-01-01T00:00:00.000Z", id);
      const partial = drainProjection(ctx.db, ctx.config, ctx.configPath);
      assert.ok(partial.projected >= 1);
      assert.ok(fs.existsSync(path.join(ctx.config.vaultPath, `${id2}.md`)));
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM projection_queue WHERE recordId=?`).get(id) as { n: number }).n,
        1,
      );
      // After the retry is due again the valid vault succeeds and dequeues.
      ctx.db.prepare(`UPDATE projection_queue SET nextAt=? WHERE recordId=?`).run("2000-01-01T00:00:00.000Z", id);
      const done = drainProjection(ctx.db, ctx.config, ctx.configPath);
      assert.ok(done.projected >= 1);
      assert.equal(done.failed, 0);
      assert.equal(
        (ctx.db.prepare(`SELECT COUNT(*) AS n FROM projection_queue`).get() as { n: number }).n,
        0,
      );
      assert.ok(fs.readFileSync(path.join(ctx.config.vaultPath, `${id}.md`), "utf8").includes("retain notebook entry"));
    } finally {
      ctx.cleanup();
    }
  });
});

describe("worker deadline contract", () => {
  it("clamps the busy wait to the remaining CLI budget", () => {
    assert.equal(effectiveBusyMs(2000, 5000), 2000);
    assert.equal(effectiveBusyMs(2000, 300), 300);
    assert.equal(effectiveBusyMs(2000, 0), 0);
    assert.equal(effectiveBusyMs(2000, -5), 0);
  });

  it("zero budget times out; broken worker fails closed, never hangs", async () => {
    const ctx = setup("deadline");
    try {
      const zero = await runStoreOpWithDeadline(
        { dbFile: ctx.config.dbPath, config: ctx.config, configPath: ctx.configPath, op: "record.recall", params: {}, effectiveBusyMs: 0 },
        0,
      );
      assert.equal(zero.timedOut, true);
      const broken = await runStoreOpWithDeadline(
        {
          dbFile: ctx.config.dbPath,
          config: ctx.config,
          configPath: ctx.configPath,
          op: "record.recall",
          params: { query: "x", scope: "personal/default" },
          effectiveBusyMs: 100,
        },
        5000,
        path.join(ctx.dir, "no-such-worker.js"),
      );
      assert.equal(broken.timedOut, false);
      if (!broken.timedOut) assert.equal(broken.res.code, "STORE_UNAVAILABLE");
    } finally {
      ctx.cleanup();
    }
  });
});

describe("CLI subprocess: M1 envelopes and old-op rejection", () => {
  function cliSetup(): { dir: string; cfgPath: string; cliPath: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-cli-"));
    const cfg = {
      dbPath: path.join(dir, "cli.db"),
      vaultPath: path.join(dir, "vault"),
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
    const cfgPath = path.join(dir, "memory.config.json");
    fs.writeFileSync(cfgPath, JSON.stringify(cfg), "utf8");
    const cliPath = path.resolve(__dirname, "..", "src", "cli.js");
    return { dir, cfgPath, cliPath, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
  }

  function run(cliPath: string, cfgPath: string, line: string): { status: number | null; body: unknown; stdout: string } {
    const r = spawnSync(process.execPath, [cliPath, "--config", cfgPath], {
      input: line + "\n",
      encoding: "utf8",
      timeout: 20000,
    });
    const first = (r.stdout || "").split("\n")[0] ?? "";
    let body: unknown = null;
    try {
      body = first ? JSON.parse(first) : null;
    } catch {
      body = null;
    }
    return { status: r.status, body, stdout: r.stdout || "" };
  }

  it("serves recall, rejects unknown and approval-era ops, fails cleanly on bad config", () => {
    const c = cliSetup();
    try {
      const good = run(c.cliPath, c.cfgPath, JSON.stringify({ v: 1, op: "record.recall", params: { query: "hello", scope: "personal/default", limit: 5 } }));
      assert.equal(good.status, 0);
      assert.equal((good.body as { ok: boolean; code: string }).ok, true);
      const unknown = run(c.cliPath, c.cfgPath, JSON.stringify({ v: 1, op: "nope.nope", params: {} }));
      assert.equal(unknown.status, 0);
      assert.equal((unknown.body as { code: string }).code, "BAD_REQUEST");
      for (const op of ["candidate.create", "approve", "record.correct-request"]) {
        const line = JSON.stringify({ v: 1, op, idempotencyKey: "k-old", params: {} });
        const r = run(c.cliPath, c.cfgPath, line);
        assert.equal(r.status, 0, op);
        assert.equal((r.body as { code: string }).code, "BAD_REQUEST", op);
      }
      const badCfg = spawnSync(process.execPath, [c.cliPath, "--config", path.join(c.dir, "missing.json")], {
        input: "{}\n",
        encoding: "utf8",
        timeout: 20000,
      });
      assert.notEqual(badCfg.status, 0);
      assert.equal((badCfg.stdout || "").trim(), "");
    } finally {
      c.cleanup();
    }
  });
});

describe("fake adapter: recall and degraded fallback", () => {
  function adapterSetup(): { dir: string; cfgPath: string; cliPath: string; recordId: string; cleanup: () => void } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-adapter-"));
    const { config, configPath } = makeConfig(dir, "adapter.db");
    const { db } = initDb(config, configPath);
    const recordId = seedRecord(db, config, "e-adapter-1", "adapter persimmon orchard memo", "adapter-1");
    db.close();
    fs.writeFileSync(
      configPath,
      JSON.stringify({ ...config, dbPath: config.dbPath, vaultPath: config.vaultPath }),
      "utf8",
    );
    return {
      dir,
      cfgPath: configPath,
      cliPath: path.resolve(__dirname, "..", "src", "cli.js"),
      recordId,
      cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
    };
  }

  it("returns bounded recall with current-recall citations only", () => {
    const a = adapterSetup();
    try {
      const res = queryMemory({ cliPath: a.cliPath, configPath: a.cfgPath, scope: "personal/default", query: "persimmon orchard" });
      assert.equal(res.degraded, false);
      if (!res.degraded) {
        assert.ok(res.items.some((i) => i.id === a.recordId), JSON.stringify(res.items));
        assert.deepEqual(res.citations, res.items.map((i) => i.id));
        assert.equal(isCitationExposed(a.recordId, res), true);
        assert.equal(isCitationExposed("rec_invented_elsewhere", res), false);
      }
    } finally {
      a.cleanup();
    }
  });

  it("degrades memoryless with fixed text on every failure mode", () => {
    const a = adapterSetup();
    try {
      const cases = [
        queryMemory({ cliPath: a.cliPath, configPath: a.cfgPath, scope: "personal/default", query: "x", enabled: false }),
        queryMemory({ cliPath: "", configPath: a.cfgPath, scope: "personal/default", query: "x" }),
        queryMemory({ cliPath: a.cliPath, configPath: a.cfgPath, scope: "personal/default", query: "x", limit: 999 }),
        queryMemory({ cliPath: a.cliPath, configPath: a.cfgPath, scope: "other/scope", query: "x" }),
      ];
      assert.deepEqual(cases.map((c) => c.degraded), [true, true, true, true]);
      for (const c of cases) {
        if (c.degraded) {
          assert.equal(c.text, FAKE_FALLBACK_TEXT);
          assert.deepEqual(c.citations, []);
        }
      }
      assert.equal(cases[0].degraded && cases[0].code, "DISABLED");
      assert.equal(cases[2].degraded && cases[2].code, "LIMIT_EXCEEDED");
      assert.equal(cases[3].degraded && cases[3].code, "FORBIDDEN_SCOPE");
    } finally {
      a.cleanup();
    }
  });
});

describe("db cap: over-cap reads/recall continue, writes fail closed", () => {
  it("get/list/recall still succeed over configured cap; writes roll back", () => {
    const ctx = setup("cap");
    try {
      const id = seedRecord(ctx.db, ctx.config, "e-cap-1", "cap continuation harbor memo", "cap-1");
      // Same open DB, tiny configured cap: reads/recall (+audit) still succeed.
      const over = { ...ctx.config, dbMaxBytes: 1 };
      const got = getRecord(ctx.db, over, { id, scope: "personal/default" });
      assert.equal(got.ok, true, JSON.stringify(got));
      const listed = listRecords(ctx.db, over, { scope: "personal/default", limit: 10 });
      assert.equal(listed.ok, true, JSON.stringify(listed));
      const rec = recallRecords(ctx.db, over, { query: "harbor memo", scope: "personal/default", limit: 5 });
      assert.equal(rec.ok, true, JSON.stringify(rec));
      const before = (ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      const denied = rememberRecord(
        ctx.db,
        over,
        {
          body: "over cap write attempt",
          kind: "user_fact",
          provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: "personal/default",
          sourceRefs: ["e-cap-1"],
        },
        "cap-write-1",
      );
      assert.equal(denied.code, "STORE_UNAVAILABLE", JSON.stringify(denied));
      assert.equal((ctx.db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n, before);
      const evDenied = eventAppend(
        ctx.db,
        over,
        {
          eventId: "e-cap-2",
          sessionId: "s1",
          turnId: "t1",
          body: "over cap raw",
          provenance: { source: "session:s1:turn:3", observedAt: OBS },
          scope: "personal/default",
        },
        "cap-ev-1",
      );
      assert.equal(evDenied.code, "STORE_UNAVAILABLE", JSON.stringify(evDenied));
    } finally {
      ctx.cleanup();
    }
  });

  it("initDb still opens an over-cap file for reads (no startup refusal)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "m1-hard-capopen-"));
    let db: DatabaseSync | null = null;
    try {
      const { config, configPath } = makeConfig(dir, "capopen.db");
      const opened = initDb(config, configPath);
      db = opened.db;
      db.close();
      db = null;
      const over = { ...config, dbMaxBytes: 1 };
      const reopened = initDb(over, configPath);
      reopened.db.close();
    } finally {
      try {
        db?.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
