/**
 * Memory-decision evaluation (seeded-only, real CLI, no user data).
 *
 * Four deterministic suites through the compiled CLI:
 *  - memprobe: stability/plasticity paradigms (interference, misinformation,
 *    consolidation strength, reconsolidation window).
 *  - support: retrieval-support diagnostic (required memories never surfaced;
 *    active records with zero exposures).
 *  - lifecycle: counterfactual KEEP/RETIRE/CORRECT branches from the same
 *    post-seed state, replayed over the same future stream. CONSOLIDATE is a
 *    separate opt-in check, not a lifecycle branch.
 *  - governance: Epistemics G1-G4 plus provenance/probe leak checks. G1 is
 *    structural only when no model is configured and is reported as skipped.
 *
 * `--llm-config <path>` runs the optional maintain.consolidate model leg
 * against that config's loopback llm section (temp DB only). It is skipped by
 * default; the default run is offline and model-free.
 *
 * Reports JSON on the first stdout line. Exits non-zero only on harness or
 * contract violations, never on quality thresholds. Derived from the plan's
 * U4 evaluation proposal; no production behavior changes.
 *
 * Usage: node dist/scripts/evaluate-memory-decisions.js
 *          [--out <json>] [--labels <jsonl>] [--llm-config <path>]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { DatabaseSync } from "node:sqlite";
import {
  validateEnvelopeValues,
  validateRecallData,
  type RecallItem,
} from "./baseline-score.js";
import { runGovernanceSuite, type GovernanceReport, type GovernanceStore } from "./decision-governance.js";

export const DECISIONS_VERSION = "memory-decisions-v1";
export const DECISIONS_SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";
const RUN = "memory-decisions-run";
const LIMIT = 3;
const CLI_TIMEOUT_MS = 30000;
const MAX_BUFFER = 256 * 1024;
const RESPONSE_MAX_BYTES = 8192;
const STORAGE_PENALTY = 0.02;

type AnyBuf = Buffer<ArrayBufferLike>;

interface CliResult {
  status: number | null;
  valid: boolean;
  ok: boolean;
  code: string;
  data: unknown;
  invalidReason: string | null;
  elapsedMs: number;
}

interface RecordView {
  id: string;
  body?: unknown;
  bodyHash?: unknown;
  status?: unknown;
  kind?: unknown;
  source?: unknown;
  supersedes?: unknown;
  revision?: unknown;
  sourceRefs?: unknown;
  links?: unknown;
}

interface Probe {
  scenario: string;
  kind: "current" | "previous" | "update" | "preserve" | "source" | "temporal";
  name: string;
  pass: boolean;
  detail: string;
}

class HarnessError extends Error {}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

const CLI_PATH = path.resolve(__dirname, "..", "src", "cli.js");
const LATENCIES: number[] = [];

function configFor(dir: string): Record<string, unknown> {
  return {
    dbPath: path.join(dir, "memory-decisions.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [DECISIONS_SCOPE],
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
    cultivation: { queueMax: 100, batchMax: 20, leaseTtlMs: 120000, reviewMaxAttempts: 5 },
    llm: { enabled: false },
  };
}

function invoke(configPath: string, request: Record<string, unknown>, timeoutMs = CLI_TIMEOUT_MS): CliResult {
  const line = Buffer.from(JSON.stringify(request) + "\n", "utf8");
  const start = process.hrtime.bigint();
  let status: number | null = null;
  let stdoutBuf: Buffer<ArrayBufferLike> = Buffer.alloc(0);
  let spawnFailed = false;
  try {
    const r = spawnSync(process.execPath, [CLI_PATH, "--config", configPath], {
      input: line,
      timeout: timeoutMs,
      killSignal: "SIGKILL",
      maxBuffer: MAX_BUFFER,
      shell: false,
      encoding: "buffer",
    });
    status = r.status;
    const raw: unknown = r.stdout;
    stdoutBuf = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw ?? ""));
    spawnFailed = r.error !== undefined && r.error !== null;
  } catch {
    spawnFailed = true;
  }
  const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
  LATENCIES.push(elapsedMs);
  if (spawnFailed) {
    return { status, valid: false, ok: false, code: "SPAWN", data: null, invalidReason: "spawn-failure", elapsedMs };
  }
  if (stdoutBuf.length === 0) {
    return { status, valid: false, ok: false, code: "EMPTY", data: null, invalidReason: "empty-stdout", elapsedMs };
  }
  if (stdoutBuf[stdoutBuf.length - 1] !== 0x0a || stdoutBuf.indexOf(0x0a) !== stdoutBuf.length - 1) {
    return { status, valid: false, ok: false, code: "FRAME", data: null, invalidReason: "framing", elapsedMs };
  }
  const jsonBytes = stdoutBuf.subarray(0, stdoutBuf.length - 1);
  if (jsonBytes.length > RESPONSE_MAX_BYTES) {
    return { status, valid: false, ok: false, code: "BUDGET", data: null, invalidReason: "over-budget", elapsedMs };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(jsonBytes));
  } catch {
    return { status, valid: false, ok: false, code: "JSON", data: null, invalidReason: "bad-json", elapsedMs };
  }
  if (!isObject(parsed)) {
    return { status, valid: false, ok: false, code: "ENV", data: null, invalidReason: "bad-envelope", elapsedMs };
  }
  const keys = Object.keys(parsed).sort().join(",");
  if (keys !== "code,data,deduplicated,message,ok,v") {
    return { status, valid: false, ok: false, code: "ENV", data: null, invalidReason: "bad-envelope", elapsedMs };
  }
  const check = validateEnvelopeValues(parsed);
  if (!check.ok) {
    return { status, valid: false, ok: false, code: "ENV", data: null, invalidReason: check.reason, elapsedMs };
  }
  return {
    status,
    valid: true,
    ok: check.success,
    code: check.code,
    data: parsed["data"],
    invalidReason: null,
    elapsedMs,
  };
}

class Workspace {
  readonly dir: string;
  readonly configPath: string;
  readonly dbPath: string;
  constructor(prefix: string, create = true, overrides?: Record<string, unknown>) {
    this.dir = create ? fs.mkdtempSync(path.join(os.tmpdir(), prefix)) : prefix;
    this.configPath = path.join(this.dir, "memory.config.json");
    this.dbPath = path.join(this.dir, "memory-decisions.db");
    fs.writeFileSync(this.configPath, JSON.stringify({ ...configFor(this.dir), ...overrides }), "utf8");
  }

  call(request: Record<string, unknown>, timeoutMs = CLI_TIMEOUT_MS): CliResult {
    return invoke(this.configPath, request, timeoutMs);
  }

  /** Successful data or HarnessError with a fixed description (no content echo). */
  must(request: Record<string, unknown>, timeoutMs = CLI_TIMEOUT_MS): unknown {
    const r = this.call(request, timeoutMs);
    if (!r.valid) throw new HarnessError(`invalid ${String(request["op"])}: ${r.invalidReason ?? "unknown"}`);
    if (!r.ok) throw new HarnessError(`op ${String(request["op"])} failed: ${r.code}`);
    return r.data;
  }

  cleanup(): void {
    try {
      fs.rmSync(this.dir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function recordOf(data: unknown): RecordView | null {
  if (!isObject(data)) return null;
  const r = data["record"];
  if (!isObject(r) || typeof r["id"] !== "string") return null;
  return {
    id: r["id"],
    body: r["body"],
    bodyHash: r["bodyHash"],
    status: r["status"],
    kind: r["kind"],
    source: r["source"],
    supersedes: r["supersedes"],
    revision: r["revision"],
    sourceRefs: r["sourceRefs"],
    links: r["links"],
  };
}

function recall(ws: Workspace, query: string): { recallId: string; items: RecallItem[] } {
  const data = ws.must({
    v: 1,
    op: "record.recall",
    params: { query, scope: DECISIONS_SCOPE, limit: LIMIT, runId: RUN },
  });
  const checked = validateRecallData(data);
  if (!checked.ok) throw new HarnessError(`recall data invalid: ${checked.reason}`);
  return { recallId: checked.recallId, items: checked.items };
}

function getRecord(ws: Workspace, id: string): RecordView {
  const record = recordOf(ws.must({ v: 1, op: "record.get", params: { id, scope: DECISIONS_SCOPE } }));
  if (!record) throw new HarnessError("record.get missing record");
  return record;
}

function searchIds(ws: Workspace, query: string): string[] {
  const data = ws.must({
    v: 1,
    op: "record.search",
    params: { query, scope: DECISIONS_SCOPE, limit: LIMIT },
  });
  if (!isObject(data) || !Array.isArray(data["items"])) throw new HarnessError("record.search bad data");
  return data["items"].map((item) => {
    if (!isObject(item) || typeof item["id"] !== "string") throw new HarnessError("record.search bad item");
    return item["id"];
  });
}

function seedRecord(
  ws: Workspace,
  key: string,
  body: string,
  source: string,
  kind: "user_fact" | "model_inference" | "summary" = "user_fact",
): { id: string; eventId: string } {
  const eventId = `${key}-ev`;
  ws.must({
    v: 1,
    op: "event.append",
    idempotencyKey: `${key}-ev`,
    params: {
      eventId,
      sessionId: "memory-decisions",
      turnId: key,
      body: `User: ${body}\nAssistant: Noted.`,
      provenance: { source, observedAt: OBS },
      scope: DECISIONS_SCOPE,
      runId: RUN,
    },
  });
  const data = ws.must({
    v: 1,
    op: "record.remember",
    idempotencyKey: `${key}-rem`,
    params: {
      body,
      kind,
      provenance: { source, observedAt: OBS },
      scope: DECISIONS_SCOPE,
      tags: [],
      links: [],
      sourceRefs: [eventId],
      runId: RUN,
    },
  });
  const record = recordOf(data);
  if (!record) throw new HarnessError("record.remember missing record");
  return { id: record.id, eventId };
}

function correct(ws: Workspace, id: string, body: string, source: string, sourceRefs: string[]): string {
  const data = ws.must({
    v: 1,
    op: "record.correct",
    idempotencyKey: `correct-${id}`,
    params: {
      recordId: id,
      body,
      kind: "correction",
      provenance: { source, observedAt: OBS },
      scope: DECISIONS_SCOPE,
      links: [],
      sourceRefs,
      runId: RUN,
    },
  });
  const record = recordOf(data);
  if (!record) throw new HarnessError("record.correct missing record");
  return record.id;
}

function retire(ws: Workspace, id: string): void {
  ws.must({
    v: 1,
    op: "record.retire",
    idempotencyKey: `retire-${id}`,
    params: { id, scope: DECISIONS_SCOPE, reasonCode: "OUTDATED" },
  });
}

function reactivate(ws: Workspace, id: string): void {
  ws.must({
    v: 1,
    op: "record.reactivate",
    idempotencyKey: `reactivate-${id}`,
    params: { id, scope: DECISIONS_SCOPE, reasonCode: "STILL_USEFUL" },
  });
}

function rememberDerived(
  ws: Workspace,
  key: string,
  body: string,
  links: string[],
  sourceRefs: string[],
): { id: string; eventId: string } {
  const data = ws.must({
    v: 1,
    op: "record.remember",
    idempotencyKey: `${key}-derived`,
    params: {
      body,
      kind: "summary",
      provenance: { source: "cultivation:llm-derived-cluster", observedAt: OBS },
      scope: DECISIONS_SCOPE,
      tags: [],
      links,
      sourceRefs,
      runId: RUN,
    },
  });
  const record = recordOf(data);
  if (!record) throw new HarnessError("record.remember derived missing record");
  return { id: record.id, eventId: sourceRefs[0] ?? "" };
}

function setTopic(ws: Workspace, id: string, bodyHash: string, topic: string): void {
  ws.must({
    v: 1,
    op: "topic.set",
    idempotencyKey: `topic-${id}`,
    params: { id, scope: DECISIONS_SCOPE, bodyHash, topics: [topic] },
  });
}

function feedback(ws: Workspace, recallId: string, recordId: string): void {
  ws.must({
    v: 1,
    op: "record.feedback",
    idempotencyKey: `feedback-${recallId}-${recordId}`,
    params: { recallId, recordIds: [recordId], scope: DECISIONS_SCOPE },
  });
}

function probe(
  scenario: string,
  kind: Probe["kind"],
  name: string,
  pass: boolean,
  detail: string,
): Probe {
  return { scenario, kind, name, pass, detail };
}

function contains(id: string, items: Array<{ id: string }>): boolean {
  return items.some((i) => i.id === id);
}

function indexOf(id: string, items: Array<{ id: string }>): number {
  return items.findIndex((i) => i.id === id);
}

function bodyOf(record: RecordView): string {
  return typeof record.body === "string" ? record.body : "";
}

function statusOf(record: RecordView): string {
  return typeof record.status === "string" ? record.status : "";
}

function sourceOf(record: RecordView): string {
  return typeof record.source === "string" ? record.source : "";
}

function heatOf(dbPath: string, id: string): number {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row: unknown = db.prepare("SELECT usedCount FROM note_heat WHERE recordId = ?").get(id);
    return isObject(row) && typeof row["usedCount"] === "number" ? row["usedCount"] : 0;
  } catch {
    return -1;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function exposureCount(dbPath: string, id: string): number {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row: unknown = db.prepare("SELECT COUNT(*) AS n FROM exposures WHERE recordId = ?").get(id);
    return isObject(row) && typeof row["n"] === "number" ? row["n"] : -1;
  } catch {
    return -1;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function activeRecords(dbPath: string): number {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const row: unknown = db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE status = 'active' AND scope = ?")
      .get(DECISIONS_SCOPE);
    return isObject(row) && typeof row["n"] === "number" ? row["n"] : -1;
  } catch {
    return -1;
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

function exposureStats(dbPath: string): { exposedDistinct: number; active: number } {
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    const exposed: unknown = db.prepare("SELECT COUNT(DISTINCT recordId) AS n FROM exposures").get();
    const active: unknown = db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE status = 'active' AND scope = ?")
      .get(DECISIONS_SCOPE);
    return {
      exposedDistinct: isObject(exposed) && typeof exposed["n"] === "number" ? exposed["n"] : -1,
      active: isObject(active) && typeof active["n"] === "number" ? active["n"] : -1,
    };
  } catch {
    return { exposedDistinct: -1, active: -1 };
  } finally {
    try {
      db?.close();
    } catch {
      /* ignore */
    }
  }
}

/* ------------------------------------------------------------------ */
/* MemProbe: stability / plasticity paradigms                         */
/* ------------------------------------------------------------------ */

interface ScenarioResult {
  name: string;
  probes: Probe[];
  invariants: string[];
  extra: Record<string, unknown>;
}

function interferenceScenario(): ScenarioResult {
  const ws = new Workspace("remind-interference-");
  const probes: Probe[] = [];
  const invariants: string[] = [];
  try {
    const { id: oldId, eventId } = seedRecord(
      ws,
      "interference",
      "The north gate keypad code is 4410.",
      "user:alice",
    );
    const newId = correct(ws, oldId, "The north gate keypad code is 9921.", "user:alice", [eventId]);
    const recalled = recall(ws, "north gate keypad code");
    const old = getRecord(ws, oldId);
    const fresh = getRecord(ws, newId);

    probes.push(
      probe("interference", "current", "current value returns the latest record", contains(newId, recalled.items), `new=${contains(newId, recalled.items)}`),
      probe("interference", "preserve", "superseded row is excluded from recall", !contains(oldId, recalled.items), `old=${contains(oldId, recalled.items)}`),
      probe("interference", "previous", "previous value remains readable by id", bodyOf(old).includes("4410"), `status=${statusOf(old)}`),
      probe("interference", "update", "old row is superseded", statusOf(old) === "superseded", `status=${statusOf(old)}`),
      probe("interference", "update", "new row supersedes the old id", fresh.supersedes === oldId, `supersedes=${String(fresh.supersedes)}`),
      probe("interference", "source", "provenance source survives the correction", sourceOf(fresh) === "user:alice", `source=${sourceOf(fresh)}`),
    );
    if (statusOf(old) !== "superseded") invariants.push("interference old status not superseded");
    return { name: "interference", probes, invariants, extra: { oldId, newId } };
  } finally {
    ws.cleanup();
  }
}

function misinformationScenario(): ScenarioResult {
  const ws = new Workspace("remind-misinformation-");
  const probes: Probe[] = [];
  const invariants: string[] = [];
  try {
    const user = seedRecord(ws, "misinfo-user", "Alice's office is Room 210.", "user:alice");
    const model = seedRecord(
      ws,
      "misinfo-model",
      "Alice's office is Room 310.",
      "assistant:model",
      "model_inference",
    );
    const before = recall(ws, "Alice office room");
    const userRecord = getRecord(ws, user.id);
    const modelRecord = getRecord(ws, model.id);

    probes.push(
      probe("misinformation", "preserve", "user fact stays active", statusOf(userRecord) === "active", `status=${statusOf(userRecord)}`),
      probe("misinformation", "preserve", "model inference does not overwrite", bodyOf(userRecord).includes("210"), `body=${bodyOf(userRecord)}`),
      probe("misinformation", "current", "user fact is recalled", contains(user.id, before.items), `hit=${contains(user.id, before.items)}`),
      probe("misinformation", "source", "user fact keeps its source", sourceOf(userRecord) === "user:alice", `source=${sourceOf(userRecord)}`),
      probe("misinformation", "source", "model inference keeps its kind", modelRecord.kind === "model_inference", `kind=${String(modelRecord.kind)}`),
      probe("misinformation", "temporal", "both rows coexist before an explicit update", statusOf(userRecord) === "active" && statusOf(modelRecord) === "active", "coexist"),
    );

    const newId = correct(ws, user.id, "Alice's office is Room 310.", "user:alice", [user.eventId]);
    const after = recall(ws, "Alice office room");
    const old = getRecord(ws, user.id);
    const updated = getRecord(ws, newId);
    const modelAfter = getRecord(ws, model.id);

    const rankUser = indexOf(user.id, before.items);
    const rankModel = indexOf(model.id, before.items);
    probes.push(
      probe("misinformation", "update", "explicit correction is accepted", statusOf(updated) === "active" && bodyOf(updated).includes("310"), `status=${statusOf(updated)}`),
      probe("misinformation", "update", "old user fact is superseded", statusOf(old) === "superseded", `status=${statusOf(old)}`),
      probe("misinformation", "update", "corrected value is recalled", contains(newId, after.items), `hit=${contains(newId, after.items)}`),
      probe("misinformation", "preserve", "model inference is not auto-archived by a correction", statusOf(modelAfter) === "active", `status=${statusOf(modelAfter)}`),
      probe("misinformation", "source", "user fact outranks its model inference before correction", rankUser >= 0 && (rankModel < 0 || rankUser < rankModel), `user=${rankUser} model=${rankModel}`),
    );
    if (statusOf(old) !== "superseded") invariants.push("misinformation old status not superseded");
    return { name: "misinformation", probes, invariants, extra: { userId: user.id, modelId: model.id, newId } };
  } finally {
    ws.cleanup();
  }
}

function consolidationStrengthScenario(): ScenarioResult {
  const ws = new Workspace("remind-consolidation-");
  const probes: Probe[] = [];
  const invariants: string[] = [];
  try {
    const strong = seedRecord(ws, "strong", "The backup server is named Cedar.", "user:alice");
    const weak = seedRecord(ws, "weak", "The guest wifi password is 1122.", "user:alice");
    for (let i = 0; i < 3; i++) {
      const r = recall(ws, "backup server named Cedar");
      if (!contains(strong.id, r.items)) throw new HarnessError("strong fact not recalled for feedback");
      feedback(ws, r.recallId, strong.id);
    }
    const inference = seedRecord(
      ws,
      "strong-inference",
      "The backup server is named Birch.",
      "assistant:model",
      "model_inference",
    );
    seedRecord(
      ws,
      "weak-inference",
      "The guest wifi password is 3344.",
      "assistant:model",
      "model_inference",
    );

    const strongRecord = getRecord(ws, strong.id);
    const weakRecord = getRecord(ws, weak.id);
    const inferenceRecord = getRecord(ws, inference.id);
    const heatStrong = heatOf(ws.dbPath, strong.id);
    const heatWeak = heatOf(ws.dbPath, weak.id);

    probes.push(
      probe("consolidation", "preserve", "reinforced fact stays active", statusOf(strongRecord) === "active", `status=${statusOf(strongRecord)}`),
      probe("consolidation", "preserve", "weak fact stays active", statusOf(weakRecord) === "active", `status=${statusOf(weakRecord)}`),
      probe("consolidation", "preserve", "reinforced fact is not overwritten by an inference", bodyOf(strongRecord).includes("Cedar"), `body=${bodyOf(strongRecord)}`),
      probe("consolidation", "source", "inference remains model_inference", inferenceRecord.kind === "model_inference", `kind=${String(inferenceRecord.kind)}`),
      probe("consolidation", "temporal", "reinforcement heat is higher than a one-off", heatStrong > heatWeak, `strong=${heatStrong} weak=${heatWeak}`),
    );
    if (!(heatStrong > heatWeak)) invariants.push("reinforcement heat did not exceed the one-off");
    return { name: "consolidation", probes, invariants, extra: { heatStrong, heatWeak } };
  } finally {
    ws.cleanup();
  }
}

function reconsolidationScenario(): ScenarioResult {
  const ws = new Workspace("remind-reconsolidation-");
  const probes: Probe[] = [];
  const invariants: string[] = [];
  try {
    const fact = seedRecord(ws, "reconsolidation", "The team meeting is on Thursday.", "user:alice");
    const before = recall(ws, "team meeting day");
    const heatAfterRecall = heatOf(ws.dbPath, fact.id);
    seedRecord(
      ws,
      "reconsolidation-model",
      "The team meeting is on Friday.",
      "assistant:model",
      "model_inference",
    );
    const afterModel = recall(ws, "team meeting day");
    const recordAfterModel = getRecord(ws, fact.id);
    const searchedIds = searchIds(ws, "team meeting day");
    const recordAfterSearch = getRecord(ws, fact.id);
    const heatAfterSearch = heatOf(ws.dbPath, fact.id);

    probes.push(
      probe("reconsolidation", "preserve", "recall exposes the fact", contains(fact.id, before.items), `hit=${contains(fact.id, before.items)}`),
      probe("reconsolidation", "preserve", "mere recall does not heat", heatAfterRecall === 0, `heat=${heatAfterRecall}`),
      probe("reconsolidation", "preserve", "inference does not overwrite after recall", bodyOf(recordAfterModel).includes("Thursday"), `body=${bodyOf(recordAfterModel)}`),
      probe("reconsolidation", "preserve", "recall after the inference still returns the fact", contains(fact.id, afterModel.items), `hit=${contains(fact.id, afterModel.items)}`),
      probe("reconsolidation", "preserve", "explicit search does not reactivate or heat", statusOf(recordAfterSearch) === "active" && heatAfterSearch === 0, `status=${statusOf(recordAfterSearch)} heat=${heatAfterSearch}`),
      probe("reconsolidation", "source", "search returns the fact without changing its source", searchedIds.includes(fact.id) && sourceOf(recordAfterSearch) === "user:alice", `source=${sourceOf(recordAfterSearch)}`),
    );

    const newId = correct(ws, fact.id, "The team meeting is on Friday.", "user:alice", [fact.eventId]);
    const updated = getRecord(ws, newId);
    probes.push(
      probe("reconsolidation", "update", "explicit correction still updates after recall", statusOf(updated) === "active" && bodyOf(updated).includes("Friday"), `status=${statusOf(updated)}`),
    );
    if (heatAfterRecall !== 0) invariants.push("mere recall heated the record");
    return { name: "reconsolidation", probes, invariants, extra: { heatAfterRecall, heatAfterSearch } };
  } finally {
    ws.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* CMP: retrieval support diagnostic                                  */
/* ------------------------------------------------------------------ */

function supportSuite(): { invariants: string[]; report: Record<string, unknown> } {
  const ws = new Workspace("remind-support-");
  const invariants: string[] = [];
  try {
    const total = 30;
    const ids: string[] = [];
    for (let i = 0; i < total; i++) {
      const key = `support-${i}`;
      const anchor = `zxq${String(i).padStart(3, "0")}`;
      const seed = seedRecord(
        ws,
        key,
        `Synthetic ledger item ${anchor} records the measurement value ${100 + i}.`,
        "synthetic:evaluator",
      );
      ids.push(seed.id);
    }
    const required = 10;
    let supportFailures = 0;
    for (let i = 0; i < required; i++) {
      const anchor = `zxq${String(i).padStart(3, "0")}`;
      const r = recall(ws, `Synthetic ledger item ${anchor} measurement value`);
      if (!contains(ids[i]!, r.items)) supportFailures += 1;
    }
    const stats = exposureStats(ws.dbPath);
    if (stats.active !== total) invariants.push(`active count ${stats.active} != ${total}`);
    if (supportFailures > 0) invariants.push(`exact-anchor support failures: ${supportFailures}`);
    return {
      invariants,
      report: {
        required,
        requiredSupported: required - supportFailures,
        supportFailureRate: supportFailures / required,
        activeRecords: stats.active,
        exposedDistinct: stats.exposedDistinct,
        zeroExposureRate:
          stats.active > 0 ? Math.max(0, stats.active - stats.exposedDistinct) / stats.active : null,
      },
    };
  } finally {
    ws.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* Lifecycle: counterfactual KEEP / RETIRE / CORRECT                  */
/* ------------------------------------------------------------------ */

type Action = "keep" | "retire" | "correct";

interface Thread {
  key: string;
  body: string;
  replacement: string;
  probesShort: string[];
  probesFull: string[];
  /** Expected id per action at the time of the probe; null = no row satisfies the truth. */
  expected: Record<Action, string | null>;
  id: string;
  eventId: string;
}

interface BranchResult {
  utility: Record<number, number>;
}

function checkpoint(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  try {
    db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } finally {
    db.close();
  }
}

function copyDb(from: string, toDir: string): string {
  fs.mkdirSync(toDir, { recursive: true });
  const to = path.join(toDir, "memory-decisions.db");
  fs.copyFileSync(from, to);
  return to;
}

function branchUtility(
  baseConfigDir: string,
  baseDbPath: string,
  threads: Thread[],
  target: Thread,
  action: Action,
  future: string[],
): BranchResult {
  const branchDir = fs.mkdtempSync(path.join(baseConfigDir, `branch-${target.key}-${action}-`));
  copyDb(baseDbPath, branchDir);
  const ws = new Workspace(branchDir, false);
  const expected: Record<string, string | null> = {};
  for (const t of threads) expected[t.key] = t.expected.keep;
  expected[target.key] = target.expected[action];

  try {
    if (action === "retire") retire(ws, target.id);
    if (action === "correct") {
      const newId = correct(ws, target.id, target.replacement, "user:alice", [target.eventId]);
      expected[target.key] = target.key === "conflict" ? newId : null;
    }

    const utility: Record<number, number> = {};
    let written = 0;
    for (let i = 0; i < future.length; i++) {
      seedRecord(ws, `future-${i}`, future[i]!, "synthetic:evaluator");
      written += 1;
      if (written !== 2 && written !== 4) continue;
      const count = activeRecords(ws.dbPath);
      if (count < 0) throw new HarnessError("active record count unavailable");
      let pass = 0;
      let total = 0;
      for (const t of threads) {
        const queries = written === 2 ? t.probesShort : t.probesFull;
        for (const query of queries) {
          const r = recall(ws, query);
          const want = expected[t.key] ?? null;
          total += 1;
          if (want !== null && contains(want, r.items)) pass += 1;
        }
      }
      utility[written] = (total > 0 ? pass / total : 0) - STORAGE_PENALTY * count;
    }
    return { utility };
  } finally {
    ws.cleanup();
    try {
      fs.rmSync(branchDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  }
}

function lifecycleSuite(): { invariants: string[]; report: Record<string, unknown> } {
  const ws = new Workspace("remind-lifecycle-");
  const invariants: string[] = [];
  try {
    const threads: Thread[] = [];
    const seed = (key: string, body: string, replacement: string, probesShort: string[], probesFull = probesShort): Thread => {
      const r = seedRecord(ws, key, body, "user:alice");
      return {
        key,
        body,
        replacement,
        probesShort,
        probesFull,
        expected: { keep: r.id, retire: null, correct: null },
        id: r.id,
        eventId: r.eventId,
      };
    };
    threads.push(seed("exact", "The vault passphrase is ORCHID-42.", "The vault passphrase is TULIP-77.", ["vault passphrase ORCHID-42"]));
    threads.push(seed("recurrent", "The daily standup is at 9:30.", "The daily standup is at 10:30.", ["daily standup time 9:30"]));
    const conflict = seed("conflict", "The project deadline is October 10.", "The project deadline is October 20.", ["project deadline October"]);
    conflict.expected.keep = null;
    threads.push(conflict);
    threads.push(seed("transient", "The courier will call at 3pm on Tuesday about the parcel.", "The courier will call at 5pm on Tuesday about the parcel.", [], ["courier parcel delivery log"]));
    // Filler rows keep the recall window competitive without being probed.
    for (let i = 0; i < 4; i++) {
      seedRecord(ws, `filler-${i}`, `Synthetic filler note ${i} about routine office supplies.`, "synthetic:evaluator");
    }
    checkpoint(ws.dbPath);

    const future = [
      "Synthetic stream event 0 about the printer queue.",
      "Synthetic stream event 1 about the weekly report.",
      "Synthetic stream event 2 about the lunch order.",
      "Synthetic stream event 3 about the fire drill.",
    ];
    const actions: Action[] = ["keep", "retire", "correct"];
    const branches: Record<string, BranchResult> = {};
    for (const t of threads) {
      for (const a of actions) {
        branches[`${t.key}:${a}`] = branchUtility(ws.dir, ws.dbPath, threads, t, a, future);
      }
    }

    const perThread: Record<string, { short: { utilities: Record<Action, number>; oracle: Action }; full: { utilities: Record<Action, number>; oracle: Action } }> = {};
    const fixedByHorizon: Record<number, number> = { 2: -Infinity, 4: -Infinity };
    const fullChoices: Action[] = [];
    let reversals = 0;
    const choose = (utils: Record<Action, number>): Action =>
      actions.reduce((a, b) => (utils[b] > utils[a] ? b : a), actions[0]!);
    for (const t of threads) {
      const utilitiesAt = (h: number): Record<Action, number> => ({
        keep: branches[`${t.key}:keep`]!.utility[h]!,
        retire: branches[`${t.key}:retire`]!.utility[h]!,
        correct: branches[`${t.key}:correct`]!.utility[h]!,
      });
      const shortUtilities = utilitiesAt(2);
      const fullUtilities = utilitiesAt(4);
      const shortOracle = choose(shortUtilities);
      const fullOracle = choose(fullUtilities);
      if (shortOracle !== fullOracle) reversals += 1;
      fullChoices.push(fullOracle);
      perThread[t.key] = {
        short: { utilities: shortUtilities, oracle: shortOracle },
        full: { utilities: fullUtilities, oracle: fullOracle },
      };
    }
    for (const h of [2, 4]) {
      let meanOracle = 0;
      for (const t of threads) {
        const entry = perThread[t.key]!;
        meanOracle += h === 2 ? entry.short.utilities[entry.short.oracle] : entry.full.utilities[entry.full.oracle];
      }
      meanOracle /= threads.length;
      let bestFixed = -Infinity;
      for (const a of actions) {
        let mean = 0;
        for (const t of threads) mean += branches[`${t.key}:${a}`]!.utility[h]!;
        mean /= threads.length;
        if (mean > bestFixed) bestFixed = mean;
      }
      fixedByHorizon[h] = meanOracle - bestFixed;
    }
    const diversity = actions.reduce<Record<string, number>>((acc, a) => {
      acc[a] = fullChoices.filter((c) => c === a).length;
      return acc;
    }, {});
    if (Object.values(diversity).filter((n) => n > 0).length < 2) {
      invariants.push("lifecycle oracle has fewer than two distinct actions");
    }
    if ((fixedByHorizon[4] ?? 0) < -1e-9) invariants.push("lifecycle headroom is negative");

    return {
      invariants,
      report: {
        perThread,
        headroom: fixedByHorizon,
        horizonReversal: reversals / threads.length,
        oracleDiversity: diversity,
        labels: threads.map((t) => ({
          stream: "lifecycle",
          features: {
            kind: "user_fact",
            ageHours: 0,
            links: 0,
            heat: Math.max(0, heatOf(ws.dbPath, t.id)),
            exposures: Math.max(0, exposureCount(ws.dbPath, t.id)),
            hasConflict: false,
          },
          utility: {
            keep: perThread[t.key]!.full.utilities.keep,
            retire: perThread[t.key]!.full.utilities.retire,
            correct: perThread[t.key]!.full.utilities.correct,
          },
        })),
      },
    };
  } finally {
    ws.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* Governance: Epistemics gates                                       */
/* ------------------------------------------------------------------ */

function governanceSuite(): { invariants: string[]; report: GovernanceReport } {
  const ws = new Workspace("remind-governance-");
  try {
    const store: GovernanceStore = {
      dbPath: ws.dbPath,
      seed: (key, body, source, kind) => seedRecord(ws, key, body, source, kind),
      rememberDerived: (key, body, links, sourceRefs) => rememberDerived(ws, key, body, links, sourceRefs),
      recall: (query) => {
        const r = recall(ws, query);
        return { recallId: r.recallId, ids: r.items.map((i) => i.id) };
      },
      searchIds: (query) => searchIds(ws, query),
      get: (id) => {
        const r = getRecord(ws, id);
        return {
          id: r.id,
          body: typeof r.body === "string" ? r.body : "",
          status: typeof r.status === "string" ? r.status : "",
          kind: typeof r.kind === "string" ? r.kind : "",
          source: typeof r.source === "string" ? r.source : "",
        };
      },
      correct: (id, body, source, sourceRefs) => correct(ws, id, body, source, sourceRefs),
      retire: (id) => retire(ws, id),
      reactivate: (id) => reactivate(ws, id),
      auditFor: (targetId) => {
        const db = new DatabaseSync(ws.dbPath, { readOnly: true });
        try {
          const rows: unknown[] = db
            .prepare("SELECT op, code, targetId, reasonCode FROM audit WHERE targetId = ? ORDER BY rowid")
            .all(targetId);
          return rows.flatMap((row) => {
            if (!isObject(row)) return [];
            const op = row["op"];
            const code = row["code"];
            const target = row["targetId"];
            const reason = row["reasonCode"];
            if (typeof op !== "string" || typeof code !== "string" || typeof target !== "string") return [];
            return [{ op, code, targetId: target, reasonCode: typeof reason === "string" ? reason : null }];
          });
        } finally {
          db.close();
        }
      },
      auditColumns: () => {
        const db = new DatabaseSync(ws.dbPath, { readOnly: true });
        try {
          const rows: unknown[] = db.prepare("PRAGMA table_info(audit)").all();
          return rows.flatMap((row) => {
            if (!isObject(row) || typeof row["name"] !== "string") return [];
            return [row["name"]];
          });
        } finally {
          db.close();
        }
      },
    };
    const report = runGovernanceSuite(store);
    return { invariants: report.invariants, report };
  } finally {
    ws.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* Consolidate: opt-in model leg                                      */
/* ------------------------------------------------------------------ */

function countKind(dbPath: string, kind: string): number {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const row: unknown = db
      .prepare("SELECT COUNT(*) AS n FROM records WHERE kind = ? AND scope = ?")
      .get(kind, DECISIONS_SCOPE);
    return isObject(row) && typeof row["n"] === "number" ? row["n"] : -1;
  } catch {
    return -1;
  } finally {
    db.close();
  }
}

function sourceCount(ws: Workspace, id: string): number {
  const data = ws.must({ v: 1, op: "record.sources", params: { id, scope: DECISIONS_SCOPE } });
  if (!isObject(data) || !Array.isArray(data["sources"])) return -1;
  return data["sources"].length;
}

function consolidateSuite(llmConfigPath: string | null): { invariants: string[]; report: Record<string, unknown> } {
  if (llmConfigPath === null) {
    return { invariants: [], report: { status: "skipped", reason: "no-llm-config" } };
  }
  const parsed: unknown = JSON.parse(fs.readFileSync(llmConfigPath, "utf8"));
  if (!isObject(parsed) || !isObject(parsed["llm"])) {
    throw new HarnessError("llm config missing llm section");
  }
  const llm = parsed["llm"];
  if (llm["enabled"] !== true || llm["backend"] !== "openai") {
    return { invariants: [], report: { status: "skipped", reason: "llm-not-openai-enabled" } };
  }
  const overrides: Record<string, unknown> = { llm };
  const maintenance = parsed["maintenance"];
  const consolidate = parsed["consolidate"];
  if (isObject(maintenance)) overrides["maintenance"] = maintenance;
  if (isObject(consolidate)) overrides["consolidate"] = consolidate;
  const timeoutMs =
    isObject(maintenance) && typeof maintenance["timeoutMs"] === "number"
      ? maintenance["timeoutMs"] + 60000
      : 180000;

  const ws = new Workspace("remind-consolidate-", true, overrides);
  const invariants: string[] = [];
  try {
    const members = [
      seedRecord(ws, "consolidate-a", "Orchard project: the harvest starts on Friday.", "user:alice"),
      seedRecord(ws, "consolidate-b", "Orchard project: the crates arrive on Thursday.", "user:alice"),
      seedRecord(ws, "consolidate-c", "Orchard project: the barn is reserved for sorting.", "user:alice"),
    ];
    for (const member of members) {
      const r = getRecord(ws, member.id);
      if (typeof r.bodyHash !== "string") throw new HarnessError("record.get missing bodyHash");
      setTopic(ws, member.id, r.bodyHash, "orchard");
    }
    const data = ws.must(
      { v: 1, op: "maintain.consolidate", idempotencyKey: "consolidate-1", params: { scope: DECISIONS_SCOPE } },
      timeoutMs,
    );
    if (!isObject(data)) throw new HarnessError("consolidate bad data");
    const clusters = Array.isArray(data["clusters"]) ? data["clusters"] : [];
    const applied = typeof data["applied"] === "number" ? data["applied"] : -1;
    const degraded = data["degraded"] === true;
    if (degraded) {
      invariants.push("consolidate degraded with a configured model");
      return { invariants, report: { status: "degraded", applied, clusters, degraded } };
    }
    const written = clusters.flatMap((cluster) => {
      if (!isObject(cluster) || cluster["outcome"] !== "written" || typeof cluster["recordId"] !== "string") return [];
      return [{ recordId: cluster["recordId"], topic: cluster["topic"], members: cluster["members"], sentencesKept: cluster["sentencesKept"] }];
    });
    if (written.length === 0) {
      return { invariants, report: { status: "no-write", applied, clusters, degraded } };
    }
    const summary = getRecord(ws, written[0]!.recordId);
    const summaryLinks = Array.isArray(summary.links) ? summary.links.filter((v): v is string => typeof v === "string") : [];
    const membersActive = members.every((m) => getRecord(ws, m.id).status === "active");
    const summaryKind = summary.kind === "summary";
    const summarySource = typeof summary.source === "string" && summary.source.includes("derived");
    const linkCoverage = members.filter((m) => summaryLinks.includes(m.id)).length / members.length;
    const linksAreMembers = summaryLinks.length > 0 && summaryLinks.every((id) => members.some((m) => m.id === id));
    const sources = sourceCount(ws, summary.id);
    const beforeSecond = countKind(ws.dbPath, "summary");
    const second = ws.must(
      { v: 1, op: "maintain.consolidate", idempotencyKey: "consolidate-2", params: { scope: DECISIONS_SCOPE } },
      timeoutMs,
    );
    const secondClusters = isObject(second) && Array.isArray(second["clusters"]) ? second["clusters"] : [];
    const unchanged = secondClusters.some((c) => isObject(c) && c["outcome"] === "unchanged");
    const afterSecond = countKind(ws.dbPath, "summary");
    if (!summaryKind) invariants.push("consolidate summary kind is not summary");
    if (!summarySource) invariants.push("consolidate summary source is not derived");
    if (!linksAreMembers) invariants.push("consolidate summary links an id outside the cluster");
    if (sources <= 0) invariants.push("consolidate summary has no resolvable sources");
    if (!membersActive) invariants.push("consolidate retired a member");
    if (!unchanged) invariants.push("second consolidate did not report unchanged");
    if (afterSecond !== beforeSecond) invariants.push("second consolidate created a duplicate summary");
    return {
      invariants,
      report: {
        status: "ok",
        applied,
        clusters,
        summaryId: summary.id,
        summaryKind,
        summarySource,
        linksAreMembers,
        linkCoverage,
        sources,
        membersActive,
        unchanged,
        summaries: beforeSecond,
      },
    };
  } finally {
    ws.cleanup();
  }
}

/* ------------------------------------------------------------------ */
/* Metrics and report                                                 */
/* ------------------------------------------------------------------ */

function metrics(probes: Probe[]): Record<string, unknown> {
  const subset = (kind: Probe["kind"]): Probe[] => probes.filter((p) => p.kind === kind);
  const rate = (kind: Probe["kind"]): number | null => {
    const s = subset(kind);
    return s.length === 0 ? null : s.filter((p) => p.pass).length / s.length;
  };
  const stability = rate("preserve");
  const plasticity = rate("update");
  const sp =
    stability !== null && plasticity !== null && stability + plasticity > 0
      ? (2 * stability * plasticity) / (stability + plasticity)
      : null;
  return {
    stability,
    plasticity,
    spBalance: sp,
    historicalFidelity: rate("previous"),
    sourceFidelity: rate("source"),
    temporalFidelity: rate("temporal"),
    currentAccuracy: rate("current"),
    probes: probes.length,
    passed: probes.filter((p) => p.pass).length,
  };
}

function main(): void {
  const args = process.argv.slice(2);
  let outPath: string | null = null;
  let labelsPath: string | null = null;
  let llmConfigPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--out" && i + 1 < args.length) outPath = args[++i]!;
    else if (args[i] === "--labels" && i + 1 < args.length) labelsPath = args[++i]!;
    else if (args[i] === "--llm-config" && i + 1 < args.length) llmConfigPath = args[++i]!;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: evaluate-memory-decisions [--out <json>] [--labels <jsonl>] [--llm-config <path>]\n");
      process.stdout.write("\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }

  const invariants: string[] = [];
  const started = process.hrtime.bigint();

  const scenarios: ScenarioResult[] = [];
  for (const run of [interferenceScenario, misinformationScenario, consolidationStrengthScenario, reconsolidationScenario]) {
    try {
      scenarios.push(run());
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      invariants.push(`scenario failed: ${msg}`);
    }
  }
  const memprobes = scenarios.flatMap((s) => s.probes);
  for (const s of scenarios) invariants.push(...s.invariants);

  let support: Record<string, unknown> = {};
  try {
    const r = supportSuite();
    support = r.report;
    invariants.push(...r.invariants);
  } catch (e) {
    invariants.push(`support suite failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let lifecycle: Record<string, unknown> = {};
  try {
    const r = lifecycleSuite();
    lifecycle = r.report;
    invariants.push(...r.invariants);
  } catch (e) {
    invariants.push(`lifecycle suite failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let governance: GovernanceReport | null = null;
  try {
    const r = governanceSuite();
    governance = r.report;
    invariants.push(...r.invariants);
  } catch (e) {
    invariants.push(`governance suite failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  let consolidate: Record<string, unknown> = {};
  try {
    const r = consolidateSuite(llmConfigPath);
    consolidate = r.report;
    invariants.push(...r.invariants);
  } catch (e) {
    invariants.push(`consolidate suite failed: ${e instanceof Error ? e.message : String(e)}`);
  }

  const sorted = [...LATENCIES].sort((a, b) => a - b);
  const p50 = sorted.length > 0 ? (sorted[Math.floor(sorted.length * 0.5)] ?? null) : null;
  const p95 = sorted.length > 0 ? (sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ?? null) : null;

  const report = {
    version: DECISIONS_VERSION,
    scope: DECISIONS_SCOPE,
    generatedAt: new Date().toISOString(),
    model: "none by default; optional --llm-config enables maintain.consolidate",
    memprobe: {
      scenarios: scenarios.map((s) => ({ name: s.name, metrics: metrics(s.probes), invariants: s.invariants })),
      overall: metrics(memprobes),
    },
    support,
    lifecycle,
    governance,
    consolidate,
    invariants,
    latency: {
      calls: LATENCIES.length,
      p50,
      p95,
      totalMs: Number(process.hrtime.bigint() - started) / 1e6,
    },
    ok: invariants.length === 0,
  };

  const line = JSON.stringify(report) + "\n";
  process.stdout.write(line);
  if (outPath) {
    try {
      fs.writeFileSync(outPath, JSON.stringify(report, null, 2) + "\n", "utf8");
    } catch {
      process.stderr.write("error: cannot write report\n");
      process.exit(2);
    }
  }
  if (labelsPath) {
    try {
      const labels = lifecycle["labels"];
      const rows = Array.isArray(labels) ? labels.map((row) => JSON.stringify(row)) : [];
      fs.writeFileSync(labelsPath, rows.length > 0 ? rows.join("\n") + "\n" : "", "utf8");
    } catch {
      process.stderr.write("error: cannot write labels\n");
      process.exit(2);
    }
  }
  process.exit(invariants.length === 0 ? 0 : 1);
}

main();
