/**
 * P2 maintain.episodes: bounded, hierarchical, span-anchored episode index.
 *
 * The small local LLM (src/llm.ts generateCompletion, Qwen2.5-1.5B) maps
 * bounded spans of raw events to verified window summaries, then reduces
 * those windows into one verified episode-level summary. All canonical writes
 * go through the normal store paths (record.remember / record.correct /
 * record.archive); the derived episode_summaries ledger only references
 * canonical record ids.
 *
 * Mirrors maintain.distill's safety envelope:
 * - Params are strict; idempotencyKey is mandatory and same-key/same-params
 *   replays the stored envelope, changed params => CONFLICT.
 * - The global M3 cultivation lease is shared with maintain.distill, so the
 *   two never run concurrently; a live foreign lease => transient CONFLICT
 *   (never stored, retryable).
 * - Model inference runs OUTSIDE DB transactions. Each canonical write is its
 *   own atomic store transaction; failures are isolated per episode.
 * - The pinned model is treated as untrusted: summaries must parse as
 *   bounded text and a second YES/NO prompt must strictly confirm that every
 *   statement is supported by the source text. Content-rejected window
 *   summaries (parse failure, anchor-guard miss, verifier NO) fall back to a
 *   verbatim raw window record so the event still counts as processed;
 *   timeouts/model failures write nothing and stop that episode at the
 *   failing event (retryable).
 * - llm disabled/missing => degraded OK with zero writes and zero state
 *   changes (no fake decisions, no heuristics).
 * - coveredThrough is kept for response compatibility and reports the max
 *   observedAt over events with an explicit episode_event_done row. It is NOT
 *   used for staleness or selection: pending events and unfolded windows are
 *   tracked explicitly (done rows + foldedRecordIds), so observation order and
 *   creation-time ties cannot skip a failed event.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { episodesBounds, maintenanceTimeoutMs, requirePrivacyEnabled } from "./config.js";
import { acquireCultivationLease, isCultivationLeaseHeldBy, releaseCultivationLease } from "./cultivation.js";
import { deriveConsolidationPrivacy, type PrivacyMetadata } from "./privacy.js";
import {
  generateCompletion,
  llmEnabled,
  llmMaxNewTokens,
  llmMaxPromptChars,
  llmTimeoutMs,
  modelFilesPresent,
  parseSummaryBody,
  resolveLlmDir,
} from "./llm.js";
import { canonicalTime, countCp, hasControl, requestHashFor } from "./normalize.js";
import { applyResponseBudget, fail, ok, type ResponseEnvelope } from "./protocol.js";
import { clipTextToNormalizedCp, splitTextRanges } from "./split.js";
import type { SourceRef } from "./sourceref.js";
import {
  archiveRecord,
  correctRecord,
  insertEpisodeEventDone,
  insertEpisodeSummary,
  isScopeAuthorized,
  listEpisodeSummaries,
  rememberRecord,
  type CanonicalWriteFence,
  type EpisodeKind,
} from "./store.js";

export const EPISODES_OP = "maintain.episodes";
export const EPISODE_WINDOWS_OP = "episode.windows";
/** Provenance source for model-derived episode records (contains "derived"). */
export const EPISODE_SUMMARY_SOURCE = "cultivation:llm-derived-episode";
export const EPISODE_WINDOW_TAG = "episode-window";
/** Marks a window whose model summary was rejected and raw text was stored. */
export const EPISODE_WINDOW_VERBATIM_TAG = "episode-window-verbatim";
export const EPISODE_TAG = "episode";
/** A single merge prompt folds at most this many inputs. */
export const EPISODE_FOLD_MAX = 5;

const EPISODE_KINDS = new Set<string>(["session", "doc", "day"]);

export interface EpisodesParams {
  scope: string;
  kind: EpisodeKind;
  episodeKey: string | null;
  limit: number;
}

/** Injectable model call (tests), same shape as distill's decide override. */
export interface EpisodesGenerate {
  (prompt: string, maxNewTokens: number): Promise<string | null>;
}

/* ------------------------------------------------------------------ */
/* Prompt builders (ChatML, bounded, instruction tail preserved)        */
/* ------------------------------------------------------------------ */

function cpLen(s: string): number {
  return [...s].length;
}

function clipCp(s: string, maxCp: number): string {
  const cps = [...s];
  return cps.length <= maxCp ? s : cps.slice(0, Math.max(0, maxCp)).join("");
}

/** Preserve the instruction/assistant tail; never sever it from the front. */
function tailClip(s: string, maxCp: number): string {
  const cps = [...s];
  return cps.length <= maxCp ? s : cps.slice(cps.length - maxCp).join("");
}

function clampMaxPromptChars(n: number): number {
  if (!Number.isFinite(n)) return 2000;
  const m = Math.floor(n);
  if (m < 500) return 500;
  if (m > 8000) return 8000;
  return m;
}

export type PromptLanguage = "cjk" | "latin";

/**
 * Dominant writing system of a text: "cjk" when Han/Hiragana/Katakana code
 * points are at least as numerous as Latin *words* (maximal runs of
 * [A-Za-z]), otherwise "latin". Comparing one CJK code point to one Latin
 * word reflects information density: Japanese uses no inter-word spaces, so
 * counting Latin letters would misclassify mixed text as Latin and make the
 * model translate names. Ties go to "cjk". Used to keep generated summaries
 * in the source language so the lexical anchor guard can match them. Pure and
 * normalization-stable (NFKC).
 */
export function dominantScript(text: string): PromptLanguage {
  let cjk = 0;
  let latinWords = 0;
  let inLatinWord = false;
  for (const ch of text.normalize("NFKC")) {
    const cp = ch.codePointAt(0)!;
    if (
      (cp >= 0x3040 && cp <= 0x30ff) || // Hiragana + Katakana
      (cp >= 0x31f0 && cp <= 0x31ff) || // Katakana phonetic extensions
      (cp >= 0x3400 && cp <= 0x4dbf) || // CJK Extension A
      (cp >= 0x4e00 && cp <= 0x9fff) || // CJK Unified Ideographs
      (cp >= 0xf900 && cp <= 0xfaff) || // CJK Compatibility Ideographs
      (cp >= 0x20000 && cp <= 0x2fa1f) // CJK Extensions B-F + compatibility
    ) {
      cjk++;
      inLatinWord = false;
    } else if ((cp >= 0x41 && cp <= 0x5a) || (cp >= 0x61 && cp <= 0x7a)) {
      if (!inLatinWord) {
        latinWords++;
        inLatinWord = true;
      }
    } else {
      inLatinWord = false;
    }
  }
  return cjk >= latinWords ? "cjk" : "latin";
}

/** Exported decision used by prompt builders (and asserted by tests). */
export function promptLanguageFor(text: string): PromptLanguage {
  return dominantScript(text);
}

/** Instruction that keeps names/places/numbers in their source spelling. */
function namesInstruction(lang: PromptLanguage): string {
  return lang === "cjk"
    ? "固有名詞・地名・数字は原文の表記のまま書き、翻訳・ローマ字化しないこと。"
    : "Copy names, places, and numbers exactly as written in the text; " +
        "never translate or romanize them. ";
}

/** Assistant prefill used by Japanese window/reduce prompts. */
const SUMMARY_CUE = "要約：";

/**
 * Remove the Japanese assistant prefill if the model echoes it at the start of
 * its output. Verify/claim prompts have no cue, so they never call this.
 */
function stripSummaryCue(raw: string | null): string | null {
  if (typeof raw !== "string") return null;
  return raw.replace(/^\s*要約\s*[:：]\s*/u, "");
}

/**
 * Window map prompt: summarize one bounded span in 1-2 sentences. CJK sources
 * get an entirely Japanese system+user instruction and a Japanese assistant
 * prefill, because the pinned model otherwise answers in English and the
 * anchor guard rejects translated/romanized names. Latin sources keep English.
 */
export function buildEpisodeWindowPrompt(text: string, maxPromptChars: number): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const lang = promptLanguageFor(text);
  const head =
    lang === "cjk"
      ? "<|im_start|>system\nあなたはエピソードの一部を要約します。要約だけを出力し、それ以外は何も書かないでください。<|im_end|>\n" +
        "<|im_start|>user\nテキスト：\n\"\"\""
      : "<|im_start|>system\nYou summarize part of an episode. Reply with only the summary and nothing else.<|im_end|>\n" +
        "<|im_start|>user\nText:\n\"\"\"";
  const tail =
    lang === "cjk"
      ? "\"\"\"\n" +
        "日本語で書くこと。" +
        namesInstruction(lang) +
        "このテキストを1〜2文で要約してください。日付、名前、事実、不確かな点は残してください。" +
        "要約だけを出力してください。<|im_end|>\n<|im_start|>assistant\n" +
        SUMMARY_CUE
      : "\"\"\"\n" +
        "Write in English. " +
        namesInstruction(lang) +
        "Summarize this text in 1-2 sentences. Keep dates, names, facts, and any uncertainty. " +
        "Reply with only the summary.<|im_end|>\n<|im_start|>assistant\n";
  const budget = Math.max(0, max - cpLen(head) - cpLen(tail));
  return tailClip(head + clipCp(text, budget) + tail, max);
}

/**
 * Minimum source text a verifier must see (or the whole source when it is
 * shorter). A candidate that only fits with less source than this cannot be
 * verified meaningfully, so the caller treats it as a content rejection.
 */
export const EPISODE_VERIFY_MIN_SOURCE_CP = 200;

interface VerificationTemplate {
  head: string;
  mid: string;
  tail: string;
}

function verificationTemplate(lang: PromptLanguage): VerificationTemplate {
  return lang === "cjk"
    ? {
        head:
          "<|im_start|>system\nあなたは要約を検証します。YES または NO だけを出力し、それ以外は何も書かないでください。<|im_end|>\n" +
          "<|im_start|>user\n本文：\n\"\"\"",
        mid: "\"\"\"\n要約：\n\"\"\"",
        tail:
          "\"\"\"\n" +
          namesInstruction(lang) +
          "要約のすべての文が本文に支持されている場合は YES、そうでなければ NO と答えてください。<|im_end|>\n<|im_start|>assistant\n",
      }
    : {
        head:
          "<|im_start|>system\nYou verify a summary. Reply with only YES or NO and nothing else.<|im_end|>\n" +
          "<|im_start|>user\nTEXT:\n\"\"\"",
        mid: "\"\"\"\nSUMMARY:\n\"\"\"",
        tail:
          "\"\"\"\n" +
          namesInstruction(lang) +
          "Reply YES if every statement in SUMMARY is supported by TEXT. " +
          "Otherwise reply NO.<|im_end|>\n<|im_start|>assistant\n",
      };
}

interface VerificationBudget {
  template: VerificationTemplate;
  /** Code points available for the source text after the full candidate. */
  available: number;
  /** Full source when shorter than the minimum, else the minimum. */
  minSource: number;
  ok: boolean;
}

/**
 * Budget the verifier template around the FULL candidate. The candidate is
 * never clipped: a YES verdict must apply to exactly the candidate text the
 * caller will store, so only the source may be shortened. When the remaining
 * source budget is below the minimum (or the full source if shorter), the
 * candidate is unverifiable and the builder returns null instead of asking a
 * question about a prefix.
 */
function verificationBudget(
  text: string,
  candidate: string,
  maxPromptChars: number,
): VerificationBudget {
  const max = clampMaxPromptChars(maxPromptChars);
  const template = verificationTemplate(promptLanguageFor(text));
  const overhead = cpLen(template.head) + cpLen(template.mid) + cpLen(template.tail);
  const available = max - overhead - cpLen(candidate);
  const minSource = Math.min(EPISODE_VERIFY_MIN_SOURCE_CP, cpLen(text));
  return { template, available, minSource, ok: available >= minSource };
}

/**
 * Exported decision (tests and callers): true only when the FULL candidate
 * plus at least the minimum source text fit the verifier prompt budget.
 */
export function verificationFits(
  text: string,
  candidate: string,
  maxPromptChars: number,
): boolean {
  return verificationBudget(text, candidate, maxPromptChars).ok;
}

/** Strict verification prompt: YES only when the summary is fully supported. */
export function buildEpisodeVerifyPrompt(
  text: string,
  summary: string,
  maxPromptChars: number,
): string | null {
  const b = verificationBudget(text, summary, maxPromptChars);
  if (!b.ok) return null;
  const { head, mid, tail } = b.template;
  return head + clipCp(text, b.available) + mid + summary + tail;
}

/**
 * Cited reduce prompt: fold up to EPISODE_FOLD_MAX notes into 1-3 sentences,
 * each ending with the citation numbers it uses (e.g. [1][3]). Citations are
 * local to this fold; the caller maps them back to window ledger rows.
 */
export function buildEpisodeCitedReducePrompt(
  inputs: string[],
  maxPromptChars: number,
  sourceText?: string,
): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const shown = inputs.slice(0, EPISODE_FOLD_MAX);
  // Language follows the concatenated cited RAW text, not the (possibly
  // already translated) window notes. Verbatim window bodies are just raw
  // text, so they select the same language as their source.
  const lang = promptLanguageFor(sourceText ?? shown.join("\n"));
  const head =
    lang === "cjk"
      ? "<|im_start|>system\nあなたは番号付きのメモからエピソードを要約します。メモにある事実だけを使い、名前や出来事を捏造しないでください。要約だけを出力してください。<|im_end|>\n" +
        "<|im_start|>user\nメモ：\n"
      : "<|im_start|>system\nYou summarize an episode from numbered notes. " +
        "Use only facts in the notes; never invent names or events. " +
        "Reply with only the summary.<|im_end|>\n" +
        "<|im_start|>user\nNotes:\n";
  const tail =
    "\n" +
    (lang === "cjk"
      ? namesInstruction(lang) +
        "1〜3文で書いてください。各文の末尾に、その文が使ったメモの番号を [1][3] のように付けてください。" +
        "日付、名前、事実、不確かな点は残してください。<|im_end|>\n<|im_start|>assistant\n" +
        SUMMARY_CUE
      : "Write in English. " +
        namesInstruction(lang) +
        "Write 1-3 sentences. End every sentence with the numbers of the notes it uses, " +
        "like [1][3]. Keep dates, names, facts, and any uncertainty.<|im_end|>\n" +
        "<|im_start|>assistant\n");
  const overhead =
    cpLen(head) +
    cpLen(tail) +
    shown.reduce((n, _, i) => n + cpLen(`[${i + 1}] \"\"\"\"\"\"\n`), 0);
  const budget = Math.max(0, max - overhead);
  const per = shown.length > 0 ? Math.floor(budget / shown.length) : 0;
  let body = "";
  for (let i = 0; i < shown.length; i++) {
    body += `[${i + 1}] \"\"\"${clipCp(shown[i] as string, per)}\"\"\"\n`;
  }
  return tailClip(head + body + tail, max);
}

function claimTemplate(lang: PromptLanguage): VerificationTemplate {
  return lang === "cjk"
    ? {
        head:
          "<|im_start|>system\nあなたは主張を検証します。YES または NO だけを出力し、それ以外は何も書かないでください。<|im_end|>\n" +
          "<|im_start|>user\n本文：\n\"\"\"",
        mid: "\"\"\"\n主張：\n\"\"\"",
        tail:
          "\"\"\"\n" +
          namesInstruction(lang) +
          "主張のすべての文が本文に支持されている場合は YES、そうでなければ NO と答えてください。<|im_end|>\n<|im_start|>assistant\n",
      }
    : {
        head:
          "<|im_start|>system\nYou verify a claim. Reply with only YES or NO and nothing else.<|im_end|>\n" +
          "<|im_start|>user\nTEXT:\n\"\"\"",
        mid: "\"\"\"\nCLAIM:\n\"\"\"",
        tail:
          "\"\"\"\n" +
          namesInstruction(lang) +
          "Reply YES if every statement in CLAIM is supported by TEXT. " +
          "Otherwise reply NO.<|im_end|>\n<|im_start|>assistant\n",
      };
}

function claimBudget(
  text: string,
  claim: string,
  maxPromptChars: number,
): VerificationBudget {
  const max = clampMaxPromptChars(maxPromptChars);
  const template = claimTemplate(promptLanguageFor(text));
  const overhead = cpLen(template.head) + cpLen(template.mid) + cpLen(template.tail);
  const available = max - overhead - cpLen(claim);
  const minSource = Math.min(EPISODE_VERIFY_MIN_SOURCE_CP, cpLen(text));
  return { template, available, minSource, ok: available >= minSource };
}

/**
 * Strict per-sentence claim verification against the cited RAW text (not a
 * summary). The full claim is always shown; only the raw text may be clipped.
 * Returns null when the full claim leaves too little raw text to verify.
 */
export function buildEpisodeClaimPrompt(
  text: string,
  claim: string,
  maxPromptChars: number,
): string | null {
  const b = claimBudget(text, claim, maxPromptChars);
  if (!b.ok) return null;
  const { head, mid, tail } = b.template;
  return head + clipCp(text, b.available) + mid + claim + tail;
}

/** True only when a full claim plus the minimum cited source fits. */
export function claimVerificationFits(
  text: string,
  claim: string,
  maxPromptChars: number,
): boolean {
  return claimBudget(text, claim, maxPromptChars).ok;
}

/** Strict verdict parse: only whitespace + YES is accepted. */
export function parseEpisodeYes(raw: unknown): boolean {
  return typeof raw === "string" && /^\s*YES\s*$/i.test(raw);
}

/* ------------------------------------------------------------------ */
/* Deterministic anchor guard (no model, pure)                         */
/* ------------------------------------------------------------------ */

function stripCitationMarkers(s: string): string {
  return s.replace(/\[\s*\d+\s*\]/g, " ");
}

function nfkcLower(s: string): string {
  return s.normalize("NFKC").toLowerCase();
}

/**
 * Common English words that are capitalized only because they start a
 * sentence. They are not treated as proper-noun anchors when they are the
 * first Latin word of a sentence (e.g. "The", "This"). Names are deliberately
 * absent from this list, so "Elena met her husband" still anchors "elena".
 */
const SENTENCE_START_COMMON = new Set<string>([
  "a",
  "after",
  "all",
  "also",
  "an",
  "and",
  "although",
  "as",
  "at",
  "because",
  "before",
  "both",
  "but",
  "by",
  "during",
  "each",
  "every",
  "finally",
  "first",
  "for",
  "from",
  "he",
  "her",
  "here",
  "his",
  "however",
  "i",
  "if",
  "in",
  "it",
  "its",
  "later",
  "many",
  "meanwhile",
  "most",
  "my",
  "next",
  "no",
  "not",
  "of",
  "on",
  "one",
  "or",
  "our",
  "she",
  "so",
  "some",
  "summary",
  "that",
  "the",
  "their",
  "them",
  "then",
  "there",
  "these",
  "they",
  "this",
  "those",
  "though",
  "to",
  "today",
  "tomorrow",
  "two",
  "we",
  "when",
  "where",
  "while",
  "with",
  "yesterday",
  "you",
  "your",
]);

/**
 * Tokens a claim cannot invent: capitalized Latin words (proper-noun-like),
 * Latin words with a digit, all digit runs, and katakana/kanji runs of >= 2
 * characters. NFKC folds full-width forms before tokenization; citations are
 * ignored. The first Latin word of each sentence is excluded from the
 * capitalized-word rule when it is a common sentence starter ("The", "This",
 * ...) because English capitalizes it grammatically; digit-containing words
 * and digit runs still count. Returned tokens are lowercased for
 * case-insensitive matching (CJK is unchanged by lowercasing).
 */
export function anchorTokens(text: string): string[] {
  const norm = text.normalize("NFKC").replace(/\[\s*\d+\s*\]/g, " ");
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (t: string): void => {
    if (!seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
  };
  let firstLatinSeen = false;
  let scannedThrough = 0;
  for (const m of norm.matchAll(/[A-Za-z][A-Za-z0-9]*/g)) {
    const idx = m.index ?? 0;
    // A sentence boundary between the previous word and this one restarts
    // "first Latin word of the sentence" tracking (. ! ? 。 ！ ？).
    if (/[.!?。！？]/.test(norm.slice(scannedThrough, idx))) firstLatinSeen = false;
    scannedThrough = idx + m[0].length;
    const w = m[0];
    const first = !firstLatinSeen;
    firstLatinSeen = true;
    const lower = w.toLowerCase();
    const capitalized = /^[A-Z]/.test(w);
    const digitWord = cpLen(w) >= 2 && /[0-9]/.test(w);
    const skipCommonStarter = first && capitalized && !digitWord && SENTENCE_START_COMMON.has(lower);
    if ((capitalized || digitWord) && !skipCommonStarter) add(lower);
  }
  for (const m of norm.matchAll(/[0-9]+/g)) add(m[0]);
  for (const m of norm.matchAll(/[\u30A1-\u30FA\u30FC-\u30FF]+/g)) {
    if (cpLen(m[0]) >= 2) add(m[0]);
  }
  for (const m of norm.matchAll(/[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]+/g)) {
    if (cpLen(m[0]) >= 2) add(m[0]);
  }
  return out;
}

/**
 * Anchor tokens present in the claim but absent from the source. Empty means
 * the deterministic guard passes. Pure: NFKC + case-fold, substring match.
 */
export function missingAnchorTokens(claim: string, source: string): string[] {
  const haystack = nfkcLower(stripCitationMarkers(source));
  const missing: string[] = [];
  for (const token of anchorTokens(claim)) {
    if (!haystack.includes(token)) missing.push(token);
  }
  return missing;
}

interface CitedSentence {
  text: string;
  citations: number[];
}

interface CitedSentenceParse {
  sentences: CitedSentence[];
  dropped: number;
}

/**
 * Bounded cited-sentence parser. Splits on sentence enders, keeps only
 * in-range citation numbers (invalid/out-of-range markers are dropped).
 * Sentences with no valid citation (or no text after marker removal) are
 * dropped and counted, so the caller can report them.
 */
export function parseCitedSentences(raw: unknown, inputCount: number): CitedSentenceParse {
  if (typeof raw !== "string") return { sentences: [], dropped: 0 };
  let s = raw.replace(/\s+/g, " ").trim();
  if (s.length === 0) return { sentences: [], dropped: 0 };
  // Tolerate "sentence. [1]" by moving a punctuation-following citation
  // group inside the sentence it belongs to.
  s = s.replace(/([.!?。！？])\s*((?:\[\s*\d+\s*\])+)/g, " $2$1");
  const parts = s.match(/[^.!?。！？]+[.!?。！？]*/g) ?? [];
  const out: CitedSentence[] = [];
  let dropped = 0;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (part.length === 0) continue;
    const citations: number[] = [];
    const seen = new Set<number>();
    for (const m of part.matchAll(/\[\s*(\d+)\s*\]/g)) {
      const n = Number(m[1]);
      if (Number.isSafeInteger(n) && n >= 1 && n <= inputCount && !seen.has(n)) {
        seen.add(n);
        citations.push(n);
      }
    }
    const text = part
      .replace(/\[\s*\d+\s*\]/g, " ")
      .replace(/\s+/g, " ")
      .replace(/\s+([.!?。！？])/g, "$1")
      .trim();
    if (!/[^\s.!?。！？]/u.test(text)) continue;
    if (citations.length === 0) {
      dropped++;
      continue;
    }
    out.push({ text, citations });
  }
  return { sentences: out, dropped };
}

/* ------------------------------------------------------------------ */
/* Params / envelope plumbing                                          */
/* ------------------------------------------------------------------ */

function budgeted(res: ResponseEnvelope, config: AppConfig): ResponseEnvelope {
  return applyResponseBudget(res, config.limits.responseMaxBytes);
}
function bad(): ResponseEnvelope {
  return fail("BAD_REQUEST");
}
function conflict(): ResponseEnvelope {
  return fail("CONFLICT");
}

function parseScope(scope: unknown): string | null {
  if (typeof scope !== "string") return null;
  if (countCp(scope) < 1 || countCp(scope) > 256 || hasControl(scope)) return null;
  return scope;
}

function parseEpisodeKey(v: unknown): string | null | "invalid" {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return "invalid";
  if (countCp(v) < 1 || countCp(v) > 256 || hasControl(v)) return "invalid";
  return v;
}

/** Strict maintain.episodes params (sync, no I/O). */
export function parseEpisodesParams(
  config: AppConfig,
  params: Record<string, unknown>,
): { ok: true; value: EpisodesParams } | { ok: false; res: ResponseEnvelope } {
  const allowed = new Set(["scope", "kind", "episodeKey", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: budgeted(bad(), config) };
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return { ok: false, res: budgeted(bad(), config) };
  const kind = params["kind"];
  if (typeof kind !== "string" || !EPISODE_KINDS.has(kind)) {
    return { ok: false, res: budgeted(bad(), config) };
  }
  const episodeKey = parseEpisodeKey(params["episodeKey"]);
  if (episodeKey === "invalid") return { ok: false, res: budgeted(bad(), config) };
  const bounds = episodesBounds(config);
  let limit = bounds.batchMax;
  if (params["limit"] !== undefined) {
    const v = params["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, res: budgeted(bad(), config) };
    }
    if (v > bounds.batchMax) return { ok: false, res: budgeted(fail("LIMIT_EXCEEDED"), config) };
    limit = v;
  }
  return { ok: true, value: { scope, kind: kind as EpisodeKind, episodeKey, limit } };
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

function storeEpisodesResult(
  db: DatabaseSync,
  config: AppConfig,
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
    ).run(key, EPISODES_OP, reqHash, JSON.stringify(stored), now);
    db.prepare(
      `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
       VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      now,
      EPISODES_OP,
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
    if (again && again.op === EPISODES_OP && again.requestHash === reqHash) {
      try {
        return budgeted({ ...(JSON.parse(again.responseJson) as ResponseEnvelope), deduplicated: true }, config);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
    }
    return budgeted(conflict(), config);
  }
  return budgeted(fail("STORE_UNAVAILABLE"), config);
}

function shaHex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* Episode selection / incremental reads                               */
/* ------------------------------------------------------------------ */

interface EpisodeEntry {
  episodeKey: string;
  startAt: string;
  maxCreatedAt: string;
}

function keyExpression(kind: EpisodeKind): string {
  return kind === "session" ? "sessionId" : kind === "doc" ? "docId" : "date(observedAt, ?)";
}

/**
 * Stale episodes of one kind. Staleness is explicit, never timestamp-based:
 * an episode needs work when it has (a) a raw event without an
 * episode_event_done row, or (b) an active window ledger row that is not in
 * the union of every episode-level row's foldedRecordIds set. Ordered by
 * startAt ASC (then episodeKey) and bounded by `limit`.
 */
function listStaleEpisodes(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  kind: EpisodeKind,
  limit: number,
  episodeKey: string | null,
): EpisodeEntry[] {
  const offset = episodesBounds(config).utcOffsetMinutes;
  const offsetModifier = `${offset >= 0 ? "+" : ""}${offset} minutes`;
  const keyExpr = keyExpression(kind);
  const args: Array<string | number> = [];
  if (kind === "day") args.push(offsetModifier);
  args.push(scope);
  args.push(scope, kind, scope, kind, scope, kind);
  let sql = `SELECT g.episodeKey AS episodeKey,
                    MIN(g.observedAt) AS startAt,
                    MAX(g.createdAt) AS maxCreatedAt
             FROM (SELECT ${keyExpr} AS episodeKey, observedAt, createdAt, eventId
                   FROM raw_events
                   WHERE scope = ?${kind === "doc" ? " AND docId IS NOT NULL" : ""}) g
             WHERE (
               NOT EXISTS (
                 SELECT 1 FROM episode_event_done d
                 WHERE d.scope = ? AND d.kind = ? AND d.episodeKey = g.episodeKey
                   AND d.eventId = g.eventId)
               OR EXISTS (
                 SELECT 1 FROM episode_summaries w
                 JOIN records rw ON rw.id = w.recordId AND rw.status = 'active'
                  WHERE w.scope = ? AND w.kind = ? AND w.episodeKey = g.episodeKey
                    AND w.level = 'window'
                    AND w.recordId NOT IN (
                      -- Union over every episode-level row. Picking one row by
                      -- createdAt would make staleness depend on timestamps
                      -- again (and on an arbitrary winner when they tie).
                      SELECT j.value
                      FROM episode_summaries ep,
                           json_each(COALESCE(ep.foldedRecordIds, '[]')) j
                      WHERE ep.scope = ? AND ep.kind = ? AND ep.episodeKey = g.episodeKey
                        AND ep.level = 'episode'))
             )`;
  if (episodeKey !== null) {
    sql += ` AND g.episodeKey = ?`;
    args.push(episodeKey);
  }
  sql += ` GROUP BY g.episodeKey
           ORDER BY startAt ASC, g.episodeKey ASC LIMIT ?`;
  args.push(limit);
  const rows = db.prepare(sql).all(...args) as Array<{
    episodeKey: string;
    startAt: string;
    maxCreatedAt: string;
  }>;
  return rows.map((r) => ({
    episodeKey: r.episodeKey,
    startAt: r.startAt,
    maxCreatedAt: r.maxCreatedAt,
  }));
}

interface RawEventRow {
  eventId: string;
  body: string;
  observedAt: string;
  createdAt: string;
  /** Stored source sensitivity (NULL = legacy/unknown privacy). */
  privacySensitivity: string | null;
}

/**
 * Pending raw events only (no episode_event_done row), in processing order
 * observedAt ASC then eventId ASC. Creation timestamps never filter events:
 * observation/creation order divergence and ties cannot hide a failed event.
 */
function eventsForEpisode(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
): RawEventRow[] {
  const offset = episodesBounds(config).utcOffsetMinutes;
  const offsetModifier = `${offset >= 0 ? "+" : ""}${offset} minutes`;
  const predicate =
    kind === "session" ? "e.sessionId = ?" : kind === "doc" ? "e.docId = ?" : "date(e.observedAt, ?) = ?";
  const args: Array<string | number> = [scope];
  if (kind === "day") args.push(offsetModifier);
  args.push(episodeKey, kind, episodeKey);
  const sql = `SELECT e.eventId AS eventId, e.body AS body,
                      e.observedAt AS observedAt, e.createdAt AS createdAt,
                      e.privacySensitivity AS privacySensitivity
               FROM raw_events e
               WHERE e.scope = ? AND ${predicate}
                 AND NOT EXISTS (
                   SELECT 1 FROM episode_event_done d
                   WHERE d.scope = e.scope AND d.kind = ? AND d.episodeKey = ?
                     AND d.eventId = e.eventId)
               ORDER BY e.observedAt ASC, e.eventId ASC`;
  return db.prepare(sql).all(...args) as unknown as RawEventRow[];
}

/**
 * `coveredThrough` compatibility field: max observedAt over events whose
 * done marker exists. It is an observed-time report only; staleness/pending
 * decisions use the explicit done rows and folded-window marker instead.
 */
function maxDoneObservedAt(
  db: DatabaseSync,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
): string | null {
  const row = db
    .prepare(
      `SELECT MAX(e.observedAt) AS covered
       FROM episode_event_done d
       JOIN raw_events e ON e.eventId = d.eventId AND e.scope = d.scope
       WHERE d.scope = ? AND d.kind = ? AND d.episodeKey = ?`,
    )
    .get(scope, kind, episodeKey) as { covered: string | null } | undefined;
  return row?.covered ?? null;
}

function insertDoneRow(
  db: DatabaseSync,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
  eventId: string,
  doneAt: string,
): void {
  insertEpisodeEventDone(db, { scope, kind, episodeKey, eventId, doneAt });
}

/**
 * Run derived episode writes atomically under the run owner's lease. Reused
 * for ledger replays and no-window done markers, where there is no canonical
 * record transaction to piggyback on.
 */
function fencedEpisodeWrite(
  db: DatabaseSync,
  fence: CanonicalWriteFence,
  write: (txDb: DatabaseSync) => void,
): boolean {
  db.exec("BEGIN IMMEDIATE");
  try {
    if (!isCultivationLeaseHeldBy(db, fence.owner, fence.now)) {
      throw new Error("lease lost");
    }
    write(db);
    db.exec("COMMIT");
    return true;
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return false;
  }
}

interface WindowLedgerHit {
  recordId: string;
  body: string;
}

function existingWindow(
  db: DatabaseSync,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
  eventId: string,
  start: number,
  end: number,
): WindowLedgerHit | null {
  try {
    const row = db
      .prepare(
        `SELECT s.recordId AS recordId, r.body AS body, r.status AS status
         FROM episode_summaries s
         JOIN records r ON r.id = s.recordId
         WHERE s.scope = ? AND s.kind = ? AND s.episodeKey = ? AND s.level = 'window'
           AND s.eventId = ? AND s.spanStart = ? AND s.spanEnd = ?
         ORDER BY s.createdAt DESC, s.recordId ASC LIMIT 1`,
      )
      .get(scope, kind, episodeKey, eventId, start, end) as
      | { recordId: string; body: string; status: string }
      | undefined;
    if (!row || row.status !== "active") return null;
    return { recordId: row.recordId, body: row.body };
  } catch {
    return null;
  }
}

function activeEpisodeRecord(
  db: DatabaseSync,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
): { recordId: string; body: string } | null {
  const rows = listEpisodeSummaries(db, scope, kind, episodeKey, "episode");
  for (const r of rows) {
    try {
      const rec = db
        .prepare(`SELECT body, status FROM records WHERE id = ?`)
        .get(r.recordId) as { body: string; status: string } | undefined;
      if (rec && rec.status === "active") return { recordId: r.recordId, body: rec.body };
    } catch {
      /* ignore */
    }
  }
  return null;
}

interface EpisodeWindow {
  recordId: string;
  eventId: string;
  spanStart: number;
  spanEnd: number;
  /** Verified window-level summary body. */
  body: string;
  /** Raw code-point slice of the event body for [spanStart, spanEnd). */
  rawText: string;
  /** Privacy sensitivity of the window's raw event (NULL = unknown). */
  privacySensitivity: string | null;
  observedAt: string;
  createdAt: string;
}

interface WindowInputSet {
  windows: EpisodeWindow[];
  /** max observedAt over done events at read time (compatibility report). */
  coveredThrough: string | null;
}

/**
 * ALL active window-ledger summaries of the episode, in event/span order.
 * The reduce step rebuilds the episode from these every time (no
 * summary-of-summary folding), so a rejected reduce remains retryable with
 * zero new windows. Completion/folding is tracked explicitly (done rows and
 * the episode row's foldedRecordIds), not by timestamps.
 */
function windowInputsForEpisode(
  db: DatabaseSync,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
): WindowInputSet {
  const empty: WindowInputSet = { windows: [], coveredThrough: null };
  let rows: Array<{
    recordId: string;
    eventId: string;
    spanStart: number;
    spanEnd: number;
    body: string;
    eventBody: string;
    privacySensitivity: string | null;
    createdAt: string;
    observedAt: string;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT s.recordId AS recordId, s.eventId AS eventId,
                s.spanStart AS spanStart, s.spanEnd AS spanEnd,
                r.body AS body, e.body AS eventBody,
                e.privacySensitivity AS privacySensitivity,
                e.createdAt AS createdAt, e.observedAt AS observedAt
         FROM episode_summaries s
         JOIN records r ON r.id = s.recordId AND r.status = 'active' AND r.scope = s.scope
         JOIN raw_events e ON e.eventId = s.eventId AND e.scope = s.scope
         WHERE s.scope = ? AND s.kind = ? AND s.episodeKey = ? AND s.level = 'window'
         ORDER BY e.observedAt ASC, e.eventId ASC, s.spanStart ASC, s.spanEnd ASC,
                  s.createdAt DESC, s.recordId ASC`,
      )
      .all(scope, kind, episodeKey) as unknown as typeof rows;
  } catch {
    return empty;
  }

  // One row per raw span: the query orders newest ledger rows first.
  const seen = new Set<string>();
  const deduped: typeof rows = [];
  for (const row of rows) {
    const key = `${row.eventId}\u0000${row.spanStart}\u0000${row.spanEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(row);
  }

  const windows: EpisodeWindow[] = deduped.map((row) => ({
    recordId: row.recordId,
    eventId: row.eventId,
    spanStart: row.spanStart,
    spanEnd: row.spanEnd,
    body: row.body,
    rawText: Array.from(row.eventBody).slice(row.spanStart, row.spanEnd).join(""),
    privacySensitivity: row.privacySensitivity,
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  }));

  return {
    windows,
    coveredThrough: maxDoneObservedAt(db, scope, kind, episodeKey),
  };
}

/** Unique window record ids across the episode's accepted windows. */
function foldedWindowIds(windows: EpisodeWindow[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of windows) {
    if (seen.has(w.recordId)) continue;
    seen.add(w.recordId);
    out.push(w.recordId);
  }
  return out;
}

/** Deduped cited spans in first-citation order, capped keeping the earliest. */
function episodeSourceRefs(windows: EpisodeWindow[], max: number): SourceRef[] {
  const seen = new Set<string>();
  const out: SourceRef[] = [];
  for (const w of windows) {
    if (out.length >= max) break;
    const key = `${w.eventId}\u0000${w.spanStart}\u0000${w.spanEnd}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ eventId: w.eventId, start: w.spanStart, end: w.spanEnd });
  }
  return out;
}

/** Deduped window record ids in first-citation order, capped. */
function episodeLinks(windows: EpisodeWindow[], max: number): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of windows) {
    if (out.length >= max) break;
    if (seen.has(w.recordId)) continue;
    seen.add(w.recordId);
    out.push(w.recordId);
  }
  return out;
}

/**
 * Normalized whitespace + bodyMaxCp clip for a verbatim window fallback.
 * The clip bounds BOTH the raw code points and `normalizeBody` output, because
 * NFKC can expand code points (e.g. "…" -> "...") and rememberRecord rejects
 * a body whose normalized length exceeds bodyMaxCp. The span sourceRef still
 * covers the whole window; this body is only a bounded display prefix.
 */
function verbatimWindowBody(text: string, bodyMaxCp: number): string {
  return clipTextToNormalizedCp(text.replace(/\s+/g, " ").trim(), bodyMaxCp);
}

/**
 * Write one window canonical record plus its level='window' ledger row (and,
 * when this completes the event, its done marker) atomically under the run
 * owner's lease. Returns the record id, or null when the fence is lost or any
 * write fails. Shared by model summaries and verbatim fallbacks so both have
 * identical span provenance.
 */
function writeWindowRecord(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
  event: { eventId: string; observedAt: string },
  spanStart: number,
  spanEnd: number,
  body: string,
  tags: string[],
  privacy: PrivacyMetadata | null,
  now: string,
  fence: CanonicalWriteFence,
  markEventDone: boolean,
): string | null {
  const windowKey = `epw-${shaHex(
    [scope, kind, episodeKey, event.eventId, spanStart, spanEnd, body].join("\u0000"),
  ).slice(0, 48)}`;
  const addLedgerRows = (txDb: DatabaseSync, recordId: string): void => {
    insertEpisodeSummary(txDb, {
      scope,
      kind,
      episodeKey,
      level: "window",
      recordId,
      eventId: event.eventId,
      spanStart,
      spanEnd,
      coveredThrough: null,
      createdAt: now,
    });
    if (markEventDone) {
      insertDoneRow(txDb, scope, kind, episodeKey, event.eventId, now);
    }
  };
  const wr = rememberRecord(
    db,
    config,
    {
      body,
      kind: "summary",
      provenance: { source: EPISODE_SUMMARY_SOURCE, observedAt: event.observedAt },
      scope,
      tags,
      links: [],
      sourceRefs: [{ eventId: event.eventId, start: spanStart, end: spanEnd }],
      ...(privacy !== null ? { privacy } : {}),
    },
    windowKey,
    now,
    {
      owner: fence.owner,
      now: fence.now,
      afterInsert: (txDb, recordId) => addLedgerRows(txDb, recordId),
    },
  );
  const recordId = wr.ok
    ? ((wr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined)
    : undefined;
  if (!wr.ok || typeof recordId !== "string") return null;
  if (wr.deduplicated) {
    // Crash repair / replay: the canonical record already exists, so mirror
    // the missing ledger (and done) rows in one fenced transaction.
    if (!fencedEpisodeWrite(db, fence, (txDb) => addLedgerRows(txDb, recordId as string))) {
      return null;
    }
  }
  return recordId;
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

interface EpisodeResult {
  kind: EpisodeKind;
  episodeKey: string;
  /**
   * windowsWritten counts only model-summary windows. windowsVerbatim counts
   * content-rejected windows written as raw verbatim fallback. windowsRejected
   * counts every rejected model attempt, including attempts recovered
   * verbatim and generation failures that write nothing.
   */
  windowsWritten: number;
  windowsVerbatim: number;
  windowsRejected: number;
  episodeRecordId: string | null;
  coveredThrough: string | null;
  /** Sentences surviving citation parsing + raw-anchor guard + YES verdict. */
  sentencesKept: number;
  sentencesDropped: number;
  /** True when no cited sentence survived and verified window summaries were used. */
  extractive: boolean;
  /**
   * True when a transient model failure (null/timeout/throw) prevented the
   * reduce step from completing. No episode-level record or ledger/fold change
   * is written; the episode stays stale and is retried on a later pass.
   */
  reduceDeferred: boolean;
}

/**
 * Run one bounded maintain.episodes pass. Idempotent per caller key: same key
 * + same params replays the stored envelope; changed params => CONFLICT.
 * Lease contention => transient CONFLICT (never stored).
 */
export async function maintainEpisodes(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
  params: Record<string, unknown>,
  idempotencyKey: string,
  generateOverride?: EpisodesGenerate,
  nowOverride?: string,
): Promise<ResponseEnvelope> {
  const parsed = parseEpisodesParams(config, params);
  if (!parsed.ok) return parsed.res;
  const p = parsed.value;
  const reqHash = requestHashFor(EPISODES_OP, {
    episodeKey: p.episodeKey,
    kind: p.kind,
    limit: p.limit,
    scope: p.scope,
  });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== EPISODES_OP) return budgeted(conflict(), config);
    const denied = scopeGate(db, config, p.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(conflict(), config);
    try {
      return budgeted({ ...(JSON.parse(saved.responseJson) as ResponseEnvelope), deduplicated: true }, config);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
  }
  {
    const denied = scopeGate(db, config, p.scope);
    if (denied) return denied;
  }
  const nowValid = (nowOverride ?? new Date().toISOString()) as string;
  if (!Number.isFinite(Date.parse(nowValid))) return budgeted(fail("STORE_UNAVAILABLE"), config);

  // Shared with maintain.distill (same leaseId 'm3'): the two never overlap.
  const execOwner = `${idempotencyKey}#${randomBytes(8).toString("hex")}`;
  const lease = acquireCultivationLease(db, config, { owner: execOwner, scope: p.scope, now: nowValid });
  if (!lease.acquired) return budgeted(conflict(), config);

  try {
    const modelDir = resolveLlmDir(config, configPath);
    // Production degrades when the model is disabled/missing (an explicitly
    // configured but unusable llm section never runs, even with an injected
    // generator). A generator injected against a config that has no llm
    // section is the test model itself, so no model files are required.
    const modelUsable = llmEnabled(config) && modelFilesPresent(modelDir);
    const usable =
      modelUsable || (generateOverride !== undefined && config.llm === undefined);
    if (!usable) {
      const stored = budgeted(
        ok({ episodes: [], applied: 0, degraded: true }),
        config,
      );
      try {
        storeEpisodesResult(db, config, idempotencyKey, reqHash, stored, p.scope, nowValid, 0);
      } catch (e) {
        return handleStoreRace(db, config, idempotencyKey, reqHash, e);
      }
      return stored;
    }

    const bounds = episodesBounds(config);
    const timeoutMs = llmTimeoutMs(config);
    const maxPromptChars = llmMaxPromptChars(config);
    const maxNewTokens = bounds.maxNewTokens;
    const maintenanceMs = maintenanceTimeoutMs(config);
    const startedMs = Date.now();
    const overDeadline = (): boolean => Date.now() - startedMs > maintenanceMs;
    const testClock = nowOverride !== undefined;
    const renewNow = (): string => (testClock ? nowValid : new Date().toISOString());
    const renewOrAbort = (): "ok" | "deadline" | "lost" => {
      if (overDeadline()) return "deadline";
      const r = acquireCultivationLease(db, config, {
        owner: execOwner,
        scope: p.scope,
        now: renewNow(),
      });
      return r.acquired ? "ok" : "lost";
    };
    const generate: EpisodesGenerate =
      generateOverride ??
      ((prompt, tokens) => generateCompletion(prompt, modelDir, { timeoutMs, maxNewTokens: tokens }));

    let selected: EpisodeEntry[];
    try {
      selected = listStaleEpisodes(db, config, p.scope, p.kind, p.limit, p.episodeKey);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }

    const results: EpisodeResult[] = [];
    let applied = 0;

    for (const ep of selected) {
      let windowsWritten = 0;
      let windowsVerbatim = 0;
      let windowsRejected = 0;
      let aborted = false;

      const existingCovered = (() => {
        try {
          return maxDoneObservedAt(db, p.scope, p.kind, ep.episodeKey);
        } catch {
          return null;
        }
      })();

      let events: RawEventRow[];
      try {
        events = eventsForEpisode(db, config, p.scope, p.kind, ep.episodeKey);
      } catch {
        results.push({
          kind: p.kind,
          episodeKey: ep.episodeKey,
          windowsWritten: 0,
          windowsVerbatim: 0,
          windowsRejected: 0,
          episodeRecordId: null,
          coveredThrough: existingCovered,
          sentencesKept: 0,
          sentencesDropped: 0,
          extractive: false,
          reduceDeferred: false,
        });
        continue;
      }

      for (const ev of events) {
        const ranges = splitTextRanges(ev.body, bounds.windowMaxCp).filter(
          (r) => /\S/u.test(Array.from(ev.body).slice(r.start, r.end).join("")),
        );
        let eventOk = true;
        let eventDone = false;

        // Window-level privacy is exactly its raw event's privacy (origin is
        // always self_activity for derived content). With requirePrivacy, an
        // unknown source cannot be written through the canonical store: keep
        // the event pending (same non-content skip semantics as a null
        // privacy in deriveConsolidationPrivacy) instead of inventing one.
        const eventPrivacy = deriveConsolidationPrivacy([ev.privacySensitivity]);
        if (requirePrivacyEnabled(config) && eventPrivacy === null) {
          eventOk = false;
          break;
        }

        for (const range of ranges) {
          // A retry after a partial event must not re-run an already accepted
          // window (and must not create a duplicate canonical record).
          const prior = existingWindow(
            db,
            p.scope,
            p.kind,
            ep.episodeKey,
            ev.eventId,
            range.start,
            range.end,
          );
          if (prior) continue;

          const state = renewOrAbort();
          if (state !== "ok") {
            aborted = true;
            break;
          }
          if (overDeadline()) {
            aborted = true;
            break;
          }

          const cps = Array.from(ev.body);
          const windowText = cps.slice(range.start, range.end).join("");
          let rawSummary: string | null = null;
          try {
            rawSummary = await generate(
              buildEpisodeWindowPrompt(windowText, maxPromptChars),
              maxNewTokens,
            );
          } catch {
            rawSummary = null;
          }
          if (rawSummary === null) {
            // Timeout / model failure: write nothing and keep the episode
            // stale (no verbatim fallback for an absent model answer).
            windowsRejected++;
            eventOk = false;
            break;
          }
          let summaryBody = parseSummaryBody(rawSummary, config.limits.bodyMaxCp);
          if (summaryBody !== null && promptLanguageFor(windowText) === "cjk") {
            // The Japanese assistant prefill may be echoed; remove it before
            // parse/anchor checks.
            summaryBody = parseSummaryBody(stripSummaryCue(summaryBody), config.limits.bodyMaxCp);
          }
          // Content rejections (parse failure, anchor miss, verifier NO) still
          // get a window record, but as raw verbatim text: the episode must be
          // able to advance instead of being retried into permanent staleness.
          let contentRejected = summaryBody === null;
          if (
            summaryBody !== null &&
            missingAnchorTokens(summaryBody, windowText).length > 0
          ) {
            contentRejected = true;
          }
          if (!contentRejected) {
            const verifyState = renewOrAbort();
            if (verifyState !== "ok") {
              aborted = true;
              break;
            }
            const verifyPrompt = buildEpisodeVerifyPrompt(
              windowText,
              summaryBody as string,
              maxPromptChars,
            );
            if (verifyPrompt === null) {
              // The full candidate cannot be shown with enough source to
              // verify it: this is a content rejection (verbatim fallback),
              // never a YES on a truncated candidate.
              contentRejected = true;
            } else {
              let rawVerify: string | null = null;
              try {
                rawVerify = await generate(verifyPrompt, Math.min(maxNewTokens, 16));
              } catch {
                rawVerify = null;
              }
              if (rawVerify === null) {
                // Timeout / model failure while verifying: no write.
                windowsRejected++;
                eventOk = false;
                break;
              }
              if (!parseEpisodeYes(rawVerify)) contentRejected = true;
            }
          }

          let windowBody: string;
          let windowTags: string[];
          if (contentRejected) {
            windowsRejected++;
            windowBody = verbatimWindowBody(windowText, config.limits.bodyMaxCp);
            windowTags = [EPISODE_WINDOW_TAG, EPISODE_WINDOW_VERBATIM_TAG];
          } else {
            windowBody = summaryBody as string;
            windowTags = [EPISODE_WINDOW_TAG];
          }
          if (windowBody.length === 0) {
            eventOk = false;
            break;
          }

          const completesEvent = ranges.every(
            (r) =>
              (r.start === range.start && r.end === range.end) ||
              existingWindow(
                db,
                p.scope,
                p.kind,
                ep.episodeKey,
                ev.eventId,
                r.start,
                r.end,
              ) !== null,
          );
          const writeFenceNow = renewNow();
          const recordId = writeWindowRecord(
            db,
            config,
            p.scope,
            p.kind,
            ep.episodeKey,
            ev,
            range.start,
            range.end,
            windowBody,
            windowTags,
            eventPrivacy,
            nowValid,
            { owner: execOwner, now: writeFenceNow },
            completesEvent,
          );
          if (recordId === null) {
            eventOk = false;
            aborted = true;
            break;
          }
          if (completesEvent) eventDone = true;
          if (contentRejected) windowsVerbatim++;
          else windowsWritten++;
          applied++;
        }

        if (aborted) break;
        if (!eventOk) break;
        if (!eventDone) {
          // All windows were already present (retry/repair): mark the event
          // done now, under the same lease fence.
          const doneFenceNow = renewNow();
          if (
            !fencedEpisodeWrite(
              db,
              { owner: execOwner, now: doneFenceNow },
              (txDb) => insertDoneRow(txDb, p.scope, p.kind, ep.episodeKey, ev.eventId, nowValid),
            )
          ) {
            aborted = true;
            break;
          }
        }
        if (overDeadline()) {
          aborted = true;
          break;
        }
      }

      // Reduce step: rebuild from ALL accepted active window summaries of the
      // episode in folds of EPISODE_FOLD_MAX (never fold the prior generated
      // episode body back in, which caused summary-of-summary drift). Each
      // sentence must cite in-range windows, pass the deterministic raw-anchor
      // guard, and then pass a strict YES/NO against the cited RAW text.
      const windowInputs = windowInputsForEpisode(db, p.scope, p.kind, ep.episodeKey);
      const allWindows = windowInputs.windows;
      let episodeRecordId: string | null = null;
      let sentencesKept = 0;
      let sentencesDropped = 0;
      let extractive = false;
      let reduceDeferred = false;

      if (!aborted && allWindows.length > 0) {
        const priorActive = activeEpisodeRecord(db, p.scope, p.kind, ep.episodeKey);
        const bodyMaxCp = config.limits.bodyMaxCp;
        const kept: Array<{ text: string; windows: EpisodeWindow[] }> = [];
        let reduceOk = true;

        for (let start = 0; start < allWindows.length; start += EPISODE_FOLD_MAX) {
          const group = allWindows.slice(start, start + EPISODE_FOLD_MAX);
          const state = renewOrAbort();
          if (state !== "ok") {
            aborted = true;
            reduceOk = false;
            break;
          }
          let rawMerge: string | null = null;
          try {
            rawMerge = await generate(
              buildEpisodeCitedReducePrompt(
                group.map((w) => w.body),
                maxPromptChars,
                group.map((w) => w.rawText).join("\n"),
              ),
              maxNewTokens,
            );
          } catch {
            rawMerge = null;
          }
          if (rawMerge === null) {
            // Transient generation failure (timeout / throw / unavailable
            // model): defer the whole reduce. Unlike a content rejection this
            // must not fall back to an extractive episode, otherwise the failed
            // reduce would be marked folded and never retried.
            reduceDeferred = true;
            reduceOk = false;
            break;
          }
          if (promptLanguageFor(group.map((w) => w.rawText).join("\n")) === "cjk") {
            rawMerge = stripSummaryCue(rawMerge);
          }
          const mergeBody = parseSummaryBody(rawMerge, bodyMaxCp);
          if (mergeBody === null) {
            // Unparseable model output (content rejection): write nothing for
            // this episode and retry it later (no transient-failure marker).
            reduceOk = false;
            break;
          }

          const parsed = parseCitedSentences(mergeBody, group.length);
          sentencesDropped += parsed.dropped;
          for (const sentence of parsed.sentences) {
            const cited = sentence.citations.map((i) => group[i - 1]!);
            const citedRaw = cited.map((w) => w.rawText).join("\n");
            if (missingAnchorTokens(sentence.text, citedRaw).length > 0) {
              sentencesDropped++;
              continue;
            }
            const claimState = renewOrAbort();
            if (claimState !== "ok") {
              aborted = true;
              reduceOk = false;
              break;
            }
            const claimPrompt = buildEpisodeClaimPrompt(
              citedRaw,
              sentence.text,
              maxPromptChars,
            );
            if (claimPrompt === null) {
              // Unverifiable without truncating the claim: drop the sentence
              // (extractive fallback handles a wholly unverifiable reduce).
              sentencesDropped++;
              continue;
            }
            let rawVerify: string | null = null;
            try {
              rawVerify = await generate(claimPrompt, Math.min(maxNewTokens, 16));
            } catch {
              rawVerify = null;
            }
            if (rawVerify === null) {
              // Transient verification failure: defer the reduce instead of
              // treating the claim as a content rejection.
              reduceDeferred = true;
              reduceOk = false;
              break;
            }
            if (!parseEpisodeYes(rawVerify)) {
              sentencesDropped++;
              continue;
            }
            kept.push({ text: sentence.text, windows: cited });
          }
          if (!reduceOk || aborted) break;
        }

        let finalSummary: string | null = null;
        let citedWindows: EpisodeWindow[] = [];
        if (reduceOk && !aborted) {
          if (kept.length > 0) {
            const parts: string[] = [];
            let used = 0;
            let included = 0;
            for (const k of kept) {
              const text = clipCp(k.text, bodyMaxCp);
              const sep = parts.length === 0 ? 0 : 1;
              // Stop at the first sentence that would push the episode body
              // over bodyMaxCp instead of skipping ahead out of order.
              if (used + sep + cpLen(text) > bodyMaxCp) {
                sentencesDropped += kept.length - included;
                break;
              }
              parts.push(text);
              used += sep + cpLen(text);
              citedWindows.push(...k.windows);
              included++;
            }
            finalSummary = parts.join(" ");
            sentencesKept = included;
          } else {
            // No cited sentence survived: fall back to the already-verified
            // window summaries in order. This still counts as a successful
            // reduce, so the episode is no longer stale.
            const parts: string[] = [];
            let used = 0;
            for (const w of allWindows) {
              const text = clipCp(w.body, bodyMaxCp);
              const sep = parts.length === 0 ? 0 : 1;
              if (parts.length > 0 && used + sep + cpLen(text) > bodyMaxCp) break;
              parts.push(text);
              used += sep + cpLen(text);
            }
            finalSummary = parts.join(" ");
            citedWindows = allWindows;
            extractive = true;
          }
        }

        // Episode-level sources are the raw events of the windows the episode
        // actually cites (or, in the extractive fallback, every folded
        // window). Origin is self_activity; sensitivity follows the same
        // helper as maintain.distill's summary consolidation (sensitive wins,
        // all-known => normal, else null).
        const episodePrivacy = deriveConsolidationPrivacy(
          citedWindows.map((w) => w.privacySensitivity),
        );
        const strictPrivacyBlocked =
          requirePrivacyEnabled(config) && episodePrivacy === null;

        if (
          reduceOk &&
          !aborted &&
          !strictPrivacyBlocked &&
          finalSummary !== null &&
          cpLen(finalSummary) > 0
        ) {
          // foldedRecordIds is the explicit "already reduced" marker: every
          // active window this reduce considered. It is written with the
          // episode ledger row in the canonical record's transaction.
          const folded = foldedWindowIds(allWindows);
          const privacyParam = episodePrivacy !== null ? { privacy: episodePrivacy } : {};
          const effectiveCovered = maxDoneObservedAt(db, p.scope, p.kind, ep.episodeKey);
          const ledgerRow = (recordId: string) => ({
            scope: p.scope,
            kind: p.kind,
            episodeKey: ep.episodeKey,
            level: "episode" as const,
            recordId,
            eventId: null,
            spanStart: null,
            spanEnd: null,
            coveredThrough: effectiveCovered,
            foldedRecordIds: folded,
            createdAt: nowValid,
          });
          const writeLedger = (txDb: DatabaseSync, recordId: string): void => {
            insertEpisodeSummary(txDb, ledgerRow(recordId));
          };
          const links = episodeLinks(citedWindows, config.limits.linksMax);
          const sourceRefs = episodeSourceRefs(citedWindows, config.limits.sourceRefsMax);
          const provenance = {
            source: EPISODE_SUMMARY_SOURCE,
            observedAt: windowInputs.coveredThrough ?? nowValid,
          };
          let newRecordId: string | null = null;
          if (priorActive) {
            const correctKey = `epe-${shaHex(
              [p.scope, p.kind, ep.episodeKey, priorActive.recordId, finalSummary].join("\u0000"),
            ).slice(0, 48)}`;
            const cr = correctRecord(
              db,
              config,
              {
                recordId: priorActive.recordId,
                body: finalSummary,
                kind: "correction",
                provenance,
                scope: p.scope,
                links,
                sourceRefs,
                ...privacyParam,
              },
              correctKey,
              nowValid,
              {
                owner: execOwner,
                now: renewNow(),
                afterInsert: (txDb, recordId) => writeLedger(txDb, recordId),
              },
            );
            if (cr.ok) {
              newRecordId =
                ((cr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
                null;
              if (newRecordId !== null && cr.deduplicated) {
                // Replayed canonical write: mirror the derived ledger row.
                if (
                  !fencedEpisodeWrite(
                    db,
                    { owner: execOwner, now: renewNow() },
                    (txDb) => writeLedger(txDb, newRecordId as string),
                  )
                ) {
                  aborted = true;
                  newRecordId = null;
                }
              }
            } else if (cr.code === "CONFLICT") {
              // A CONFLICT caused by a stolen/expired lease must not fall back
              // to another write: stop the episode with no partial state.
              if (!isCultivationLeaseHeldBy(db, execOwner, renewNow())) {
                aborted = true;
              } else {
                // Fallback consistent with existing rules: remember the new
                // summary and archive the old one as OBSOLETE (no deletes).
                const rememberKey = `eper-${shaHex(
                  [p.scope, p.kind, ep.episodeKey, finalSummary].join("\u0000"),
                ).slice(0, 48)}`;
                const rr = rememberRecord(
                  db,
                  config,
                  {
                    body: finalSummary,
                    kind: "summary",
                    provenance,
                    scope: p.scope,
                    tags: [EPISODE_TAG],
                    links,
                    sourceRefs,
                    ...privacyParam,
                  },
                  rememberKey,
                  nowValid,
                  {
                    owner: execOwner,
                    now: renewNow(),
                    afterInsert: (txDb, recordId) => writeLedger(txDb, recordId),
                  },
                );
                if (rr.ok) {
                  newRecordId =
                    ((rr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
                    null;
                  if (newRecordId !== null && rr.deduplicated) {
                    if (
                      !fencedEpisodeWrite(
                        db,
                        { owner: execOwner, now: renewNow() },
                        (txDb) => writeLedger(txDb, newRecordId as string),
                      )
                    ) {
                      aborted = true;
                      newRecordId = null;
                    }
                  }
                  if (newRecordId !== null) {
                    const ar = archiveRecord(
                      db,
                      config,
                      { id: priorActive.recordId, scope: p.scope, reasonCode: "OBSOLETE" },
                      `epa-${shaHex([p.scope, ep.episodeKey, priorActive.recordId].join("\u0000")).slice(0, 48)}`,
                      nowValid,
                      { owner: execOwner, now: renewNow() },
                    );
                    if (!ar.ok && !isCultivationLeaseHeldBy(db, execOwner, renewNow())) {
                      aborted = true;
                    }
                  }
                } else if (!isCultivationLeaseHeldBy(db, execOwner, renewNow())) {
                  aborted = true;
                }
              }
            }
          } else {
            const rememberKey = `epe-${shaHex(
              [p.scope, p.kind, ep.episodeKey, finalSummary].join("\u0000"),
            ).slice(0, 48)}`;
            const rr = rememberRecord(
              db,
              config,
              {
                body: finalSummary,
                kind: "summary",
                provenance,
                scope: p.scope,
                tags: [EPISODE_TAG],
                links,
                sourceRefs,
                ...privacyParam,
              },
              rememberKey,
              nowValid,
              {
                owner: execOwner,
                now: renewNow(),
                afterInsert: (txDb, recordId) => writeLedger(txDb, recordId),
              },
            );
            if (rr.ok) {
              newRecordId =
                ((rr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
                null;
              if (newRecordId !== null && rr.deduplicated) {
                if (
                  !fencedEpisodeWrite(
                    db,
                    { owner: execOwner, now: renewNow() },
                    (txDb) => writeLedger(txDb, newRecordId as string),
                  )
                ) {
                  aborted = true;
                  newRecordId = null;
                }
              }
            } else if (!isCultivationLeaseHeldBy(db, execOwner, renewNow())) {
              aborted = true;
            }
          }

          if (newRecordId !== null && !aborted) {
            episodeRecordId = newRecordId;
            applied++;
          }
        }
      }

      const finalCovered = (() => {
        try {
          return maxDoneObservedAt(db, p.scope, p.kind, ep.episodeKey);
        } catch {
          return existingCovered;
        }
      })();

      results.push({
        kind: p.kind,
        episodeKey: ep.episodeKey,
        windowsWritten,
        windowsVerbatim,
        windowsRejected,
        episodeRecordId,
        coveredThrough: finalCovered,
        sentencesKept,
        sentencesDropped,
        extractive,
        reduceDeferred,
      });

      if (aborted) {
        // Deadline or lost lease: no envelope is stored, so a retry with the
        // same key replays completed actions idempotently.
        return budgeted(overDeadline() ? fail("TIMEOUT") : conflict(), config);
      }
    }

    const stored = budgeted(
      ok({ episodes: results, applied, degraded: false }),
      config,
    );
    try {
      storeEpisodesResult(db, config, idempotencyKey, reqHash, stored, p.scope, nowValid, p.limit);
    } catch (e) {
      return handleStoreRace(db, config, idempotencyKey, reqHash, e);
    }
    return stored;
  } finally {
    try {
      releaseCultivationLease(db, execOwner);
    } catch {
      /* best-effort */
    }
  }
}

/* ------------------------------------------------------------------ */
/* episode.windows read op                                             */
/* ------------------------------------------------------------------ */

interface WindowsCursor {
  observedAt: string;
  spanStart: number;
  recordId: string;
}

function encodeWindowsCursor(c: WindowsCursor): string {
  return Buffer.from(
    JSON.stringify({ o: c.observedAt, s: c.spanStart, r: c.recordId }),
    "utf8",
  ).toString("base64url");
}

function decodeWindowsCursor(v: unknown): WindowsCursor | null {
  if (typeof v !== "string" || v.length === 0 || !/^[A-Za-z0-9_-]+$/.test(v)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(v, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  if (Object.keys(obj).length !== 3) return null;
  const observedAt = canonicalTime(obj["o"]);
  const spanStart = obj["s"];
  const recordId = obj["r"];
  if (observedAt === null) return null;
  if (typeof spanStart !== "number" || !Number.isSafeInteger(spanStart) || spanStart < 0) return null;
  if (
    typeof recordId !== "string" ||
    countCp(recordId) < 1 ||
    countCp(recordId) > 256 ||
    hasControl(recordId)
  ) {
    return null;
  }
  return { observedAt, spanStart, recordId };
}

function snippetFor(body: string, maxCp: number): { snippet: string; truncated: boolean } {
  const cps = [...body];
  if (cps.length <= maxCp) return { snippet: body, truncated: false };
  return { snippet: cps.slice(0, maxCp).join(""), truncated: true };
}

/** Read window ledger rows joined to their active canonical records. */
export function episodeWindows(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
): ResponseEnvelope {
  const allowed = new Set(["scope", "kind", "episodeKey", "cursor", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return budgeted(bad(), config);
  const kind = params["kind"];
  if (typeof kind !== "string" || !EPISODE_KINDS.has(kind)) return budgeted(bad(), config);
  const nKind = kind as EpisodeKind;
  const episodeKey = parseEpisodeKey(params["episodeKey"]);
  if (episodeKey === "invalid" || episodeKey === null) return budgeted(bad(), config);
  let cursor: WindowsCursor | null = null;
  if (params["cursor"] !== undefined && params["cursor"] !== null) {
    cursor = decodeWindowsCursor(params["cursor"]);
    if (cursor === null) return budgeted(bad(), config);
  }
  const maxLimit = config.limits.rangeLimitMax ?? 50;
  let limit = config.limits.limitDefault;
  if (params["limit"] !== undefined) {
    const v = params["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) return budgeted(bad(), config);
    if (v > maxLimit) return budgeted(fail("LIMIT_EXCEEDED"), config);
    limit = v;
  }
  const denied = scopeGate(db, config, scope);
  if (denied) return denied;

  try {
    const args: Array<string | number> = [scope, nKind, episodeKey];
    let sql = `SELECT s.recordId AS recordId, s.eventId AS eventId,
                      s.spanStart AS spanStart, s.spanEnd AS spanEnd,
                      r.body AS body, e.observedAt AS observedAt
               FROM episode_summaries s
               JOIN records r ON r.id = s.recordId AND r.status = 'active' AND r.scope = s.scope
               JOIN raw_events e ON e.eventId = s.eventId AND e.scope = s.scope
               WHERE s.scope = ? AND s.kind = ? AND s.episodeKey = ? AND s.level = 'window'`;
    if (cursor !== null) {
      sql += ` AND (e.observedAt > ? OR (e.observedAt = ? AND (s.spanStart > ? OR (s.spanStart = ? AND s.recordId > ?))))`;
      args.push(
        cursor.observedAt,
        cursor.observedAt,
        cursor.spanStart,
        cursor.spanStart,
        cursor.recordId,
      );
    }
    sql += ` ORDER BY e.observedAt ASC, s.spanStart ASC, s.recordId ASC LIMIT ?`;
    args.push(limit + 1);
    const rows = db.prepare(sql).all(...args) as Array<{
      recordId: string;
      eventId: string;
      spanStart: number;
      spanEnd: number;
      body: string;
      observedAt: string;
    }>;
    const shown = rows.slice(0, limit);
    const items = shown.map((r) => {
      const { snippet, truncated } = snippetFor(r.body, config.limits.snippetMaxCp);
      return {
        recordId: r.recordId,
        eventId: r.eventId,
        span: { start: r.spanStart, end: r.spanEnd },
        snippet,
        truncated,
      };
    });
    const last = shown.length > 0 ? shown[shown.length - 1] : null;
    const nextCursor =
      rows.length > limit && last
        ? encodeWindowsCursor({
            observedAt: last.observedAt,
            spanStart: last.spanStart,
            recordId: last.recordId,
          })
        : null;
    return budgeted(ok({ items, nextCursor }), config);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
}
