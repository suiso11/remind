/**
 * sourceRefs entry model (P1 raw-read slice).
 *
 * A sourceRef is either the legacy opaque eventId string or a code-point
 * span `{eventId, start, end}`. Structural parsing is shared by
 * record.remember / record.correct (store.ts) and maintain.cultivate /
 * maintain.distill (cultivation.ts, distill.ts) so hash and storage
 * normalization stay identical everywhere.
 */
import { countCp, hasControl } from "./normalize.js";

export interface SpanRef {
  eventId: string;
  start: number;
  end: number;
}

export type SourceRef = string | SpanRef;

/** Storage shape: legacy rows keep both span columns NULL. */
export interface StoredSourceRef {
  eventId: string;
  start: number | null;
  end: number | null;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function validEventId(v: unknown): v is string {
  return (
    typeof v === "string" &&
    countCp(v) >= 1 &&
    countCp(v) <= 256 &&
    !hasControl(v)
  );
}

export function sourceRefKey(r: SourceRef): string {
  return typeof r === "string"
    ? `s\u0000${r}`
    : `p\u0000${r.eventId}\u0000${r.start}\u0000${r.end}`;
}

function compareRefs(a: SourceRef, b: SourceRef): number {
  const ae = typeof a === "string" ? a : a.eventId;
  const be = typeof b === "string" ? b : b.eventId;
  if (ae < be) return -1;
  if (ae > be) return 1;
  const aString = typeof a === "string";
  const bString = typeof b === "string";
  if (aString || bString) {
    if (aString && bString) return 0;
    return aString ? -1 : 1;
  }
  const as = a as SpanRef;
  const bs = b as SpanRef;
  if (as.start !== bs.start) return as.start - bs.start;
  return as.end - bs.end;
}

/**
 * Canonical order/dedup. For an all-string input this is exactly the legacy
 * `[...new Set(refs)].sort()` representation, so request hashes stay
 * byte-identical for legacy callers.
 */
export function canonicalSourceRefs(refs: SourceRef[]): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const r of refs) {
    const k = sourceRefKey(r);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out.sort(compareRefs);
}

/**
 * Strict structural parse of the optional `sourceRefs` request param.
 * `undefined` => []. Array length > max => "over" (LIMIT_EXCEEDED by callers).
 * Anything malformed => "bad" (BAD_REQUEST). DB existence/span bounds are
 * validated by the caller (it needs the raw event body).
 */
export function parseSourceRefsParam(
  refs: unknown,
  max: number,
): SourceRef[] | "bad" | "over" {
  if (refs === undefined) return [];
  if (!Array.isArray(refs)) return "bad";
  if (refs.length > max) return "over";
  const out: SourceRef[] = [];
  for (const r of refs) {
    if (typeof r === "string") {
      if (!validEventId(r)) return "bad";
      out.push(r);
      continue;
    }
    if (!isPlainObject(r)) return "bad";
    const keys = Object.keys(r);
    if (
      keys.length !== 3 ||
      !keys.includes("eventId") ||
      !keys.includes("start") ||
      !keys.includes("end")
    ) {
      return "bad";
    }
    const eventId = r["eventId"];
    const start = r["start"];
    const end = r["end"];
    if (!validEventId(eventId)) return "bad";
    if (
      typeof start !== "number" ||
      !Number.isSafeInteger(start) ||
      typeof end !== "number" ||
      !Number.isSafeInteger(end) ||
      start < 0 ||
      end <= start
    ) {
      return "bad";
    }
    out.push({ eventId: eventId as string, start, end });
  }
  return canonicalSourceRefs(out);
}

export function storedSourceRefs(refs: SourceRef[]): StoredSourceRef[] {
  return refs.map((r) =>
    typeof r === "string"
      ? { eventId: r, start: null, end: null }
      : { eventId: r.eventId, start: r.start, end: r.end },
  );
}

/** Rebuild the request-facing ref from nullable storage columns. */
export function sourceRefFromColumns(
  eventId: string,
  start: number | null | undefined,
  end: number | null | undefined,
): SourceRef {
  if (start === null || start === undefined || end === null || end === undefined) {
    return eventId;
  }
  return { eventId, start, end };
}
