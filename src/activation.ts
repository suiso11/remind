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
  cultivationBounds,
  maintenanceTimeoutMs,
  type ActivationConfig,
} from "./config.js";
import {
  acquireCultivationLease,
  isCultivationLeaseHeldBy,
  releaseCultivationLease,
  withLeaseHeartbeat,
  RETIRE_REASONS,
} from "./cultivation.js";
import {
  generateCompletion,
  llmMaxPromptChars,
  llmTimeoutMs,
  llmUsable,
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
  assertDbUnderCap,
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
  signal?: AbortSignal,
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
  wNature: Record<NatureLabel, number>;
  wLinks: number;
  expiryGraceDays: number;
  wExpired: number;
  wConsolidated: number;
  minAgeHoursByNature: Partial<Record<NatureLabel, number>>;
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
  wNature: {
    FACT: 1.0,
    PREFERENCE: 1.0,
    RELATIONSHIP: 1.2,
    PROJECT: 1.0,
    OPINION: 0.6,
    PLAN: 0.6,
    EVENT: 0.4,
    EMOTION: -0.8,
    TRANSIENT: -1.5,
    GREETING: -2.5,
    CHATOPS: -2.0,
  },
  wLinks: 0.8,
  expiryGraceDays: 3,
  wExpired: 2.0,
  wConsolidated: 0.5,
  minAgeHoursByNature: {
    GREETING: 24,
    CHATOPS: 24,
    EMOTION: 72,
    TRANSIENT: 72,
  },
};

/** Nature labels produced by the combined retention classifier. */
export const NATURE_LABELS = [
  "FACT",
  "PREFERENCE",
  "OPINION",
  "PLAN",
  "EVENT",
  "RELATIONSHIP",
  "PROJECT",
  "EMOTION",
  "TRANSIENT",
  "GREETING",
  "CHATOPS",
] as const;
export type NatureLabel = (typeof NATURE_LABELS)[number];

export interface NatureClassification {
  nature: NatureLabel;
  importance: number;
}

/**
 * Token budget for the combined nature+importance JSON answer. The old
 * one-digit budget (8) was too tight for a JSON object once the model emitted
 * any prefix/thinking token; the strict parser below still accepts surrounding
 * prose, but the budget must leave room for the object itself.
 */
const CLASSIFIER_TOKEN_BUDGET = 64;

/**
 * Classifier prompt/semantics version. Bump this whenever the definitions or
 * few-shot examples change: the value is persisted in record_importance.source
 * ("llm:v2"), and selectUnscored treats rows stamped with an older version as
 * unscored so a prompt change rescans the corpus once.
 */
export const CLASSIFIER_VERSION = "v2";
/** Value written to record_importance.source for the current classifier. */
export const CLASSIFIER_SOURCE = `llm:${CLASSIFIER_VERSION}`;

/** Minimum body room the classifier keeps even when llm.maxPromptChars is
 *  below the fixed instruction size (500..8000 documented range). */
const MIN_CLASSIFIER_BODY_CP = 200;

/**
 * Japanese ChatML prompt for the ONE combined retention classifier.
 *
 * The single call returns the nature label plus the 0-3 importance in strict
 * JSON, so maintain.activation has one consistent retention signal instead of
 * two independent gates. Definitions are generic and never keyword-scanned
 * from the body. The body is clipped to the remaining character budget and the
 * assistant cue is preserved (tailClip-equivalent guard below) so the ChatML
 * conversion to the OpenAI backend always sees a complete prefill.
 *
 * Boundary rules (v2): CHATOPS is ONLY operating this assistant/conversation
 * itself (search requests, remarks about tone/persona/mistakes, "can you do
 * X", "anything else to talk about") with no lasting content. A question or
 * request ABOUT a topic in the world reveals the user's interest and is
 * PREFERENCE (or OPINION when it states a stance). Things the user builds,
 * changes, or names (models, projects, tools, features to add) are PROJECT.
 * Feelings about a person are RELATIONSHIP (or EMOTION when momentary).
 * GREETING is only greetings/goodnight/thanks/compliments with no other
 * content.
 */
export function buildClassifierPrompt(body: string, maxPromptChars = 2000): string {
  const head =
    "<|im_start|>system\n" +
    "あなたは記憶の保持価値を判定する分類器です。記憶を読み、nature ラベルと重要度 importance を1つのJSONで返してください。\n" +
    "基本方針: 世界の話題についての質問・依頼は、その話題へのユーザーの関心を示す。\n" +
    "nature は次のいずれか1つだけ:\n" +
    "FACT: ユーザー本人・持ち物・環境（使用中のモデル・ツールを含む）について長く続く事実\n" +
    "PREFERENCE: 好き嫌い・好み・こだわり・関心・習慣・傾向（話題についての質問や依頼も、その話題への興味として PREFERENCE）\n" +
    "OPINION: 意見・信念・判断・立場（話題について自分の考えを述べた場合）\n" +
    "PLAN: 今後やろうとしていること・目標\n" +
    "EVENT: その日を超えて意味のある出来事\n" +
    "RELATIONSHIP: 人物・集団・関係性、特定の人物への好意・可愛い/好きという感情（対象が人なら PREFERENCE ではなく RELATIONSHIP）\n" +
    "PROJECT: ユーザーが作る・変える・名付けるもの（モデル・プロジェクト・ツール・追加したい機能・使用モデルの差し替えや設定変更）\n" +
    "EMOTION: その時点の気持ち・感情（持続する性質ではない）\n" +
    "TRANSIENT: 天気・体調・当日の予定など一日限りの状態\n" +
    "GREETING: 挨拶・おやすみ・感謝・褒め言葉のみ（他に内容がない場合だけ）\n" +
    "CHATOPS: このアシスタントや会話そのものへの操作・会話運用だけ（検索依頼、口調・人格・誤りへの言及、できるか尋ねる、「他に話すことある？」など）。世界の話題についての質問、利用モデルやツールの構成変更、ユーザーの傾向・習慣の記述は含めない\n" +
    "importance は 0〜3 の整数:\n" +
    "3: 長期的にユーザー理解へ役立つ（持続する事実・好み・人間関係・計画・プロジェクト）\n" +
    "2: 後で役立つ文脈\n" +
    "1: 些細だが記録する価値がある\n" +
    "0: 一時的・社交的なだけ\n" +
    "例:\n" +
    "「その小説の主人公について教えて」→ {\"nature\":\"PREFERENCE\",\"importance\":2}\n" +
    "「最近の為替についてどう思う？」→ {\"nature\":\"OPINION\",\"importance\":2}\n" +
    "「自作アプリに通知機能を追加したい」→ {\"nature\":\"PROJECT\",\"importance\":3}\n" +
    "「利用モデルを別のものに差し替えた」→ {\"nature\":\"PROJECT\",\"importance\":3}\n" +
    "「同僚の佐藤さんは頼りになる」→ {\"nature\":\"RELATIONSHIP\",\"importance\":3}\n" +
    "「今日は少し疲れた」→ {\"nature\":\"EMOTION\",\"importance\":1}\n" +
    "「明日は雨らしい」→ {\"nature\":\"TRANSIENT\",\"importance\":0}\n" +
    "「君は音声で話せる？」→ {\"nature\":\"CHATOPS\",\"importance\":0}\n" +
    "「さっきの返答は間違っていた。もっと砕けて話して」→ {\"nature\":\"CHATOPS\",\"importance\":0}\n" +
    "「おやすみ、ありがとう」→ {\"nature\":\"GREETING\",\"importance\":0}\n" +
    "出力はJSONオブジェクト1つだけ。前後に説明を書かない。例: {\"nature\":\"PREFERENCE\",\"importance\":3}\n" +
    "<|im_end|>\n" +
    "<|im_start|>user\n";
  const tail = "<|im_end|>\n<|im_start|>assistant\n";
  // The fixed instructions ARE the classifier contract: unlike distill's
  // tailClip, they must never be truncated, and the assistant cue must always
  // survive so chatMlToMessages() yields a valid system+user+assistant array.
  // Below `fixed + MIN_CLASSIFIER_BODY_CP` the configured cap cannot hold both
  // the contract and a classifiable body. Like episodes' verificationFits
  // (which refuses a prompt it cannot ask honestly), we keep the contract and
  // give it the minimum body budget: the effective budget is therefore
  // max(cap, fixed + minimum), and the prompt may exceed a too-small cap.
  // The alternative (returning only the cue) silently sent an empty request.
  const fixed = countCp(head) + countCp(tail);
  const budget = Math.max(maxPromptChars, fixed + MIN_CLASSIFIER_BODY_CP);
  const room = Math.max(MIN_CLASSIFIER_BODY_CP, budget - fixed);
  const cps = [...body];
  const shown = cps.length > room ? cps.slice(0, room).join("") : body;
  return head + shown + tail;
}

/** Remove complete or unterminated think blocks before JSON extraction. */
function stripClassifierThinking(raw: string): string {
  return raw
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*?<\/think(?:ing)?>/gi, " ")
    .replace(/<think(?:ing)?\b[^>]*>[\s\S]*$/i, " ");
}

/**
 * Extract the first balanced JSON object from model output, ignoring braces
 * inside strings. Returns null when no complete object exists. Prose before or
 * after the object is tolerated (models often prefix an explanation).
 */
function firstJsonObject(raw: string): string | null {
  const start = raw.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return raw.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Strict combined-classifier parser. Accepts surrounding prose/thinking, then
 * requires exactly one JSON object with exactly the keys `nature` and
 * `importance`, an exact label from NATURE_LABELS, and an integer 0..3.
 * Anything else (wrong/missing label, float/string/out-of-range importance,
 * extra keys, arrays, non-string input) is null so the caller leaves the
 * record unscored and counts a scoring failure.
 */
export function parseNatureClassification(raw: string | null | undefined): NatureClassification | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 8000) return null;
  if (hasControl(raw.replace(/\n/g, ""))) return null;
  const cleaned = stripClassifierThinking(raw);
  const jsonText = firstJsonObject(cleaned);
  if (jsonText === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const rec = parsed as Record<string, unknown>;
  const keys = Object.keys(rec);
  if (keys.length !== 2 || !keys.includes("nature") || !keys.includes("importance")) return null;
  const nature = rec["nature"];
  const importance = rec["importance"];
  if (typeof nature !== "string" || !(NATURE_LABELS as readonly string[]).includes(nature)) return null;
  if (typeof importance !== "number" || !Number.isInteger(importance) || importance < 0 || importance > 3) return null;
  return { nature: nature as NatureLabel, importance };
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
  /** Combined-classifier nature label, or null when unscored/stale. */
  nature: NatureLabel | null;
  /** Canonical active same-scope links plus 0.5 per similar edge. */
  links: number;
  /** Latest absolute date in the body is past the expiry grace (PLAN/EVENT/TRANSIENT). */
  expired: boolean;
  /** An active cluster summary cites this record (record_links from). */
  consolidated: boolean;
  /** Latest metadata-only reactivation reason, or null. */
  latestReactivationReason: string | null;
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

export interface RetentionFactors {
  base: number;
  kind: number;
  importance: number;
  nature: number;
  links: number;
  expired: number;
  consolidated: number;
  total: number;
}

type RetentionInput = Pick<
  ActivationInput,
  "kind" | "createdAt" | "importance" | "eventTimes"
> &
  Partial<Pick<ActivationInput, "nature" | "links" | "expired" | "consolidated">>;

/**
 * Multi-factor retention factors. `base` is the ACT-R base-level activation
 * (createdAt + usage/feedback + predecessor usage + corrections +
 * reactivations, with decay d); the remaining factors are additive. Missing
 * optional signals contribute zero, except importance (neutral 0.5).
 * Invalid event timestamps are ignored; no usable event time yields -Infinity.
 */
export function computeRetentionFactors(
  input: RetentionInput,
  params: ActivationParams,
  now: string | number | Date,
): RetentionFactors {
  const nowMs = toMs(now);
  if (nowMs === null) {
    return {
      base: Number.NaN,
      kind: 0,
      importance: 0,
      nature: 0,
      links: 0,
      expired: 0,
      consolidated: 0,
      total: Number.NaN,
    };
  }
  let sum = 0;
  const times: Array<string | number> = [input.createdAt, ...input.eventTimes];
  for (const t of times) {
    const ms = toMs(t);
    if (ms === null) continue;
    const hours = Math.max((nowMs - ms) / 3_600_000, 1);
    sum += Math.pow(hours, -params.decay);
  }
  const base = sum <= 0 ? Number.NEGATIVE_INFINITY : Math.log(sum);
  const importanceValue = clamp01(input.importance ?? 0.5);
  const kind = params.wKind[input.kind] ?? 0;
  const importance = params.wImportance * importanceValue;
  const nature = input.nature ? params.wNature[input.nature] ?? 0 : 0;
  const linkCount = Math.max(0, input.links ?? 0);
  const links = params.wLinks * Math.log(1 + linkCount);
  const expired = input.expired === true ? -params.wExpired : 0;
  const consolidated =
    input.consolidated === true && importanceValue < 2 / 3 ? -params.wConsolidated : 0;
  return {
    base,
    kind,
    importance,
    nature,
    links,
    expired,
    consolidated,
    total: base + kind + importance + nature + links + expired + consolidated,
  };
}

/** Total retention score R (sum of computeRetentionFactors). */
export function computeActivation(
  input: RetentionInput,
  params: ActivationParams,
  now: string | number | Date,
): number {
  return computeRetentionFactors(input, params, now).total;
}

/** Auto-retirement reason codes that may be reconsidered by activation. */
export const AUTO_RETIRE_REASONS = ["LOW_ACTIVATION", "LOW_SIGNAL", "OUTDATED", "CONSOLIDATED"] as const;

/** Per-nature retirement age, falling back to the global minAgeHours. */
export function minAgeHoursFor(nature: NatureLabel | null | undefined, params: ActivationParams): number {
  if (nature) {
    const override = params.minAgeHoursByNature[nature];
    if (typeof override === "number" && Number.isFinite(override)) return override;
  }
  return params.minAgeHours;
}

export interface RetirementReasonFactors {
  expired: number;
  consolidated: number;
  total: number;
}

/**
 * Dominant retirement cause for the audit reasonCode: an applied expiry
 * penalty is OUTDATED; otherwise a consolidated penalty that alone pushed the
 * score below tauRetire is CONSOLIDATED; everything else is LOW_ACTIVATION.
 */
export function retirementReason(
  factors: RetirementReasonFactors,
  params: ActivationParams,
): "OUTDATED" | "CONSOLIDATED" | "LOW_ACTIVATION" {
  if (factors.expired < 0) return "OUTDATED";
  if (factors.consolidated < 0 && factors.total < params.tauRetire && factors.total - factors.consolidated >= params.tauRetire) {
    return "CONSOLIDATED";
  }
  return "LOW_ACTIVATION";
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

/** Latest absolute date in the body (UTC midnight), or null if none. */
export function latestAbsoluteDateMs(body: string): number | null {
  let latest: number | null = null;
  const consider = (y: number, m: number, d: number): void => {
    if (m < 1 || m > 12 || d < 1 || d > 31) return;
    const ms = Date.UTC(y, m - 1, d);
    const dt = new Date(ms);
    if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== m - 1 || dt.getUTCDate() !== d) return;
    if (latest === null || ms > latest) latest = ms;
  };
  for (const m of body.matchAll(/(\d{4})-(\d{2})-(\d{2})/g)) {
    consider(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of body.matchAll(/(\d{4})年(\d{1,2})月(\d{1,2})日/g)) {
    consider(Number(m[1]), Number(m[2]), Number(m[3]));
  }
  return latest;
}

/**
 * Deterministic date expiry signal: only PLAN/EVENT/TRANSIENT bodies are
 * considered. True when the latest absolute date (YYYY-MM-DD or
 * YYYY年M月D日) is strictly more than `graceDays` before now.
 */
export function isExpiredDated(
  body: string,
  nature: NatureLabel | null,
  now: string | number | Date,
  graceDays: number,
): boolean {
  if (nature !== "PLAN" && nature !== "EVENT" && nature !== "TRANSIENT") return false;
  const nowMs = toMs(now);
  const latest = latestAbsoluteDateMs(body);
  if (nowMs === null || latest === null) return false;
  return nowMs - latest > graceDays * 86_400_000;
}

const CLUSTER_SUMMARY_SOURCE = "cultivation:llm-derived-cluster";

export interface RetirementDecisionContext {
  nature?: NatureLabel | null;
  latestReactivationReason?: string | null;
  factors?: RetirementReasonFactors;
}

/**
 * Hysteresis gate over the multi-factor retention score R.
 *
 * Active rows retire when R < tauRetire and age >= the nature-aware minimum
 * age (minAgeHoursByNature, else minAgeHours). A record whose latest
 * reactivation was USER_REQUESTED is never auto-retired. Retired rows
 * reactivate when R >= tauReactivate and the latest retirement was one of the
 * auto-retirement causes (LOW_ACTIVATION, legacy LOW_SIGNAL, OUTDATED,
 * CONSOLIDATED); user-driven NO_LONGER_USEFUL retirements stay retired.
 *
 * Protective margin: a record whose importance is at/above
 * `protectImportance` (default 0.66 ≈ 2/3) is never retired at the normal
 * threshold; it retires only if R falls below `tauRetire - 1`. This keeps a
 * model-scored lasting fact from being dropped by recency/frequency alone.
 */
export function retireDecision(
  R: number,
  status: ActivationStatus,
  retireReason: string | null,
  ageHours: number,
  params: ActivationParams,
  importance: number | null = null,
  protectImportance = 0.66,
  ctx: RetirementDecisionContext = {},
): ActivationDecision {
  if (status === "active") {
    if (ctx.latestReactivationReason === "USER_REQUESTED") return "keep";
    const belowRetire = R < params.tauRetire;
    if (!belowRetire || ageHours < minAgeHoursFor(ctx.nature, params)) return "keep";
    const protectedImportance =
      importance !== null &&
      Number.isFinite(importance) &&
      importance >= protectImportance;
    if (protectedImportance && R >= params.tauRetire - 1) return "keep";
    return "retire";
  }
  if (status === "retired") {
    const activationDriven =
      retireReason !== null &&
      (AUTO_RETIRE_REASONS as readonly string[]).includes(retireReason);
    return activationDriven && R >= params.tauReactivate ? "reactivate" : "keep";
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

export interface ActivationAfter {
  createdAt: string;
  id: string;
}

export interface LoadActivationOptions {
  /** Include retired rows (default true). Active-only scans pass false. */
  includeRetired?: boolean;
  /** Hard candidate cap (default ACTIVATION_MAX_RECORDS). */
  maxRecords?: number;
  /**
   * Keyset continuation: return records strictly after (createdAt, id) in
   * scan order. Used by maintain.activation to advance past the oldest
   * bounded window across passes.
   */
  after?: ActivationAfter;
  /** Evaluation clock for the deterministic date-expiry signal. */
  now?: string;
  /** Date-expiry grace in days (default 3). */
  expiryGraceDays?: number;
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
  const after =
    options.after &&
    typeof options.after.createdAt === "string" &&
    Number.isFinite(Date.parse(options.after.createdAt)) &&
    typeof options.after.id === "string" &&
    options.after.id.length > 0
      ? options.after
      : null;
  const keyset = after ? "AND (createdAt > ? OR (createdAt = ? AND id > ?))" : "";
  const rows = db
    .prepare(
      `SELECT id, body, bodyHash, kind, status, createdAt, supersedes
         FROM records
        WHERE scope = ? AND status IN ${statuses} ${keyset}
        ORDER BY createdAt ASC, id ASC
        LIMIT ?`,
    )
    .all(
      ...(after
        ? [scope, after.createdAt, after.createdAt, after.id, maxRecords]
        : [scope, maxRecords]),
    ) as unknown as RecordRow[];
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
  const latestReactivationReasons = new Map<string, string | null>();
  for (const ids of chunk(candidateIds)) {
    const found = db
      .prepare(
        `SELECT targetId, ts, reasonCode FROM audit
          WHERE op = 'record.reactivate' AND targetId IN (${placeholders(ids.length)})
          ORDER BY ts ASC, rowid ASC`,
      )
      .all(...ids) as unknown as Array<{ targetId: string; ts: string; reasonCode: string | null }>;
    for (const row of found) {
      const list = reactivationTimes.get(row.targetId);
      if (list) list.push(row.ts);
      else reactivationTimes.set(row.targetId, [row.ts]);
      latestReactivationReasons.set(row.targetId, row.reasonCode);
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

  // Derived importance/nature, only while they still match the current bodyHash.
  const importance = new Map<string, { value: number; bodyHash: string; nature: string | null }>();
  for (const ids of chunk(candidateIds)) {
    const found = db
      .prepare(
        `SELECT recordId, importance, bodyHash, nature FROM record_importance WHERE recordId IN (${placeholders(ids.length)})`,
      )
      .all(...ids) as unknown as Array<{
      recordId: string;
      importance: number;
      bodyHash: string;
      nature: string | null;
    }>;
    for (const row of found) {
      importance.set(row.recordId, {
        value: row.importance,
        bodyHash: row.bodyHash,
        nature: row.nature,
      });
    }
  }
  const hashOf = new Map(candidates.map((r) => [r.id, r.bodyHash]));

  // Canonical links: count edges whose OTHER endpoint is active in this scope.
  const linkCounts = new Map<string, number>();
  // Chunk queries can return the same edge once per endpoint chunk (the row
  // matches fromId IN this chunk OR toRef IN this chunk). Dedupe by edge key
  // so a cross-chunk edge contributes exactly once per endpoint.
  const seenLinks = new Set<string>();
  for (const ids of chunk(candidateIds)) {
    const rows = db
      .prepare(
        `SELECT fromId, toRef FROM record_links
          WHERE fromId IN (${placeholders(ids.length)}) OR toRef IN (${placeholders(ids.length)})`,
      )
      .all(...ids, ...ids) as unknown as Array<{ fromId: string; toRef: string }>;
    const otherIds = new Set<string>();
    for (const row of rows) {
      if (row.fromId !== row.toRef) {
        otherIds.add(row.toRef);
        otherIds.add(row.fromId);
      }
    }
    const activePeers = new Set<string>();
    for (const others of chunk([...otherIds])) {
      const found = db
        .prepare(
          `SELECT id FROM records WHERE scope = ? AND status = 'active' AND id IN (${placeholders(others.length)})`,
        )
        .all(scope, ...others) as unknown as Array<{ id: string }>;
      for (const row of found) activePeers.add(row.id);
    }
    for (const row of rows) {
      if (row.fromId === row.toRef) continue;
      const edgeKey = `${row.fromId}\u0000${row.toRef}`;
      if (seenLinks.has(edgeKey)) continue;
      seenLinks.add(edgeKey);
      if (candidateSet.has(row.fromId) && activePeers.has(row.toRef)) {
        linkCounts.set(row.fromId, (linkCounts.get(row.fromId) ?? 0) + 1);
      }
      if (candidateSet.has(row.toRef) && activePeers.has(row.fromId)) {
        linkCounts.set(row.toRef, (linkCounts.get(row.toRef) ?? 0) + 1);
      }
    }
  }

  // Derived similar_edges count at 0.5 weight each. Same rule as canonical
  // links: an edge is evidence only while the OTHER endpoint is active in this
  // scope. maintain.associate prunes rows for inactive records lazily, so
  // without this filter retirement decisions would depend on whether that
  // maintenance has run since a neighbour was retired/archived/superseded.
  const similarCounts = new Map<string, number>();
  // Same chunking overlap for similar_edges: count each stored row once.
  const seenSimilar = new Set<string>();
  for (const ids of chunk(candidateIds)) {
    const rows = db
      .prepare(
        `SELECT a, b FROM similar_edges
          WHERE scope = ? AND (a IN (${placeholders(ids.length)}) OR b IN (${placeholders(ids.length)}))`,
      )
      .all(scope, ...ids, ...ids) as unknown as Array<{ a: string; b: string }>;
    const otherIds = new Set<string>();
    for (const row of rows) {
      if (row.a !== row.b) {
        otherIds.add(row.a);
        otherIds.add(row.b);
      }
    }
    const activePeers = new Set<string>();
    for (const others of chunk([...otherIds])) {
      const found = db
        .prepare(
          `SELECT id FROM records WHERE scope = ? AND status = 'active' AND id IN (${placeholders(others.length)})`,
        )
        .all(scope, ...others) as unknown as Array<{ id: string }>;
      for (const row of found) activePeers.add(row.id);
    }
    for (const row of rows) {
      if (row.a === row.b) continue;
      const edgeKey = `${row.a}\u0000${row.b}`;
      if (seenSimilar.has(edgeKey)) continue;
      seenSimilar.add(edgeKey);
      if (candidateSet.has(row.a) && activePeers.has(row.b)) {
        similarCounts.set(row.a, (similarCounts.get(row.a) ?? 0) + 1);
      }
      if (candidateSet.has(row.b) && activePeers.has(row.a)) {
        similarCounts.set(row.b, (similarCounts.get(row.b) ?? 0) + 1);
      }
    }
  }

  // Cited by an ACTIVE cluster summary whose revision is current (nothing
  // supersedes it) — a stale citation from a replaced summary is not evidence.
  const consolidated = new Set<string>();
  for (const ids of chunk(candidateIds)) {
    const found = db
      .prepare(
        `SELECT l.toRef AS target FROM record_links l
           JOIN records s ON s.id = l.fromId
          WHERE s.scope = ? AND s.status = 'active' AND s.source = ?
            AND NOT EXISTS (
              SELECT 1 FROM records n
               WHERE n.supersedes = s.id AND n.scope = s.scope
            )
            AND l.toRef IN (${placeholders(ids.length)})
          GROUP BY l.toRef`,
      )
      .all(scope, CLUSTER_SUMMARY_SOURCE, ...ids) as unknown as Array<{ target: string }>;
    for (const row of found) consolidated.add(row.target);
  }

  const nowForExpiry =
    options.now !== undefined && Number.isFinite(Date.parse(options.now)) ? options.now : nowIso();
  const graceDays = Math.max(0, options.expiryGraceDays ?? 3);

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
    const fresh = imp !== undefined && imp.bodyHash === hashOf.get(r.id);
    const freshImp = fresh && Number.isFinite(imp.value) ? imp.value : null;
    const freshNature =
      fresh && imp.nature !== null && (NATURE_LABELS as readonly string[]).includes(imp.nature)
        ? (imp.nature as NatureLabel)
        : null;
    return {
      recordId: r.id,
      kind: r.kind as ActivationKind,
      status: r.status as ActivationStatus,
      createdAt: r.createdAt,
      body: r.body,
      importance: freshImp,
      nature: freshNature,
      links: (linkCounts.get(r.id) ?? 0) + 0.5 * (similarCounts.get(r.id) ?? 0),
      expired: isExpiredDated(r.body, freshNature, nowForExpiry, graceDays),
      consolidated: consolidated.has(r.id),
      latestReactivationReason: latestReactivationReasons.get(r.id) ?? null,
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
  /** Pinned evaluation clock so later pages use the exact same scores. */
  now: string;
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
    const now = o["now"];
    if (typeof a !== "number" || !Number.isFinite(a)) return null;
    if (typeof id !== "string" || id.length < 1 || id.length > 256) return null;
    if (typeof now !== "string" || now.length < 1 || now.length > 64) return null;
    if (!Number.isFinite(Date.parse(now))) return null;
    return { a, id, now };
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
  nature: NatureLabel | null;
  A: number;
  importance: number | null;
  factors: RetentionFactors;
  /** Dominant retire reason, or null when the decision is not retire. */
  reason: "OUTDATED" | "CONSOLIDATED" | "LOW_ACTIVATION" | null;
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

  const now = cursor?.now ?? nowOverride ?? nowIso();
  if (!Number.isFinite(Date.parse(now))) {
    return applyResponseBudget(fail("STORE_UNAVAILABLE"), config.limits.responseMaxBytes);
  }
  const bounds: ActivationConfig = activationBounds(config);
  const paramsForModel: ActivationParams = bounds;

  let inputs: ActivationInput[];
  try {
    inputs = loadActivationInputs(db, scope, {
      includeRetired,
      now,
      expiryGraceDays: bounds.expiryGraceDays,
    });
  } catch {
    return applyResponseBudget(fail("STORE_UNAVAILABLE"), config.limits.responseMaxBytes);
  }

  const scored: PreviewItem[] = inputs.map((input) => {
    const factors = computeRetentionFactors(input, paramsForModel, now);
    const ageHours = activationAgeHours(input.createdAt, now);
    const decision = retireDecision(
      factors.total,
      input.status,
      input.retireReason,
      ageHours,
      paramsForModel,
      input.importance,
      bounds.protectImportance,
      {
        nature: input.nature,
        latestReactivationReason: input.latestReactivationReason,
        factors,
      },
    );
    return {
      id: input.recordId,
      status: input.status,
      kind: input.kind,
      label: labelOf(input.body, config.limits.snippetMaxCp),
      nature: input.nature,
      A: factors.total,
      importance: input.importance,
      factors,
      reason: decision === "retire" ? retirementReason(factors, paramsForModel) : null,
      uses: input.uses,
      ageHours,
      decision,
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
      nextCursor:
        hasMore && items.length > 0
          ? encodeCursor({
              a: items[items.length - 1].A,
              id: items[items.length - 1].id,
              now,
            })
          : null,
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

/** Per-scope continuation for the bounded maintenance scan. */
function ensureActivationScanSchema(db: DatabaseSync): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS activation_scan(
       scope TEXT PRIMARY KEY,
       createdAt TEXT NOT NULL,
       id TEXT NOT NULL,
       updatedAt TEXT NOT NULL)`,
  );
}

function readScanCursor(db: DatabaseSync, scope: string): ActivationAfter | null {
  ensureActivationScanSchema(db);
  const row = db
    .prepare(`SELECT createdAt, id FROM activation_scan WHERE scope = ?`)
    .get(scope) as { createdAt: string; id: string } | undefined;
  if (!row || !Number.isFinite(Date.parse(row.createdAt)) || row.id.length === 0) return null;
  return { createdAt: row.createdAt, id: row.id };
}

function storeActivationResult(
  db: DatabaseSync,
  config: AppConfig,
  key: string,
  reqHash: string,
  stored: ResponseEnvelope,
  scope: string,
  now: string,
  limitN: number,
  scanAfter: ActivationAfter | null,
): void {
  ensureActivationScanSchema(db);
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
    // Persist the scan continuation in the same transaction as the ledger
    // rows so a committed pass always advances (or wraps) atomically.
    if (scanAfter) {
      db.prepare(
        `INSERT INTO activation_scan(scope, createdAt, id, updatedAt) VALUES (?, ?, ?, ?)
         ON CONFLICT(scope) DO UPDATE SET
           createdAt = excluded.createdAt,
           id = excluded.id,
           updatedAt = excluded.updatedAt`,
      ).run(scope, scanAfter.createdAt, scanAfter.id, now);
    } else {
      db.prepare(`DELETE FROM activation_scan WHERE scope = ?`).run(scope);
    }
    assertDbUnderCap(db, config);
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

/**
 * Active+retired records whose ledger row is missing, stale for the current
 * bodyHash, lacks a nature label, or was written by an older classifier
 * version. The version check makes a prompt/definition change rescore the
 * corpus exactly once (`source='llm:<CLASSIFIER_VERSION>'`).
 */
function selectUnscored(
  db: DatabaseSync,
  scope: string,
  limit: number,
  classifierSource = CLASSIFIER_SOURCE,
): UnscoredRow[] {
  return db
    .prepare(
      `SELECT r.id AS id, r.bodyNorm AS bodyNorm, r.bodyHash AS bodyHash
         FROM records r
         LEFT JOIN record_importance i ON i.recordId = r.id
        WHERE r.scope = ? AND r.status IN ('active','retired')
          AND (i.recordId IS NULL OR i.bodyHash <> r.bodyHash OR i.nature IS NULL
               OR i.source <> ?)
        ORDER BY r.createdAt ASC, r.id ASC
        LIMIT ?`,
    )
    .all(scope, classifierSource, limit) as unknown as UnscoredRow[];
}

interface ImportanceWrite {
  recordId: string;
  importance: number;
  nature: NatureLabel;
  bodyHash: string;
}

function writeImportance(
  db: DatabaseSync,
  config: AppConfig,
  writes: ImportanceWrite[],
  now: string,
  fenceOwner: string,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!isCultivationLeaseHeldBy(db, fenceOwner, now)) throw new Error("lease lost");
    const stmt = db.prepare(
      `INSERT INTO record_importance(recordId, importance, nature, bodyHash, source, scoredAt)
       VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(recordId) DO UPDATE SET
         importance = excluded.importance,
         nature = excluded.nature,
         bodyHash = excluded.bodyHash,
         source = excluded.source,
         scoredAt = excluded.scoredAt`,
    );
    for (const w of writes)
      stmt.run(w.recordId, w.importance, w.nature, w.bodyHash, CLASSIFIER_SOURCE, now);
    assertDbUnderCap(db, config);
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
  reason: "OUTDATED" | "CONSOLIDATED" | "LOW_ACTIVATION" | null;
}

/**
 * Run one bounded maintain.activation pass.
 *
 * Step (a): classify nature + importance for up to `limit` active+retired
 * records whose record_importance row is missing, stale for the current
 * bodyHash, or still lacks a nature label. One strict-JSON model call per
 * record stores nature and `importance / 3` with source='llm:<version>'. When the
 * configured LLM is disabled/missing (and no injected generator applies),
 * scoring is skipped and `degraded` is true.
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

    // Bounded scan continuation: each pass examines at most the same
    // ACTIVATION_MAX_RECORDS window, advancing (createdAt, id) and wrapping
    // to the start once the end is reached, so newer records are eventually
    // evaluated even when the oldest rows stay eligible.
    let scanAfter: ActivationAfter | null;
    try {
      scanAfter = readScanCursor(db, p.scope);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }

    const llmModelDir = resolveLlmDir(config, configPath);
    const modelUsable = llmUsable(config, llmModelDir);
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
        ((prompt, tokens, signal) =>
          generateCompletion(prompt, llmModelDir, {
            timeoutMs: llmTimeoutMs(config),
            maxNewTokens: tokens,
            config,
            signal,
          }));
      const maxPromptChars = llmMaxPromptChars(config);
      const leaseTtlMs = cultivationBounds(config).leaseTtlMs;
      // One inference under the lease heartbeat. A generator exception stays a
      // scoring failure (raw=null); a lost lease must drop every pending write.
      const heartbeatGenerate = async (
        prompt: string,
      ): Promise<{ lost: boolean; raw: string | null }> => {
        try {
          const run = await withLeaseHeartbeat(
            renew,
            leaseTtlMs,
            (signal) => generate(prompt, CLASSIFIER_TOKEN_BUDGET, signal),
          );
          return run.ok ? { lost: false, raw: run.value } : { lost: true, raw: null };
        } catch {
          return { lost: false, raw: null };
        }
      };
      const writes: ImportanceWrite[] = [];
      for (const row of candidates) {
        if (overDeadline()) {
          degraded = true;
          break;
        }
        // Renew before each model call (belt and braces: the heartbeat below
        // covers the call itself). A stolen or expired lease aborts the pass
        // before any importance commit.
        if (!renew()) return budgeted(conflict(), config);
        // Keep the lease alive while this inference runs; a slow scoring call
        // must not expire the lease before writeImportance's fence.
        const run = await heartbeatGenerate(buildClassifierPrompt(row.bodyNorm, maxPromptChars));
        if (run.lost) {
          // Lease stolen/expired mid-inference: drop every pending write.
          return budgeted(conflict(), config);
        }
        const raw: string | null = run.raw;
        const classification = parseNatureClassification(raw);
        if (classification === null) {
          scoreFailed++;
          continue;
        }
        writes.push({
          recordId: row.id,
          importance: classification.importance / 3,
          nature: classification.nature,
          bodyHash: row.bodyHash,
        });
      }
      if (writes.length > 0) {
        try {
          // Fence with the execution clock *now*, not the pre-inference
          // timestamp: a long generation must not commit after lease expiry.
          writeImportance(db, config, writes, renewNow(), execOwner);
          scored = writes.length;
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          return budgeted(fail(msg === "lease lost" ? "CONFLICT" : "STORE_UNAVAILABLE"), config);
        }
      }
      if (scoreFailed > 0) degraded = true;
    }

    let inputs: ActivationInput[];
    let nextScanAfter: ActivationAfter | null = null;
    try {
      inputs = loadActivationInputs(db, p.scope, {
        includeRetired: true,
        now: nowValid,
        expiryGraceDays: bounds.expiryGraceDays,
        ...(scanAfter ? { after: scanAfter } : {}),
      });
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    if (inputs.length >= ACTIVATION_MAX_RECORDS) {
      const last = inputs[inputs.length - 1];
      nextScanAfter = { createdAt: last.createdAt, id: last.recordId };
    }

    const decisions: ActivationDecisionItem[] = inputs.map((input) => {
      const factors = computeRetentionFactors(input, bounds, nowValid);
      const ageHours = activationAgeHours(input.createdAt, nowValid);
      const decision = retireDecision(
        factors.total,
        input.status,
        input.retireReason,
        ageHours,
        bounds,
        input.importance,
        bounds.protectImportance,
        {
          nature: input.nature,
          latestReactivationReason: input.latestReactivationReason,
          factors,
        },
      );
      return {
        id: input.recordId,
        decision,
        reason: decision === "retire" ? retirementReason(factors, bounds) : null,
      };
    });

    const wouldRetire = decisions.filter((d) => d.decision === "retire").length;
    const wouldReactivate = decisions.filter((d) => d.decision === "reactivate").length;
    let retired = 0;
    let reactivated = 0;

    if (bounds.apply && (wouldRetire > 0 || wouldReactivate > 0)) {
      // Heartbeat before applying; each transition re-checks the lease inside
      // its own transaction via CanonicalWriteFence. The fence timestamp is
      // the current execution clock (not the pre-inference `nowValid`), so an
      // expired lease aborts instead of committing a transition.
      if (!renew()) return budgeted(conflict(), config);
      for (const item of decisions) {
        if (overDeadline()) break;
        if (item.decision !== "retire" && item.decision !== "reactivate") continue;
        const fence: CanonicalWriteFence = { owner: execOwner, now: renewNow() };
        const innerKey = sha256HexUtf8(`${ACTIVATION_OP}:${idempotencyKey}:${item.id}`);
        const transitionParams = {
          id: item.id,
          scope: p.scope,
          reasonCode: item.decision === "retire" ? item.reason ?? "LOW_ACTIVATION" : "STILL_USEFUL",
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
      storeActivationResult(
        db,
        config,
        idempotencyKey,
        reqHash,
        stored,
        p.scope,
        nowValid,
        p.limit,
        nextScanAfter,
      );
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
