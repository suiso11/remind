// Offline evaluator-label fit (proposal only). Never applied to production.
import * as fs from "node:fs";

const ACTIONS = ["keep", "retire", "correct"] as const;
type Action = (typeof ACTIONS)[number];
const LR = 0.5;
const ITERATIONS = 400;
const L2 = 0.02;
const MIN_N = 30;
const MIN_HOLDOUT = 6;
const MIN_IMPROVEMENT = 1e-4;
const MIN_UTILITY_MARGIN = 1e-6;
const NUM_KEYS = ["ageHours", "links", "heat", "exposures"] as const;

export interface PolicyRow {
  stream: string;
  features: {
    kind: string;
    ageHours: number;
    links: number;
    heat: number;
    exposures: number;
    hasConflict: boolean;
  };
  utility: Record<Action, number>;
  prevalence?: number;
}

export interface PolicyFitReport {
  accepted: boolean;
  reason: string;
  n: number;
  trainN: number;
  holdoutN: number;
  trainStreams: number;
  holdoutStreams: number;
  featureNames: string[];
  weights: Record<Action, number[]> | null;
  trainLoss: number | null;
  holdoutLoss: number | null;
  baselineHoldoutLoss: number | null;
  trainAccuracy: number | null;
  holdoutAccuracy: number | null;
  holdoutUtility: number | null;
  bestFixedUtility: number | null;
  loso: Array<{
    stream: string; trainN: number; holdoutN: number; policyUtility: number;
    bestFixedUtility: number; holdoutLoss: number; baselineLoss: number;
  }>;
  losoMeanPolicyUtility: number | null;
  losoMeanBestFixedUtility: number | null;
  losoMeanLossImprovement: number | null;
  prevalenceBuckets: Record<string, { n: number; modelLoss: number; baselineLoss: number; ok: boolean }>;
  autoApply: false;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function parseRow(value: unknown, fail: (m: string) => never): PolicyRow {
  if (!isObject(value)) return fail("row must be an object");
  const { stream, features: f, utility: u, prevalence } = value;
  if (typeof stream !== "string") return fail("stream must be string");
  if (!isObject(f)) return fail("features must be an object");
  if (!isObject(u)) return fail("utility must be an object");
  const { kind, ageHours, links, heat, exposures, hasConflict } = f;
  if (typeof kind !== "string") return fail("features.kind must be string");
  if (!isNum(ageHours)) return fail("features.ageHours must be a finite number");
  if (!isNum(links)) return fail("features.links must be a finite number");
  if (!isNum(heat)) return fail("features.heat must be a finite number");
  if (!isNum(exposures)) return fail("features.exposures must be a finite number");
  if (typeof hasConflict !== "boolean") return fail("features.hasConflict must be boolean");
  const { keep, retire, correct } = u;
  if (!isNum(keep) || !isNum(retire) || !isNum(correct)) {
    return fail("utility.keep/retire/correct must be finite numbers");
  }
  const row: PolicyRow = {
    stream,
    features: { kind, ageHours, links, heat, exposures, hasConflict },
    utility: { keep, retire, correct },
  };
  if (prevalence !== undefined) {
    if (!isNum(prevalence) || prevalence < 0 || prevalence > 1) return fail("prevalence must be a number in [0,1]");
    row.prevalence = prevalence;
  }
  return row;
}

export function parseRows(text: string): PolicyRow[] {
  const rows: PolicyRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const fail = (m: string): never => {
      throw new Error(`line ${i + 1}: ${m}`);
    };
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      return fail("invalid JSON");
    }
    rows.push(parseRow(value, fail));
  });
  return rows;
}

const argmax = (v: number[]): number => v.reduce((b, x, i) => (x > v[b] ? i : b), 0);

function softmax(z: number[]): number[] {
  const m = Math.max(...z);
  const e = z.map((x) => Math.exp(x - m));
  const s = e.reduce((a, b) => a + b, 0);
  return e.map((x) => x / s);
}

const logit = (W: number[][], x: number[]): number[] =>
  W.map((w) => w.reduce((s, wj, j) => s + wj * x[j], 0));

function meanLoss(ps: number[][], ys: number[]): number {
  return ys.reduce((s, y, i) => s - Math.log(Math.max(ps[i][y], 1e-12)), 0) / ys.length;
}

const mean = (xs: number[]): number => xs.reduce((a, b) => a + b, 0) / xs.length;

// Deterministic MAP multinomial fit on `train` (standardized/one-hot from train only), evaluated on `hold`.
function fitOnce(train: PolicyRow[], hold: PolicyRow[]) {
  const label = (r: PolicyRow) => argmax(ACTIONS.map((a) => r.utility[a]));
  const ytr = train.map(label);
  const yho = hold.map(label);
  if (new Set(ytr).size < 2) return null;
  const trainN = train.length;

  const kinds = [...new Set(train.map((r) => r.features.kind))].sort();
  const featureNames = ["bias", ...NUM_KEYS, "hasConflict", ...kinds.map((k) => `kind=${k}`)];
  const raw = (r: PolicyRow) => NUM_KEYS.map((k) => r.features[k]);
  const mu = NUM_KEYS.map((_, j) => mean(train.map((r) => raw(r)[j])));
  const sd = NUM_KEYS.map((_, j) => Math.sqrt(mean(train.map((r) => (raw(r)[j] - mu[j]) ** 2))) || 1);
  const vec = (r: PolicyRow) => [
    1,
    ...raw(r).map((v, j) => (v - mu[j]) / sd[j]),
    r.features.hasConflict ? 1 : 0,
    ...kinds.map((k) => (r.features.kind === k ? 1 : 0)),
  ];
  const xtr = train.map(vec);
  const xho = hold.map(vec);
  const d = featureNames.length;

  const W = ACTIONS.map(() => new Array<number>(d).fill(0));
  for (let it = 0; it < ITERATIONS; it++) {
    const G = ACTIONS.map(() => new Array<number>(d).fill(0));
    xtr.forEach((x, i) => {
      const p = softmax(logit(W, x));
      for (let c = 0; c < 3; c++) {
        const e = p[c] - (ytr[i] === c ? 1 : 0);
        for (let j = 0; j < d; j++) G[c][j] += (e * x[j]) / trainN;
      }
    });
    for (let c = 0; c < 3; c++) {
      for (let j = 0; j < d; j++) W[c][j] -= LR * (G[c][j] + (j === 0 ? 0 : L2 * W[c][j]));
    }
  }

  const ptr = xtr.map((x) => softmax(logit(W, x)));
  const pho = xho.map((x) => softmax(logit(W, x)));
  const counts = [0, 0, 0];
  ytr.forEach((y) => counts[y]++);
  const prior = counts.map((c) => (c + 1) / (trainN + 3));
  return {
    featureNames, W, ptr, pho, ytr, yho, prior,
    trainLoss: meanLoss(ptr, ytr),
    holdoutLoss: meanLoss(pho, yho),
    baselineLoss: meanLoss(yho.map(() => prior), yho),
    holdoutUtility: mean(hold.map((r, i) => r.utility[ACTIONS[argmax(pho[i])]])),
    bestFixedUtility: Math.max(...ACTIONS.map((a) => mean(hold.map((r) => r.utility[a])))),
  };
}

export function fitPolicy(rows: PolicyRow[]): PolicyFitReport {
  const n = rows.length;
  const empty: PolicyFitReport = {
    accepted: false, reason: "", n, trainN: 0, holdoutN: 0, trainStreams: 0, holdoutStreams: 0,
    featureNames: [], weights: null, trainLoss: null, holdoutLoss: null, baselineHoldoutLoss: null,
    trainAccuracy: null, holdoutAccuracy: null, holdoutUtility: null, bestFixedUtility: null,
    loso: [], losoMeanPolicyUtility: null, losoMeanBestFixedUtility: null, losoMeanLossImprovement: null,
    prevalenceBuckets: {}, autoApply: false,
  };
  const result = (reason: string, extra: Partial<PolicyFitReport> = {}): PolicyFitReport => ({
    ...empty, ...extra, reason, accepted: reason === "accepted",
  });
  if (n < MIN_N) return result(`skipped: n=${n} < ${MIN_N}`);

  // Group by stream (sorted by stream id, input order within a stream). A stream is never split.
  const byStream = new Map<string, PolicyRow[]>();
  for (const r of rows) {
    const g = byStream.get(r.stream);
    if (g) g.push(r);
    else byStream.set(r.stream, [r]);
  }
  const streams = [...byStream.keys()].sort();
  if (streams.length < 3) return result("skipped: <3 streams");

  // Take whole streams from the end until the holdout is large enough; keep >=1 stream for train.
  const target = Math.max(MIN_HOLDOUT, Math.ceil(0.2 * n));
  let cut = streams.length;
  let holdoutN = 0;
  while (cut > 1 && holdoutN < target) {
    cut--;
    holdoutN += byStream.get(streams[cut])?.length ?? 0;
  }
  const train = streams.slice(0, cut).flatMap((s) => byStream.get(s) ?? []);
  const hold = streams.slice(cut).flatMap((s) => byStream.get(s) ?? []);
  const trainN = train.length;
  const split = { trainN, holdoutN, trainStreams: cut, holdoutStreams: streams.length - cut };
  if (holdoutN < MIN_HOLDOUT) return result(`skipped: holdout=${holdoutN} < ${MIN_HOLDOUT}`, split);

  const f = fitOnce(train, hold);
  if (!f) return result("skipped: <2 distinct argmax classes in train", split);
  const { featureNames, W, ptr, pho, ytr, yho, prior } = f;
  const acc = (ps: number[][], ys: number[]) => ys.filter((y, i) => argmax(ps[i]) === y).length / ys.length;

  // Leave-one-stream-out: every stream is evaluated by a model that never saw it.
  const loso: PolicyFitReport["loso"] = [];
  let losoSkip = "";
  for (const s of streams) {
    const h = byStream.get(s) ?? [];
    const t = streams.filter((o) => o !== s).flatMap((o) => byStream.get(o) ?? []);
    if (h.length < MIN_HOLDOUT) { losoSkip = `skipped: loso fold ${s} holdout=${h.length} < ${MIN_HOLDOUT}`; break; }
    const g = fitOnce(t, h);
    if (!g) { losoSkip = `skipped: <2 distinct argmax classes in loso train (holdout ${s})`; break; }
    loso.push({
      stream: s, trainN: t.length, holdoutN: h.length, policyUtility: g.holdoutUtility,
      bestFixedUtility: g.bestFixedUtility, holdoutLoss: g.holdoutLoss, baselineLoss: g.baselineLoss,
    });
  }
  if (losoSkip) return result(losoSkip, split);
  const losoMeanPolicyUtility = mean(loso.map((l) => l.policyUtility));
  const losoMeanBestFixedUtility = mean(loso.map((l) => l.bestFixedUtility));
  const losoMeanLossImprovement = mean(loso.map((l) => l.baselineLoss - l.holdoutLoss));

  const buckets: PolicyFitReport["prevalenceBuckets"] = {};
  ["low", "mid", "high"].forEach((name, b) => {
    const idx = hold.map((_, i) => i).filter((i) => {
      const p = hold[i].prevalence;
      return p !== undefined && (p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2) === b;
    });
    if (idx.length === 0) return;
    const modelLoss = meanLoss(idx.map((i) => pho[i]), idx.map((i) => yho[i]));
    const baselineLoss = meanLoss(idx.map(() => prior), idx.map((i) => yho[i]));
    buckets[name] = { n: idx.length, modelLoss, baselineLoss, ok: modelLoss <= baselineLoss };
  });

  const weights: Record<Action, number[]> = { keep: W[0], retire: W[1], correct: W[2] };
  const badBuckets = Object.entries(buckets).filter(([, v]) => !v.ok).map(([k]) => k);
  const worseFolds = loso.filter((l) => !(l.policyUtility >= l.bestFixedUtility)).map((l) => l.stream);
  let reason = "accepted";
  if (!(losoMeanPolicyUtility > losoMeanBestFixedUtility + MIN_UTILITY_MARGIN)) {
    reason = `rejected: loso mean utility ${losoMeanPolicyUtility.toFixed(6)} does not beat best fixed action ${losoMeanBestFixedUtility.toFixed(6)}`;
  } else if (worseFolds.length > 0) {
    reason = `rejected: loso fold worse than best fixed action: ${worseFolds.join(",")}`;
  } else if (!(losoMeanLossImprovement > MIN_IMPROVEMENT)) {
    reason = `rejected: loso mean log-loss improvement ${losoMeanLossImprovement.toFixed(6)} <= ${MIN_IMPROVEMENT}`;
  } else if (Object.keys(buckets).length < 2) {
    reason = "prevalence-unverified";
  } else if (badBuckets.length > 0) {
    reason = `rejected: prevalence bucket worse than baseline: ${badBuckets.join(",")}`;
  }
  return result(reason, {
    ...split, featureNames, weights, trainLoss: f.trainLoss, holdoutLoss: f.holdoutLoss,
    baselineHoldoutLoss: f.baselineLoss, trainAccuracy: acc(ptr, ytr), holdoutAccuracy: acc(pho, yho),
    holdoutUtility: f.holdoutUtility, bestFixedUtility: f.bestFixedUtility, prevalenceBuckets: buckets,
    loso, losoMeanPolicyUtility, losoMeanBestFixedUtility, losoMeanLossImprovement,
  });
}

function main(argv: string[]): number {
  const arg = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const input = arg("--input");
  const out = arg("--out");
  if (!input || (argv.includes("--out") && !out)) {
    process.stderr.write("usage: decision-policy-fit --input <jsonl> [--out <json>]\n");
    return 2;
  }
  let report: PolicyFitReport;
  try {
    report = fitPolicy(parseRows(fs.readFileSync(input, "utf8")));
  } catch (e) {
    process.stderr.write(`decision-policy-fit: ${e instanceof Error ? e.message : String(e)}\n`);
    return 2;
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  if (out) fs.writeFileSync(out, json);
  process.stdout.write(json);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
