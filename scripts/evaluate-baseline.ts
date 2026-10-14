/**
 * R13 M1 synthetic baseline evaluator (complete, usable, M1 lexical+graph only).
 * - Own mkdtemp config from fixed limits, never user config.
 * - All 8 ops via real compiled CLI subprocess (boring serial spawnSync).
 * - Fixed 12 queries x 3 rounds = 36 recalls, honest denominators.
 * - No quality threshold; low quality alone exits 0.
 * - Corrupt probe: ONE scenario / TWO real CLI invocations, excluded.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { queryMemory } from "../src/fake-adapter.js";
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
import {
  BASELINE_FIXTURE_VERSION,
  BASELINE_K,
  BASELINE_NEW_EVENT,
  BASELINE_OBSERVED_AT,
  BASELINE_ORPHAN_EVENT,
  BASELINE_QUERIES,
  BASELINE_REPETITIONS,
  BASELINE_RUN_QUALITY,
  BASELINE_RUN_SEED,
  BASELINE_SCHEMA_VERSION,
  BASELINE_SEEDS,
  BASELINE_SESSION,
  SCOPE_P,
  SCOPE_W,
  provenanceFor,
  rawBodyFor,
} from "./fixtures/baseline-v1.js";

const CLI_TIMEOUT_MS = 6000;
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
    dbPath: path.join(dir, "baseline.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE_P, SCOPE_W],
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
  };
}

function verifyConfig(actual: unknown, dir: string): boolean {
  const exp = expectedConfig(dir);
  try {
    return JSON.stringify(actual) === JSON.stringify(exp);
  } catch {
    return false;
  }
}

interface AttemptReport {
  queryId: string;
  round: number;
  ok: boolean;
  code: string;
  returnedIds: string[];
  snippets: string[];
  tags: string[][];
  recallId: string | null;
  goldIds: string[];
  hits: number;
  pAt3: number | null;
  recall: number | null;
  rr: number | null;
  firstRank: number | null;
  failed: boolean;
  invalid: boolean;
  invalidReason: string | null;
  invariantViolation: string[];
  latencyMs: number;
  kind: string;
}

function main(): void {
  const runUTC = new Date().toISOString();
  const repoRoot = path.resolve(__dirname, "..", "..");
  const cliPath = path.resolve(__dirname, "..", "src", "cli.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "r13-baseline-"));
  const configPath = path.join(dir, "memory.config.json");
  let setupFailure: string | null = null;
  const aliasToId = new Map<string, string>();
  const attempts: AttemptReport[] = [];
  const negativeOutcomes: NegativeOutcome[] = [];
  const positiveEntries: Array<{ failed: boolean; pAt3: number; recall: number; rr: number }> = [];
  const allLatencies: number[] = [];
  const successLatencies: number[] = [];
  const failureLatencies: number[] = [];
  let normalPlanned = BASELINE_QUERIES.length * BASELINE_REPETITIONS;
  let normalExecuted = 0;
  let normalFailures = 0;
  const invariantFailures: string[] = [];
  const stabilityByQuery = new Map<string, string[][]>();
  let feedback: Record<string, unknown> = { status: "unavailable", reason: "no eligible exposed relevant result" };
  let feedbackInvocations = 0;

  const cleanup = (): void => {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
  };

  let exitCode = 0;
  try {
    const cfg = expectedConfig(dir);
    fs.writeFileSync(configPath, JSON.stringify(cfg), "utf8");
    const readBack: unknown = JSON.parse(fs.readFileSync(configPath, "utf8"));
    if (!verifyConfig(readBack, dir)) {
      setupFailure = "config verification mismatch";
    }

    if (setupFailure === null) {
      // Seed 10 base events+remembers in dependency order.
      const ordered = [...BASELINE_SEEDS];
      for (const s of ordered) {
        const evReq = {
          v: 1,
          op: "event.append",
          idempotencyKey: `b1-ev-${s.alias}`,
          params: {
            eventId: s.eventId,
            sessionId: BASELINE_SESSION,
            turnId: s.turnId,
            body: rawBodyFor(s.utterance),
            provenance: provenanceFor(s.eventId),
            scope: s.scope,
            runId: BASELINE_RUN_SEED,
          },
        };
        const ev = invokeCli(cliPath, configPath, evReq);
        if (!ev.envelopeValid || (ev.envelope as { ok?: unknown })["ok"] !== true) {
          setupFailure = `event.append failed for ${s.alias}: ${ev.invalidReason ?? String((ev.envelope as { code?: unknown } | null)?.code ?? ev.status)}`;
          break;
        }
        const links = s.linkAliases.map((a) => aliasToId.get(a)).filter((v): v is string => typeof v === "string");
        if (links.length !== s.linkAliases.length) {
          setupFailure = `link alias unresolved for ${s.alias}`;
          break;
        }
        const remReq = {
          v: 1,
          op: "record.remember",
          idempotencyKey: `b1-rem-${s.alias}`,
          params: {
            body: s.body,
            kind: "user_fact",
            provenance: provenanceFor(s.eventId),
            scope: s.scope,
            tags: s.tags,
            links,
            sourceRefs: [s.eventId],
            runId: BASELINE_RUN_SEED,
          },
        };
        const rem = invokeCli(cliPath, configPath, remReq);
        if (!rem.envelopeValid || (rem.envelope as { ok?: unknown })["ok"] !== true) {
          setupFailure = `record.remember failed for ${s.alias}: ${rem.invalidReason ?? String((rem.envelope as { code?: unknown } | null)?.code ?? rem.status)}`;
          break;
        }
        const data = (rem.envelope as { data?: { record?: { id?: unknown } } }).data;
        const id = data?.record?.id;
        if (typeof id !== "string" || id.length === 0) {
          setupFailure = `missing record id for ${s.alias}`;
          break;
        }
        aliasToId.set(s.alias, id);
      }
    }

    if (setupFailure === null) {
      // b1-new event + correct old -> new
      const oldId = aliasToId.get("old");
      if (!oldId) {
        setupFailure = "old alias missing for correction";
      } else {
        const evNew = invokeCli(cliPath, configPath, {
          v: 1,
          op: "event.append",
          idempotencyKey: "b1-ev-new",
          params: {
            eventId: BASELINE_NEW_EVENT.eventId,
            sessionId: BASELINE_SESSION,
            turnId: BASELINE_NEW_EVENT.turnId,
            body: rawBodyFor(BASELINE_NEW_EVENT.utterance),
            provenance: provenanceFor(BASELINE_NEW_EVENT.eventId),
            scope: BASELINE_NEW_EVENT.scope,
            runId: BASELINE_RUN_SEED,
          },
        });
        if (!evNew.envelopeValid || (evNew.envelope as { ok?: unknown })["ok"] !== true) {
          setupFailure = `b1-new event.append failed: ${evNew.invalidReason ?? "not-ok"}`;
        } else {
          const corr = invokeCli(cliPath, configPath, {
            v: 1,
            op: "record.correct",
            idempotencyKey: "b1-corr-old",
            params: {
              recordId: oldId,
              body: BASELINE_NEW_EVENT.correctBody,
              kind: "correction",
              provenance: provenanceFor(BASELINE_NEW_EVENT.eventId),
              scope: SCOPE_P,
              links: [],
              sourceRefs: [BASELINE_NEW_EVENT.eventId],
              runId: BASELINE_RUN_SEED,
            },
          });
          if (!corr.envelopeValid || (corr.envelope as { ok?: unknown })["ok"] !== true) {
            setupFailure = `record.correct failed: ${corr.invalidReason ?? String((corr.envelope as { code?: unknown } | null)?.code)}`;
          } else {
            const data = (corr.envelope as { data?: { record?: { id?: unknown } } }).data;
            const newId = data?.record?.id;
            if (typeof newId !== "string") setupFailure = "missing corrected id";
            else aliasToId.set("new", newId);
          }
        }
      }
    }

    if (setupFailure === null) {
      const retiredId = aliasToId.get("retired");
      if (!retiredId) setupFailure = "retired alias missing";
      else {
        const arc = invokeCli(cliPath, configPath, {
          v: 1,
          op: "record.archive",
          idempotencyKey: "b1-arc-retired",
          params: { id: retiredId, scope: SCOPE_P, reasonCode: "OBSOLETE" },
        });
        if (!arc.envelopeValid || (arc.envelope as { ok?: unknown })["ok"] !== true) {
          setupFailure = `record.archive failed: ${arc.invalidReason ?? "not-ok"}`;
        }
      }
    }

    if (setupFailure === null) {
      const orph = invokeCli(cliPath, configPath, {
        v: 1,
        op: "event.append",
        idempotencyKey: "b1-ev-orphan",
        params: {
          eventId: BASELINE_ORPHAN_EVENT.eventId,
          sessionId: BASELINE_SESSION,
          turnId: BASELINE_ORPHAN_EVENT.turnId,
          body: rawBodyFor(BASELINE_ORPHAN_EVENT.utterance),
          provenance: provenanceFor(BASELINE_ORPHAN_EVENT.eventId),
          scope: BASELINE_ORPHAN_EVENT.scope,
          runId: BASELINE_RUN_SEED,
        },
      });
      if (!orph.envelopeValid || (orph.envelope as { ok?: unknown })["ok"] !== true) {
        setupFailure = `orphan event.append failed: ${orph.invalidReason ?? "not-ok"}`;
      }
    }

    // Verification reads (real get/list via CLI).
    let verifiedListP: string[] = [];
    if (setupFailure === null) {
      const oldId = aliasToId.get("old") as string;
      const newId = aliasToId.get("new") as string;
      const retiredId = aliasToId.get("retired") as string;
      const lensId = aliasToId.get("lens") as string;
      const foreignId = aliasToId.get("foreign") as string;
      const getOld = invokeCli(cliPath, configPath, { v: 1, op: "record.get", params: { id: oldId, scope: SCOPE_P } });
      const getNew = invokeCli(cliPath, configPath, { v: 1, op: "record.get", params: { id: newId, scope: SCOPE_P } });
      const getRet = invokeCli(cliPath, configPath, { v: 1, op: "record.get", params: { id: retiredId, scope: SCOPE_P } });
      const getLens = invokeCli(cliPath, configPath, { v: 1, op: "record.get", params: { id: lensId, scope: SCOPE_P } });
      const listP = invokeCli(cliPath, configPath, { v: 1, op: "record.list", params: { scope: SCOPE_P, limit: 25 } });
      const getForeignP = invokeCli(cliPath, configPath, { v: 1, op: "record.get", params: { id: foreignId, scope: SCOPE_P } });
      const getForeignW = invokeCli(cliPath, configPath, { v: 1, op: "record.get", params: { id: foreignId, scope: SCOPE_W } });
      try {
        const oldView = (getOld.envelope as { data?: { record?: { status?: unknown; } } } | null)?.data?.record as { status?: string } | undefined;
        const newView = (getNew.envelope as { data?: { record?: { status?: unknown; supersedes?: unknown } } } | null)?.data?.record as { status?: string; supersedes?: string } | undefined;
        const retView = (getRet.envelope as { data?: { record?: { status?: unknown } } } | null)?.data?.record as { status?: string } | undefined;
        const lensView = (getLens.envelope as { data?: { record?: { links?: unknown; sourceRefs?: unknown } } } | null)?.data?.record as { links?: string[]; sourceRefs?: string[] } | undefined;
        if (!getOld.envelopeValid || oldView?.status !== "superseded") setupFailure = `old status check failed: ${JSON.stringify(oldView)}`;
        else if (!getNew.envelopeValid || newView?.status !== "active" || newView?.supersedes !== oldId) setupFailure = `new status/supersedes check failed: ${JSON.stringify(newView)}`;
        else if (!getRet.envelopeValid || retView?.status !== "archived") setupFailure = `retired status check failed: ${JSON.stringify(retView)}`;
        else if (!getLens.envelopeValid || !Array.isArray(lensView?.links) || !Array.isArray(lensView?.sourceRefs)) setupFailure = `lens links/refs check failed: ${JSON.stringify(lensView)}`;
        else {
          const beaconId = aliasToId.get("beacon") as string;
          const chartId = aliasToId.get("chart") as string;
          const gotLinks = [...((lensView as { links: string[] }).links)].sort();
          const expLinks = [beaconId, chartId].sort();
          const gotRefs = (lensView as { sourceRefs: string[] }).sourceRefs;
          if (JSON.stringify(gotLinks) !== JSON.stringify(expLinks)) setupFailure = `lens links identity check failed: got ${JSON.stringify(gotLinks)} exp ${JSON.stringify(expLinks)}`;
          else if (JSON.stringify(gotRefs) !== JSON.stringify(["b1-lens"])) setupFailure = `lens sourceRefs identity check failed: got ${JSON.stringify(gotRefs)}`;
          else if (!listP.envelopeValid) setupFailure = "list P failed";
        else {
          const items = ((listP.envelope as { data?: { items?: Array<{ id?: unknown }> } }).data?.items ?? []) as Array<{ id: string }>;
          verifiedListP = items.map((i) => i.id);
          const expectActive = ["orchard", "tea", "delivery", "beacon", "chart", "lens", "bicycle", "new"].map((a) => aliasToId.get(a) as string);
          const setGot = new Set(verifiedListP);
          const setExp = new Set(expectActive);
          const same = setGot.size === setExp.size && [...setExp].every((id) => setGot.has(id));
          const excludesForeign = !setGot.has(foreignId) && !setGot.has(oldId) && !setGot.has(retiredId);
          if (!same || !excludesForeign || verifiedListP.length !== 8) {
            setupFailure = `list P exact-8 check failed: got ${JSON.stringify(verifiedListP)} exp ${JSON.stringify([...setExp])}`;
          } else if (!getForeignP.envelopeValid || (getForeignP.envelope as { code?: unknown })["code"] !== "FORBIDDEN_SCOPE") {
            setupFailure = `foreign P scope check failed: ${JSON.stringify(getForeignP.envelope)}`;
          } else if (!getForeignW.envelopeValid || (getForeignW.envelope as { ok?: unknown })["ok"] !== true) {
            setupFailure = "foreign W read failed";
          }
          }
        }
      } catch {
        setupFailure = "verification parse failed";
      }
    }

    // Quality: fixed order, P, k=3, 3 rounds = 36 recalls.
    const activePSet = new Set<string>(verifiedListP);
    // Include check: activePSet covers 8 active P IDs for invariant validation.
    if (setupFailure === null) {
      for (let round = 0; round < BASELINE_REPETITIONS; round++) {
        for (const q of [...BASELINE_QUERIES].sort((a, b) => a.order - b.order)) {
          const goldIds = q.goldAliases.map((a) => aliasToId.get(a)).filter((v): v is string => typeof v === "string");
          if (goldIds.length !== q.goldAliases.length) {
            attempts.push({
              queryId: q.id, round, ok: false, code: "SETUP", returnedIds: [], snippets: [], tags: [],
              recallId: null, goldIds: [], hits: 0, pAt3: 0, recall: 0, rr: 0, firstRank: null,
              failed: true, invalid: true, invalidReason: "gold-unresolved", invariantViolation: [],
              latencyMs: 0, kind: q.kind,
            });
            positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            normalExecuted += 1;
            normalFailures += 1;
            if (q.kind === "negative") negativeOutcomes.push("failure");
            continue;
          }
          const params: Record<string, unknown> = { query: q.query, scope: SCOPE_P, limit: BASELINE_K, runId: BASELINE_RUN_QUALITY };
          if (q.tags) params["tags"] = q.tags;
          if (q.linkAlias) {
            const linkId = aliasToId.get(q.linkAlias);
            if (!linkId) {
              attempts.push({
                queryId: q.id, round, ok: false, code: "SETUP", returnedIds: [], snippets: [], tags: [],
                recallId: null, goldIds, hits: 0, pAt3: q.kind === "positive" ? 0 : null as unknown as number,
                recall: q.kind === "positive" ? 0 : null as unknown as number,
                rr: q.kind === "positive" ? 0 : null as unknown as number,
                firstRank: null, failed: true, invalid: true, invalidReason: "link-unresolved",
                invariantViolation: [], latencyMs: 0, kind: q.kind,
              });
              if (q.kind === "positive") positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
              else negativeOutcomes.push("failure");
              normalExecuted += 1;
              normalFailures += 1;
              continue;
            }
            params["link"] = linkId;
          }
          const res = invokeCli(cliPath, configPath, { v: 1, op: "record.recall", params });
          normalExecuted += 1;
          allLatencies.push(res.elapsedMs);
          const key = `${q.id}`;
          if (!stabilityByQuery.has(key)) stabilityByQuery.set(key, []);
          if (!res.envelopeValid || res.timedOut || res.status !== 0) {
            failureLatencies.push(res.elapsedMs);
            normalFailures += 1;
            stabilityByQuery.get(key)?.push([]);
            if (q.kind === "positive") {
              attempts.push({
                queryId: q.id, round, ok: false, code: res.timedOut ? "TIMEOUT" : "INVALID",
                returnedIds: [], snippets: [], tags: [], recallId: null, goldIds, hits: 0,
                pAt3: 0, recall: 0, rr: 0, firstRank: null, failed: true,
                invalid: true, invalidReason: res.invalidReason ?? "transport",
                invariantViolation: [], latencyMs: res.elapsedMs, kind: q.kind,
              });
              positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            } else {
              attempts.push({
                queryId: q.id, round, ok: false, code: res.timedOut ? "TIMEOUT" : "INVALID",
                returnedIds: [], snippets: [], tags: [], recallId: null, goldIds, hits: 0,
                pAt3: null, recall: null, rr: null, firstRank: null, failed: true,
                invalid: true, invalidReason: res.invalidReason ?? "transport",
                invariantViolation: [], latencyMs: res.elapsedMs, kind: q.kind,
              });
              negativeOutcomes.push("failure");
            }
            continue;
          }
          const env = res.envelope as { ok: boolean; code: string; data: { items?: Array<{ id?: unknown; snippet?: unknown; tags?: unknown }>; recallId?: unknown } | null };
          if (!env.ok) {
            failureLatencies.push(res.elapsedMs);
            normalFailures += 1;
            stabilityByQuery.get(key)?.push([]);
            if (q.kind === "positive") {
              attempts.push({
                queryId: q.id, round, ok: false, code: env.code, returnedIds: [], snippets: [], tags: [],
                recallId: null, goldIds, hits: 0, pAt3: 0, recall: 0, rr: 0, firstRank: null,
                failed: true, invalid: false, invalidReason: null, invariantViolation: [],
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            } else {
              const cls = classifyNegative({ transportFailed: false, ok: false, itemsCount: null });
              attempts.push({
                queryId: q.id, round, ok: false, code: env.code, returnedIds: [], snippets: [], tags: [],
                recallId: null, goldIds, hits: 0, pAt3: null, recall: null, rr: null, firstRank: null,
                failed: env.code !== "OK", invalid: false, invalidReason: null, invariantViolation: [],
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              negativeOutcomes.push(cls.outcome);
            }
            continue;
          }
          // OK path: validate recall data contract BEFORE any map.
          // Missing/null data, non-array items, or malformed item shapes are
          // a failed NORMAL attempt (positive zero / negative failure with
          // failed latency), never a thrown setup failure and never a fake
          // valid empty. Completed attempts/counts are preserved.
          const checked = validateRecallData((env as { data?: unknown }).data);
          if (!checked.ok) {
            failureLatencies.push(res.elapsedMs);
            normalFailures += 1;
            invariantFailures.push(`${q.id}/r${round}: ${checked.reason}`);
            stabilityByQuery.get(key)?.push([]);
            if (q.kind === "positive") {
              attempts.push({
                queryId: q.id, round, ok: true, code: "OK", returnedIds: [],
                snippets: [], tags: [],
                recallId: null, goldIds, hits: 0, pAt3: 0, recall: 0, rr: 0, firstRank: null,
                failed: true, invalid: true, invalidReason: checked.reason, invariantViolation: [],
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            } else {
              attempts.push({
                queryId: q.id, round, ok: true, code: "OK", returnedIds: [],
                snippets: [], tags: [],
                recallId: null, goldIds, hits: 0, pAt3: null, recall: null, rr: null, firstRank: null,
                failed: true, invalid: true, invalidReason: checked.reason, invariantViolation: [],
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              negativeOutcomes.push("failure");
            }
            exitCode = 1;
            continue;
          }
          const items = checked.items;
          const recallId: string | null = checked.recallId;
          const ids = items.map((i) => i.id);
          const v = validateReturnedIds(ids, BASELINE_K);
          if (!v.ok) {
            failureLatencies.push(res.elapsedMs);
            normalFailures += 1;
            invariantFailures.push(`${q.id}/r${round}: ${v.reason}`);
            stabilityByQuery.get(key)?.push([]);
            if (q.kind === "positive") {
              attempts.push({
                queryId: q.id, round, ok: true, code: "OK", returnedIds: ids,
                snippets: items.map((i) => String(i.snippet ?? "")), tags: items.map((i) => (Array.isArray(i.tags) ? i.tags as string[] : [])),
                recallId, goldIds, hits: 0, pAt3: 0, recall: 0, rr: 0, firstRank: null,
                failed: true, invalid: true, invalidReason: v.reason, invariantViolation: [],
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            } else {
              attempts.push({
                queryId: q.id, round, ok: true, code: "OK", returnedIds: ids,
                snippets: items.map((i) => String(i.snippet ?? "")), tags: items.map((i) => (Array.isArray(i.tags) ? i.tags as string[] : [])),
                recallId, goldIds, hits: 0, pAt3: null, recall: null, rr: null, firstRank: null,
                failed: true, invalid: true, invalidReason: v.reason, invariantViolation: [],
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              negativeOutcomes.push("failure");
            }
            exitCode = 1;
            continue;
          }
          const violations = findInvariantViolations(ids, activePSet);
          if (violations.length > 0) {
            failureLatencies.push(res.elapsedMs);
            normalFailures += 1;
            invariantFailures.push(`${q.id}/r${round}: invariant ${JSON.stringify(violations)}`);
            stabilityByQuery.get(key)?.push([...ids]);
            if (q.kind === "positive") {
              attempts.push({
                queryId: q.id, round, ok: true, code: "OK", returnedIds: ids,
                snippets: items.map((i) => String(i.snippet ?? "")), tags: items.map((i) => (Array.isArray(i.tags) ? i.tags as string[] : [])),
                recallId, goldIds, hits: 0, pAt3: 0, recall: 0, rr: 0, firstRank: null,
                failed: true, invalid: true, invalidReason: "invariant", invariantViolation: violations,
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              positiveEntries.push({ failed: true, pAt3: 0, recall: 0, rr: 0 });
            } else {
              attempts.push({
                queryId: q.id, round, ok: true, code: "OK", returnedIds: ids,
                snippets: items.map((i) => String(i.snippet ?? "")), tags: items.map((i) => (Array.isArray(i.tags) ? i.tags as string[] : [])),
                recallId, goldIds, hits: 0, pAt3: null, recall: null, rr: null, firstRank: null,
                failed: true, invalid: true, invalidReason: "invariant", invariantViolation: violations,
                latencyMs: res.elapsedMs, kind: q.kind,
              });
              negativeOutcomes.push("failure");
            }
            exitCode = 1;
            continue;
          }
          successLatencies.push(res.elapsedMs);
          stabilityByQuery.get(key)?.push([...ids]);
          if (q.kind === "positive") {
            const s = scorePositive(ids, goldIds, BASELINE_K);
            attempts.push({
              queryId: q.id, round, ok: true, code: "OK", returnedIds: ids,
              snippets: items.map((i) => String(i.snippet ?? "")), tags: items.map((i) => (Array.isArray(i.tags) ? i.tags as string[] : [])),
              recallId, goldIds, hits: s.hits, pAt3: s.pAt3, recall: s.recall, rr: s.rr,
              firstRank: s.firstRank, failed: false, invalid: false, invalidReason: null,
              invariantViolation: [], latencyMs: res.elapsedMs, kind: q.kind,
            });
            positiveEntries.push({ failed: false, pAt3: s.pAt3, recall: s.recall, rr: s.rr });
          } else {
            const cls = classifyNegative({ transportFailed: false, ok: true, itemsCount: ids.length });
            attempts.push({
              queryId: q.id, round, ok: true, code: "OK", returnedIds: ids,
              snippets: items.map((i) => String(i.snippet ?? "")), tags: items.map((i) => (Array.isArray(i.tags) ? i.tags as string[] : [])),
              recallId, goldIds, hits: 0, pAt3: null, recall: null, rr: null, firstRank: null,
              failed: false, invalid: false, invalidReason: null, invariantViolation: [],
              latencyMs: res.elapsedMs, kind: q.kind,
            });
            negativeOutcomes.push(cls.outcome);
          }
        }
      }
      // Feedback ONLY after quality: actual eligible exposed relevant result.
      const eligible = attempts.find((a) => a.kind === "positive" && a.ok && !a.failed && !a.invalid && (a.hits ?? 0) > 0 && a.recallId && a.returnedIds.length > 0 && a.goldIds.length > 0);
      if (eligible && eligible.recallId) {
        const relevant = eligible.returnedIds.filter((id) => (eligible.goldIds as string[]).includes(id));
        const fbReq = {
          v: 1,
          op: "record.feedback",
          idempotencyKey: "baseline-v1-fb-1",
          params: { recallId: eligible.recallId, recordIds: relevant, scope: SCOPE_P, runId: BASELINE_RUN_QUALITY },
        };
        feedbackInvocations += 1;
        const fb = invokeCli(cliPath, configPath, fbReq);
        if (fb.envelopeValid && (fb.envelope as { ok?: unknown })["ok"] === true) {
          feedback = { status: "reported", recallId: eligible.recallId, recordIds: relevant, queryId: eligible.queryId, round: eligible.round, code: "OK", latencyMs: fb.elapsedMs };
        } else {
          // Non-normal runtime failure: invoked feedback MUST succeed. Keep the
          // 36 quality rows untouched; signal via invariants + nonzero exit.
          // Intended low quality or no eligible exposure stays "unavailable", never an error.
          feedback = { status: "failed", recallId: eligible.recallId, recordIds: relevant, code: (fb.envelope as { code?: unknown } | null)?.code ?? fb.invalidReason ?? "INVALID", latencyMs: fb.elapsedMs };
          invariantFailures.push(`feedback: invoked feedback failed code=${String((fb.envelope as { code?: unknown } | null)?.code ?? fb.invalidReason ?? "INVALID")}`);
          exitCode = 1;
        }
      } else {
        feedback = { status: "unavailable", reason: "no eligible exposed relevant result without quality threshold" };
      }
    }

    // Corrupt probe: SECOND own DB/config/vault, ONE scenario / TWO invocations.
    const corruptDir = fs.mkdtempSync(path.join(os.tmpdir(), "r13-baseline-corrupt-"));
    let corruptDirect: Record<string, unknown> = {};
    let corruptAdapter: Record<string, unknown> = {};
    try {
      const corruptDb = path.join(corruptDir, "corrupt.db");
      const corruptVault = path.join(corruptDir, "vault");
      const corruptCfgPath = path.join(corruptDir, "memory.config.json");
      const corruptCfg = {
        dbPath: corruptDb,
        vaultPath: corruptVault,
        allowedScopes: [SCOPE_P, SCOPE_W],
        limits: {
          bodyMaxCp: 2000, queryMaxCp: 500, tagsMax: 5, linksMax: 8, sourceRefsMax: 8,
          limitDefault: 10, limitMax: 25, snippetMaxCp: 200, responseMaxBytes: 8192,
        },
        timeouts: { cliMs: 5000, busyMs: 2000 },
        dbMaxBytes: 104857600,
      };
      fs.writeFileSync(corruptCfgPath, JSON.stringify(corruptCfg), "utf8");
      fs.writeFileSync(corruptDb, Buffer.from("synthetic corrupt SQLite probe\n", "utf8"));
      // Invocation 1: direct real CLI recall.
      const direct = invokeCli(cliPath, corruptCfgPath, { v: 1, op: "record.recall", params: { query: "probe", scope: SCOPE_P, limit: 3 } });
      corruptDirect = {
        kind: "direct-cli-recall",
        status: direct.status,
        stdoutBytes: direct.stdoutBuf.length,
        stdoutEmpty: direct.stdoutBuf.length === 0,
        stderr: direct.stderrText,
        elapsedMs: direct.elapsedMs,
      };
      // Invocation 2: fake adapter (memoryless fallback, NO LLM).
      const adapterStart = monotonicMs();
      const adapterRes = queryMemory({ cliPath, configPath: corruptCfgPath, scope: SCOPE_P, query: "probe", limit: 3, enabled: true, timeoutMs: 6000 });
      const adapterEnd = monotonicMs();
      corruptAdapter = {
        kind: "fake-adapter-queryMemory",
        degraded: (adapterRes as { degraded?: unknown }).degraded ?? null,
        code: (adapterRes as { code?: unknown }).code ?? null,
        citations: (adapterRes as { citations?: unknown }).citations ?? null,
        elapsedMs: elapsedMsSince(adapterStart, adapterEnd),
      };
      void BASELINE_OBSERVED_AT;
    } finally {
      try {
        fs.rmSync(corruptDir, { recursive: true, force: true });
      } catch { /* ignore */ }
    }

    // Deliberate corrupt-probe contract: direct CLI must stay a degraded
    // startup failure (exit 3, empty stdout) and the adapter must stay
    // degraded STORE_UNAVAILABLE with EMPTY citations. An unexpected
    // nondegraded/cited/successful probe is an explicit probe-contract
    // failure (nonzero) WITHOUT touching normal quality/degradation counts.
    let probeContract: Record<string, unknown> = { status: "ok" };
    {
      const d = corruptDirect as { status?: unknown; stdoutBytes?: unknown; stdoutEmpty?: unknown };
      const a = corruptAdapter as { degraded?: unknown; code?: unknown; citations?: unknown };
      const directOk = d.status === 3 && d.stdoutBytes === 0 && d.stdoutEmpty === true;
      const adapterOk = a.degraded === true && a.code === "STORE_UNAVAILABLE" && Array.isArray(a.citations) && (a.citations as unknown[]).length === 0;
      if (!directOk || !adapterOk) {
        const reason = `probe contract failed: directOk=${String(directOk)} adapterOk=${String(adapterOk)}`;
        probeContract = { status: "failure", reason };
        invariantFailures.push(reason);
        exitCode = 1;
      }
    }

    const posAgg = aggregatePositive(positiveEntries);
    const negFrac = negativeFractions(negativeOutcomes);
    const latAll = latencyStats(allLatencies);
    const latSuccess = latencyStats(successLatencies);
    const latFailure = latencyStats(failureLatencies);
    const stability: Record<string, { rounds: string[][]; stable: boolean }> = {};
    for (const [k, v] of stabilityByQuery) {
      const stable = v.length === BASELINE_REPETITIONS && v.every((r) => JSON.stringify(r) === JSON.stringify(v[0]));
      stability[k] = { rounds: v, stable };
    }

    const report: Record<string, unknown> = {
      fixture: BASELINE_FIXTURE_VERSION,
      schema: BASELINE_SCHEMA_VERSION,
      k: BASELINE_K,
      repetitions: BASELINE_REPETITIONS,
      fixedOrder: BASELINE_QUERIES.map((q) => q.id),
      denominators: {
        plannedPositive: 7 * BASELINE_REPETITIONS,
        plannedNegative: 5 * BASELINE_REPETITIONS,
        plannedNormal: normalPlanned,
        executedNormal: normalExecuted,
        normalFailures,
      },
      syntheticOnly: true,
      mode: { name: "M1-lexical-graph", model: null, semanticCompletion: false, acceptanceThresholds: null, futureM2Delta: null },
      runtime: { node: process.version, platform: process.platform, arch: process.arch, runUTC },
      config: { allowedScopes: [SCOPE_P, SCOPE_W], limits: (expectedConfig(dir) as { limits: unknown }).limits, timeouts: { cliMs: 5000, busyMs: 2000 }, dbMaxBytes: 104857600 },
      aliasToId: Object.fromEntries(aliasToId),
      queries: BASELINE_QUERIES.map((q) => ({
        id: q.id,
        query: q.query,
        tags: q.tags ?? null,
        linkAlias: q.linkAlias ?? null,
        linkId: q.linkAlias ? (aliasToId.get(q.linkAlias) ?? null) : null,
        goldAliases: q.goldAliases,
        goldIds: q.goldAliases.map((a) => aliasToId.get(a) ?? null),
        kind: q.kind,
        note: q.note,
      })),
      attempts,
      aggregation: {
        positive: posAgg,
        negative: negFrac,
        latencyAll: latAll,
        latencySuccess: latSuccess,
        latencyFailure: latFailure,
      },
      invariants: { failures: invariantFailures },
      stability,
      feedback,
      feedbackInvocations,
      probes: {
        scenario: "corrupt-db",
        excludedFromQuality: true,
        excludedFromDegradation: true,
        direct: corruptDirect,
        adapter: corruptAdapter,
        contract: probeContract,
      },
      setup: setupFailure === null ? { status: "ok" } : { status: "failure", reason: setupFailure, quality: "UNAVAILABLE" },
      quality: setupFailure === null ? "available" : "UNAVAILABLE",
      sourceRevision: null,
      sourceRevisionReason: "not resolved to avoid inventing HEAD",
    };

    if (setupFailure !== null) {
      exitCode = 1;
      report["invariants"] = { failures: [...invariantFailures, `setup: ${setupFailure}`] };
    }
    if (invariantFailures.length > 0) exitCode = 1;

    process.stdout.write(JSON.stringify(report) + "\n");
    cleanup();
    process.exit(exitCode);
  } catch (e) {
    try {
      const report = {
        fixture: BASELINE_FIXTURE_VERSION,
        schema: BASELINE_SCHEMA_VERSION,
        setup: { status: "failure", reason: String(e), quality: "UNAVAILABLE" },
        quality: "UNAVAILABLE",
        syntheticOnly: true,
      };
      process.stdout.write(JSON.stringify(report) + "\n");
    } catch { /* ignore */ }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch { /* ignore */ }
    process.exit(1);
  }
}

main();
