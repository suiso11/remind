/**
 * T6 fake adapter (plan.md 14.1 / 14.10 / 14.11-A8).
 *
 * A thin LOCAL test/sample module that invokes the COMPILED CLI process
 * (`dist/src/cli.js --config <path>`) with exactly one LF-framed
 * `record.recall` JSON line. It is a fake integration for evaluation and
 * samples only: NOT a Companion implementation, NOT a network client, and
 * it performs NO LLM calls and NO external-network access.
 *
 * Hard constraints (all enforced here):
 * - NO shell interpolation: child is spawned with an argv array and
 *   `shell: false`; the query/body never becomes a shell string.
 * - Strict finite bounds: input bytes (default 32768), stdout bytes
 *   (default 65536), and wall-clock timeout (default 5000ms, clamped to
 *   100..10000ms) always apply.
 * - Fixed error mapping with NO raw-text diagnostics: every degraded path
 *   returns a constant `text` ("ordinary response without memory") and a
 *   fixed `code`; stderr/stdout bytes, exception text, query text, and
 *   memory body text are never copied into the result.
 * - Disabled / unavailable / corrupt-DB / startup-nonzero / timeout /
 *   malformed-response / over-budget errors all degrade to the same
 *   memoryless ordinary fake response (`degraded: true`, `citations: []`).
 * - Success validates the envelope shape (`v`, `ok`, `code`, `data`),
 *   `recallId`, and per-item shape BEFORE projecting bounded memory data,
 *   and only for the authorized request scope that was actually sent.
 * - Citations are the current recall's record IDs only: arbitrary text is
 *   never accepted as a citation (see `isCitationExposed`).
 */

import { spawnSync } from "node:child_process";

export const FAKE_FALLBACK_TEXT = "ordinary response without memory";

export type FakeDegradedCode =
  | "DISABLED"
  | "STORE_UNAVAILABLE"
  | "TIMEOUT"
  | "LIMIT_EXCEEDED"
  | "BAD_REQUEST"
  | "FORBIDDEN_SCOPE";

export interface FakeMemoryHit {
  id: string;
  snippet: string;
  truncated: boolean;
  tags: string[];
  createdAt: string;
}

export type FakeAdapterResult =
  | {
      degraded: false;
      code: "OK";
      recallId: string;
      scope: string;
      items: FakeMemoryHit[];
      citations: string[];
    }
  | {
      degraded: true;
      code: FakeDegradedCode;
      text: typeof FAKE_FALLBACK_TEXT;
      citations: [];
    };

export interface FakeAdapterOptions {
  /** Absolute path to the compiled CLI (`dist/src/cli.js`). */
  cliPath: string;
  /** Absolute path to the startup config file. */
  configPath: string;
  /** Authorized request scope actually sent with the recall. */
  scope: string;
  /** Recall query (1..500 code points; raw text never echoed on failure). */
  query: string;
  /** Recall limit (default 10, clamped to 1..25). */
  limit?: number;
  /** `false` simulates a disabled memory subsystem (default true). */
  enabled?: boolean;
  /** Wall-clock bound in ms (default 5000, clamped 100..10000). */
  timeoutMs?: number;
  /** Max stdin input bytes incl. LF (default 32768). */
  maxInputBytes?: number;
  /** Max stdout bytes accepted (default 65536). */
  maxOutputBytes?: number;
}

function countCp(s: string): number {
  return [...s].length;
}

// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001F\u007F-\u009F]/;

function degraded(code: FakeDegradedCode): FakeAdapterResult {
  return { degraded: true, code, text: FAKE_FALLBACK_TEXT, citations: [] };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validItem(v: unknown): v is FakeMemoryHit {
  if (!isPlainObject(v)) return false;
  if (typeof v["id"] !== "string" || v["id"].length === 0 || v["id"].length > 256) return false;
  if (typeof v["snippet"] !== "string" || countCp(v["snippet"]) > 1000) return false;
  if (typeof v["truncated"] !== "boolean") return false;
  if (!Array.isArray(v["tags"])) return false;
  for (const t of v["tags"] as unknown[]) {
    if (typeof t !== "string" || countCp(t) < 1 || countCp(t) > 256 || CONTROL_RE.test(t)) return false;
  }
  if (typeof v["createdAt"] !== "string" || v["createdAt"].length === 0) return false;
  return true;
}

/**
 * Query memory through the CLI subprocess. Never throws: every failure
 * mode degrades to the fixed memoryless response.
 */
export function queryMemory(opts: FakeAdapterOptions): FakeAdapterResult {
  const enabled = opts.enabled !== false;
  if (!enabled) return degraded("DISABLED");
  if (typeof opts.cliPath !== "string" || opts.cliPath.length === 0) return degraded("STORE_UNAVAILABLE");
  if (typeof opts.configPath !== "string" || opts.configPath.length === 0) return degraded("STORE_UNAVAILABLE");
  if (typeof opts.scope !== "string" || countCp(opts.scope) < 1 || countCp(opts.scope) > 256 || CONTROL_RE.test(opts.scope)) {
    return degraded("BAD_REQUEST");
  }
  if (typeof opts.query !== "string" || countCp(opts.query) < 1 || countCp(opts.query) > 500) {
    return degraded("BAD_REQUEST");
  }
  let limit = opts.limit ?? 10;
  if (!Number.isInteger(limit)) return degraded("BAD_REQUEST");
  if (limit < 1) limit = 1;
  if (limit > 25) return degraded("LIMIT_EXCEEDED");
  let timeoutMs = opts.timeoutMs ?? 5000;
  if (!Number.isFinite(timeoutMs)) timeoutMs = 5000;
  timeoutMs = Math.max(100, Math.min(10000, Math.floor(timeoutMs)));
  const maxInput = opts.maxInputBytes ?? 32768;
  const maxOutput = opts.maxOutputBytes ?? 65536;

  const line =
    JSON.stringify({ v: 1, op: "record.recall", params: { query: opts.query, scope: opts.scope, limit } }) + "\n";
  if (Buffer.byteLength(line, "utf8") > maxInput) return degraded("LIMIT_EXCEEDED");

  let out: string;
  try {
    // No shell, fixed argv only: query text travels as stdin bytes, never as
    // a shell-interpolated command string.
    const r = spawnSync(process.execPath, [opts.cliPath, "--config", opts.configPath], {
      input: line,
      timeout: timeoutMs,
      maxBuffer: maxOutput + 1024,
      shell: false,
      encoding: "utf8",
    });
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT") return degraded("TIMEOUT");
      // The OS truncated an over-bound stdout (ENOBUFS): over-budget output.
      if (code === "ENOBUFS") return degraded("LIMIT_EXCEEDED");
      const msg = String(r.error);
      if (/timed?out/i.test(msg)) return degraded("TIMEOUT");
      return degraded("STORE_UNAVAILABLE");
    }
    if (r.status !== 0) return degraded("STORE_UNAVAILABLE");
    const stdout = typeof r.stdout === "string" ? r.stdout : "";
    if (stdout.length === 0) return degraded("STORE_UNAVAILABLE");
    if (Buffer.byteLength(stdout, "utf8") > maxOutput) return degraded("LIMIT_EXCEEDED");
    out = stdout;
  } catch {
    return degraded("STORE_UNAVAILABLE");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(out.trim());
  } catch {
    return degraded("STORE_UNAVAILABLE");
  }
  if (!isPlainObject(parsed)) return degraded("STORE_UNAVAILABLE");
  if (parsed["v"] !== 1 || typeof parsed["ok"] !== "boolean" || typeof parsed["code"] !== "string") {
    return degraded("STORE_UNAVAILABLE");
  }
  if (parsed["ok"] !== true) {
    const code = parsed["code"] as string;
    if (code === "FORBIDDEN_SCOPE") return degraded("FORBIDDEN_SCOPE");
    if (code === "LIMIT_EXCEEDED") return degraded("LIMIT_EXCEEDED");
    if (code === "TIMEOUT") return degraded("TIMEOUT");
    if (code === "BAD_REQUEST") return degraded("BAD_REQUEST");
    return degraded("STORE_UNAVAILABLE");
  }
  const data = parsed["data"];
  if (!isPlainObject(data)) return degraded("STORE_UNAVAILABLE");
  const recallId = data["recallId"];
  const items = data["items"];
  if (typeof recallId !== "string" || recallId.length === 0 || recallId.length > 256) {
    return degraded("STORE_UNAVAILABLE");
  }
  if (!Array.isArray(items) || items.length > limit) return degraded("STORE_UNAVAILABLE");
  const hits: FakeMemoryHit[] = [];
  for (const it of items as unknown[]) {
    if (!validItem(it)) return degraded("STORE_UNAVAILABLE");
    // Bounded projection: keep the CLI snippet as-is (already bounded by
    // snippetMaxCp + response budget); copy only the fixed fields.
    hits.push({
      id: it.id,
      snippet: it.snippet,
      truncated: it.truncated,
      tags: [...it.tags],
      createdAt: it.createdAt,
    });
  }
  // The adapter only exposes the scope it actually requested: no cross-scope
  // promotion happens here (the CLI already enforces the authorized scope).
  return {
    degraded: false,
    code: "OK",
    recallId,
    scope: opts.scope,
    items: hits,
    citations: hits.map((h) => h.id),
  };
}

/**
 * Citation gate: only a record ID from the CURRENT recall result counts as
 * exposed. Arbitrary text (including IDs from other recalls, other scopes,
 * or invented strings) is rejected. This is the structural check the A2
 * acceptance case exercises for "grant out-of-exposure citation rejected".
 */
export function isCitationExposed(citationId: unknown, result: FakeAdapterResult): boolean {
  if (result.degraded) return false;
  if (typeof citationId !== "string" || citationId.length === 0) return false;
  return result.citations.includes(citationId);
}
