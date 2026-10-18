/**
 * Canonical fallback substitute-rank tests:
 * - healthy derived-index recall ordering is unchanged (fixed deterministic
 *   corpus, exact expected order — regression guard for the fusion path);
 * - canonical-only hits whose derived FTS/bigram entry is damaged (stale
 *   FTS body, deleted FTS row, deleted bigram rows) receive the substitute
 *   lexical rank from canonical order and are no longer displaced from
 *   small top-k by healthy bigram-overlap competitors.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { eventAppend, recallRecords, rememberRecord } from "../src/store.js";

function setup(): {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "canon-rank-"));
  const config: AppConfig = {
    dbPath: path.join(dir, "t.db"),
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
  const configPath = path.join(dir, "memory.config.json");
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
let seq = 0;

function seedRecord(db: DatabaseSync, config: AppConfig, body: string, hour: number): string {
  const evId = `e-canon-rank-${seq}`;
  const ev = eventAppend(
    db,
    config,
    {
      eventId: evId,
      sessionId: "s1",
      turnId: `t${seq}`,
      body: `conversation padding ${evId}`,
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: "personal/default",
    },
    `evk-canon-rank-${seq}`,
  );
  assert.equal(ev.ok, true, JSON.stringify(ev));
  seq += 1;
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: "personal/default",
      sourceRefs: [evId],
    },
    `remk-canon-rank-${seq}`,
    `2026-03-01T00:${String(hour).padStart(2, "0")}:00.000Z`,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function recallOrder(db: DatabaseSync, config: AppConfig, query: string, limit: number): string[] {
  const res = recallRecords(db, config, { query, scope: "personal/default", limit });
  assert.equal(res.ok, true, JSON.stringify(res));
  return ((res.data as { items: Array<{ id: string }> }).items).map((i) => i.id);
}

const HEALTHY_QUERIES = ["harbor lighthouse schedule", "tide chart evening notes", "ledger"] as const;

describe("canonical fallback substitute rank", () => {
  it("healthy derived-index ordering is byte-identical on a fixed corpus", () => {
    const ctx = setup();
    try {
      const bodies = [
        "harbor lighthouse schedule pinned at dawn",
        "tide chart checked before dusk at the pier",
        "ledger of evening notes kept in the shed",
        "spare key hangs on the blue hook",
        "bicycle tire patched in the shed yesterday",
      ];
      const ids = bodies.map((b, i) => seedRecord(ctx.db, ctx.config, b, i));
      // Exact expected order captured from the healthy fusion path (no
      // substitute ranks participate: every derived entry is intact).
      assert.deepEqual(recallOrder(ctx.db, ctx.config, HEALTHY_QUERIES[0], 10), [
        ids[0]!,
        ids[1]!,
        ids[4]!,
        ids[3]!,
        ids[2]!,
      ]);
      assert.deepEqual(recallOrder(ctx.db, ctx.config, HEALTHY_QUERIES[1], 10), [
        ids[2]!,
        ids[1]!,
        ids[4]!,
        ids[3]!,
        ids[0]!,
      ]);
      assert.deepEqual(recallOrder(ctx.db, ctx.config, HEALTHY_QUERIES[2], 10), [
        ids[2]!,
        ids[4]!,
        ids[3]!,
        ids[1]!,
        ids[0]!,
      ]);
    } finally {
      ctx.cleanup();
    }
  });

  it("stale FTS body: canonical hit ranks within top 3 at limit 3", () => {
    const ctx = setup();
    try {
      const target = seedRecord(
        ctx.db,
        ctx.config,
        "ops ledger note 0 the tidechartreview was checked before dusk",
        9,
      );
      // Bigram-overlap competitors share generic query vocabulary but not
      // the anchor term; pre-substitute they displaced the flat +1 canon hit.
      for (let i = 1; i <= 5; i++) {
        seedRecord(
          ctx.db,
          ctx.config,
          `ops ledger note ${i} spare key hangs on the blue hook ${i}`,
          i,
        );
      }
      // Corrupt the target's FTS row BODY (row count preserved — exactly the
      // per-row derived damage the count-based startup repair cannot detect).
      ctx.db.prepare(`UPDATE fts_notes SET body = 'corrupted derived row' WHERE recordId = ?`).run(target);
      const top = recallOrder(ctx.db, ctx.config, "can you remind me what i said about the tidechart review yesterday", 3);
      assert.ok(top.slice(0, 3).includes(target), `target missing from top 3: ${JSON.stringify(top)}`);
    } finally {
      ctx.cleanup();
    }
  });

  it("deleted FTS row: canonical hit ranks within top 3 at limit 3", () => {
    const ctx = setup();
    try {
      const target = seedRecord(
        ctx.db,
        ctx.config,
        "ops ledger note 0 the tidechartreview was checked before dusk",
        9,
      );
      for (let i = 1; i <= 5; i++) {
        seedRecord(
          ctx.db,
          ctx.config,
          `ops ledger note ${i} spare key hangs on the blue hook ${i}`,
          i,
        );
      }
      ctx.db.prepare(`DELETE FROM fts_notes WHERE recordId = ?`).run(target);
      const top = recallOrder(ctx.db, ctx.config, "can you remind me what i said about the tidechart review yesterday", 3);
      assert.ok(top.slice(0, 3).includes(target), `target missing from top 3: ${JSON.stringify(top)}`);
    } finally {
      ctx.cleanup();
    }
  });

  it("deleted bigram rows: canonical hit ranks within top 3 at limit 3", () => {
    const ctx = setup();
    try {
      const target = seedRecord(
        ctx.db,
        ctx.config,
        "ops ledger note 0 the tidechartreview was checked before dusk",
        9,
      );
      for (let i = 1; i <= 5; i++) {
        seedRecord(
          ctx.db,
          ctx.config,
          `ops ledger note ${i} spare key hangs on the blue hook ${i}`,
          i,
        );
      }
      ctx.db.prepare(`DELETE FROM char_bigrams WHERE kind = 'note' AND id = ?`).run(target);
      const top = recallOrder(ctx.db, ctx.config, "can you remind me what i said about the tidechart review yesterday", 3);
      assert.ok(top.slice(0, 3).includes(target), `target missing from top 3: ${JSON.stringify(top)}`);
    } finally {
      ctx.cleanup();
    }
  });
});
