import { createHash, timingSafeEqual } from "node:crypto";

/** Code points, not UTF-16 units. */
export function countCp(s: string): number {
  return [...s].length;
}

function isWhiteSpace(ch: string): boolean {
  // Exact Unicode White_Space (plan 14.6). Do NOT use JS \s: it also
  // matches U+FEFF (BOM), which is not White_Space.
  return /^\p{White_Space}$/u.test(ch);
}

/**
 * Exact normalization per plan 14.6:
 * NFKC -> trim White_Space -> collapse runs to U+0020 -> optional ASCII casefold.
 */
export function normalizeField(s: string, casefold: boolean): string {
  const nfkc = s.normalize("NFKC");
  const cps = [...nfkc];
  let start = 0;
  let end = cps.length;
  while (start < end && isWhiteSpace(cps[start])) start++;
  while (end > start && isWhiteSpace(cps[end - 1])) end--;
  const trimmed = cps.slice(start, end);
  let out = "";
  let inWs = false;
  for (const ch of trimmed) {
    if (isWhiteSpace(ch)) {
      if (!inWs) {
        out += " ";
        inWs = true;
      }
    } else {
      out += ch;
      inWs = false;
    }
  }
  if (!casefold) return out;
  // ASCII A-Z only.
  return out.replace(/[A-Z]/g, (c) => c.toLowerCase());
}

export function normalizeBody(s: string): string {
  return normalizeField(s, true);
}
export function normalizeTag(s: string): string {
  return normalizeField(s, true);
}
export function normalizeLink(s: string): string {
  return normalizeField(s, false);
}

/** Canonical UTC ms RFC3339; returns canonical string or null. */
export function canonicalTime(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return null;
  const ms = Date.parse(v);
  if (!Number.isFinite(ms)) return null;
  const canon = new Date(ms).toISOString();
  if (canon !== v) return null;
  return canon;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function sha256HexUtf8(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export function bodyHashFor(normalizedBody: string): string {
  return `sha256:${sha256HexUtf8(normalizedBody)}`;
}

/** Stable canonical JSON: sorted object keys recursively. */
export function canonicalStringify(v: unknown): string {
  if (v === null || typeof v !== "object") return JSON.stringify(v) as string;
  if (Array.isArray(v)) return `[${v.map((e) => canonicalStringify(e)).join(",")}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalStringify(obj[k])}`).join(",")}}`;
}

export function requestHashFor(op: string, normalizedParams: unknown): string {
  return sha256HexUtf8(canonicalStringify({ op, params: normalizedParams }));
}

/**
 * Approval token per plan 14.5: SHA256 over UTF-8 of JSON.stringify of the
 * fixed-position array (no delimiter tricks, no key sorting inside).
 * Tags must already be normalized sorted unique; supersedes/link null when absent.
 */
export function approvalTokenFor(args: {
  id: string;
  bodyHash: string;
  kind: string;
  source: string;
  observedAt: string;
  scope: string;
  supersedes: string | null;
  tags: string[];
  link: string | null;
  createdAt: string;
  expiresAt: string;
}): string {
  const arr = [
    1,
    args.id,
    args.bodyHash,
    args.kind,
    args.source,
    args.observedAt,
    args.scope,
    args.supersedes,
    args.tags,
    args.link,
    args.createdAt,
    args.expiresAt,
  ];
  const ser = JSON.stringify(arr);
  return `sha256:${sha256HexUtf8(ser)}`;
}

export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ba.length !== bb.length) return false;
  try {
    return timingSafeEqual(ba, bb);
  } catch {
    return false;
  }
}

/**
 * Escape for terminal review display: never let stored bytes drive the
 * terminal. ESC becomes \x1B text; other C0/C1 (except LF) and DEL become
 * \uXXXX; the string is otherwise preserved (LF newlines kept for readability).
 */
export function escapeForTerminal(s: string): string {
  let out = "";
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (ch === "\n") {
      out += "\n";
      continue;
    }
    if (cp === 0x1b) {
      out += "\\x1B";
      continue;
    }
    if ((cp >= 0x00 && cp <= 0x1f) || (cp >= 0x7f && cp <= 0x9f)) {
      out += `\\u${cp.toString(16).padStart(4, "0").toUpperCase()}`;
      continue;
    }
    out += ch;
  }
  return out;
}

export function hasControl(s: string): boolean {
  // eslint-disable-next-line no-control-regex
  return /[\u0000-\u001F\u007F-\u009F]/.test(s);
}

/**
 * Strict well-formedness: reject unpaired surrogates (lone lead/trail).
 * Valid astral pairs (e.g. emoji) pass; only unpaired halves fail.
 * Used at the protocol envelope AND at direct create/recall domain
 * validation so an escaped "\ud800" can never mutate state (BAD_REQUEST).
 */
export function hasLoneSurrogate(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff) {
      const n = i + 1 < s.length ? s.charCodeAt(i + 1) : -1;
      if (n < 0xdc00 || n > 0xdfff) return true;
      i++;
    } else if (c >= 0xdc00 && c <= 0xdfff) {
      return true;
    }
  }
  return false;
}

/** Recursively reject any string with an unpaired surrogate. */
export function containsLoneSurrogateDeep(v: unknown): boolean {
  if (typeof v === "string") return hasLoneSurrogate(v);
  if (Array.isArray(v)) {
    for (const e of v) {
      if (containsLoneSurrogateDeep(e)) return true;
    }
    return false;
  }
  if (v !== null && typeof v === "object") {
    for (const k of Object.keys(v as Record<string, unknown>)) {
      if (containsLoneSurrogateDeep((v as Record<string, unknown>)[k])) return true;
      if (hasLoneSurrogate(k)) return true;
    }
  }
  return false;
}
