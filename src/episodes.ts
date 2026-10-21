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
 * - coveredThrough only advances over events whose windows all succeeded;
 *   window ledger rows make a partial-event retry idempotent.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { episodesBounds, maintenanceTimeoutMs } from "./config.js";
import { acquireCultivationLease, releaseCultivationLease } from "./cultivation.js";
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
import { splitTextRanges } from "./split.js";
import type { SourceRef } from "./sourceref.js";
import {
  archiveRecord,
  correctRecord,
  insertEpisodeSummary,
  isScopeAuthorized,
  listEpisodeSummaries,
  rememberRecord,
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

/** Strict verification prompt: YES only when the summary is fully supported. */
export function buildEpisodeVerifyPrompt(
  text: string,
  summary: string,
  maxPromptChars: number,
): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const lang = promptLanguageFor(text);
  const head =
    lang === "cjk"
      ? "<|im_start|>system\nあなたは要約を検証します。YES または NO だけを出力し、それ以外は何も書かないでください。<|im_end|>\n" +
        "<|im_start|>user\n本文：\n\"\"\""
      : "<|im_start|>system\nYou verify a summary. Reply with only YES or NO and nothing else.<|im_end|>\n" +
        "<|im_start|>user\nTEXT:\n\"\"\"";
  const mid = lang === "cjk" ? "\"\"\"\n要約：\n\"\"\"" : "\"\"\"\nSUMMARY:\n\"\"\"";
  const tail =
    lang === "cjk"
      ? "\"\"\"\n" +
        namesInstruction(lang) +
        "要約のすべての文が本文に支持されている場合は YES、そうでなければ NO と答えてください。<|im_end|>\n<|im_start|>assistant\n"
      : "\"\"\"\n" +
        namesInstruction(lang) +
        "Reply YES if every statement in SUMMARY is supported by TEXT. " +
        "Otherwise reply NO.<|im_end|>\n<|im_start|>assistant\n";
  const budget = Math.max(0, max - cpLen(head) - cpLen(mid) - cpLen(tail));
  const summaryBudget = Math.min(cpLen(summary), Math.floor(budget / 3));
  const textBudget = Math.max(0, budget - summaryBudget);
  const c = clipCp(summary, summaryBudget);
  const t = clipCp(text, textBudget);
  return tailClip(head + t + mid + c + tail, max);
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

/**
 * Strict per-sentence claim verification against the cited RAW text (not a
 * summary). The instruction tail is preserved when the raw text is clipped.
 */
export function buildEpisodeClaimPrompt(
  text: string,
  claim: string,
  maxPromptChars: number,
): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const lang = promptLanguageFor(text);
  const head =
    lang === "cjk"
      ? "<|im_start|>system\nあなたは主張を検証します。YES または NO だけを出力し、それ以外は何も書かないでください。<|im_end|>\n" +
        "<|im_start|>user\n本文：\n\"\"\""
      : "<|im_start|>system\nYou verify a claim. Reply with only YES or NO and nothing else.<|im_end|>\n" +
        "<|im_start|>user\nTEXT:\n\"\"\"";
  const mid = lang === "cjk" ? "\"\"\"\n主張：\n\"\"\"" : "\"\"\"\nCLAIM:\n\"\"\"";
  const tail =
    lang === "cjk"
      ? "\"\"\"\n" +
        namesInstruction(lang) +
        "主張のすべての文が本文に支持されている場合は YES、そうでなければ NO と答えてください。<|im_end|>\n<|im_start|>assistant\n"
      : "\"\"\"\n" +
        namesInstruction(lang) +
        "Reply YES if every statement in CLAIM is supported by TEXT. " +
        "Otherwise reply NO.<|im_end|>\n<|im_start|>assistant\n";
  const budget = Math.max(0, max - cpLen(head) - cpLen(mid) - cpLen(tail));
  const claimBudget = Math.min(cpLen(claim), Math.floor(budget / 3));
  const textBudget = Math.max(0, budget - claimBudget);
  return tailClip(head + clipCp(text, textBudget) + mid + clipCp(claim, claimBudget) + tail, max);
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
 * Stale episodes of one kind (per episode.list semantics): no episode-level
 * ledger row, no coveredThrough, or a raw event newer than coveredThrough.
 * Ordered by startAt ASC (then episodeKey) and bounded by `limit`.
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
  args.push(scope, kind);
  let sql = `SELECT g.episodeKey AS episodeKey,
                    MIN(g.observedAt) AS startAt,
                    MAX(g.createdAt) AS maxCreatedAt
             FROM (SELECT ${keyExpr} AS episodeKey, observedAt, createdAt
                   FROM raw_events
                   WHERE scope = ?${kind === "doc" ? " AND docId IS NOT NULL" : ""}) g
             LEFT JOIN (SELECT episodeKey AS sk, MAX(coveredThrough) AS covered
                        FROM episode_summaries
                        WHERE scope = ? AND kind = ? AND level = 'episode'
                        GROUP BY episodeKey) s ON s.sk = g.episodeKey`;
  if (episodeKey !== null) {
    sql += ` WHERE g.episodeKey = ?`;
    args.push(episodeKey);
  }
  sql += ` GROUP BY g.episodeKey
           HAVING s.covered IS NULL OR MAX(g.createdAt) > s.covered
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
}

function eventsForEpisode(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
  coveredThrough: string | null,
): RawEventRow[] {
  const offset = episodesBounds(config).utcOffsetMinutes;
  const offsetModifier = `${offset >= 0 ? "+" : ""}${offset} minutes`;
  const predicate =
    kind === "session" ? "sessionId = ?" : kind === "doc" ? "docId = ?" : "date(observedAt, ?) = ?";
  const args: Array<string | number> = [scope];
  if (kind === "day") args.push(offsetModifier);
  args.push(episodeKey);
  let sql = `SELECT eventId, body, observedAt, createdAt FROM raw_events
             WHERE scope = ? AND ${predicate}`;
  if (coveredThrough !== null) {
    sql += ` AND createdAt > ?`;
    args.push(coveredThrough);
  }
  sql += ` ORDER BY observedAt ASC, eventId ASC`;
  return db.prepare(sql).all(...args) as unknown as RawEventRow[];
}

function maxEpisodeCovered(
  db: DatabaseSync,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
): string | null {
  const rows = listEpisodeSummaries(db, scope, kind, episodeKey, "episode");
  let covered: string | null = null;
  for (const r of rows) {
    if (r.coveredThrough !== null && (covered === null || r.coveredThrough > covered)) {
      covered = r.coveredThrough;
    }
  }
  return covered;
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
  observedAt: string;
  createdAt: string;
}

interface WindowInputSet {
  windows: EpisodeWindow[];
  lastEventCreatedAt: string | null;
  lastEventObservedAt: string | null;
}

/**
 * ALL active window-ledger summaries of the episode, in event/span order.
 * The reduce step rebuilds the episode from these every time (no
 * summary-of-summary folding), so a rejected reduce remains retryable with
 * zero new windows. `lastEventCreatedAt` only advances across a contiguous
 * prefix of fully-windowed events, preserving coveredThrough safety when a
 * later event's window was rejected.
 */
function windowInputsForEpisode(
  db: DatabaseSync,
  config: AppConfig,
  scope: string,
  kind: EpisodeKind,
  episodeKey: string,
): WindowInputSet {
  const empty: WindowInputSet = {
    windows: [],
    lastEventCreatedAt: null,
    lastEventObservedAt: null,
  };
  let rows: Array<{
    recordId: string;
    eventId: string;
    spanStart: number;
    spanEnd: number;
    body: string;
    eventBody: string;
    createdAt: string;
    observedAt: string;
  }>;
  try {
    rows = db
      .prepare(
        `SELECT s.recordId AS recordId, s.eventId AS eventId,
                s.spanStart AS spanStart, s.spanEnd AS spanEnd,
                r.body AS body, e.body AS eventBody,
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
    observedAt: row.observedAt,
    createdAt: row.createdAt,
  }));

  const windowMaxCp = episodesBounds(config).windowMaxCp;
  const out: WindowInputSet = { windows, lastEventCreatedAt: null, lastEventObservedAt: null };
  let i = 0;
  while (i < deduped.length) {
    const eventId = deduped[i]!.eventId;
    const group: typeof rows = [];
    while (i < deduped.length && deduped[i]!.eventId === eventId) {
      group.push(deduped[i]!);
      i++;
    }
    const first = group[0]!;
    const expected = splitTextRanges(first.eventBody, windowMaxCp).filter((r) =>
      /\S/u.test(Array.from(first.eventBody).slice(r.start, r.end).join("")),
    );
    const bySpan = new Map<string, (typeof rows)[number]>();
    for (const row of group) {
      const spanKey = `${row.spanStart}:${row.spanEnd}`;
      if (!bySpan.has(spanKey)) bySpan.set(spanKey, row);
    }
    let complete = true;
    for (const range of expected) {
      if (!bySpan.has(`${range.start}:${range.end}`)) {
        complete = false;
        break;
      }
    }
    if (!complete) break;
    out.lastEventCreatedAt = first.createdAt;
    out.lastEventObservedAt = first.observedAt;
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

/** Normalized whitespace + bodyMaxCp clip for a verbatim window fallback. */
function verbatimWindowBody(text: string, bodyMaxCp: number): string {
  return clipCp(text.replace(/\s+/g, " ").trim(), bodyMaxCp);
}

/**
 * Write one window canonical record plus its level='window' ledger row.
 * Returns the record id, or null when either write fails. Shared by model
 * summaries and verbatim fallbacks so both have identical span provenance.
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
  now: string,
): string | null {
  const windowKey = `epw-${shaHex(
    [scope, kind, episodeKey, event.eventId, spanStart, spanEnd, body].join("\u0000"),
  ).slice(0, 48)}`;
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
    },
    windowKey,
    now,
  );
  const recordId = wr.ok
    ? ((wr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined)
    : undefined;
  if (!wr.ok || typeof recordId !== "string") return null;
  try {
    db.exec("BEGIN IMMEDIATE");
    insertEpisodeSummary(db, {
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
    db.exec("COMMIT");
  } catch {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    return null;
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
          return maxEpisodeCovered(db, p.scope, p.kind, ep.episodeKey);
        } catch {
          return null;
        }
      })();

      let events: RawEventRow[];
      try {
        events = eventsForEpisode(db, config, p.scope, p.kind, ep.episodeKey, existingCovered);
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
        });
        continue;
      }

      for (const ev of events) {
        const ranges = splitTextRanges(ev.body, bounds.windowMaxCp).filter(
          (r) => /\S/u.test(Array.from(ev.body).slice(r.start, r.end).join("")),
        );
        let eventOk = true;

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
            let rawVerify: string | null = null;
            try {
              rawVerify = await generate(
                buildEpisodeVerifyPrompt(windowText, summaryBody as string, maxPromptChars),
                Math.min(maxNewTokens, 16),
              );
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
            nowValid,
          );
          if (recordId === null) {
            eventOk = false;
            aborted = true;
            break;
          }
          if (contentRejected) windowsVerbatim++;
          else windowsWritten++;
          applied++;
        }

        if (aborted) break;
        if (!eventOk) break;
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
      const windowInputs = windowInputsForEpisode(db, config, p.scope, p.kind, ep.episodeKey);
      const allWindows = windowInputs.windows;
      let episodeRecordId: string | null = null;
      let resultCovered = existingCovered;
      let sentencesKept = 0;
      let sentencesDropped = 0;
      let extractive = false;

      if (allWindows.length > 0) {
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
          if (rawMerge !== null && promptLanguageFor(group.map((w) => w.rawText).join("\n")) === "cjk") {
            rawMerge = stripSummaryCue(rawMerge);
          }
          const mergeBody = parseSummaryBody(rawMerge, bodyMaxCp);
          if (mergeBody === null) {
            // Model/parse failure: write nothing for this episode (retry later).
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
            let rawVerify: string | null = null;
            try {
              rawVerify = await generate(
                buildEpisodeClaimPrompt(citedRaw, sentence.text, maxPromptChars),
                Math.min(maxNewTokens, 16),
              );
            } catch {
              rawVerify = null;
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

        if (reduceOk && !aborted && finalSummary !== null && cpLen(finalSummary) > 0) {
          const effectiveCovered = windowInputs.lastEventCreatedAt ?? existingCovered;
          const links = episodeLinks(citedWindows, config.limits.linksMax);
          const sourceRefs = episodeSourceRefs(citedWindows, config.limits.sourceRefsMax);
          const provenance = {
            source: EPISODE_SUMMARY_SOURCE,
            observedAt: windowInputs.lastEventObservedAt ?? nowValid,
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
              },
              correctKey,
              nowValid,
            );
            if (cr.ok) {
              newRecordId =
                ((cr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
                null;
            } else if (cr.code === "CONFLICT") {
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
                },
                rememberKey,
                nowValid,
              );
              if (rr.ok) {
                newRecordId =
                  ((rr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
                  null;
                archiveRecord(
                  db,
                  config,
                  { id: priorActive.recordId, scope: p.scope, reasonCode: "OBSOLETE" },
                  `epa-${shaHex([p.scope, ep.episodeKey, priorActive.recordId].join("\u0000")).slice(0, 48)}`,
                  nowValid,
                );
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
              },
              rememberKey,
              nowValid,
            );
            if (rr.ok) {
              newRecordId =
                ((rr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
                null;
            }
          }

          if (newRecordId !== null) {
            try {
              db.exec("BEGIN IMMEDIATE");
              insertEpisodeSummary(db, {
                scope: p.scope,
                kind: p.kind,
                episodeKey: ep.episodeKey,
                level: "episode",
                recordId: newRecordId,
                eventId: null,
                spanStart: null,
                spanEnd: null,
                coveredThrough: effectiveCovered,
                createdAt: nowValid,
              });
              db.exec("COMMIT");
              episodeRecordId = newRecordId;
              resultCovered = effectiveCovered;
              applied++;
            } catch {
              try {
                db.exec("ROLLBACK");
              } catch {
                /* ignore */
              }
            }
          }
        }
      }

      results.push({
        kind: p.kind,
        episodeKey: ep.episodeKey,
        windowsWritten,
        windowsVerbatim,
        windowsRejected,
        episodeRecordId,
        coveredThrough: resultCovered,
        sentencesKept,
        sentencesDropped,
        extractive,
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
