/**
 * Operational synthetic evaluation (lifecycle + scale, real CLI only).
 * - Own mkdtemp config per data size from fixed limits, never user config.
 * - All ops via real compiled CLI subprocess (boring serial spawnSync).
 * - Synthetic conversation-shaped queries at bounded data sizes (10/30/60).
 * - Lifecycle proof per size: correction excludes superseded; retire excludes
 *   normal recall yet explicit search recovers and reactivation restores;
 *   feedback raises heat only for validated selected citations (invalid
 *   outside-exposure feedback rejected with heat unchanged).
 * - Derived-index fallback per size: partial (one record's bigrams dropped)
 *   and per-row FTS-body corruption (damage the count-based startup repair
 *   does not detect; row count preserved) recalls still hit via the canonical
 *   bodyNorm fallback, with post-recall DB proof the damage was still present.
 *   A fully empty FTS table is startup-repaired and claims nothing. Derived
 *   rows only; canonical rows never touched.
 * - Queue cap per size: cultivation queueMax=8 configured; open reviews stay
 *   bounded while every canonical write still commits.
 * - No quality thresholds; low lexical scores alone exit 0. Lexical results
 *   are never labelled semantic/model quality. Optional model leg is opt-in
 *   only (--model-dir): baseline runs fully offline without it.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  aggregatePositive,
  classifyNegative,
  findInvariantViolations,
  latencyStats,
  negativeFractions,
  scorePositive,
  validateEnvelopeValues,
  validateRecallData,
  validateReturnedIds,
  type NegativeOutcome,
} from "./baseline-score.js";

export const OPS_FIXTURE_VERSION = "operations-v1";
export const OPS_SCHEMA_VERSION = 1;
export const OPS_K = 3;
export const OPS_SCALES = [10, 30, 60] as const;
export const OPS_QUEUE_MAX = 8;
export const OPS_SCOPE = "personal/default";
export const OPS_RUN = "operations-v1-run";
export const OPS_OBSERVED_AT = "2026-09-01T00:00:00.000Z";

// Spawn-kill budget for the harness. The CLI's op-level deadline contract
// stays config.timeouts.cliMs; this budget only needs headroom above it for
// process startup (node + module load), which loaded CI runners (windows
// Defender real-time scanning, parallel test files) can stretch to seconds.
// Killing a healthy child mid-startup reads as a transport failure, so the
// budget is generous; the op deadline itself is unchanged.
const CLI_TIMEOUT_MS = 30000;
const MAX_BUFFER = 64 * 1024;
const MAX_STDERR = 16 * 1024;
const RESPONSE_MAX_BYTES = 8192;

type AnyBuf = Buffer<ArrayBufferLike>;
interface CliResult {
  status: number | null;
  stdoutBuf: AnyBuf;
  stderrText: string;
  timedOut: boolean;
  elapsedMs: number;
  envelope: Record<string, unknown> | null;
  envelopeValid: boolean;
  jsonBytes: number;
  invalidReason: string | null;
}

function monotonicMs(): bigint {
  return process.hrtime.bigint();
}

function elapsedMsSince(start: bigint, end: bigint): number {
  return Number(end - start) / 1e6;
}

/** Boring serial shell-free CLI invocation; waits child exit before cleanup. */
function invokeCli(
  cliPath: string,
  configPath: string,
  request: Record<string, unknown>,
): CliResult {
  const line = Buffer.from(JSON.stringify(request) + "\n", "utf8");
  const start = monotonicMs();
  let status: number | null = null;
  let stdoutBuf: AnyBuf = Buffer.alloc(0) as AnyBuf;
  let stderrText = "";
  let timedOut = false;
  try {
    const r = spawnSync(process.execPath, [cliPath, "--config", configPath], {
      input: line,
      timeout: CLI_TIMEOUT_MS,
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER,
      shell: false,
      encoding: "buffer",
    });
    const end = monotonicMs();
    status = r.status;
    const rawOut = r.stdout as unknown;
    stdoutBuf = (Buffer.isBuffer(rawOut) ? rawOut : Buffer.from(String(rawOut ?? ""))) as AnyBuf;
    const rawErr = r.stderr as unknown;
    const errBuf = (Buffer.isBuffer(rawErr) ? rawErr : Buffer.from(String(rawErr ?? ""))) as AnyBuf;
    stderrText = (() => {
      try {
        return new TextDecoder("utf-8", { fatal: true }).decode(errBuf.subarray(0, MAX_STDERR));
      } catch {
        return "";
      }
    })();
    if (r.error) {
      const code = (r.error as NodeJS.ErrnoException).code;
      if (code === "ETIMEDOUT" || /timed?out/i.test(String(r.error))) timedOut = true;
    }
    const elapsed = elapsedMsSince(start, end);
    return parseCliOutput(status, stdoutBuf, stderrText, timedOut, elapsed);
  } catch {
    const end = monotonicMs();
    const elapsed = elapsedMsSince(start, end);
    return {
      status,
      stdoutBuf,
      stderrText,
      timedOut: true,
      elapsedMs: elapsed,
      envelope: null,
      envelopeValid: false,
      jsonBytes: 0,
      invalidReason: "spawn-failure",
    };
  }
}

function parseCliOutput(
  status: number | null,
  stdoutBuf: Buffer,
  stderrText: string,
  timedOut: boolean,
  elapsedMs: number,
): CliResult {
  if (timedOut) {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: 0, invalidReason: "timeout" };
  }
  if (stdoutBuf.length === 0) {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: 0, invalidReason: "empty-stdout" };
  }
  if (stdoutBuf[stdoutBuf.length - 1] !== 0x0a || stdoutBuf.indexOf(0x0a) !== stdoutBuf.length - 1) {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: stdoutBuf.length, invalidReason: "framing" };
  }
  const jsonBytes = stdoutBuf.subarray(0, stdoutBuf.length - 1);
  if (jsonBytes.length > RESPONSE_MAX_BYTES) {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: jsonBytes.length, invalidReason: "over-budget" };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes);
  } catch {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: jsonBytes.length, invalidReason: "bad-utf8" };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: jsonBytes.length, invalidReason: "bad-json" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: jsonBytes.length, invalidReason: "bad-envelope" };
  }
  const keys = Object.keys(parsed as Record<string, unknown>).sort().join(",");
  if (keys !== "code,data,deduplicated,message,ok,v") {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: jsonBytes.length, invalidReason: "bad-envelope" };
  }
  const env = parsed as Record<string, unknown>;
  if (!validateEnvelopeValues(env).ok) {
    return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: null, envelopeValid: false, jsonBytes: jsonBytes.length, invalidReason: "bad-envelope" };
  }
  return { status, stdoutBuf, stderrText, timedOut, elapsedMs, envelope: parsed as Record<string, unknown>, envelopeValid: true, jsonBytes: jsonBytes.length, invalidReason: null };
}

function expectedConfig(dir: string): Record<string, unknown> {
  return {
    dbPath: path.join(dir, "ops.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [OPS_SCOPE],
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      linksMax: 8,
      sourceRefsMax: 8,
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 8192,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
    cultivation: { queueMax: OPS_QUEUE_MAX, batchMax: 20, leaseTtlMs: 120000, reviewMaxAttempts: 5 },
  };
}

const FILLER_TOPICS = [
  "persimmon crates stacked by the north wall",
  "beacon lamp oil ordered for friday",
  "miso broth simmered before sunrise",
  "spare key hangs on the blue hook",
  "tide chart checked before dusk",
  "bicycle tire patched in the shed",
] as const;

function fillerBody(scale: number, i: number): string {
  const topic = FILLER_TOPICS[i % FILLER_TOPICS.length];
  return `Ops ledger s${scale} n${i}: ${topic} anchortoken${scale}x${i}.`;
}

function fillerQuery(scale: number, i: number): string {
  return `Can you remind me about anchor${"token"}${scale}x${i} from yesterday's ledger?`;
}

function provenanceFor(eventId: string): { source: string; observedAt: string } {
  return { source: `synthetic:ops:${eventId}`, observedAt: OPS_OBSERVED_AT };
}

function rawBodyFor(utterance: string): string {
  return `User: ${utterance}\nAssistant: Noted.`;
}

function heatOf(db: DatabaseSync, id: string): number {
  try {
    const row = db.prepare(`SELECT usedCount FROM note_heat WHERE recordId = ?`).get(id) as { usedCount?: number } | undefined;
    return typeof row?.usedCount === "number" ? row.usedCount : 0;
  } catch {
    return -1;
  }
}

/** heatOf via a short-lived read-only connection to the eval DB path. */
function heatViaPath(dbPath: string, id: string): number {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    return heatOf(db, id);
  } catch {
    return -1;
  } finally {
    try { (db as DatabaseSync | null)?.close(); } catch { /* ignore */ }
  }
}

function openReviewCount(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM cultivation_queue WHERE status IN ('pending','leased')`).get() as { n?: number } | undefined;
    return typeof row?.n === "number" ? row.n : -1;
  } catch {
    return -1;
  }
}

function recordCount(db: DatabaseSync): number {
  try {
    const row = db.prepare(`SELECT COUNT(*) AS n FROM records`).get() as { n?: number } | undefined;
    return typeof row?.n === "number" ? row.n : -1;
  } catch {
    return -1;
  }
}

function okEnvelope(res: CliResult): Record<string, unknown> | null {
  if (!res.envelopeValid || res.status !== 0) return null;
  const env = res.envelope as { ok?: unknown } | null;
  if (!env || env.ok !== true) return null;
  return res.envelope;
}

interface ScaleReport {
  scale: number;
  seedWritesOk: boolean;
  lifecycle: Record<string, unknown>;
  retrieval: Record<string, unknown>;
  indexFallback: Record<string, unknown>;
  queue: Record<string, unknown>;
  latency: Record<string, unknown>;
  storage: Record<string, unknown>;
  resources: Record<string, unknown>;
}

function runScale(cliPath: string, scale: number): { report: ScaleReport; failed: boolean; invariants: string[] } {
  const invariants: string[] = [];
  let failed = false;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `ops-eval-s${scale}-`));
  const configPath = path.join(dir, "memory.config.json");
  const allLatencies: number[] = [];
  const successLatencies: number[] = [];
  let cliCalls = 0;
  const wall0 = monotonicMs();
  const fillerIds: string[] = [];
  let seedWritesOk = true;

  const call = (req: Record<string, unknown>): CliResult => {
    const r = invokeCli(cliPath, configPath, req);
    cliCalls += 1;
    allLatencies.push(r.elapsedMs);
    if (r.envelopeValid && r.status === 0 && (r.envelope as { ok?: unknown })["ok"] === true) {
      successLatencies.push(r.elapsedMs);
    }
    return r;
  };

  // Seed writes are idempotencyKey'd ops, so per the CLI deadline contract
  // ("a TIMEOUT must never be read as rolled back; callers replay with the
  // same idempotency key + params") ONLY a commit-unknown outcome is replayed
  // ONCE with the byte-identical request: a commit that did land returns the
  // stored envelope with deduplicated:true, an uncommitted one re-executes.
  // Commit-unknown means the harness killed the child (invalidReason
  // timeout/spawn-failure) or the CLI itself answered its cliMs deadline with
  // a TIMEOUT envelope. Any other non-ok code (NOT_FOUND, VALIDATION, ...) is
  // a definitive answer, never retried. A second non-ok still fails the seed
  // honestly. Latency of both spawns is recorded (each is a real CLI call).
  const commitUnknown = (r: CliResult): boolean => {
    if (r.invalidReason === "timeout" || r.invalidReason === "spawn-failure") return true;
    if (r.envelopeValid && r.envelope !== null) {
      const code = (r.envelope as { code?: unknown })["code"];
      if (code === "TIMEOUT") return true;
    }
    return false;
  };
  const callSeed = (req: Record<string, unknown>): CliResult => {
    const first = call(req);
    if (okEnvelope(first) !== null || !commitUnknown(first)) return first;
    const second = call(req);
    return okEnvelope(second) !== null ? second : first;
  };

  /** Fixed-text code/message for a non-ok CliResult (no config/param echo). */
  const failReason = (r: CliResult): string => {
    if (r.invalidReason !== null) return r.invalidReason;
    if (r.status !== 0) return `exit-${String(r.status)}`;
    const env = (r.envelope ?? {}) as { code?: unknown; message?: unknown };
    const code = typeof env["code"] === "string" ? env["code"] : "NOT-OK";
    const msg = typeof env["message"] === "string" && env["message"].length > 0
      ? ` ${env["message"].slice(0, 120)}`
      : "";
    return `envelope-${code}${msg}`;
  };

  const recallIds = (
    query: string,
    limit: number = OPS_K,
  ): { ids: string[]; recallId: string | null; ok: boolean; code: string } => {
    const res = call({ v: 1, op: "record.recall", params: { query, scope: OPS_SCOPE, limit, runId: OPS_RUN } });
    if (!res.envelopeValid || res.status !== 0) {
      return { ids: [], recallId: null, ok: false, code: res.invalidReason ?? "INVALID" };
    }
    const env = res.envelope as { ok: boolean; code: string; data?: unknown };
    if (!env.ok) return { ids: [], recallId: null, ok: false, code: env.code };
    const checked = validateRecallData(env.data);
    if (!checked.ok) {
      invariants.push(`s${scale} recall data contract: ${checked.reason}`);
      failed = true;
      return { ids: [], recallId: null, ok: false, code: "INVALID" };
    }
    const v = validateReturnedIds(checked.items.map((i) => i.id), limit);
    if (!v.ok) {
      invariants.push(`s${scale} recall id contract: ${v.reason}`);
      failed = true;
      return { ids: [], recallId: null, ok: false, code: "INVALID" };
    }
    return { ids: checked.items.map((i) => i.id), recallId: checked.recallId, ok: true, code: "OK" };
  };

  let scaleReport: ScaleReport | null = null;
  try {
    fs.writeFileSync(configPath, JSON.stringify(expectedConfig(dir)), "utf8");
    const dbPath = path.join(dir, "ops.db");

    // Seed fillers: event.append + record.remember each, dependency order.
    for (let i = 0; i < scale; i++) {
      const evId = `ops-s${scale}-e${i}`;
      const ev = callSeed({
        v: 1, op: "event.append", idempotencyKey: `ops-s${scale}-ev-${i}`,
        params: {
          eventId: evId, sessionId: `ops-s${scale}`, turnId: `t${i}`,
          body: rawBodyFor(`ledger note ${i} for scale ${scale}`),
          provenance: provenanceFor(evId), scope: OPS_SCOPE, runId: OPS_RUN,
        },
      });
      if (!okEnvelope(ev)) {
        invariants.push(`s${scale} seed event.append ${i} not ok: ${failReason(ev)}`);
        seedWritesOk = false;
        break;
      }
      const rem = callSeed({
        v: 1, op: "record.remember", idempotencyKey: `ops-s${scale}-rem-${i}`,
        params: {
          body: fillerBody(scale, i), kind: "user_fact",
          provenance: provenanceFor(evId), scope: OPS_SCOPE, tags: [],
          links: [], sourceRefs: [evId], runId: OPS_RUN,
        },
      });
      const env = okEnvelope(rem);
      const id = (env?.["data"] as { record?: { id?: unknown } } | undefined)?.record?.id;
      if (!env || typeof id !== "string") {
        invariants.push(`s${scale} seed record.remember ${i} not ok: ${failReason(rem)}`);
        seedWritesOk = false;
        break;
      }
      fillerIds.push(id);
    }

    // --- Correction lifecycle: dedicated target with a unique gate code.
    let correction: Record<string, unknown> = { status: "not-run" };
    let oldId = "";
    let newId = "";
    if (seedWritesOk) {
      const evId = `ops-s${scale}-corr-ev`;
      const oldBody = `Ops correction ledger s${scale}: the side gate code is 4410.`;
      const newBody = `Ops correction ledger s${scale}: the side gate code is 9921.`;
      const evOk = okEnvelope(call({
        v: 1, op: "event.append", idempotencyKey: `ops-s${scale}-corr-ev`,
        params: {
          eventId: evId, sessionId: `ops-s${scale}`, turnId: "tcorr",
          body: rawBodyFor("the side gate code changed"), provenance: provenanceFor(evId),
          scope: OPS_SCOPE, runId: OPS_RUN,
        },
      }));
      const remEnv = okEnvelope(call({
        v: 1, op: "record.remember", idempotencyKey: `ops-s${scale}-corr-rem`,
        params: {
          body: oldBody, kind: "user_fact", provenance: provenanceFor(evId),
          scope: OPS_SCOPE, tags: [], links: [], sourceRefs: [evId], runId: OPS_RUN,
        },
      }));
      oldId = (remEnv?.["data"] as { record?: { id?: unknown } } | undefined)?.record?.id as string ?? "";
      if (!evOk || !remEnv || !oldId) {
        correction = { status: "setup-failed" };
        failed = true;
        invariants.push(`s${scale} correction setup failed`);
      } else {
        const corrEnv = okEnvelope(call({
          v: 1, op: "record.correct", idempotencyKey: `ops-s${scale}-corr-fix`,
          params: {
            recordId: oldId, body: newBody, kind: "correction",
            provenance: provenanceFor(evId), scope: OPS_SCOPE,
            links: [], sourceRefs: [evId], runId: OPS_RUN,
          },
        }));
        newId = (corrEnv?.["data"] as { record?: { id?: unknown } } | undefined)?.record?.id as string ?? "";
        const getOld = call({ v: 1, op: "record.get", params: { id: oldId, scope: OPS_SCOPE } });
        const getNew = call({ v: 1, op: "record.get", params: { id: newId, scope: OPS_SCOPE } });
        const oldStatus = ((getOld.envelope as { data?: { record?: { status?: unknown } } } | null)?.data?.record?.status) ?? null;
        const newRec = ((getNew.envelope as { data?: { record?: { status?: unknown; supersedes?: unknown } } } | null)?.data?.record) ?? null;
        const hitNew = recallIds(`side gate code 9921 ledger s${scale}`);
        const hitOld = recallIds(`side gate code 4410 ledger s${scale}`);
        const excludesSuperseded = !hitOld.ids.includes(oldId) && !hitNew.ids.includes(oldId);
        const usesLatest = hitNew.ids.includes(newId);
        correction = {
          status: "ok",
          oldStatus, newStatus: newRec?.status ?? null,
          supersedesMatchesOld: (newRec?.supersedes ?? null) === oldId,
          recallNewHitsLatest: usesLatest,
          recallExcludesSuperseded: excludesSuperseded,
        };
        if (oldStatus !== "superseded" || newRec?.status !== "active" || (newRec?.supersedes ?? null) !== oldId || !excludesSuperseded || !usesLatest) {
          failed = true;
          invariants.push(`s${scale} correction lifecycle violated: ${JSON.stringify(correction)}`);
        }
      }
    }

    // --- Retire lifecycle: excluded from recall, found by search, restored.
    let retirement: Record<string, unknown> = { status: "not-run" };
    let retireId = "";
    if (seedWritesOk) {
      const evId = `ops-s${scale}-ret-ev`;
      const body = `Ops retire ledger s${scale}: zebra crossing duty roster.`;
      const evOk = okEnvelope(call({
        v: 1, op: "event.append", idempotencyKey: `ops-s${scale}-ret-ev`,
        params: {
          eventId: evId, sessionId: `ops-s${scale}`, turnId: "tret",
          body: rawBodyFor("zebra roster note"), provenance: provenanceFor(evId),
          scope: OPS_SCOPE, runId: OPS_RUN,
        },
      }));
      const remEnv = okEnvelope(call({
        v: 1, op: "record.remember", idempotencyKey: `ops-s${scale}-ret-rem`,
        params: {
          body, kind: "user_fact", provenance: provenanceFor(evId),
          scope: OPS_SCOPE, tags: [], links: [], sourceRefs: [evId], runId: OPS_RUN,
        },
      }));
      retireId = (remEnv?.["data"] as { record?: { id?: unknown } } | undefined)?.record?.id as string ?? "";
      if (!evOk || !remEnv || !retireId) {
        retirement = { status: "setup-failed" };
        failed = true;
        invariants.push(`s${scale} retire setup failed`);
      } else {
        const query = `zebra crossing duty roster ledger s${scale}`;
        const before = recallIds(query);
        const retEnv = okEnvelope(call({
          v: 1, op: "record.retire", idempotencyKey: `ops-s${scale}-ret-1`,
          params: { id: retireId, scope: OPS_SCOPE, reasonCode: "OUTDATED" },
        }));
        const afterRetire = recallIds(query);
        // record.search must create no exposure: snapshot the retired
        // record's heat immediately before and after the search call.
        const heatBeforeSearch = heatViaPath(dbPath, retireId);
        const seaRes = call({ v: 1, op: "record.search", params: { query, scope: OPS_SCOPE, limit: OPS_K } });
        const heatAfterSearch = heatViaPath(dbPath, retireId);
        const searchHeatUnchanged = heatBeforeSearch >= 0 && heatBeforeSearch === heatAfterSearch;
        // record.search returns data {searchId, items} with a 6-field item
        // shape (recall's 5 fields plus status); it creates no exposure, so
        // the recall validators do not apply. Validate ids directly.
        let searchIds: string[] = [];
        let searchOk = false;
        let searchStatus: string | null = null;
        if (seaRes.envelopeValid && seaRes.status === 0 && (seaRes.envelope as { ok?: unknown })["ok"] === true) {
          const data = (seaRes.envelope as { data?: unknown }).data;
          if (typeof data === "object" && data !== null && !Array.isArray(data)) {
            const rec = data as Record<string, unknown>;
            if (typeof rec["searchId"] === "string" && Array.isArray(rec["items"])) {
              const items = rec["items"] as Array<{ id?: unknown; status?: unknown }>;
              const ids = items.map((i) => i.id);
              const v = validateReturnedIds(ids, OPS_K);
              if (v.ok) {
                searchIds = [...v.ids];
                searchOk = true;
                const hit = items.find((i) => i.id === retireId);
                searchStatus = typeof hit?.status === "string" ? (hit.status as string) : null;
              } else {
                invariants.push(`s${scale} search id contract: ${v.reason}`);
                failed = true;
              }
            }
          }
        }
        const reaEnv = okEnvelope(call({
          v: 1, op: "record.reactivate", idempotencyKey: `ops-s${scale}-rea-1`,
          params: { id: retireId, scope: OPS_SCOPE, reasonCode: "STILL_USEFUL" },
        }));
        const afterReactivate = recallIds(query);
        retirement = {
          status: "ok",
          recallBeforeIncludes: before.ids.includes(retireId),
          recallExcludesRetired: !afterRetire.ids.includes(retireId),
          searchRecoversRetired: searchOk && searchIds.includes(retireId) && searchStatus === "retired",
          searchHeatUnchanged,
          reactivationRestoresRecall: afterReactivate.ids.includes(retireId),
        };
        if (!retEnv || !reaEnv || afterRetire.ids.includes(retireId) || !(searchOk && searchIds.includes(retireId) && searchStatus === "retired") || !afterReactivate.ids.includes(retireId) || !searchHeatUnchanged) {
          failed = true;
          invariants.push(`s${scale} retirement lifecycle violated: ${JSON.stringify(retirement)}`);
        }
      }
    }

    // --- Feedback heat: validated selected citations only.
    let feedbackProof: Record<string, unknown> = { status: "not-run" };
    if (seedWritesOk && fillerIds.length > 0) {
      const probeIdx = 0;
      const probe = recallIds(fillerQuery(scale, probeIdx));
      const gold = fillerIds[probeIdx] as string;
      if (!probe.ok || !probe.recallId || !probe.ids.includes(gold)) {
        feedbackProof = { status: "no-eligible-exposure", recallOk: probe.ok, exposedGold: probe.ids.includes(gold) };
      } else {
        const others = probe.ids.filter((id) => id !== gold);
        // Heat snapshots use short-lived connections (heatViaPath) that are
        // fully closed BEFORE any CLI child is spawned: the evaluator never
        // holds a second DB handle open across a CLI process (Windows keeps
        // file handles alive until close, and a lingering -shm/-wal sharing
        // handle must never race the child's open or its close checkpoint).
        const heatOfAll = (ids: string[]): Map<string, number> =>
          new Map<string, number>(ids.map((id) => [id, heatViaPath(dbPath, id)]));
        {
          const heatBefore = heatOfAll([gold, ...others]);
          const fb = call({
            v: 1, op: "record.feedback", idempotencyKey: `ops-s${scale}-fb-1`,
            params: { recallId: probe.recallId, recordIds: [gold], scope: OPS_SCOPE, runId: OPS_RUN },
          });
          const fbOk = okEnvelope(fb) !== null;
          const heatAfter = heatOfAll([gold, ...others]);
          const selectedRose = (heatAfter.get(gold) ?? -2) === (heatBefore.get(gold) ?? -1) + 1;
          const othersUnchanged = others.every((id) => heatAfter.get(id) === heatBefore.get(id));
          // Invalid: outside-exposure id must be rejected whole with no heat change.
          const fbBad = call({
            v: 1, op: "record.feedback", idempotencyKey: `ops-s${scale}-fb-bad`,
            params: { recallId: probe.recallId, recordIds: [gold, "ops-nonexistent-id-000"], scope: OPS_SCOPE, runId: OPS_RUN },
          });
          const badRejected = fbBad.envelopeValid && (fbBad.envelope as { ok?: unknown })["ok"] === false
            && (fbBad.envelope as { code?: unknown })["code"] === "NOT_FOUND";
          const heatAfterBad = heatOfAll([gold, ...others]);
          const badUnchanged = [gold, ...others].every((id) => heatAfterBad.get(id) === heatAfter.get(id));
          feedbackProof = {
            status: "ok",
            validFeedbackAccepted: fbOk,
            selectedHeatPlusOne: selectedRose,
            unselectedUnchanged: othersUnchanged,
            invalidRejectedWhole: badRejected,
            invalidHeatUnchanged: badUnchanged,
          };
          if (!fbOk || !selectedRose || !othersUnchanged || !badRejected || !badUnchanged) {
            failed = true;
            invariants.push(`s${scale} feedback heat violated: ${JSON.stringify(feedbackProof)}`);
          }
        }
      }
    }

    // --- Retrieval probes: conversation-shaped lexical queries, 2 rounds.
    const positiveEntries: Array<{ failed: boolean; pAt3: number; recall: number; rr: number }> = [];
    const negativeOutcomes: NegativeOutcome[] = [];
    const attempts: Array<Record<string, unknown>> = [];
    const stability = new Map<string, string[][]>();
    let normalPlanned = 0;
    let normalExecuted = 0;
    let normalFailures = 0;
    const activeSet = new Set<string>([...fillerIds, newId].filter((s) => s.length > 0));
    if (retireId.length > 0) activeSet.add(retireId); // reactivated by now
    if (oldId.length > 0) activeSet.delete(oldId);
    if (seedWritesOk) {
      const idxs = [0, Math.floor(scale / 3), Math.floor((2 * scale) / 3), scale - 1].filter((v, i, a) => a.indexOf(v) === i);
      const positives = idxs.map((i) => ({ qid: `ops-s${scale}-p${i}`, query: fillerQuery(scale, i), gold: [fillerIds[i] as string] }));
      const negatives = [
        { qid: `ops-s${scale}-n0`, query: `鑿鸞鬱` },
        { qid: `ops-s${scale}-n1`, query: `xyzzy phantom ghost` },
      ];
      for (let round = 0; round < 2; round++) {
        for (const p of positives) {
          normalPlanned += 0; // counted below honestly
          const r = recallIds(p.query);
          normalExecuted += 1;
          const key = p.qid;
          if (!stability.has(key)) stability.set(key, []);
          if (!r.ok) {
            normalFailures += 1;
            stability.get(key)?.push([]);
            attempts.push({ queryId: p.qid, round, ok: false, code: r.code, returnedIds: [], goldIds: p.gold, hits: 0, kind: "positive" });
            positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            continue;
          }
          const bad = findInvariantViolations(r.ids, activeSet);
          if (bad.length > 0) {
            normalFailures += 1;
            failed = true;
            invariants.push(`s${scale} ${p.qid}/r${round} invariant: ${JSON.stringify(bad)}`);
            stability.get(key)?.push([...r.ids]);
            attempts.push({ queryId: p.qid, round, ok: true, code: "OK", returnedIds: r.ids, goldIds: p.gold, hits: 0, kind: "positive", invalid: true });
            positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            continue;
          }
          stability.get(key)?.push([...r.ids]);
          const s = scorePositive(r.ids, p.gold, OPS_K);
          attempts.push({ queryId: p.qid, round, ok: true, code: "OK", returnedIds: r.ids, goldIds: p.gold, hits: s.hits, pAt3: s.pAt3, recall: s.recall, rr: s.rr, firstRank: s.firstRank, kind: "positive" });
          positiveEntries.push({ failed: false, pAt3: s.pAt3, recall: s.recall, rr: s.rr });
        }
        for (const n of negatives) {
          const r = recallIds(n.query);
          normalExecuted += 1;
          const key = n.qid;
          if (!stability.has(key)) stability.set(key, []);
          if (!r.ok) {
            normalFailures += 1;
            stability.get(key)?.push([]);
            attempts.push({ queryId: n.qid, round, ok: false, code: r.code, returnedIds: [], kind: "negative" });
            negativeOutcomes.push("failure");
            continue;
          }
          const bad = findInvariantViolations(r.ids, activeSet);
          if (bad.length > 0) {
            normalFailures += 1;
            failed = true;
            invariants.push(`s${scale} ${n.qid}/r${round} invariant: ${JSON.stringify(bad)}`);
            stability.get(key)?.push([...r.ids]);
            attempts.push({ queryId: n.qid, round, ok: true, code: "OK", returnedIds: r.ids, kind: "negative", invalid: true });
            negativeOutcomes.push("failure");
            continue;
          }
          stability.get(key)?.push([...r.ids]);
          const cls = classifyNegative({ transportFailed: false, ok: true, itemsCount: r.ids.length });
          attempts.push({ queryId: n.qid, round, ok: true, code: "OK", returnedIds: r.ids, kind: "negative", outcome: cls.outcome });
          negativeOutcomes.push(cls.outcome);
        }
      }
      normalPlanned = (positives.length + negatives.length) * 2;
    }
    const posAgg = aggregatePositive(positiveEntries);
    const negFrac = negativeFractions(negativeOutcomes);
    const stabilityObj: Record<string, { rounds: string[][]; stable: boolean }> = {};
    for (const [k, v] of stability) {
      stabilityObj[k] = { rounds: v, stable: v.length === 2 && JSON.stringify(v[0]) === JSON.stringify(v[1]) };
    }

    // --- Derived-index fallback (canonical bodyNorm covers derived loss).
    //
    // Honest scope (PR15 review finding 6): a fully EMPTY fts_notes/fts_raw
    // table is repaired by the CLI startup hook (maybeRebuildDerivedIndexes
    // rebuilds when counts are 0 or below the canonical row count), so an
    // empty-table recall cannot prove the bodyNorm fallback. Instead this
    // probe damages the target record's fts_notes row BODY while PRESERVING
    // the row count — damage the count-based startup repair does not detect —
    // and verifies via the DB after recall that the row was still corrupted
    // when recall ran (recall never repairs derived rows). A recall hit on
    // the target then proves the canonical bodyNorm fallback for real.
    //
    // Since the canonical substitute-rank fix, a canonical-only hit with a
    // damaged derived entry receives the substitute lexical signal it would
    // have had with a healthy index, so it is ASSERTED at small top-k
    // (conversation-shaped query, limit OPS_K) — no longer merely
    // informational (the flat +1 displacement bound no longer applies).
    let indexFallback: Record<string, unknown> = { status: "not-run" };
    if (seedWritesOk && fillerIds.length > 0) {
      const target = fillerIds[0] as string;
      const q = fillerQuery(scale, 0);
      // Single anchor-term recall at a wider limit: the target is the ONLY
      // record whose bodyNorm contains the whole anchor query, so any hit
      // proves the canonical bodyNorm fallback.
      const qAnchor = `anchortoken${scale}x0`;
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbPath);
        try { db.exec(`DELETE FROM char_bigrams WHERE kind = 'note' AND id = '${target.replace(/'/g, "''")}'`); } catch { /* ignore */ }
        try { db.prepare(`UPDATE fts_notes SET body = 'ops corrupted derived row' WHERE recordId = ?`).run(target); } catch { /* ignore */ }
        db.close(); db = null;
        const partial = recallIds(q);
        const fallbackHit = recallIds(qAnchor, 10);
        // Post-recall DB verification: the corrupted derived row must still
        // be corrupted (no startup repair and no recall-side healing), so
        // the FTS leg genuinely missed the target when recall ran.
        let stillCorrupted = false;
        let ftsRowCount = -1;
        try {
          db = new DatabaseSync(dbPath);
          const row = db.prepare(`SELECT body FROM fts_notes WHERE recordId = ?`).get(target) as { body?: unknown } | undefined;
          stillCorrupted = typeof row?.body === "string" && row.body === "ops corrupted derived row";
          const cnt = db.prepare(`SELECT COUNT(*) AS n FROM fts_notes`).get() as { n?: number } | undefined;
          ftsRowCount = typeof cnt?.n === "number" ? cnt.n : -1;
        } catch { /* keep defaults */ }
        indexFallback = {
          status: "ok",
          partialBigramDropStillHits: partial.ids.includes(target),
          corruptFtsRowStillHits: fallbackHit.ids.includes(target),
          ftsRowStillCorruptedAfterRecall: stillCorrupted,
          ftsRowCount,
          note: "full-empty FTS tables are startup-repaired (maybeRebuildDerivedIndexes); the proven fallback is per-row derived damage the count-based repair does not detect, verified via the DB after recall. The conversation-shaped query at limit OPS_K (3) asserts the target within top 3: with the canonical substitute-rank fix the damaged canonical hit receives the lexical signal a healthy index would have given it, so it is no longer displaced by char-bigram-overlap competitors. The unique-anchor query at limit 10 remains asserted as the pure canonical-fallback proof",
          conversationShapedQueryStillHits: partial.ids.includes(target),
        };
        if (!fallbackHit.ids.includes(target) || !partial.ids.includes(target) || !stillCorrupted) {
          failed = true;
          invariants.push(`s${scale} index fallback missed: ${JSON.stringify(indexFallback)}`);
        }
      } catch {
        failed = true;
        invariants.push(`s${scale} index fallback harness error`);
        indexFallback = { status: "harness-error" };
      } finally {
        try { (db as DatabaseSync | null)?.close(); } catch { /* ignore */ }
      }
    }

    // --- Queue cap (configured OPS_QUEUE_MAX; canonical writes unaffected).
    let queue: Record<string, unknown> = { status: "not-run" };
    if (seedWritesOk) {
      let db: DatabaseSync | null = null;
      try {
        db = new DatabaseSync(dbPath);
        const open = openReviewCount(db);
        const total = recordCount(db);
        db.close(); db = null;
        queue = {
          status: "ok",
          queueMax: OPS_QUEUE_MAX,
          openReviews: open,
          bounded: open >= 0 && open <= OPS_QUEUE_MAX,
          canonicalRecords: total,
          writesOk: seedWritesOk,
        };
        if (!(open >= 0 && open <= OPS_QUEUE_MAX)) {
          failed = true;
          invariants.push(`s${scale} queue cap exceeded: open=${open} max=${OPS_QUEUE_MAX}`);
        }
      } catch {
        failed = true;
        invariants.push(`s${scale} queue read harness error`);
        queue = { status: "harness-error" };
      } finally {
        try { (db as DatabaseSync | null)?.close(); } catch { /* ignore */ }
      }
    }

    const latAll = latencyStats(allLatencies);
    const latSuccess = latencyStats(successLatencies);
    let dbBytes = -1;
    try { dbBytes = fs.statSync(dbPath).size; } catch { /* ignore */ }
    let vaultFiles = 0;
    let vaultNote = "vault entries observed at scale end";
    try {
      vaultFiles = fs.readdirSync(path.join(dir, "vault")).length;
    } catch {
      // Vault projection is queued best-effort post-commit; the directory may
      // honestly not exist yet at observation time. Report 0, never invent.
      vaultFiles = 0;
      vaultNote = "vault dir absent at observation (projection queued best-effort)";
    }
    const mem = process.memoryUsage();
    const wallMs = elapsedMsSince(wall0, monotonicMs());
    scaleReport = {
      scale,
      seedWritesOk,
      lifecycle: { correction, retirement, feedback: feedbackProof },
      retrieval: {
        k: OPS_K,
        rounds: 2,
        denominators: { plannedNormal: normalPlanned, executedNormal: normalExecuted, normalFailures },
        positive: posAgg,
        negative: negFrac,
        stability: stabilityObj,
      },
      indexFallback,
      queue,
      latency: { all: latAll, success: latSuccess, cliCalls },
      storage: { dbBytes, vaultFiles, vaultNote, records: fillerIds.length + (newId ? 2 : oldId ? 1 : 0) + (retireId ? 1 : 0) },
      resources: {
        wallMs,
        evaluatorRssBytes: mem.rss,
        evaluatorHeapUsedBytes: mem.heapUsed,
        note: "rss/heap are the evaluator harness process, honestly labelled; CLI latency is measured per real CLI spawn",
      },
    };
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    return { report: scaleReport, failed: failed || !seedWritesOk, invariants };
  } catch (e) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
    const mem = process.memoryUsage();
    const wallMs = elapsedMsSince(wall0, monotonicMs());
    scaleReport = {
      scale,
      seedWritesOk: false,
      lifecycle: { error: String(e) },
      retrieval: { error: String(e) },
      indexFallback: { status: "not-run" },
      queue: { status: "not-run" },
      latency: { all: latencyStats(allLatencies), success: latencyStats(successLatencies), cliCalls },
      storage: { dbBytes: -1, vaultFiles: -1, records: fillerIds.length },
      resources: { wallMs, evaluatorRssBytes: mem.rss, evaluatorHeapUsedBytes: mem.heapUsed, note: "scale harness threw" },
    };
    return { report: scaleReport, failed: true, invariants: [...invariants, `s${scale} harness: ${String(e)}`] };
  }
}

function main(): void {
  const args = process.argv.slice(2);
  let modelDir: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--model-dir" && i + 1 < args.length) modelDir = args[++i] as string;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: evaluate-operations [--model-dir <dir>]\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }
  const runUTC = new Date().toISOString();
  const cliPath = path.resolve(__dirname, "..", "src", "cli.js");
  const scales: ScaleReport[] = [];
  const invariants: string[] = [];
  let failed = false;
  for (const s of OPS_SCALES) {
    const r = runScale(cliPath, s as number);
    scales.push(r.report);
    invariants.push(...r.invariants);
    if (r.failed) failed = true;
  }
  // Optional model leg: opt-in only, never downloaded, never required.
  let modelLeg: Record<string, unknown>;
  if (modelDir === null) {
    modelLeg = { attempted: false, reason: "no --model-dir given; baseline runs offline without downloads" };
  } else {
    const abs = path.resolve(modelDir);
    const present = fs.existsSync(abs);
    modelLeg = present
      ? { attempted: false, reason: "model leg not wired to assertions; lexical lifecycle stands alone", modelDir: abs }
      : { attempted: false, reason: "model dir absent; no download attempted", modelDir: abs };
  }
  const report: Record<string, unknown> = {
    fixture: OPS_FIXTURE_VERSION,
    schema: OPS_SCHEMA_VERSION,
    k: OPS_K,
    scales: OPS_SCALES,
    syntheticOnly: true,
    mode: {
      name: "operational-lifecycle-scale",
      model: null,
      semanticClaim: false,
      acceptanceThresholds: null,
    },
    runtime: { node: process.version, platform: process.platform, arch: process.arch, runUTC },
    scaleReports: scales,
    modelLeg,
    invariants: { failures: invariants },
    setup: failed ? { status: "failure", quality: "UNAVAILABLE" } : { status: "ok" },
    quality: failed ? "UNAVAILABLE" : "available",
    sourceRevision: null,
    sourceRevisionReason: "not resolved to avoid inventing HEAD",
  };
  process.stdout.write(JSON.stringify(report) + "\n");
  process.exit(failed || invariants.length > 0 ? 1 : 0);
}

main();
