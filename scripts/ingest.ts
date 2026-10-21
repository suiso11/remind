/**
 * Ingest a UTF-8 document into raw events as bounded chunks (P1).
 *
 * Chunks are <= limits.rawBodyMaxCp code points, preferring paragraph
 * boundaries ("\n\n"), then line boundaries ("\n"), then a hard cut. Chunk
 * boundaries are chosen on code points, so surrogate pairs are never split.
 * Whitespace-only chunks are never emitted.
 *
 * Each chunk is an idempotent event.append with
 *   idempotencyKey = ingest-<docId>-<seq>
 *   eventId        = <docId>-c<seq>
 *   sessionId      = --session (default doc:<docId>)
 *   turnId         = <seq>
 *   source         = --source (default file:<basename>)
 *   observedAt     = file mtime (ISO)
 *   chunk          = {docId, seq}
 * Re-running the same file therefore replays deduplicated.
 *
 * Usage: node dist/scripts/ingest.js --config <path> --scope <scope>
 *   --file <path> --doc-id <id> [--session <sid>] [--source <src>]
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  countCp,
  loadConfig,
  rawBodyMaxCp,
  requirePrivacyEnabled,
} from "../src/config.js";
import { initDb } from "../src/db.js";
import { normalizeBody } from "../src/normalize.js";
import type { PrivacyMetadata } from "../src/privacy.js";
import { splitTextRanges } from "../src/split.js";
import { eventAppend } from "../src/store.js";

/** Same charset/length contract as protocol idempotency keys and chunk docIds. */
const DOC_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const WHITE_SPACE_RE = /^\p{White_Space}$/u;

function failArgs(): never {
  process.stderr.write("error: bad arguments\n");
  process.exit(2);
}

function isWhiteSpaceCp(cp: string): boolean {
  return WHITE_SPACE_RE.test(cp);
}

/**
 * Default provenance source must satisfy store validation (1..256 code
 * points, no control characters) and the lone-surrogate envelope guard.
 * Strip forbidden code points and cap the length; "file:" itself is valid.
 */
function sourceFromBasename(basename: string): string {
  const safe = Array.from(basename)
    .filter((cp) => {
      const n = cp.codePointAt(0) ?? 0;
      if (n >= 0xd800 && n <= 0xdfff) return false;
      return !/[\u0000-\u001F\u007F-\u009F]/.test(cp);
    })
    .slice(0, 251)
    .join("");
  return `file:${safe}`;
}

/**
 * Split text into <= maxCp code-point chunks. The shared splitter returns
 * non-whitespace code-point ranges, so ingest behavior is unchanged.
 */
export function chunkText(text: string, maxCp: number): string[] {
  const cps = Array.from(text);
  return splitTextRanges(text, maxCp).map((r) => cps.slice(r.start, r.end).join(""));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let configPath: string | null = null;
  let scope: string | null = null;
  let filePath: string | null = null;
  let docId: string | null = null;
  let session: string | null = null;
  let source: string | null = null;
  let privacySensitivity: string | null = null;
  let privacyOrigin: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (
      (a === "--config" ||
        a === "--scope" ||
        a === "--file" ||
        a === "--doc-id" ||
        a === "--session" ||
        a === "--source" ||
        a === "--privacy-sensitivity" ||
        a === "--privacy-origin") &&
      i + 1 < args.length
    ) {
      const v = args[++i]!;
      if (a === "--config") configPath = v;
      else if (a === "--scope") scope = v;
      else if (a === "--file") filePath = v;
      else if (a === "--doc-id") docId = v;
      else if (a === "--session") session = v;
      else if (a === "--source") source = v;
      else if (a === "--privacy-sensitivity") privacySensitivity = v;
      else privacyOrigin = v;
    } else if (a === "--help" || a === "-h") {
      process.stderr.write(
        "usage: ingest --config <path> --scope <scope> --file <path> --doc-id <id> [--session <sid>] [--source <src>] [--privacy-sensitivity <normal|sensitive> --privacy-origin <conversation|self_activity>]\n",
      );
      process.exit(0);
    } else {
      failArgs();
    }
  }
  if (!configPath || !scope || !filePath || !docId) failArgs();
  // Both privacy flags or neither; invalid values are usage errors and must
  // fail before the DB is even opened.
  if ((privacySensitivity === null) !== (privacyOrigin === null)) failArgs();
  if (
    privacySensitivity !== null &&
    privacySensitivity !== "normal" &&
    privacySensitivity !== "sensitive"
  ) {
    failArgs();
  }
  if (
    privacyOrigin !== null &&
    privacyOrigin !== "conversation" &&
    privacyOrigin !== "self_activity"
  ) {
    failArgs();
  }
  const privacy: PrivacyMetadata | null =
    privacySensitivity !== null && privacyOrigin !== null
      ? {
          sensitivity: privacySensitivity as PrivacyMetadata["sensitivity"],
          origin: privacyOrigin as PrivacyMetadata["origin"],
        }
      : null;
  if (!DOC_ID_RE.test(docId)) failArgs();
  if (session !== null && (countCp(session) < 1 || countCp(session) > 128 || /[\u0000-\u001F\u007F-\u009F]/.test(session))) {
    failArgs();
  }

  let config;
  try {
    config = loadConfig(configPath);
  } catch {
    process.stderr.write("error: invalid config\n");
    process.exit(2);
  }
  // A privacy-required store rejects every chunk append, so fail closed with
  // the fixed ingest error before reading input or opening the store.
  if (requirePrivacyEnabled(config) && privacy === null) {
    process.stderr.write("error: ingest failed BAD_REQUEST\n");
    process.exit(2);
  }

  let text: string;
  let observedAt: string;
  try {
    text = fs.readFileSync(filePath, "utf8");
    observedAt = fs.statSync(filePath).mtime.toISOString();
  } catch {
    process.stderr.write("error: bad arguments\n");
    process.exit(2);
  }

  const maxCp = rawBodyMaxCp(config);
  const chunks = chunkText(text, maxCp);
  // Fail closed before opening the store or appending anything: every chunk
  // must satisfy the same raw and normalized bounds eventAppend enforces, and
  // must normalize to non-empty content.
  for (const chunk of chunks) {
    const normalized = countCp(normalizeBody(chunk));
    if (countCp(chunk) > maxCp || normalized > maxCp) {
      process.stderr.write("error: ingest failed LIMIT_EXCEEDED\n");
      process.exit(2);
    }
    if (normalized < 1) {
      process.stderr.write("error: ingest failed BAD_REQUEST\n");
      process.exit(2);
    }
  }
  const effectiveSession = session ?? `doc:${docId}`;
  const effectiveSource = source ?? sourceFromBasename(path.basename(filePath));
  const derived = chunks.map((_, seq) => ({
    seq,
    eventId: `${docId}-c${seq}`,
    idempotencyKey: `ingest-${docId}-${seq}`,
  }));
  // Fail closed before any write if a derived id violates protocol bounds.
  for (const d of derived) {
    if (countCp(d.eventId) > 128 || countCp(d.idempotencyKey) > 128 || d.seq > 100000) {
      process.stderr.write("error: ingest failed BAD_REQUEST\n");
      process.exit(2);
    }
  }

  let db: DatabaseSync;
  try {
    ({ db } = initDb(config, configPath));
  } catch {
    process.stderr.write("error: store unavailable\n");
    process.exit(3);
  }

  let appended = 0;
  let deduplicated = 0;
  let failed: string | null = null;
  try {
    for (let i = 0; i < chunks.length; i++) {
      const d = derived[i]!;
      let res;
      try {
        res = eventAppend(
          db,
          config,
          {
            eventId: d.eventId,
            sessionId: effectiveSession,
            turnId: String(d.seq),
            body: chunks[i]!,
            provenance: { source: effectiveSource, observedAt },
            scope,
            chunk: { docId, seq: d.seq },
            ...(privacy !== null ? { privacy } : {}),
          },
          d.idempotencyKey,
        );
      } catch {
        failed = "STORE_UNAVAILABLE";
        break;
      }
      if (!res.ok) {
        failed = res.code;
        break;
      }
      if (res.deduplicated) deduplicated++;
      else appended++;
    }
  } finally {
    try {
      db.close();
    } catch {
      /* ignore */
    }
  }

  if (failed !== null) {
    process.stderr.write(`error: ingest failed ${failed}\n`);
    process.exit(2);
  }
  process.stdout.write(
    JSON.stringify({ docId, chunks: chunks.length, appended, deduplicated }) + "\n",
  );
}

if (require.main === module) void main();
