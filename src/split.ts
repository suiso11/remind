/**
 * Shared code-point text splitter (P1 ingest + P2 episode windows).
 *
 * Ranges are half-open code-point offsets `[start, end)` into the original
 * text. Boundaries prefer paragraph breaks ("\n\n" / CRLF), then line
 * breaks ("\n"), then a hard cut on a code-point boundary, so surrogate
 * pairs are never split. Whitespace-only ranges are not emitted (matching
 * the historical ingest chunker); ranges never overlap and are in order.
 */
import { normalizeBody } from "./normalize.js";

export interface TextRange {
  /** Inclusive code-point offset. */
  start: number;
  /** Exclusive code-point offset. */
  end: number;
}

/**
 * Split `text` into ranges of at most `maxCp` code points. Boundary search is
 * limited to the first `maxCp` code points of the remaining text, so every
 * emitted range stays within the bound.
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
