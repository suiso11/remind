/**
 * Long-horizon retention evaluation (2609.06986 protocol, real CLI, seeded only).
 *
 * Each session appends M unique user_fact records (event.append + record.remember).
 * After every session i, every session j<=i is probed P times with that
 * session's exact anchor; a probe passes when the target record id appears in
 * record.recall items. M[i][j] = pass rate of session j at time i.
 *
 * Quality numbers are reported, never thresholded. Exit is non-zero only for
 * harness/contract failure: bad CLI envelope, failed op, invalid recall data,
 * or a target missing from an exact-anchor probe issued in its own session
 * (age 0, nothing could have been forgotten yet).
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  latencyStats,
  validateEnvelopeValues,
  validateRecallData,
  validateReturnedIds,
} from "./baseline-score.js";

const SCOPE = "personal/default";
const RUN = "long-horizon-v1-run";
const OBSERVED_AT = "2026-09-01T00:00:00.000Z";
const CLI_TIMEOUT_MS = 30000;
const RECALL_LIMIT = 10;
const MAX_SESSIONS = 60;
const MAX_PER_SESSION = 10;

interface Call { ok: boolean; data: unknown; why: string; ms: number }

function invoke(cliPath: string, configPath: string, request: Record<string, unknown>): Call {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [cliPath, "--config", configPath], {
    input: JSON.stringify(request) + "\n",
    timeout: CLI_TIMEOUT_MS,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024,
    shell: false,
    encoding: "utf8",
  });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const bad = (why: string): Call => ({ ok: false, data: null, why, ms });
  if (r.error) return bad(`spawn-${(r.error as NodeJS.ErrnoException).code ?? "error"}`);
  if (r.status !== 0) return bad(`exit-${String(r.status)}`);
  const out = r.stdout;
  if (out.length === 0 || out.indexOf("\n") !== out.length - 1) return bad("framing");
  let env: unknown;
  try { env = JSON.parse(out); } catch { return bad("bad-json"); }
  if (typeof env !== "object" || env === null || Array.isArray(env)) return bad("bad-envelope");
  const e = env as Record<string, unknown>;
  if (Object.keys(e).sort().join(",") !== "code,data,deduplicated,message,ok,v" || !validateEnvelopeValues(e).ok) {
    return bad("bad-envelope");
  }
  if (e["ok"] !== true) return bad(`envelope-${String(e["code"])}`);
  return { ok: true, data: e["data"], why: "", ms };
}

function config(dir: string): Record<string, unknown> {
  return {
    dbPath: path.join(dir, "lh.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE],
    limits: {
      bodyMaxCp: 2000, queryMaxCp: 500, tagsMax: 5, linksMax: 8, sourceRefsMax: 8,
      limitDefault: 10, limitMax: 25, snippetMaxCp: 200, responseMaxBytes: 8192,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
    cultivation: { queueMax: 8, batchMax: 20, leaseTtlMs: 120000, reviewMaxAttempts: 5 },
  };
}

const anchorOf = (s: number, m: number): string => `anchortoken${s}x${m}`;
const QUERY_TEMPLATES = [
  (a: string) => `Can you remind me about ${a} from the ledger?`,
  (a: string) => `What do I know about ${a}?`,
  (a: string) => `${a}`,
];

const mean = (xs: number[]): number => (xs.length === 0 ? NaN : xs.reduce((a, b) => a + b, 0) / xs.length);

/** Pure metric computation over the temporal matrix (null = not yet observable). */
export function summarizeMatrix(matrix: (number | null)[][]): {
  finalRetention: number;
  immediateAcquisition: number;
  forgetting: number;
  ageRecall: number[];
  memoryHalfLife: number | null;
} {
  const n = matrix.length;
  const at = (i: number, j: number): number => matrix[i]?.[j] as number;
  const js = Array.from({ length: n }, (_, j) => j);
  const ageBuckets: number[][] = Array.from({ length: n }, () => []);
  for (let i = 0; i < n; i++) for (let j = 0; j <= i; j++) (ageBuckets[i - j] as number[]).push(at(i, j));
  const ageRecall = ageBuckets.map(mean);
  let memoryHalfLife: number | null = null;
  for (let a = 1; a < n; a++) {
    if ((ageRecall[a] as number) < 0.5 * (ageRecall[0] as number)) { memoryHalfLife = a; break; }
  }
  return {
    finalRetention: mean(js.map((j) => at(n - 1, j))),
    immediateAcquisition: mean(js.map((j) => at(j, j))),
    forgetting: mean(js.map((j) => {
      let peak = 0;
      for (let i = j; i < n; i++) peak = Math.max(peak, at(i, j));
      return peak - at(n - 1, j);
    })),
    ageRecall,
    memoryHalfLife,
  };
}

function parseIntArg(v: string | undefined, max: number): number | null {
  if (v === undefined || !/^[1-9][0-9]*$/.test(v)) return null;
  const n = Number(v);
  return n <= max ? n : null;
}

function main(): void {
  const args = process.argv.slice(2);
  let sessions = 12, memories = 3, probes = 2;
  let out: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    const v = args[i + 1];
    let ok = true;
    if (a === "--sessions") { const n = parseIntArg(v, MAX_SESSIONS); ok = n !== null; sessions = n ?? sessions; i++; }
    else if (a === "--memories-per-session") { const n = parseIntArg(v, MAX_PER_SESSION); ok = n !== null; memories = n ?? memories; i++; }
    else if (a === "--probes-per-session") { const n = parseIntArg(v, MAX_PER_SESSION); ok = n !== null; probes = n ?? probes; i++; }
    else if (a === "--out" && v !== undefined) { out = v; i++; }
    else if (a === "--help" || a === "-h") {
      process.stderr.write("usage: evaluate-long-horizon [--sessions N] [--memories-per-session M] [--probes-per-session P] [--out file]\n");
      process.exit(0);
    } else ok = false;
    if (!ok) { process.stderr.write("error: bad arguments\n"); process.exit(2); }
  }

  const cliPath = path.resolve(__dirname, "..", "src", "cli.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lh-eval-"));
  const configPath = path.join(dir, "memory.config.json");
  const invariants: string[] = [];
  const latencies: number[] = [];
  const call = (req: Record<string, unknown>): Call => {
    const r = invoke(cliPath, configPath, req);
    latencies.push(r.ms);
    return r;
  };

  const matrix: (number | null)[][] = Array.from({ length: sessions }, () => Array<number | null>(sessions).fill(null));
  const targets: string[][] = [];
  let aborted = false;
  try {
    fs.writeFileSync(configPath, JSON.stringify(config(dir)), "utf8");
    for (let s = 0; s < sessions && !aborted; s++) {
      const ids: string[] = [];
      for (let m = 0; m < memories; m++) {
        const evId = `lh-s${s}-e${m}`;
        const prov = { source: `synthetic:lh:${evId}`, observedAt: OBSERVED_AT };
        const ev = call({
          v: 1, op: "event.append", idempotencyKey: `lh-ev-${s}-${m}`,
          params: {
            eventId: evId, sessionId: `lh-s${s}`, turnId: `t${m}`,
            body: `User: session ${s} note ${m} ${anchorOf(s, m)}\nAssistant: Noted.`,
            provenance: prov, scope: SCOPE, runId: RUN,
          },
        });
        const rem = ev.ok ? call({
          v: 1, op: "record.remember", idempotencyKey: `lh-rem-${s}-${m}`,
          params: {
            body: `Session ${s} ledger note ${m} carries ${anchorOf(s, m)}.`, kind: "user_fact",
            provenance: prov, scope: SCOPE, tags: [], links: [], sourceRefs: [evId], runId: RUN,
          },
        }) : ev;
        const id = (rem.data as { record?: { id?: unknown } } | null)?.record?.id;
        if (!rem.ok || typeof id !== "string") {
          invariants.push(`seed s${s} m${m} failed: ${rem.why || "no-record-id"}`);
          aborted = true;
          break;
        }
        ids.push(id);
      }
      targets.push(ids);
      if (aborted) break;

      for (let j = 0; j <= s; j++) {
        let pass = 0;
        for (let p = 0; p < probes; p++) {
          const m = p % memories;
          const query = (QUERY_TEMPLATES[Math.floor(p / memories) % QUERY_TEMPLATES.length] as (a: string) => string)(anchorOf(j, m));
          const res = call({ v: 1, op: "record.recall", params: { query, scope: SCOPE, limit: RECALL_LIMIT, runId: RUN } });
          const checked = res.ok ? validateRecallData(res.data) : null;
          if (!checked || !checked.ok) {
            invariants.push(`recall t${s} j${j} p${p} failed: ${res.ok ? "bad-data" : res.why}`);
            aborted = true;
            break;
          }
          const returned = checked.items.map((it) => it.id);
          const v = validateReturnedIds(returned, RECALL_LIMIT);
          if (!v.ok) {
            invariants.push(`recall t${s} j${j} p${p} ids: ${v.reason}`);
            aborted = true;
            break;
          }
          if (returned.includes((targets[j] as string[])[m] as string)) pass++;
          else if (j === s) invariants.push(`age-0 exact-anchor target missing: session ${s} memory ${m}`);
        }
        if (aborted) break;
        (matrix[s] as (number | null)[])[j] = pass / probes;
      }
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }

  const lat = latencyStats(latencies);
  const report: Record<string, unknown> = {
    fixture: "long-horizon-v1",
    syntheticOnly: true,
    sessions,
    memoriesPerSession: memories,
    probesPerSession: probes,
    probes: sessions * (sessions + 1) / 2 * probes,
    matrix,
    ...(invariants.length === 0 ? summarizeMatrix(matrix) : {}),
    latencyMs: lat === null ? null : { p50: lat.median, p95: lat.p95, count: lat.count },
    invariants,
  };
  const line = JSON.stringify(report) + "\n";
  process.stdout.write(line);
  if (out !== null) fs.writeFileSync(out, line, "utf8");
  process.exit(invariants.length > 0 ? 1 : 0);
}

main();
