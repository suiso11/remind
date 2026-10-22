/**
 * ACT-R activation model + read-only activation preview.
 *
 * Base-level learning (ACT-R):
 *
 *   B_i = ln( Σ_j t_j^(-d) )                  (t_j in seconds/hours)
 *
 * This slice uses hours and a one-hour floor so very fresh events do not
 * dominate a long history:
 *
 *   A = ln( Σ_j max(Δt_j hours, 1)^(-d) )
 *       + wKind[kind]
 *       + wImportance · importance
 *
 * Event times t_j are canonical record events, never recall exposure:
 *   - record.createdAt
 *   - every record.feedback/usage timestamp for the record
 *   - every usage timestamp of superseded predecessors, followed through the
 *     records.supersedes chain (a correction inherits the history it replaces)
 *   - every correction event (a correction record that supersedes this row)
 *   - every record.reactivate audit event
 *
 * importance ∈ [0,1]; missing importance uses the neutral 0.5. The derived
 * record_importance row is only trusted while its bodyHash matches the
 * current record (a stale score after a correction is ignored).
 *
 * loadActivationInputs is bounded: at most ACTIVATION_MAX_RECORDS candidate
 * rows, chains are capped at ACTIVATION_CHAIN_MAX hops, and all ledger reads
 * use chunked IN queries. When only aggregate heat exists (note_heat usedCount
 * + lastUsedAt) the missing per-use timestamps are approximated by repeating
 * lastUsedAt for the residual count; that approximation is deterministic and
 * only affects the frequency term.
 *
 * Nothing here writes: no heat, exposure, usage, audit, importance, or status
 * changes. activation.preview is a pure read over an existing snapshot.
 */
import { randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  ACTIVATION_BATCH_MAX_CAP,
  activationBounds,
  maintenanceTimeoutMs,
  type ActivationConfig,
} from "./config.js";
import {
  acquireCultivationLease,
  isCultivationLeaseHeldBy,
  releaseCultivationLease,
  RETIRE_REASONS,
} from "./cultivation.js";
import {
  generateCompletion,
  llmEnabled,
  llmMaxPromptChars,
  llmTimeoutMs,
  modelFilesPresent as llmModelFilesPresent,
  resolveLlmDir,
} from "./llm.js";
import {
  countCp,
  hasControl,
  nowIso,
  requestHashFor,
  sha256HexUtf8,
} from "./normalize.js";
import { applyResponseBudget, fail, ok, type ResponseEnvelope } from "./protocol.js";
import {
  isScopeAuthorized,
  reactivateRecord,
  retireRecord,
  type CanonicalWriteFence,
} from "./store.js";

export const ACTIVATION_OP = "maintain.activation";

/** Injectable SLM generator (production: generateCompletion with the configured llm). */
export type ActivationGenerate = (
  prompt: string,
  maxNewTokens: number,
) => Promise<string | null>;

export type ActivationKind =
  | "user_fact"
  | "model_inference"
  | "summary"
  | "correction";
export type ActivationStatus = "active" | "retired" | "superseded" | "archived";
export type ActivationDecision = "keep" | "retire" | "reactivate";

export interface ActivationParams {
  decay: number;
  tauRetire: number;
  tauReactivate: number;
  minAgeHours: number;
  wImportance: number;
  wKind: Record<ActivationKind, number>;
  reconsiderLegacy: boolean;
}

export const ACTIVATION_DEFAULTS: ActivationParams = {
  decay: 0.5,
  tauRetire: -1.5,
  tauReactivate: -0.5,
  minAgeHours: 72,
  wImportance: 2.0,
  wKind: {
    user_fact: 1.0,
    model_inference: 0.0,
    summary: 0.3,
    correction: 1.0,
  },
  reconsiderLegacy: true,
};

/** Token budget for the one-digit importance answer. */
const IMPORTANCE_TOKEN_BUDGET = 8;

/**
 * Japanese ChatML prompt for importance scoring. The few-shot examples are
 * deliberately generic (no domain vocabulary), so the model learns the
 * retention semantics rather than copying corpus nouns. A missing score
 * (model disabled/missing/failed) is neutral, never an implicit zero.
 */
export function buildImportancePrompt(body: string, maxPromptChars = 2000): string {
  const head =
    "<|im_start|>system\n" +
    "あなたは記憶の重要度評価器です。記憶が長期的にユーザーを理解するのにどれほど役立つかを0〜3で評価してください。\n" +
    "3: 長く続く好み・所有物・人間関係・予定・アイデンティティに関する事実\n" +
    "2: 後で役立つ文脈\n" +
    "1: 些細な情報\n" +
    "0: 一時的な気分や一度きりの雑談\n" +
    "出力は数字1文字だけ。説明や文は書かないでください。\n" +
    "例：\n" +
    "「コーヒーはブラックが好き」→ 3\n" +
    "「週末は図書館へ行く予定」→ 3\n" +
    "「会議は3階で行われる」→ 2\n" +
    "「今日は少し疲れた」→ 0\n" +
    "<|im_end|>\n" +
    "<|im_start|>user\n";
  const tail = "<|im_end|>\n<|im_start|>assistant\n";
  const room = Math.max(1, maxPromptChars - countCp(head) - countCp(tail));
  const cps = [...body];
  const shown = cps.length > room ? cps.slice(0, room).join("") : body;
  return head + shown + tail;
}

/**
 * Strict importance parser: trim surrounding whitespace and accept exactly one
 * digit in 0..3. Anything else (words, punctuation, multi-digit, multi-line
 * answers) is null so the caller can leave the record unscored.
 */
export function parseImportance(raw: string | null | undefined): number | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  if (!/^[0-3]$/.test(trimmed)) return null;
  return Number(trimmed);
}

/** Maximum candidate records considered by one preview scan. */
export const ACTIVATION_MAX_RECORDS = 2000;
/** Maximum supersedes-chain hops followed for predecessor usage. */
export const ACTIVATION_CHAIN_MAX = 32;
/** Chunk size for bounded IN queries (well below SQLite's variable limit). */
const SQL_CHUNK = 300;
/** Label cap; the preview never returns more than a short body prefix. */
const LABEL_MAX_CP = 120;

export interface ActivationInput {
  recordId: string;
  kind: ActivationKind;
  status: ActivationStatus;
  /** Canonical creation time (ISO-8601). */
  createdAt: string;
  /** Canonical body, only used to derive a short label in preview. */
  body: string;
  /** Derived importance, or null when absent/stale. */
  importance: number | null;
  /** Feedback/usage count from note_heat (0 when no heat row). */
  uses: number;
  /** Additional event timestamps (usage/correction/reactivation/predecessor). */
  eventTimes: ReadonlyArray<string>;
  /** Latest metadata-only retirement reason, or null. */
  retireReason: string | null;
}

function toMs(value: string | number | Date): number | null {
  if (value instanceof Date) {
    const t = value.getTime();
    return Number.isFinite(t) ? t : null;
  }
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const t = Date.parse(value);
  return Number.isFinite(t) ? t : null;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0.5;
  if (n < 0) return 0;
  if (n > 1) return 1;
  return n;
}

/**
 * Pure ACT-R activation score. Deterministic for a given input/params/now.
 * Invalid event timestamps are ignored; no usable event time yields -Infinity.
 */
export function computeActivation(
  input: Pick<ActivationInput, "kind" | "createdAt" | "importance" | "eventTimes">,
  params: ActivationParams,
  now: string | number | Date,
): number {
  const nowMs = toMs(now);
  if (nowMs === null) return Number.NaN;
  let sum = 0;
  const times: Array<string | number> = [input.createdAt, ...input.eventTimes];
  for (const t of times) {
    const ms = toMs(t);
    if (ms === null) continue;
    const hours = Math.max((nowMs - ms) / 3_600_000, 1);
    sum += Math.pow(hours, -params.decay);
  }
  if (sum <= 0) return Number.NEGATIVE_INFINITY;
  const importance = clamp01(input.importance ?? 0.5);
  const kindWeight = params.wKind[input.kind] ?? 0;
  return Math.log(sum) + kindWeight + params.wImportance * importance;
}

/** Age in hours, clamped at 0 for clock skew/future creation times. */
export function activationAgeHours(
  createdAt: string,
  now: string | number | Date,
): number {
  const nowMs = toMs(now);
  const createdMs = toMs(createdAt);
  if (nowMs === null || createdMs === null) return 0;
  return Math.max((nowMs - createdMs) / 3_600_000, 0);
}

/**
 * Hysteresis gate. Active rows retire only below tauRetire and only after
 * minAgeHours. Retired rows reactivate only below the (higher) tauReactivate
 * threshold and only when the latest retirement was activation-driven
 * (LOW_ACTIVATION, or legacy LOW_SIGNAL when reconsiderLegacy is enabled).
 *
 * Protective margin: a record whose importance is at/above
 * `protectImportance` (default 0.66 ≈ 2/3) is never retired at the normal
 * threshold; it retires only if A falls below `tauRetire - 1`. This keeps a
 * model-scored lasting fact from being dropped by recency/frequency alone.
 */
export function retireDecision(
  A: number,
  status: ActivationStatus,
  retireReason: string | null,
  ageHours: number,
  params: ActivationParams,
  importance: number | null = null,
  protectImportance = 0.66,
): ActivationDecision {
  if (status === "active") {
    const belowRetire = A < params.tauRetire;
    if (!belowRetire || ageHours < params.minAgeHours) return "keep";
    const protectedImportance =
      importance !== null &&
      Number.isFinite(importance) &&
      importance >= protectImportance;
    if (protectedImportance && A >= params.tauRetire - 1) return "keep";
    return "retire";
  }
  if (status === "retired") {
    const activationDriven =
      retireReason === "LOW_ACTIVATION" ||
      (params.reconsiderLegacy && retireReason === "LOW_SIGNAL");
    return activationDriven && A >= params.tauReactivate ? "reactivate" : "keep";
  }
  return "keep";
}

function isRecordKind(v: string): v is ActivationKind {
  return (
    v === "user_fact" ||
    v === "model_inference" ||
    v === "summary" ||
    v === "correction"
  );
}

function isRecordStatus(v: string): v is ActivationStatus {
  return (
    v === "active" ||
    v === "retired" ||
    v === "superseded" ||
    v === "archived"
  );
}

function chunk<T>(items: T[], size = SQL_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function placeholders(n: number): string {
  return new Array(n).fill("?").join(",");
}

interface RecordRow {
  id: string;
  body: string;
  bodyHash: string;
  kind: string;
  status: string;
  createdAt: string;
  supersedes: string | null;
}

export interface LoadActivationOptions {
  /** Include retired rows (default true). Active-only scans pass false. */
  includeRetired?: boolean;
  /** Hard candidate cap (default ACTIVATION_MAX_RECORDS). */
  maxRecords?: number;
}

/**
 * Bounded activation inputs for one scope. See the header for the event
 * sources and the aggregate-heat approximation. Returns candidates only
 * (active, plus retired when requested); ancestor/correction/usage data is
 * folded into each candidate's eventTimes.
 */
export function loadActivationInputs(
  db: DatabaseSync,
  scope: string,
  options: LoadActivationOptions = {},
): ActivationInput[] {
  const includeRetired = options.includeRetired ?? true;
  const maxRecords = Math.max(1, Math.floor(options.maxRecords ?? ACTIVATION_MAX_RECORDS));
  const statuses = includeRetired ? "('active','retired')" : "('active')";
  const rows = db
    .prepare(
      `SELECT id, body, bodyHash, kind, status, createdAt, supersedes
         FROM records
        WHERE scope = ? AND status IN ${statuses}
        ORDER BY createdAt ASC, id ASC
        LIMIT ?`,
    )
    .all(scope, maxRecords) as unknown as RecordRow[];
  const candidates = rows.filter(
    (r) => isRecordKind(r.kind) && isRecordStatus(r.status),
  );
  if (candidates.length === 0) return [];
  const candidateIds = candidates.map((r) => r.id);
  const candidateSet = new Set(candidateIds);

  // Follow supersedes links (bounded) to collect predecessor ids per candidate.
  const ancestors = new Map<string, string[]>();
  for (const ids of chunk(candidateIds)) {
    const sql = `WITH RECURSIVE chain(rootId, id, supersedes, depth) AS (
        SELECT r.id, r.id, r.supersedes, 0 FROM records r WHERE r.id IN (${placeholders(ids.length)})
        UNION ALL
        SELECT c.rootId, p.id, p.supersedes, c.depth + 1
          FROM chain c JOIN records p ON p.id = c.supersedes
         WHERE c.depth < ${ACTIVATION_CHAIN_MAX}
      )
      SELECT rootId, id FROM chain WHERE depth > 0`;
    const found = db.prepare(sql).all(...ids) as unknown as Array<{
      rootId: string;
      id: string;
    }>;
    for (const row of found) {
      const list = ancestors.get(row.rootId);
      if (!list) ancestors.set(row.rootId, [row.id]);
      else if (!list.includes(row.id)) list.push(row.id);
    }
  }

  const allIds = [...candidateIds];
  for (const list of ancestors.values()) {
    for (const id of list) if (!candidateSet.has(id)) allIds.push(id);
  }

  // Heat aggregates (uses output + aggregate-only usage approximation).
  const heat = new Map<string, { usedCount: number; lastUsedAt: string }>();
  for (const ids of chunk(allIds)) {
    const found = db
      .prepare(
        `SELECT recordId, usedCount, lastUsedAt FROM note_heat WHERE recordId IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as unknown as Array<{
      recordId: string;
      usedCount: number;
      lastUsedAt: string;
    }>;
    for (const row of found) heat.set(row.recordId, row);
  }

  // Per-usage timestamps (canonical feedback ledger).
  const usageTimes = new Map<string, string[]>();
  for (const ids of chunk(allIds)) {
    const found = db
      .prepare(
        `SELECT recordId, ts FROM usage WHERE recordId IN (${placeholders(ids.length)}) ORDER BY ts ASC`,
      )
      .all(...ids) as unknown as Array<{ recordId: string; ts: string }>;
    for (const row of found) {
      const list = usageTimes.get(row.recordId);
      if (list) list.push(row.ts);
      else usageTimes.set(row.recordId, [row.ts]);
    }
  }

  // Corrections that supersede a candidate.
  const correctionTimes = new Map<string, string[]>();
  for (const ids of chunk(candidateIds)) {
    const found = db
      .prepare(
        `SELECT supersedes, createdAt FROM records
          WHERE kind = 'correction' AND supersedes IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as unknown as Array<{ supersedes: string; createdAt: string }>;
    for (const row of found) {
      const list = correctionTimes.get(row.supersedes);
      if (list) list.push(row.createdAt);
      else correctionTimes.set(row.supersedes, [row.createdAt]);
    }
  }

  // Reactivation events (metadata-only audit).
  const reactivationTimes = new Map<string, string[]>();
  for (const ids of chunk(candidateIds)) {
    const found = db
      .prepare(
        `SELECT targetId, ts FROM audit
          WHERE op = 'record.reactivate' AND targetId IN (${placeholders(ids.length)})
          ORDER BY ts ASC, rowid ASC`,
      )
      .all(...ids) as unknown as Array<{ targetId: string; ts: string }>;
    for (const row of found) {
      const list = reactivationTimes.get(row.targetId);
      if (list) list.push(row.ts);
      else reactivationTimes.set(row.targetId, [row.ts]);
    }
  }

  // Latest retirement reason for retired candidates, from ANY op that can
  // retire a record. Production retirements are mostly written by
  // maintain.cultivate on behalf of maintain.distill (reasonCode LOW_SIGNAL);
  // maintain.activation itself reuses record.retire (LOW_ACTIVATION). Older
  // databases may also carry maintain.distill/maintain.activation target rows.
  // Filtering by the fixed retire codes excludes cultivate keep/reactivate
  // rows (STILL_USEFUL) and per-batch summary audit rows.
  const retireReasons = new Map<string, string | null>();
  const retiredIds = candidates.filter((r) => r.status === "retired").map((r) => r.id);
  const retirementOps = [
    "record.retire",
    "maintain.cultivate",
    "maintain.cultivation",
    "maintain.distill",
    "maintain.activation",
  ];
  for (const ids of chunk(retiredIds)) {
    const found = db
      .prepare(
        `SELECT targetId, reasonCode FROM audit
          WHERE op IN (${placeholders(retirementOps.length)})
            AND targetId IN (${placeholders(ids.length)})
            AND reasonCode IN (${placeholders(RETIRE_REASONS.length)})
          ORDER BY ts ASC, rowid ASC`,
      )
      .all(...retirementOps, ...ids, ...RETIRE_REASONS) as unknown as Array<{
      targetId: string;
      reasonCode: string | null;
    }>;
    for (const row of found) retireReasons.set(row.targetId, row.reasonCode);
  }

  // Derived importance, only when it still matches the current bodyHash.
  const importance = new Map<string, { value: number; bodyHash: string }>();
  for (const ids of chunk(candidateIds)) {
    const found = db
      .prepare(
        `SELECT recordId, importance, bodyHash FROM record_importance WHERE recordId IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as unknown as Array<{
      recordId: string;
      importance: number;
      bodyHash: string;
    }>;
    for (const row of found) {
      importance.set(row.recordId, { value: row.importance, bodyHash: row.bodyHash });
    }
  }
  const hashOf = new Map(candidates.map((r) => [r.id, r.bodyHash]));

  const timesFor = (id: string): string[] => {
    const out: string[] = [];
    out.push(...(usageTimes.get(id) ?? []));
    const h = heat.get(id);
    if (h && Number.isFinite(h.usedCount) && h.usedCount > 0) {
      const residual = h.usedCount - (usageTimes.get(id)?.length ?? 0);
      // Aggregate-only legacy rows: repeat lastUsedAt for the residual count.
      for (let i = 0; i < Math.min(residual, 1000); i++) out.push(h.lastUsedAt);
    }
    return out;
  };

  return candidates.map((r) => {
    const eventTimes: string[] = [];
    eventTimes.push(...timesFor(r.id));
    for (const ancestorId of ancestors.get(r.id) ?? []) {
      eventTimes.push(...timesFor(ancestorId));
    }
    eventTimes.push(...(correctionTimes.get(r.id) ?? []));
    eventTimes.push(...(reactivationTimes.get(r.id) ?? []));
    const imp = importance.get(r.id);
    const freshImp =
      imp !== undefined && Number.isFinite(imp.value) && imp.bodyHash === hashOf.get(r.id)
        ? imp.value
        : null;
    return {
      recordId: r.id,
      kind: r.kind as ActivationKind,
      status: r.status as ActivationStatus,
      createdAt: r.createdAt,
      body: r.body,
      importance: freshImp,
      uses: heat.get(r.id)?.usedCount ?? 0,
      eventTimes,
      retireReason: retireReasons.get(r.id) ?? null,
    };
  });
}

/* ------------------------------------------------------------------ */
/* activation.preview (read-only)                                      */
/* ------------------------------------------------------------------ */

interface PreviewCursor {
  a: number;
  id: string;
}

function encodeCursor(c: PreviewCursor): string {
  return Buffer.from(JSON.stringify(c), "utf8").toString("base64url");
}

function decodeCursor(raw: string): PreviewCursor | null {
  if (raw.length === 0 || raw.length > 1024) return null;
  try {
    const parsed = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    const a = o["a"];
    const id = o["id"];
    if (typeof a !== "number" || !Number.isFinite(a)) return null;
    if (typeof id !== "string" || id.length < 1 || id.length > 256) return null;
    return { a, id };
  } catch {
    return null;
  }
}

function parseScope(scope: unknown): string | null {
  if (typeof scope !== "string") return null;
  const n = countCp(scope);
  if (n < 1 || n > 256) return null;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001F\u007F-\u009F]/.test(scope)) return null;
  return scope;
}

function scopeDenied(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
): ResponseEnvelope | null {
  if (!config.allowedScopes.includes(scope)) return fail("FORBIDDEN_SCOPE");
  try {
    const row = db.prepare(`SELECT 1 AS ok FROM scopes WHERE scope = ?`).get(scope);
    return row ? null : fail("FORBIDDEN_SCOPE");
  } catch {
    return fail("STORE_UNAVAILABLE");
  }
}

function labelOf(body: string, snippetMaxCp: number): string {
  const cap = Math.min(Math.max(1, snippetMaxCp), LABEL_MAX_CP);
  const cps = [...body];
  return cps.length <= cap ? body : cps.slice(0, cap).join("");
}

export interface PreviewItem {
  id: string;
  status: string;
  kind: string;
  label: string;
  A: number;
  importance: number | null;
  uses: number;
  ageHours: number;
  decision: ActivationDecision;
}

/**
 * activation.preview {scope, limit?, cursor?, includeRetired?=true}.
 * Items are ordered by A ASC (retirement candidates first), id ASC; summary
 * counts cover the whole bounded scan, not just the returned page. Pure read:
 * no heat/exposure/usage/audit/importance/status writes.
 */
export function activationPreview(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  nowOverride?: string,
): ResponseEnvelope {
  const allowed = new Set(["scope", "limit", "cursor", "includeRetired"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);

  let includeRetired = true;
  if (params["includeRetired"] !== undefined) {
    if (typeof params["includeRetired"] !== "boolean") {
      return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
    }
    includeRetired = params["includeRetired"];
  }

  let limit = Math.min(config.limits.limitDefault, config.limits.limitMax);
  if (params["limit"] !== undefined) {
    const n = params["limit"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) {
      return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
    }
    if (n > config.limits.limitMax) {
      return applyResponseBudget(fail("LIMIT_EXCEEDED"), config.limits.responseMaxBytes);
    }
    limit = n;
  }

  let cursor: PreviewCursor | null = null;
  if (params["cursor"] !== undefined && params["cursor"] !== null) {
    if (typeof params["cursor"] !== "string") {
      return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
    }
    cursor = decodeCursor(params["cursor"]);
    if (cursor === null) {
      return applyResponseBudget(fail("BAD_REQUEST"), config.limits.responseMaxBytes);
    }
  }

  const denied = scopeDenied(db, config, scope);
  if (denied) return applyResponseBudget(denied, config.limits.responseMaxBytes);

  const now = nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) {
    return applyResponseBudget(fail("STORE_UNAVAILABLE"), config.limits.responseMaxBytes);
  }
  const bounds: ActivationConfig = activationBounds(config);
  const paramsForModel: ActivationParams = bounds;

  let inputs: ActivationInput[];
  try {
    inputs = loadActivationInputs(db, scope, { includeRetired });
  } catch {
    return applyResponseBudget(fail("STORE_UNAVAILABLE"), config.limits.responseMaxBytes);
  }

  const scored: PreviewItem[] = inputs.map((input) => {
    const A = computeActivation(input, paramsForModel, now);
    const ageHours = activationAgeHours(input.createdAt, now);
    return {
      id: input.recordId,
      status: input.status,
      kind: input.kind,
      label: labelOf(input.body, config.limits.snippetMaxCp),
      A,
      importance: input.importance,
      uses: input.uses,
      ageHours,
      decision: retireDecision(
        A,
        input.status,
        input.retireReason,
        ageHours,
        paramsForModel,
        input.importance,
        bounds.protectImportance,
      ),
    };
  });

  const summary = {
    total: scored.length,
    active: scored.filter((i) => i.status === "active").length,
    retired: scored.filter((i) => i.status === "retired").length,
    keep: scored.filter((i) => i.decision === "keep").length,
    retire: scored.filter((i) => i.decision === "retire").length,
    reactivate: scored.filter((i) => i.decision === "reactivate").length,
  };

  scored.sort((x, y) => (x.A === y.A ? (x.id < y.id ? -1 : x.id > y.id ? 1 : 0) : x.A - y.A));
  const remaining =
    cursor === null
      ? scored
      : scored.filter(
          (i) => i.A > cursor.a || (i.A === cursor.a && i.id > cursor.id),
        );

  // Deterministically shrink the page until the envelope fits the budget.
  let page = remaining.slice(0, limit);
  const build = (items: PreviewItem[], hasMore: boolean): ResponseEnvelope =>
    ok({
      items,
      summary,
      nextCursor: hasMore && items.length > 0 ? encodeCursor({ a: items[items.length - 1].A, id: items[items.length - 1].id }) : null,
    });
  let res = applyResponseBudget(build(page, remaining.length > page.length), config.limits.responseMaxBytes);
  while (!res.ok && page.length > 0) {
    page = page.slice(0, page.length - 1);
    res = applyResponseBudget(build(page, remaining.length > page.length), config.limits.responseMaxBytes);
  }
  return res;
}

/* ------------------------------------------------------------------ */
/* maintain.activation (importance scoring + optional apply)           */
/* ------------------------------------------------------------------ */

function budgeted(res: ResponseEnvelope, config: AppConfig): ResponseEnvelope {
  return applyResponseBudget(res, config.limits.responseMaxBytes);
}

function conflict(): ResponseEnvelope {
  return fail("CONFLICT");
}

function bad(): ResponseEnvelope {
  return fail("BAD_REQUEST");
}

export interface ActivationOpParams {
  scope: string;
  limit: number;
}

/** Strict maintain.activation params (sync, no I/O). */
export function parseActivationParams(
  config: AppConfig,
  params: Record<string, unknown>,
): { ok: true; value: ActivationOpParams } | { ok: false; res: ResponseEnvelope } {
  const allowed = new Set(["scope", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: budgeted(bad(), config) };
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return { ok: false, res: budgeted(bad(), config) };
  const bounds = activationBounds(config);
  let limit = bounds.batchMax;
  if (params["limit"] !== undefined) {
    const v = params["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, res: budgeted(bad(), config) };
    }
    if (v > ACTIVATION_BATCH_MAX_CAP) {
      return { ok: false, res: budgeted(fail("LIMIT_EXCEEDED"), config) };
    }
    limit = v;
  }
  return { ok: true, value: { scope, limit } };
}

function scopeGate(db: DatabaseSync, config: AppConfig, scope: string): ResponseEnvelope | null {
  try {
    if (!isScopeAuthorized(db, config, scope)) return budgeted(fail("FORBIDDEN_SCOPE"), config);
    return null;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}

interface StoredOp {
  op: string;
  requestHash: string;
  responseJson: string;
}

function readOperation(db: DatabaseSync, key: string): StoredOp | null {
  const row = db
    .prepare(`SELECT op, requestHash, responseJson FROM operations WHERE idempotencyKey = ?`)
    .get(key) as StoredOp | undefined;
  return row ?? null;
}

function storeActivationResult(
  db: DatabaseSync,
  key: string,
  reqHash: string,
  stored: ResponseEnvelope,
  scope: string,
  now: string,
  limitN: number,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
    ).run(key, ACTIVATION_OP, reqHash, JSON.stringify(stored), now);
    db.prepare(
      `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
       VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      now,
      ACTIVATION_OP,
      stored.code,
      scope,
      Buffer.byteLength(JSON.stringify(stored), "utf8"),
      limitN,
    );
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

function handleStoreRace(
  db: DatabaseSync,
  config: AppConfig,
  idempotencyKey: string,
  reqHash: string,
  e: unknown,
): ResponseEnvelope {
  const msg = e instanceof Error ? e.message : String(e);
  if (/UNIQUE constraint failed: operations/.test(msg)) {
    let again: StoredOp | null = null;
    try {
      again = readOperation(db, idempotencyKey);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    if (again && again.op === ACTIVATION_OP && again.requestHash === reqHash) {
      try {
        return budgeted(
          { ...(JSON.parse(again.responseJson) as ResponseEnvelope), deduplicated: true },
          config,
        );
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
    }
    return budgeted(conflict(), config);
  }
  return budgeted(fail("STORE_UNAVAILABLE"), config);
}

interface UnscoredRow {
  id: string;
  bodyNorm: string;
  bodyHash: string;
}

/** Active+retired records with no importance row for the current bodyHash. */
function selectUnscored(db: DatabaseSync, scope: string, limit: number): UnscoredRow[] {
  return db
    .prepare(
      `SELECT r.id AS id, r.bodyNorm AS bodyNorm, r.bodyHash AS bodyHash
         FROM records r
         LEFT JOIN record_importance i ON i.recordId = r.id
        WHERE r.scope = ? AND r.status IN ('active','retired')
          AND (i.recordId IS NULL OR i.bodyHash <> r.bodyHash)
        ORDER BY r.createdAt ASC, r.id ASC
        LIMIT ?`,
    )
    .all(scope, limit) as unknown as UnscoredRow[];
}

interface ImportanceWrite {
  recordId: string;
  importance: number;
  bodyHash: string;
}

function writeImportance(
  db: DatabaseSync,
  writes: ImportanceWrite[],
  now: string,
  fenceOwner: string,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!isCultivationLeaseHeldBy(db, fenceOwner, now)) throw new Error("lease lost");
    const stmt = db.prepare(
      `INSERT INTO record_importance(recordId, importance, bodyHash, source, scoredAt)
       VALUES (?, ?, ?, 'llm', ?)
       ON CONFLICT(recordId) DO UPDATE SET
         importance = excluded.importance,
         bodyHash = excluded.bodyHash,
         source = excluded.source,
         scoredAt = excluded.scoredAt`,
    );
    for (const w of writes) stmt.run(w.recordId, w.importance, w.bodyHash, now);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

interface ActivationDecisionItem {
  id: string;
  decision: ActivationDecision;
}

/**
 * Run one bounded maintain.activation pass.
 *
 * Step (a): score importance for up to `limit` active+retired records whose
 * record_importance row is missing or stale for the current bodyHash. The
 * score is stored as `digit / 3` with source='llm'. When the configured LLM is
 * disabled/missing (and no injected generator applies), scoring is skipped and
 * `degraded` is true.
 *
 * Step (b): compute ACT-R activation over the scope. Decisions are applied
 * only when `activation.apply` is true (default false); otherwise the response
 * reports wouldRetire/wouldReactivate and changes nothing. Applied transitions
 * reuse record.retire/reactivate (audit + operations ledger) with LOW_ACTIVATION
 * for retirement and STILL_USEFUL for reactivation, each fenced inside its own
 * transaction by the shared cultivation lease.
 *
 * Idempotent per caller key: same key + same params replays the stored
 * envelope; changed params => CONFLICT. Lease contention => transient CONFLICT.
 */
export async function maintainActivation(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
  params: Record<string, unknown>,
  idempotencyKey: string,
  generateOverride?: ActivationGenerate,
  nowOverride?: string,
): Promise<ResponseEnvelope> {
  const parsed = parseActivationParams(config, params);
  if (!parsed.ok) return parsed.res;
  const p = parsed.value;
  const reqHash = requestHashFor(ACTIVATION_OP, { limit: p.limit, scope: p.scope });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== ACTIVATION_OP) return budgeted(conflict(), config);
    const denied = scopeGate(db, config, p.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(conflict(), config);
    try {
      const replay = JSON.parse(saved.responseJson) as ResponseEnvelope;
      return budgeted({ ...replay, deduplicated: true }, config);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
  }
  {
    const denied = scopeGate(db, config, p.scope);
    if (denied) return denied;
  }

  const nowValid = nowOverride ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(nowValid))) return budgeted(fail("STORE_UNAVAILABLE"), config);
  const execOwner = `${idempotencyKey}#${randomBytes(8).toString("hex")}`;
  const lease = acquireCultivationLease(db, config, {
    owner: execOwner,
    scope: p.scope,
    now: nowValid,
  });
  if (!lease.acquired) return budgeted(conflict(), config);

  try {
    const bounds = activationBounds(config);
    const maintenanceMs = maintenanceTimeoutMs(config);
    const startedMs = Date.now();
    const overDeadline = (): boolean => Date.now() - startedMs > maintenanceMs;
    const testClock = nowOverride !== undefined;
    const renewNow = (): string => (testClock ? nowValid : new Date().toISOString());
    const renew = (): boolean =>
      acquireCultivationLease(db, config, {
        owner: execOwner,
        scope: p.scope,
        now: renewNow(),
      }).acquired;

    let scored = 0;
    let scoreFailed = 0;
    let degraded = false;

    const llmModelDir = resolveLlmDir(config, configPath);
    const modelUsable = llmEnabled(config) && llmModelFilesPresent(llmModelDir);
    // An injected generator against a config without an llm section is the
    // test model itself (same convention as episodes/associate).
    const usable = modelUsable || (generateOverride !== undefined && config.llm === undefined);
    if (!usable) degraded = true;

    if (usable) {
      let candidates: UnscoredRow[];
      try {
        candidates = selectUnscored(db, p.scope, p.limit);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      const generate: ActivationGenerate =
        generateOverride ??
        ((prompt, tokens) =>
          generateCompletion(prompt, llmModelDir, {
            timeoutMs: llmTimeoutMs(config),
            maxNewTokens: tokens,
          }));
      const maxPromptChars = llmMaxPromptChars(config);
      const writes: ImportanceWrite[] = [];
      for (const row of candidates) {
        if (overDeadline()) {
          degraded = true;
          break;
        }
        let raw: string | null = null;
        try {
          raw = await generate(buildImportancePrompt(row.bodyNorm, maxPromptChars), IMPORTANCE_TOKEN_BUDGET);
        } catch {
          raw = null;
        }
        const digit = parseImportance(raw);
        if (digit === null) {
          scoreFailed++;
          continue;
        }
        writes.push({ recordId: row.id, importance: digit / 3, bodyHash: row.bodyHash });
      }
      if (writes.length > 0) {
        try {
          writeImportance(db, writes, nowValid, execOwner);
          scored = writes.length;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return budgeted(fail(msg === "lease lost" ? "CONFLICT" : "STORE_UNAVAILABLE"), config);
        }
      }
      if (scoreFailed > 0) degraded = true;
    }

    let inputs: ActivationInput[];
    try {
      inputs = loadActivationInputs(db, p.scope, { includeRetired: true });
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }

    const decisions: ActivationDecisionItem[] = inputs.map((input) => {
      const A = computeActivation(input, bounds, nowValid);
      const ageHours = activationAgeHours(input.createdAt, nowValid);
      const decision = retireDecision(
        A,
        input.status,
        input.retireReason,
        ageHours,
        bounds,
        input.importance,
        bounds.protectImportance,
      );
      return { id: input.recordId, decision };
    });

    const wouldRetire = decisions.filter((d) => d.decision === "retire").length;
    const wouldReactivate = decisions.filter((d) => d.decision === "reactivate").length;
    let retired = 0;
    let reactivated = 0;

    if (bounds.apply && (wouldRetire > 0 || wouldReactivate > 0)) {
      // Heartbeat before applying; each transition re-checks the lease inside
      // its own transaction via CanonicalWriteFence.
      if (!renew()) return budgeted(conflict(), config);
      const fence: CanonicalWriteFence = { owner: execOwner, now: nowValid };
      for (const item of decisions) {
        if (overDeadline()) break;
        if (item.decision !== "retire" && item.decision !== "reactivate") continue;
        const innerKey = sha256HexUtf8(`${ACTIVATION_OP}:${idempotencyKey}:${item.id}`);
        const transitionParams = {
          id: item.id,
          scope: p.scope,
          reasonCode: item.decision === "retire" ? "LOW_ACTIVATION" : "STILL_USEFUL",
        };
        const res =
          item.decision === "retire"
            ? retireRecord(db, config, transitionParams, innerKey, nowValid, fence)
            : reactivateRecord(db, config, transitionParams, innerKey, nowValid, fence);
        if (res.ok) {
          if (item.decision === "retire") retired++;
          else reactivated++;
        } else if (res.code === "STORE_UNAVAILABLE") {
          return budgeted(fail("STORE_UNAVAILABLE"), config);
        } else if (
          res.code === "CONFLICT" &&
          !isCultivationLeaseHeldBy(db, execOwner, renewNow())
        ) {
          // The lease was stolen/expired between decisions: stop without
          // further transitions. The partial set was applied under valid
          // fences and replays idempotently on the next run.
          return budgeted(conflict(), config);
        }
        // NOT_FOUND/FORBIDDEN_SCOPE/CONFLICT with a live lease mean the row
        // changed under us or is no longer reversible: leave it for next pass.
      }
    }

    const stored = budgeted(
      ok({
        scored,
        scoreFailed,
        retired,
        reactivated,
        wouldRetire,
        wouldReactivate,
        degraded,
      }),
      config,
    );
    try {
      storeActivationResult(db, idempotencyKey, reqHash, stored, p.scope, nowValid, p.limit);
    } catch (e) {
      return handleStoreRace(db, config, idempotencyKey, reqHash, e);
    }
    return stored;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  } finally {
    try {
      releaseCultivationLease(db, execOwner);
    } catch {
      /* best-effort */
    }
  }
}
