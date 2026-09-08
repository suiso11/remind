import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { isHumanTty } from "../src/cli.js";
import { createRequire } from "node:module";
import {
  approveCandidate,
  createCandidate,
  getCandidateForReview,
  getCandidateMeta,
  isEnoentStatError,
  measureFootprintOrThrow,
  rejectCandidate,
  shmGrowthBound,
} from "../src/store.js";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

function writeConfig(dir: string, dbName: string): string {
  const p = path.join(dir, "memory.config.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      dbPath: `./${dbName}`,
      allowedScopes: ["personal/default"],
      candidateTtlSec: 259200,
      limits: {
        bodyMaxCp: 2000,
        queryMaxCp: 500,
        tagsMax: 5,
        limitDefault: 10,
        limitMax: 25,
        snippetMaxCp: 200,
        responseMaxBytes: 8192,
      },
      timeouts: { cliMs: 5000, busyMs: 2000 },
      dbMaxBytes: 104857600,
    }),
  );
  return p;
}

function openDb(cfgPath: string) {
  const config = loadConfig(cfgPath);
  const { db, dbFile } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config, dbFile };
}

/** Physical footprint: main file + WAL/SHM sidecars (missing sidecar = 0). */
function totalDbBytes(dbFile: string): number {
  let total = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      total += fs.statSync(dbFile + suffix).size;
    } catch {
      /* missing sidecar is fine */
    }
  }
  return total;
}

function baseParams(body: string): Record<string, unknown> {
  return {
    body,
    kind: "user_fact",
    provenance: { source: "session:s1:turn:1", observedAt: "2026-09-01T00:00:00.000Z" },
    scope: "personal/default",
  };
}

function countRows(db: DatabaseSync, table: string): number {
  return (db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("PR1 finding 1: human disclosure requires stdout TTY as well as stdin", () => {
  it("isHumanTty matrix: stdin true + stdout false must refuse", () => {
    assert.equal(isHumanTty(true, true), true);
    // The reported hole: stdout redirected/piped while stdin is a terminal.
    assert.equal(isHumanTty(true, false), false);
    assert.equal(isHumanTty(false, true), false);
    assert.equal(isHumanTty(false, false), false);
    assert.equal(isHumanTty(undefined, true), false);
    assert.equal(isHumanTty(true, undefined), false);
  });

  it("CLI review with piped stdout refuses with fixed stderr and discloses nothing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-tty-"));
    const cfg = writeConfig(dir, "tty.db");
    const secret = "tty secret body must never reach a pipe";
    const { db, config } = openDb(cfg);
    let id: string;
    let token: string;
    try {
      const c = createCandidate(db, config, baseParams(secret), "k-tty-pr1");
      assert.equal(c.ok, true);
      id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      token = rev.token;
    } finally {
      db.close();
    }
    // Both stdio streams are pipes here, so stdout is definitively non-TTY.
    const r = spawnSync(
      process.execPath,
      [cli, "review", "--config", cfg, "--id", id, "--scope", "personal/default"],
      { encoding: "utf8" },
    );
    assert.equal(r.status, 2);
    assert.equal(String(r.stderr), "error: human operation requires tty\n");
    assert.equal(String(r.stdout), "");
    assert.ok(!String(r.stdout).includes(secret));
    assert.ok(!String(r.stdout).includes(token));
  });
});

describe("PR1 finding 2: dbMaxBytes enforced pre-commit after mutations", () => {
  it("create crossing the cap from below fails closed with no orphan rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-cap-"));
    const cfg = writeConfig(dir, "cap-create.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const seed = createCandidate(db, config, baseParams("seed stays"), "k-cap-seed");
      assert.equal(seed.ok, true);
      const candBefore = countRows(db, "candidates");
      const auditBefore = countRows(db, "audit");
      // Just above the current footprint: initially below the cap, so the
      // transaction starts, then the ~2KB write must cross it before COMMIT.
      const capped = { ...config, dbMaxBytes: totalDbBytes(dbFile) + 16 };
      const res = createCandidate(db, capped, baseParams("x".repeat(2000)), "k-cap-cross");
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal(res.ok, false);
      // Rolled back: no candidate, no idempotency row, no audit row.
      assert.equal(countRows(db, "candidates"), candBefore);
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("k-cap-cross"),
        undefined,
      );
      assert.equal(countRows(db, "audit"), auditBefore);
    } finally {
      db.close();
    }
  });

  it("approve crossing the cap rolls back record + status flip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-cap-"));
    const cfg = writeConfig(dir, "cap-approve.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const c = createCandidate(db, config, baseParams("approve cap probe"), "k-cap-ap");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const capped = { ...config, dbMaxBytes: totalDbBytes(dbFile) + 16 };
      const res = approveCandidate(db, capped, {
        id,
        scope: "personal/default",
        token: rev.token,
        idempotencyKey: "h-cap-ap",
      });
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal((db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string }).status, "candidate");
      assert.equal(countRows(db, "records"), 0);
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("h-cap-ap"),
        undefined,
      );
    } finally {
      db.close();
    }
  });

  it("reject crossing the cap rolls back the status flip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-cap-"));
    const cfg = writeConfig(dir, "cap-reject.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const c = createCandidate(db, config, baseParams("reject cap probe"), "k-cap-rj");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const capped = { ...config, dbMaxBytes: totalDbBytes(dbFile) + 16 };
      const res = rejectCandidate(db, capped, {
        id,
        scope: "personal/default",
        token: rev.token,
        idempotencyKey: "h-cap-rj",
        reasonCode: "USER_REJECTED",
      });
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal((db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string }).status, "candidate");
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("h-cap-rj"),
        undefined,
      );
    } finally {
      db.close();
    }
  });
});

describe("PR1 finding 3: metadata query failures are STORE_UNAVAILABLE", () => {
  it("candidate_tags failure: get/review/approve fail closed (tagless candidate)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-meta-"));
    const cfg = writeConfig(dir, "meta-tags.db");
    const { db, config } = openDb(cfg);
    try {
      // No tags/links: the old empty-list fabrication would bind the exact
      // same token and silently approve. Capture the token first.
      const c = createCandidate(db, config, baseParams("meta tags probe"), "k-meta-tags");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      db.exec(`DROP TABLE candidate_tags`);
      assert.equal(getCandidateMeta(db, config, { id, scope: "personal/default" }).code, "STORE_UNAVAILABLE");
      const rerev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rerev.ok, false);
      if (rerev.ok) throw new Error("review should have failed");
      assert.equal(rerev.code, "STORE_UNAVAILABLE");
      const ap = approveCandidate(db, config, {
        id,
        scope: "personal/default",
        token: rev.token,
        idempotencyKey: "h-meta-tags",
      });
      assert.equal(ap.code, "STORE_UNAVAILABLE");
      assert.equal((db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string }).status, "candidate");
      assert.equal(countRows(db, "records"), 0);
    } finally {
      db.close();
    }
  });

  it("candidate_links failure: get/review/approve fail closed (linkless candidate)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-meta-"));
    const cfg = writeConfig(dir, "meta-links.db");
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, baseParams("meta links probe"), "k-meta-links");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      db.exec(`DROP TABLE candidate_links`);
      assert.equal(getCandidateMeta(db, config, { id, scope: "personal/default" }).code, "STORE_UNAVAILABLE");
      const rerev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rerev.ok, false);
      if (rerev.ok) throw new Error("review should have failed");
      assert.equal(rerev.code, "STORE_UNAVAILABLE");
      const ap = approveCandidate(db, config, {
        id,
        scope: "personal/default",
        token: rev.token,
        idempotencyKey: "h-meta-links",
      });
      assert.equal(ap.code, "STORE_UNAVAILABLE");
      assert.equal((db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string }).status, "candidate");
      assert.equal(countRows(db, "records"), 0);
    } finally {
      db.close();
    }
  });
});

describe("PR1 hardening: conservative WAL-reserve cap + fail-closed measurement", () => {
  it("tiny create starting below cap is rejected: one commit frame dwarfs the value bytes", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-hard-"));
    const cfg = writeConfig(dir, "hard-create.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const seed = createCandidate(db, config, baseParams("seed stays"), "k-hard-seed");
      assert.equal(seed.ok, true);
      const candBefore = countRows(db, "candidates");
      const auditBefore = countRows(db, "audit");
      // Committed footprint is below the cap (entry gate passes), but the
      // commit must append at least one WAL frame (4096 page + 24 frame
      // header + 32 WAL header) for a 1-byte body. The WAL-reserve bound
      // refuses it pre-commit with a full rollback.
      const capped = { ...config, dbMaxBytes: totalDbBytes(dbFile) + 1000 };
      const res = createCandidate(db, capped, baseParams("y"), "k-hard-tiny");
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal(countRows(db, "candidates"), candBefore);
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("k-hard-tiny"),
        undefined,
      );
      assert.equal(countRows(db, "audit"), auditBefore);
    } finally {
      db.close();
    }
  });

  it("tiny approve starting below cap rolls back record + status flip", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-hard-"));
    const cfg = writeConfig(dir, "hard-approve.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const c = createCandidate(db, config, baseParams("q"), "k-hard-ap");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      const capped = { ...config, dbMaxBytes: totalDbBytes(dbFile) + 1000 };
      const res = approveCandidate(db, capped, {
        id,
        scope: "personal/default",
        token: rev.token,
        idempotencyKey: "h-hard-ap",
      });
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal((db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string }).status, "candidate");
      assert.equal(countRows(db, "records"), 0);
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("h-hard-ap"),
        undefined,
      );
    } finally {
      db.close();
    }
  });

  it("reject starting below cap rolls back: ledger-only writes still reserve a frame", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-hard-"));
    const cfg = writeConfig(dir, "hard-reject.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const c = createCandidate(db, config, baseParams("r"), "k-hard-rj");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(rev.ok, true);
      if (!rev.ok) throw new Error("review failed");
      // A reject copies no body at all; COMMIT still appends WAL frame(s).
      const capped = { ...config, dbMaxBytes: totalDbBytes(dbFile) + 1000 };
      const res = rejectCandidate(db, capped, {
        id,
        scope: "personal/default",
        token: rev.token,
        idempotencyKey: "h-hard-rj",
        reasonCode: "USER_REJECTED",
      });
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal((db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string }).status, "candidate");
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("h-hard-rj"),
        undefined,
      );
    } finally {
      db.close();
    }
  });

  it("measurement failure fails closed with STORE_UNAVAILABLE and no rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-pr1-hard-"));
    const cfg = writeConfig(dir, "hard-measure.db");
    const { db, config } = openDb(cfg);
    try {
      const seed = createCandidate(db, config, baseParams("seed stays"), "k-hard-mseed");
      assert.equal(seed.ok, true);
      const candBefore = countRows(db, "candidates");
      const dbAny = db as unknown as { prepare: (...args: string[]) => unknown };
      const origPrepare = dbAny.prepare.bind(db);
      dbAny.prepare = (...args: string[]) => {
        if (typeof args[0] === "string" && args[0].includes("page_count")) {
          throw new Error("injected page_count failure");
        }
        return origPrepare(...args);
      };
      let res: { code: string };
      try {
        res = createCandidate(db, config, baseParams("probe"), "k-hard-mprobe") as unknown as { code: string };
      } finally {
        dbAny.prepare = origPrepare;
      }
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal(countRows(db, "candidates"), candBefore);
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("k-hard-mprobe"),
        undefined,
      );
    } finally {
      db.close();
    }
  });
});

describe("correct-shm-bound: multi-block wal-index + ENOENT-only sidecars", () => {
  it("shmGrowthBound scales in 32KiB blocks and subtracts existing SHM", () => {
    // Fresh tiny DB: projected 6 frames -> ceil(6/4000)+1 = 2 blocks.
    assert.equal(shmGrowthBound({ walSize: 0, shmSize: 0, pageCount: 6, pageSize: 4096 }), 65536);
    // Already-counted SHM is subtracted (growth only, no double-count).
    assert.equal(shmGrowthBound({ walSize: 0, shmSize: 32768, pageCount: 6, pageSize: 4096 }), 32768);
    // Large WAL (~8000 frames): projected 8006 -> ceil(8006/4000)+1 = 4 blocks.
    const wal8000 = 8000 * (4096 + 24) + 32;
    assert.equal(shmGrowthBound({ walSize: wal8000, shmSize: 32768, pageCount: 6, pageSize: 4096 }), 98304);
    // A fixed single-block bound would report 0 here; the multi-block bound does not.
    assert.ok(shmGrowthBound({ walSize: wal8000, shmSize: 32768, pageCount: 6, pageSize: 4096 }) > 32768);
  });

  it("isEnoentStatError tolerates only ENOENT", () => {
    const enoent = Object.assign(new Error("missing"), { code: "ENOENT" });
    const eacces = Object.assign(new Error("denied"), { code: "EACCES" });
    const enotdir = Object.assign(new Error("notdir"), { code: "ENOTDIR" });
    assert.equal(isEnoentStatError(enoent), true);
    assert.equal(isEnoentStatError(eacces), false);
    assert.equal(isEnoentStatError(enotdir), false);
    assert.equal(isEnoentStatError(new Error("plain")), false);
    assert.equal(isEnoentStatError(null), false);
  });

  it("malformed database_list fails closed (not treated as :memory:)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-shm-"));
    const cfg = writeConfig(dir, "shm-list.db");
    const { db } = openDb(cfg);
    try {
      const dbAny = db as unknown as { prepare: (...args: string[]) => unknown };
      const origPrepare = dbAny.prepare.bind(db);
      dbAny.prepare = (...args: string[]) => {
        if (typeof args[0] === "string" && args[0].includes("database_list")) {
          return { all: () => [] };
        }
        return origPrepare(...args);
      };
      try {
        assert.throws(() => measureFootprintOrThrow(db), /db measure failed/);
      } finally {
        dbAny.prepare = origPrepare;
      }
    } finally {
      db.close();
    }
  });

  it("non-ENOENT sidecar stat failure fails closed with no rows", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-shm-"));
    const cfg = writeConfig(dir, "shm-enoent.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const seed = createCandidate(db, config, baseParams("seed stays"), "k-shm-seed");
      assert.equal(seed.ok, true);
      const candBefore = countRows(db, "candidates");
      const req = createRequire(__filename);
      const rawFs = req("node:fs") as typeof fs;
      const origStat = rawFs.statSync;
      (rawFs as unknown as { statSync: unknown }).statSync = (p: string, ...rest: unknown[]) => {
        if (typeof p === "string" && p === dbFile + "-wal") {
          throw Object.assign(new Error("injected EACCES"), { code: "EACCES" });
        }
        return (origStat as (...a: unknown[]) => unknown).call(rawFs, p, ...rest) as never;
      };
      let res: { code: string; ok: boolean };
      try {
        res = createCandidate(db, config, baseParams("probe"), "k-shm-eacces") as unknown as {
          code: string;
          ok: boolean;
        };
      } finally {
        (rawFs as unknown as { statSync: unknown }).statSync = origStat;
      }
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal(countRows(db, "candidates"), candBefore);
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("k-shm-eacces"),
        undefined,
      );
    } finally {
      db.close();
    }
  });

  it("multi-block SHM reserve enforced pre-commit under a large WAL", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-shm-"));
    const cfg = writeConfig(dir, "shm-multi.db");
    const { db, config, dbFile } = openDb(cfg);
    try {
      const seed = createCandidate(db, config, baseParams("seed stays"), "k-shm-mseed");
      assert.equal(seed.ok, true);
      const ps = (db.prepare(`PRAGMA page_size`).get() as { page_size: number }).page_size;
      const pc = (db.prepare(`PRAGMA page_count`).get() as { page_count: number }).page_count;
      const req = createRequire(__filename);
      const rawFs = req("node:fs") as typeof fs;
      const origStat = rawFs.statSync;
      const realMain = (origStat(dbFile) as { size: number }).size;
      const fakeWal = 8000 * (ps + 24) + 32;
      const fakeShm = 32768;
      const fakeFootprint = realMain + fakeWal + fakeShm;
      // Headroom covers the old single-block reserve (growth 0) but not the
      // multi-block growth (~3 extra blocks for ~8000 frames).
      const singleReserve = pc * (ps + 24) + 32;
      const capped = { ...config, dbMaxBytes: fakeFootprint + singleReserve + 10000 };
      assert.ok(fakeFootprint <= capped.dbMaxBytes, "entry gate must pass so the pre-commit bound is tested");
      (rawFs as unknown as { statSync: unknown }).statSync = (p: string, ...rest: unknown[]) => {
        if (p === dbFile + "-wal") return { size: fakeWal } as never;
        if (p === dbFile + "-shm") return { size: fakeShm } as never;
        return (origStat as (...a: unknown[]) => unknown).call(rawFs, p, ...rest) as never;
      };
      const candBefore = countRows(db, "candidates");
      let res: { code: string };
      try {
        res = createCandidate(db, capped, baseParams("y"), "k-shm-multi") as unknown as { code: string };
      } finally {
        (rawFs as unknown as { statSync: unknown }).statSync = origStat;
      }
      assert.equal(res.code, "STORE_UNAVAILABLE");
      assert.equal(countRows(db, "candidates"), candBefore);
      assert.equal(
        db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("k-shm-multi"),
        undefined,
      );
    } finally {
      db.close();
    }
  });
});
