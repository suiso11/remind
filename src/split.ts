/**
 * Shared code-point text splitter (P1 ingest + P2 episode windows).
 *
 * Ranges are half-open code-point offsets `[start, end)` into the original
 * text. Boundaries prefer paragraph breaks ("\n\n" / CRLF), then line
 * breaks ("\n"), then a hard cut on a code-point boundary, so surrogate
 * pairs are never split. Whitespace-only ranges are not emitted (matching
 * the historical ingest chunker); ranges never overlap and are in order.
 *
 * `eventAppend` bounds both the raw body and `normalizeBody(body)`. NFKC can
 * expand code points (e.g. U+2026 "…" -> "..."), so a raw chunk within the
 * limit can still be rejected after normalization. Boundaries are therefore
 * chosen so both counts stay within `maxCp`.
 */
import { countCp } from "./config.js";
import { normalizeBody } from "./normalize.js";

export interface TextRange {
  /** Inclusive code-point offset. */
  start: number;
  /** Exclusive code-point offset. */
  end: number;
}

/** Exactly the normalized length `eventAppend` enforces. */
function normalizedCp(cps: string[], start: number, end: number): number {
  return countCp(normalizeBody(cps.slice(start, end).join("")));
}

/**
 * Split `text` into ranges of at most `maxCp` code points before and after
 * normalization. Boundary search starts from the first `maxCp` code points of
 * the remaining text (paragraph -> line -> hard cut), then shrinks only when
 * normalization would exceed the bound. Code-point granularity means a
 * surrogate pair is never split.
 */
export function splitTextRanges(text: string, maxCp: number): TextRange[] {
  const cps = Array.from(text);
  const ranges: TextRange[] = [];
  const cap = Number.isFinite(maxCp) ? Math.max(1, Math.floor(maxCp)) : 1;
  let pos = 0;
  while (pos < cps.length) {
    const remaining = cps.length - pos;
    let end: number;
    if (remaining <= cap) {
      end = cps.length;
    } else {
      const limit = pos + cap; // exclusive
      end = -1;
      // Prefer the last paragraph boundary that ends within the bound:
      // "\n\n" or CRLF "\r\n\r\n".
      for (let p = limit - 2; p >= pos; p--) {
        if (cps[p] === "\n" && cps[p + 1] === "\n") {
          end = p + 2;
          break;
        }
        if (
          p + 3 < limit &&
          cps[p] === "\r" &&
          cps[p + 1] === "\n" &&
          cps[p + 2] === "\r" &&
          cps[p + 3] === "\n"
        ) {
          end = p + 4;
          break;
        }
      }
      // Then the last line boundary whose end fits.
      if (end < 0) {
        for (let p = limit - 1; p >= pos; p--) {
          if (cps[p] === "\n") {
            end = p + 1;
            break;
          }
        }
      }
      // Finally a hard cut on a code-point boundary.
      if (end < 0) end = limit;
    }
    if (end <= pos) end = Math.min(pos + cap, cps.length);
    if (normalizedCp(cps, pos, end) > cap) {
      // The raw boundary fits but NFKC expanded it past the limit. Find the
      // largest smaller boundary whose normalized form fits. `lo` starts at
      // the (normalized-empty) start, so a valid boundary is always retained
      // under the mostly-monotone length function; verify and scan forward
      // in the rare cases composition makes lengths dip non-monotonically.
      let lo = pos;
      let hi = end;
      while (lo + 1 < hi) {
        const mid = Math.floor((lo + hi) / 2);
        if (normalizedCp(cps, pos, mid) <= cap) lo = mid;
        else hi = mid;
      }
      if (lo === pos) {
        for (let e = pos + 1; e < end; e++) {
          if (normalizedCp(cps, pos, e) <= cap) {
            lo = e;
            break;
          }
        }
      }
      // No prefix can satisfy the bound (a single expanding code point with a
      // tiny cap). Keep one code point so the caller can fail closed before
      // committing instead of looping forever.
      end = lo > pos ? lo : Math.min(pos + 1, cps.length);
    }
    const chunk = cps.slice(pos, end).join("");
    if (normalizeBody(chunk).length > 0) ranges.push({ start: pos, end });
    pos = end;
  }
  return ranges;
}

/** Slice a range back into text (code points, so no surrogate split). */
export function sliceRange(text: string, range: TextRange): string {
  return Array.from(text)
    .slice(range.start, range.end)
    .join("");
}

/**
 * Largest leading code-point range of `text` whose raw and normalized
 * lengths both stay within `maxCp`. Returns "" when no non-empty prefix fits.
 * Display bodies use this while the raw span remains the ground truth.
 */
export function clipTextToNormalizedCp(text: string, maxCp: number): string {
  const first = splitTextRanges(text, maxCp)[0];
  return first === undefined ? "" : sliceRange(text, first);
}
