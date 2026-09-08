import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { loadConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import {
  approveCandidate,
  createCandidate,
  getCandidateForReview,
} from "../src/store.js";
import { normalizeBody } from "../src/normalize.js";
import { fail, ok } from "../src/protocol.js";
import { preserveCommittedResult } from "../src/cli.js";

function writeConfig(dir: string, dbName = "fix.db"): string {
  const p = path.join(dir, "memory.config.json");
  fs.writeFileSync(
    p,
    JSON.stringify({
      dbPath: `./${dbName}`,
      allowedScopes: ["personal/default", "personal/other"],
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
  const { db } = initDb(config, cfgPath);
  return { db: db as unknown as DatabaseSync, config };
}

function params(body = "review fix body") {
  return {
    body,
    kind: "user_fact",
    provenance: { source: "session:s1:turn:3", observedAt: "2026-09-01T00:00:00.000Z" },
    scope: "personal/default",
    tags: [] as string[],
  };
}

describe("T2 review fixes", () => {
  it("review requires scope authorization (revoked DB row or config is FORBIDDEN_SCOPE, no body)", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-fix-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      const c = createCandidate(db, config, params("secret body abc"), "k-rev-1");
      assert.equal(c.ok, true);
      const id = (c.data as { candidate: { id: string } }).candidate.id as string;
      // Baseline: authorized review discloses.
      const base = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(base.ok, true);
      // Revoke in DB (config still lists it): AND fails.
      db.prepare(`DELETE FROM scopes WHERE scope=?`).run("personal/default");
      const revokedDb = getCandidateForReview(db, config, id, "personal/default");
      assert.equal(revokedDb.ok, false);
      if (!revokedDb.ok) assert.equal(revokedDb.code, "FORBIDDEN_SCOPE");
      assert.ok(!JSON.stringify(revokedDb).includes("secret body abc"));
      // Restore DB row, revoke in config instead.
      db.prepare(`INSERT OR IGNORE INTO scopes(scope) VALUES (?)`).run("personal/default");
      const narrowed = { ...config, allowedScopes: ["personal/other"] };
      const revokedCfg = getCandidateForReview(db, narrowed, id, "personal/default");
      assert.equal(revokedCfg.ok, false);
      if (!revokedCfg.ok) assert.equal(revokedCfg.code, "FORBIDDEN_SCOPE");
    } finally {
      db.close();
    }
  });

  it("over-budget create/approve fail closed with no orphan rows or cached mutation", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-fix-"));
    const cfg = writeConfig(dir);
    const { db, config } = openDb(cfg);
    try {
      // Prod config minimum (1024) always fits these small successes, so use
      // a direct domain config below the file minimum as the regression probe.
      const tiny = { ...config, limits: { ...config.limits, responseMaxBytes: 40 } };
      const over = createCandidate(db, tiny, params("budget probe"), "k-budget-1");
      assert.equal(over.code, "LIMIT_EXCEEDED");
      const nCand = (db.prepare(`SELECT COUNT(*) AS n FROM candidates`).get() as { n: number }).n;
      assert.equal(nCand, 0);
      const op = db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("k-budget-1");
      assert.equal(op, undefined);
      // Retry with the real budget succeeds fresh (failure cached nothing).
      const retry = createCandidate(db, config, params("budget probe"), "k-budget-1");
      assert.equal(retry.ok, true);
      assert.equal(retry.deduplicated, false);
      const id = (retry.data as { candidate: { id: string } }).candidate.id as string;
      const rev = getCandidateForReview(db, config, id, "personal/default");
      if (!rev.ok) throw new Error("review failed");
      // Approve over budget: no record, candidate stays candidate, no op row.
      const overAp = approveCandidate(db, tiny, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-budget-1" });
      assert.equal(overAp.code, "LIMIT_EXCEEDED");
      const st = db.prepare(`SELECT status FROM candidates WHERE id=?`).get(id) as { status: string };
      assert.equal(st.status, "candidate");
      const nRec = (db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n: number }).n;
      assert.equal(nRec, 0);
      const opAp = db.prepare(`SELECT * FROM operations WHERE idempotencyKey=?`).get("h-budget-1");
      assert.equal(opAp, undefined);
      const good = approveCandidate(db, config, { id, scope: "personal/default", token: rev.token, idempotencyKey: "h-budget-1" });
      assert.equal(good.ok, true);
    } finally {
      db.close();
    }
  });

  it("normalization uses exact Unicode White_Space (BOM is not whitespace)", () => {
    // U+FEFF (BOM/ZWNBSP) is matched by JS \\s but is NOT White_Space.
    assert.equal(normalizeBody(" hello "), "hello");
    assert.equal(normalizeBody("﻿hello﻿"), "﻿hello﻿");
    assert.equal(normalizeBody("a﻿b"), "a﻿b");
    assert.equal(normalizeBody("a  b"), "a b");
    // Explicit escapes (same assertions, encoding-proof).
    assert.equal(normalizeBody(" hello "), "hello");
    assert.equal(normalizeBody("﻿hello﻿"), "﻿hello﻿");
    assert.equal(normalizeBody("a﻿b"), "a﻿b");
  });

  it("committed success is preserved over TIMEOUT/close failure; failures stay fixed-code", () => {
    const good = ok({ record: { id: "rec_x" } });
    assert.deepEqual(preserveCommittedResult(good, true, true, 8192), good);
    const bad = fail("BAD_REQUEST");
    assert.equal(preserveCommittedResult(bad, true, false, 8192).code, "TIMEOUT");
    assert.equal(preserveCommittedResult(bad, false, true, 8192).code, "STORE_UNAVAILABLE");
    assert.equal(preserveCommittedResult(bad, false, false, 8192).code, "BAD_REQUEST");
    // Unknown-outcome path: a killed process leaves no stdout; the same
    // key + params replays the committed result (covered in t2.test.ts
    // restart/idempotency cases; this helper only guards the known-success
    // overwrite, never invents success for unknown outcomes).
  });
});
