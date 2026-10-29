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
const NUM_KEYS = ["hasShortProbe", "hasDelayedReuse", "hasNoProbe", "ageHours", "links"] as const;

export interface PolicyRow {
  stream: string;
  features: {
    hasShortProbe: boolean;
    hasDelayedReuse: boolean;
    hasNoProbe: boolean;
    kind: string;
    ageHours: number;
    links: number;
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
  featureNames: string[];
  weights: Record<Action, number[]> | null;
  trainLoss: number | null;
  holdoutLoss: number | null;
  baselineHoldoutLoss: number | null;
  trainAccuracy: number | null;
  holdoutAccuracy: number | null;
  prevalenceBuckets: Record<string, { n: number; modelLoss: number; baselineLoss: number; ok: boolean }>;
  autoApply: false;
}

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

export function parseRows(text: string): PolicyRow[] {
  const rows: PolicyRow[] = [];
  text.split("\n").forEach((line, i) => {
    if (line.trim() === "") return;
    const fail = (m: string): never => {
      throw new Error(`line ${i + 1}: ${m}`);
    };
    let r: any;
    try {
      r = JSON.parse(line);
    } catch {
      return fail("invalid JSON");
    }
    const f = r?.features;
    const u = r?.utility;
    if (typeof r?.stream !== "string") fail("stream must be string");
    if (!f || typeof f.kind !== "string") fail("features.kind must be string");
    for (const k of ["hasShortProbe", "hasDelayedReuse", "hasNoProbe"]) {
      if (typeof f[k] !== "boolean") fail(`features.${k} must be boolean`);
    }
    if (!isNum(f.ageHours) || !isNum(f.links)) fail("features.ageHours/links must be finite numbers");
    if (!u || !ACTIONS.every((a) => isNum(u[a]))) fail("utility.keep/retire/correct must be finite numbers");
    if (r.prevalence !== undefined && !(isNum(r.prevalence) && r.prevalence >= 0 && r.prevalence <= 1)) {
      fail("prevalence must be a number in [0,1]");
    }
    rows.push(r as PolicyRow);
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

export function fitPolicy(rows: PolicyRow[]): PolicyFitReport {
  const n = rows.length;
  const empty: PolicyFitReport = {
    accepted: false, reason: "", n, trainN: 0, holdoutN: 0, featureNames: [], weights: null,
    trainLoss: null, holdoutLoss: null, baselineHoldoutLoss: null, trainAccuracy: null,
    holdoutAccuracy: null, prevalenceBuckets: {}, autoApply: false,
  };
  const skip = (reason: string, extra: Partial<PolicyFitReport> = {}): PolicyFitReport => ({ ...empty, ...extra, reason });
  if (n < MIN_N) return skip(`skipped: n=${n} < ${MIN_N}`);

  // Stream-ordered (stable, so input order breaks ties); last 20% is holdout.
  const sorted = rows.map((r, i) => ({ r, i })).sort((a, b) => (a.r.stream < b.r.stream ? -1 : a.r.stream > b.r.stream ? 1 : a.i - b.i)).map((x) => x.r);
  const holdoutN = Math.floor(n * 0.2);
  const trainN = n - holdoutN;
  if (holdoutN < MIN_HOLDOUT) return skip(`skipped: holdout=${holdoutN} < ${MIN_HOLDOUT}`, { trainN, holdoutN });
  const train = sorted.slice(0, trainN);
  const hold = sorted.slice(trainN);
  const label = (r: PolicyRow) => argmax(ACTIONS.map((a) => r.utility[a]));
  const ytr = train.map(label);
  const yho = hold.map(label);
  if (new Set(ytr).size < 2) return skip("skipped: <2 distinct argmax classes in train", { trainN, holdoutN });

  const kinds = [...new Set(train.map((r) => r.features.kind))].sort();
  const featureNames = ["bias", ...NUM_KEYS, ...kinds.map((k) => `kind=${k}`)];
  const raw = (r: PolicyRow) => NUM_KEYS.map((k) => Number(r.features[k]));
  // Standardize numeric columns with train statistics only.
  const mean = NUM_KEYS.map((_, j) => train.reduce((s, r) => s + raw(r)[j], 0) / trainN);
  const std = NUM_KEYS.map((_, j) => Math.sqrt(train.reduce((s, r) => s + (raw(r)[j] - mean[j]) ** 2, 0) / trainN) || 1);
  const vec = (r: PolicyRow) => [
    1,
    ...raw(r).map((v, j) => (v - mean[j]) / std[j]),
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
  const base = yho.map(() => prior);
  const trainLoss = meanLoss(ptr, ytr);
  const holdoutLoss = meanLoss(pho, yho);
  const baselineHoldoutLoss = meanLoss(base, yho);
  const acc = (ps: number[][], ys: number[]) => ys.filter((y, i) => argmax(ps[i]) === y).length / ys.length;

  const buckets: PolicyFitReport["prevalenceBuckets"] = {};
  const names = ["low", "mid", "high"];
  names.forEach((name, b) => {
    const idx = hold.map((r, i) => i).filter((i) => {
      const p = hold[i].prevalence;
      return p !== undefined && (p < 1 / 3 ? 0 : p < 2 / 3 ? 1 : 2) === b;
    });
    if (idx.length === 0) return;
    const modelLoss = meanLoss(idx.map((i) => pho[i]), idx.map((i) => yho[i]));
    const baselineLoss = meanLoss(idx.map(() => prior), idx.map((i) => yho[i]));
    buckets[name] = { n: idx.length, modelLoss, baselineLoss, ok: modelLoss <= baselineLoss };
  });

  const weights = Object.fromEntries(ACTIONS.map((a, c) => [a, W[c]])) as Record<Action, number[]>;
  const improvement = baselineHoldoutLoss - holdoutLoss;
  let reason = "accepted";
  if (!(improvement > MIN_IMPROVEMENT)) reason = `rejected: holdout log-loss improvement ${improvement.toFixed(6)} <= ${MIN_IMPROVEMENT}`;
  else {
    const bad = Object.entries(buckets).filter(([, v]) => !v.ok).map(([k]) => k);
    if (bad.length) reason = `rejected: prevalence bucket worse than baseline: ${bad.join(",")}`;
  }
  return {
    ...empty, accepted: reason === "accepted", reason, trainN, holdoutN, featureNames, weights,
    trainLoss, holdoutLoss, baselineHoldoutLoss, trainAccuracy: acc(ptr, ytr),
    holdoutAccuracy: acc(pho, yho), prevalenceBuckets: buckets,
  };
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
    process.stderr.write(`decision-policy-fit: ${(e as Error).message}\n`);
    return 2;
  }
  const json = JSON.stringify(report, null, 2) + "\n";
  if (out) fs.writeFileSync(out, json);
  process.stdout.write(json);
  return 0;
}

if (require.main === module) process.exit(main(process.argv.slice(2)));
