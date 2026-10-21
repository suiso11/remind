/**
 * Shared splitter bounds: eventAppend enforces rawBodyMaxCp on both the raw
 * body and normalizeBody(body), so NFKC-expanding text must be split using
 * both measures. Chunks stay verbatim and reconstruct the input.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { chunkText } from "../scripts/ingest.js";
import { countCp, type AppConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { normalizeBody } from "../src/normalize.js";
import type { ResponseEnvelope } from "../src/protocol.js";
import { splitTextRanges } from "../src/split.js";
import { eventAppend } from "../src/store.js";

const SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";
const MAX = 8000;

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
      rawBodyMaxCp: MAX,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
  return { config, configPath: path.join(dir, "memory.config.json") };
}

function appendAll(chunks: string[]): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "split-"));
  const { config, configPath } = baseConfig(dir);
  const { db } = initDb(config, configPath);
  try {
    for (let seq = 0; seq < chunks.length; seq++) {
      const chunk = chunks[seq]!;
      const res: ResponseEnvelope = eventAppend(
        db,
        config,
        {
          eventId: `doc1-c${seq}`,
          sessionId: "doc:doc1",
          turnId: String(seq),
          body: chunk,
          provenance: { source: "file:fixture.txt", observedAt: OBS },
          scope: SCOPE,
          chunk: { docId: "doc1", seq },
        },
        `ingest-doc1-${seq}`,
      );
      assert.equal(res.ok, true, `chunk ${seq}: ${JSON.stringify(res)}`);
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function assertChunks(text: string, max: number): string[] {
  const chunks = chunkText(text, max);
  assert.ok(chunks.length > 0, "expected at least one chunk");
  for (const [i, chunk] of chunks.entries()) {
    assert.ok(countCp(chunk) <= max, `chunk ${i} raw ${countCp(chunk)} > ${max}`);
    assert.ok(
      countCp(normalizeBody(chunk)) <= max,
      `chunk ${i} normalized ${countCp(normalizeBody(chunk))} > ${max}`,
    );
    assert.ok(countCp(normalizeBody(chunk)) >= 1, `chunk ${i} normalizes empty`);
  }
  assert.equal(chunks.join(""), text);
  return chunks;
}

describe("splitTextRanges normalized bound", () => {
  it("splits 7999 x + ellipsis so every chunk passes eventAppend", () => {
    const text = "x".repeat(7999) + "…" + "more text";
    assert.ok(countCp(normalizeBody(text)) > MAX, "fixture must exceed normalized bound");
    const chunks = assertChunks(text, MAX);
    assert.ok(chunks.length >= 2, "ellipsis expansion must force a split");
    appendAll(chunks);
  });

  it("bounds many ellipses and full-width characters", () => {
    const text = "…".repeat(4000) + "㍿".repeat(1500) + "ＡＢＣ".repeat(1000);
    assert.ok(countCp(text) > MAX, "fixture must need more than one raw chunk");
    assert.ok(countCp(normalizeBody(text)) > MAX, "fixture must exceed normalized bound");
    const chunks = assertChunks(text, MAX);
    assert.ok(chunks.length >= 2);
    appendAll(chunks);
  });

  it("keeps existing paragraph preference for plain text", () => {
    const text = "a".repeat(10) + "\n\n" + "b".repeat(10) + "\n\n" + "c".repeat(10);
    const ranges = splitTextRanges(text, 20);
    const cps = Array.from(text);
    const chunks = ranges.map((r) => cps.slice(r.start, r.end).join(""));
    assert.deepEqual(chunks, ["a".repeat(10) + "\n\n", "b".repeat(10) + "\n\n", "c".repeat(10)]);
    assert.equal(chunks.join(""), text);
  });
});
