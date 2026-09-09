/**
 * M1 protocol: autonomous JSON ops, fixed error codes/messages, strict
 * request validation, bounded sizes. No candidate/approval/TTY semantics:
 * every write op commits directly with a caller-supplied idempotencyKey.
 */

export const PROTOCOL_V = 1;
import { containsLoneSurrogateDeep } from "./normalize.js";
/** Max raw stdin request size in UTF-8 bytes (fixed by spec, not config). */
export const RAW_MAX_BYTES = 32768;
/** Allowed idempotencyKey characters: ASCII A-Za-z0-9_- , length 1..128. */
const KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

export type ErrorCode =
  | "OK"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "CONFLICT"
  | "FORBIDDEN_SCOPE"
  | "STORE_UNAVAILABLE"
  | "LIMIT_EXCEEDED"
  | "TIMEOUT";

export interface ResponseEnvelope {
  v: 1;
  ok: boolean;
  code: ErrorCode;
  /** Fixed template only; never echoes memory body or query text. */
  message: string;
  data: Record<string, unknown> | null;
  deduplicated: boolean;
}

/** Fixed message templates (no input echo). */
export const MESSAGES: Record<ErrorCode, string> = {
  OK: "ok",
  BAD_REQUEST: "bad request",
  NOT_FOUND: "not found",
  CONFLICT: "conflict",
  FORBIDDEN_SCOPE: "forbidden scope",
  STORE_UNAVAILABLE: "store unavailable",
  LIMIT_EXCEEDED: "limit exceeded",
  TIMEOUT: "timeout",
};

export function ok(
  data: Record<string, unknown> | null = null,
): ResponseEnvelope {
  return {
    v: 1,
    ok: true,
    code: "OK",
    message: MESSAGES.OK,
    data,
    deduplicated: false,
  };
}

export function fail(code: Exclude<ErrorCode, "OK">): ResponseEnvelope {
  return {
    v: 1,
    ok: false,
    code,
    message: MESSAGES[code],
    data: null,
    deduplicated: false,
  };
}

/** Write ops: caller-supplied idempotencyKey mandatory, commit directly. */
export const WRITE_OPS = new Set([
  "event.append",
  "record.remember",
  "record.feedback",
  "record.correct",
  "record.archive",
]);
/** Read ops: no idempotency key. */
export const READ_OPS = new Set(["record.get", "record.list", "record.recall"]);

export interface ValidRequest {
  v: 1;
  op: string;
  idempotencyKey?: string;
  params: Record<string, unknown>;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * Validate a parsed request object. Returns ok:true with the request,
 * or ok:false with the fixed-code envelope (no input echo).
 */
export function validateRequest(
  parsed: unknown,
): { ok: true; req: ValidRequest } | { ok: false; res: ResponseEnvelope } {
  if (!isPlainObject(parsed)) return { ok: false, res: fail("BAD_REQUEST") };
  const keys = Object.keys(parsed);
  const allowed = new Set(["v", "op", "idempotencyKey", "params"]);
  for (const k of keys) {
    if (!allowed.has(k)) return { ok: false, res: fail("BAD_REQUEST") };
  }
  if (parsed["v"] !== 1) return { ok: false, res: fail("BAD_REQUEST") };
  const op = parsed["op"];
  if (typeof op !== "string" || op.length === 0 || op.length > 64) {
    return { ok: false, res: fail("BAD_REQUEST") };
  }
  const known = WRITE_OPS.has(op) || READ_OPS.has(op);
  if (!known) return { ok: false, res: fail("BAD_REQUEST") };

  const hasKey = "idempotencyKey" in parsed;
  const key = parsed["idempotencyKey"];
  if (WRITE_OPS.has(op)) {
    if (!hasKey || typeof key !== "string" || !KEY_RE.test(key)) {
      return { ok: false, res: fail("BAD_REQUEST") };
    }
  } else {
    // Read ops must not carry an idempotency key.
    if (hasKey) return { ok: false, res: fail("BAD_REQUEST") };
  }
  const params = parsed["params"];
  if (!isPlainObject(params)) return { ok: false, res: fail("BAD_REQUEST") };
  // Strict well-formedness: any unpaired surrogate (including an escaped
  // "\ud800" that JSON.parse turns into a lone half) is BAD_REQUEST.
  if (containsLoneSurrogateDeep(parsed)) return { ok: false, res: fail("BAD_REQUEST") };

  const req: ValidRequest = { v: 1, op, params };
  if (hasKey) req.idempotencyKey = key as string;
  return { ok: true, req };
}

/** Raw byte size guard before JSON.parse (spec: oversize -> LIMIT_EXCEEDED). */
export function checkRawSize(raw: string): ResponseEnvelope | null {
  if (Buffer.byteLength(raw, "utf8") > RAW_MAX_BYTES) return fail("LIMIT_EXCEEDED");
  return null;
}

/**
 * Enforce the bounded response budget. If the encoded response exceeds
 * maxBytes, return the fixed LIMIT_EXCEEDED envelope instead (never truncate).
 */
export function applyResponseBudget(
  res: ResponseEnvelope,
  maxBytes: number,
): ResponseEnvelope {
  const n = Buffer.byteLength(JSON.stringify(res), "utf8");
  if (n <= maxBytes) return res;
  return fail("LIMIT_EXCEEDED");
}
