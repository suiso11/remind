// Pure scoring for link and summary cultivation quality. No CLI, DB, or model calls.

export interface LinkTruth {
  required: string[];
  forbidden?: string[];
}

export interface LinkScore {
  precision: number | null;
  recall: number | null;
  falseLinks: string[];
  misses: string[];
  predicted: number;
  required: number;
}

const uniq = (xs: string[]): string[] => [...new Set(xs)];

export function scoreLinks(predicted: string[], truth: LinkTruth): LinkScore {
  const pred = uniq(predicted);
  const required = uniq(truth.required);
  const forbidden = new Set(truth.forbidden ?? []);
  const predSet = new Set(pred);
  const falseLinks = pred.filter((id) => forbidden.has(id));
  const misses = required.filter((id) => !predSet.has(id));
  return {
    precision: pred.length === 0 ? null : (pred.length - falseLinks.length) / pred.length,
    recall: required.length === 0 ? null : (required.length - misses.length) / required.length,
    falseLinks,
    misses,
    predicted: pred.length,
    required: required.length,
  };
}

export interface SummaryExpectation {
  mustInclude: string[];
  mustExclude: string[];
  requiredSourceIds: string[];
}

export interface SummaryScore {
  factHits: string[];
  factMisses: string[];
  unsupported: string[];
  sourceHits: string[];
  sourceMisses: string[];
  factFidelity: number;
  unsupportedRate: number;
  sourceCoverage: number;
}

const norm = (s: string): string => s.normalize("NFKC").toLowerCase();

// sourceBodies is accepted for caller symmetry; matching is against expectation lists only.
export function scoreSummary(
  body: string,
  _sourceBodies: string[],
  _sourceIds: string[],
  summarySourceIds: string[],
  exp: SummaryExpectation,
): SummaryScore {
  const text = norm(body);
  const include = uniq(exp.mustInclude);
  const exclude = uniq(exp.mustExclude);
  const required = uniq(exp.requiredSourceIds);
  const has = (needle: string): boolean => text.includes(norm(needle));
  const factHits = include.filter(has);
  const factMisses = include.filter((f) => !has(f));
  const unsupported = exclude.filter(has);
  const have = new Set(summarySourceIds);
  const sourceHits = required.filter((id) => have.has(id));
  const sourceMisses = required.filter((id) => !have.has(id));
  return {
    factHits,
    factMisses,
    unsupported,
    sourceHits,
    sourceMisses,
    factFidelity: include.length === 0 ? 1 : factHits.length / include.length,
    unsupportedRate: unsupported.length / Math.max(1, exclude.length),
    sourceCoverage: required.length === 0 ? 1 : sourceHits.length / required.length,
  };
}
