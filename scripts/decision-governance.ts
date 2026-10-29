/**
 * Store-agnostic governance gates (poison resistance, reversibility,
 * auditability, quality gate vs. governance-by-inaction, leakage checks).
 * Deterministic, offline, model-free; talks only to GovernanceStore.
 */

export interface GovernanceStoreRecord { id: string; body: string; status: string; kind: string; source: string }
export interface GovernanceAuditRow { op: string; code: string; targetId: string; reasonCode: string | null }
export interface GovernanceStore {
  readonly dbPath: string;
  seed(key: string, body: string, source: string, kind?: "user_fact" | "model_inference" | "summary"): { id: string; eventId: string };
  rememberDerived(key: string, body: string, links: string[], sourceRefs: string[]): { id: string; eventId: string };
  recall(query: string): { recallId: string; ids: string[] };
  searchIds(query: string): string[];
  get(id: string): GovernanceStoreRecord;
  correct(id: string, body: string, source: string, sourceRefs: string[]): string;
  retire(id: string): void;
  reactivate(id: string): void;
  auditFor(targetId: string): GovernanceAuditRow[];
  auditColumns(): string[];
}
export interface GovernanceGate { pass: boolean; detail: string; skipped?: boolean }
export interface GovernanceReport { gates: Record<string, GovernanceGate>; invariants: string[]; ok: boolean }

/** A recall probe: the query issued and whether the target was expected in the result. */
interface ProbeState { query: string; expectIn: boolean }
interface Ctx { probes: ProbeState[]; ids: Set<string> }

const ORACLE_LABELS = ["retire", "reactivate", "correct", "supersede", "include", "exclude"];
const FORBIDDEN_AUDIT_COLUMNS = /^(body|text|content|raw)$/i;

function probe(ctx: Ctx, store: GovernanceStore, query: string, id: string, expectIn: boolean): boolean {
  ctx.probes.push({ query, expectIn });
  return store.recall(query).ids.includes(id) === expectIn;
}

/**
 * Retire -> reactivate -> correct cycle on a fresh fact. True only when every
 * step visibly changed state, so a store whose mutations are no-ops fails.
 */
function lifecycleCycle(store: GovernanceStore, ctx: Ctx, key: string): boolean {
  const q = `cycle${key}token`;
  const { id } = store.seed(`cycle-${key}`, `${q} baseline fact`, "user", "user_fact");
  ctx.ids.add(id);
  let ok = probe(ctx, store, q, id, true);
  store.retire(id);
  ok = probe(ctx, store, q, id, false) && ok;
  store.reactivate(id);
  ok = probe(ctx, store, q, id, true) && ok;
  const next = store.correct(id, `${q} corrected fact`, "user", []);
  ctx.ids.add(next);
  return ok && next !== id && store.get(id).status !== "active" && store.get(next).status === "active";
}

function noopAdversary(store: GovernanceStore): GovernanceStore {
  return {
    dbPath: store.dbPath,
    seed: (k, b, s, kind) => store.seed(k, b, s, kind),
    rememberDerived: (k, b, l, r) => store.rememberDerived(k, b, l, r),
    recall: (q) => store.recall(q),
    searchIds: (q) => store.searchIds(q),
    get: (id) => store.get(id),
    correct: (id) => id,
    retire: () => undefined,
    reactivate: () => undefined,
    auditFor: (id) => store.auditFor(id),
    auditColumns: () => store.auditColumns(),
  };
}

function g1Poison(store: GovernanceStore, ctx: Ctx): GovernanceGate {
  const q = "poisonprobe";
  const decoy = store.seed("g1-decoy", `${q} the deploy region is eu-west`, "user", "user_fact");
  const inf = store.seed("g1-model", `${q} the deploy region is us-east`, "model", "model_inference");
  ctx.ids.add(decoy.id).add(inf.id);
  const known = new Set([decoy.id, inf.id]);
  const seen = [...store.recall(q).ids, ...store.recall(q).ids, ...store.searchIds(q)];
  ctx.probes.push({ query: q, expectIn: true });
  const stray = seen.filter((id) => !known.has(id));
  const autoOps = store.auditFor(decoy.id).filter((r) => /correct|supersed|summar/i.test(r.op));
  const stayed = store.get(decoy.id).status === "active";
  const next = store.correct(decoy.id, `${q} the deploy region is us-east`, "user", []);
  ctx.ids.add(next);
  const explicit = store.get(decoy.id).status !== "active" && next !== decoy.id;
  const pass = stray.length === 0 && autoOps.length === 0 && stayed && explicit;
  return {
    pass,
    skipped: true,
    detail: `skipped: model-free; no automatic durable write path (structural sanity only: stray=${stray.length}, autoOps=${autoOps.length}, decoyActive=${stayed}, explicitCorrectSupersedes=${explicit})`,
  };
}

function g2Reversible(store: GovernanceStore, ctx: Ctx): GovernanceGate {
  const fail: string[] = [];
  const q = "revprobe";
  const f = store.seed("g2-fact", `${q} fact`, "user", "user_fact");
  ctx.ids.add(f.id);
  if (!probe(ctx, store, q, f.id, true)) fail.push("initial recall misses fact");
  store.retire(f.id);
  if (!probe(ctx, store, q, f.id, false)) fail.push("recall still returns retired");
  if (!store.searchIds(q).includes(f.id)) fail.push("search misses retired");
  store.reactivate(f.id);
  if (!probe(ctx, store, q, f.id, true)) fail.push("recall misses reactivated");

  const gq = "sumprobe";
  const a = store.seed("g2-a", `${gq} alpha`, "user", "user_fact");
  const b = store.seed("g2-b", `${gq} beta`, "user", "user_fact");
  const s = store.rememberDerived("g2-sum", `${gq} summary`, [a.id, b.id], [a.eventId, b.eventId]);
  ctx.ids.add(a.id).add(b.id).add(s.id);
  store.retire(s.id);
  if (store.get(a.id).status !== "active" || store.get(b.id).status !== "active") fail.push("retiring summary touched facts");
  const rec = store.recall(gq).ids;
  ctx.probes.push({ query: gq, expectIn: true });
  if (!rec.includes(a.id) || !rec.includes(b.id)) fail.push("facts not recalled after summary retire");
  store.reactivate(s.id);
  const s2 = store.correct(s.id, `${gq} summary revised`, "user", [a.eventId, b.eventId]);
  ctx.ids.add(s2);
  if (s2 === s.id || store.get(s.id).status === "active") fail.push("old summary not superseded");
  if (store.get(a.id).status !== "active" || store.get(b.id).status !== "active") fail.push("correcting summary touched facts");
  return { pass: fail.length === 0, detail: fail.length ? fail.join("; ") : "retire/reactivate/correct reversible; facts untouched" };
}

function g3Audit(store: GovernanceStore, ctx: Ctx): GovernanceGate {
  const fail: string[] = [];
  const { id } = store.seed("g3-fact", "auditprobe fact", "user", "user_fact");
  ctx.ids.add(id);
  store.retire(id);
  store.reactivate(id);
  const next = store.correct(id, "auditprobe fact v2", "user", []);
  ctx.ids.add(next);
  // record.correct audits the new revision id; retire/reactivate audit the old.
  const rows = [...store.auditFor(id), ...store.auditFor(next)];
  for (const want of ["retire", "reactivate", "correct"]) {
    const hit = rows.filter((r) => r.op.toLowerCase().includes(want));
    if (hit.length === 0) fail.push(`missing ${want} audit row`);
    else if (want !== "correct" && hit.some((r) => !r.reasonCode)) fail.push(`${want} row lacks reasonCode`);
  }
  const bad = store.auditColumns().filter((c) => FORBIDDEN_AUDIT_COLUMNS.test(c));
  if (bad.length) fail.push(`audit stores content column(s): ${bad.join(",")}`);
  return { pass: fail.length === 0, detail: fail.length ? fail.join("; ") : `ops=${rows.map((r) => r.op).join(",")}; no content columns` };
}

interface G4Result { gate: GovernanceGate; adversaryPassed: boolean; real: Ctx }

function g4Quality(store: GovernanceStore): G4Result {
  const real: Ctx = { probes: [], ids: new Set() };
  const noop: Ctx = { probes: [], ids: new Set() };
  const realOk = lifecycleCycle(store, real, "real");
  const adversaryPassed = lifecycleCycle(noopAdversary(store), noop, "noop");
  return {
    gate: {
      pass: realOk && !adversaryPassed,
      detail: `governanceByInaction: ${adversaryPassed} (real cycle ${realOk ? "changes" : "does not change"} state; no-op adversary ${adversaryPassed ? "PASSED" : "rejected"})`,
    },
    adversaryPassed,
    real,
  };
}

function leakProvenance(ctx: Ctx): GovernanceGate {
  const hits: string[] = [];
  for (const { query } of ctx.probes) {
    const lower = query.toLowerCase();
    for (const id of ctx.ids) if (id && query.includes(id)) hits.push(`id:${id}`);
    for (const l of ORACLE_LABELS) if (lower.includes(l)) hits.push(`label:${l}`);
  }
  return { pass: hits.length === 0, detail: hits.length ? `leaked ${hits.join(",")}` : `${ctx.probes.length} queries free of ids/labels` };
}

/** Best single-threshold accuracy of a numeric feature against the boolean expectation. */
function bestThresholdAccuracy(xs: number[], ys: boolean[]): number {
  let best = 0;
  for (const t of xs) {
    const hi = xs.filter((x, i) => (x >= t) === ys[i]).length / xs.length;
    best = Math.max(best, hi, 1 - hi);
  }
  return best;
}

function leakProbe(ctx: Ctx): GovernanceGate {
  const n = ctx.probes.length;
  if (n < 8) return { pass: true, skipped: true, detail: `n/a: insufficient-samples (${n} < 8)` };
  const ys = ctx.probes.map((p) => p.expectIn);
  const prevalence = ys.filter(Boolean).length / n;
  const majority = Math.max(prevalence, 1 - prevalence);
  const features: Record<string, number[]> = {
    queryLength: ctx.probes.map((p) => p.query.length),
    wordCount: ctx.probes.map((p) => p.query.split(/\s+/).length),
  };
  const acc = Object.entries(features).map(([k, v]) => [k, bestThresholdAccuracy(v, ys)] as const);
  const worst = acc.reduce((a, b) => (b[1] > a[1] ? b : a));
  const lift = worst[1] - majority;
  return {
    pass: lift < 0.2,
    detail: `best single-feature accuracy ${worst[1].toFixed(3)} (${worst[0]}) minus majority ${majority.toFixed(3)} = lift ${lift.toFixed(3)} over ${n} states`,
  };
}


export function runGovernanceSuite(store: GovernanceStore): GovernanceReport {
  const gates: Record<string, GovernanceGate> = {};
  const invariants: string[] = [];
  const ctx: Ctx = { probes: [], ids: new Set() };
  const run = (name: string, fn: () => GovernanceGate): void => {
    try {
      gates[name] = fn();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      gates[name] = { pass: false, detail: `threw: ${msg}` };
      invariants.push(`${name} adapter error: ${msg}`);
    }
  };
  run("G1_poison", () => g1Poison(store, ctx));
  run("G2_reversibility", () => g2Reversible(store, ctx));
  run("G3_auditability", () => g3Audit(store, ctx));
  const g4s: G4Result[] = [];
  run("G4_quality", () => {
    const r = g4Quality(store);
    g4s.push(r);
    return r.gate;
  });
  const g4 = g4s[0];
  if (g4?.adversaryPassed) invariants.push("G4 no-op adversary passed (governance-by-inaction)");
  run("leak_provenance", () => leakProvenance({ probes: [...ctx.probes, ...(g4?.real.probes ?? [])], ids: new Set([...ctx.ids, ...(g4?.real.ids ?? [])]) }));
  run("leak_probe", () => leakProbe({ probes: [...ctx.probes, ...(g4?.real.probes ?? [])], ids: ctx.ids }));
  run("leak_count_matched", () => ({ pass: true, skipped: true, detail: "n/a: deterministic suite; no sampled arms" }));
  for (const [name, g] of Object.entries(gates)) {
    if (!g.pass && !invariants.some((i) => i.startsWith(name))) invariants.push(`${name} failed: ${g.detail}`);
  }
  return { gates, invariants, ok: invariants.length === 0 };
}
