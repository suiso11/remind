/**
 * M3 local small multilingual instruction LLM (real offline generation, no heuristics).
 *
 * Model (pinned, public, local-only at runtime):
 * - repo: onnx-community/Qwen2.5-1.5B-Instruct (ONNX, transformers.js text-generation)
 * - revision: d54957e3af1be04546436e874a60fe386041b244
 * - base: Qwen/Qwen2.5-1.5B-Instruct (multilingual instruction-tuned, 1.5B params)
 * - license: apache-2.0 (base model card)
 * - runtime: @huggingface/transformers 4.3.1 + onnxruntime-node 1.30.0 (pinned)
 * - file: onnx/model_q4.onnx (dtype "q4" selection; onnx-community layout
 *   resolves decoder sessions as onnx/model_<quant>.onnx)
 * - decoding: greedy (do_sample:false) => deterministic for fixed input
 * - prompts: ChatML (<|im_start|> roles) matching the model's instruction
 *   template; the model answers with one verdict line or one merged sentence
 *
 * Why not bloomz-560m: the previously pinned Xenova/bloomz-560m @ e760ef38
 * was probed on the real distill prompts and proved unsuitable — the review
 * prompt completed to " NA" (uncertain => keep) and the summary prompt to
 * hallucinated repetitive filler ("this picture was taken after having fun,
 * fun, fun, ..."). A Qwen2.5-0.5B-Instruct candidate was also probed: its
 * summaries were good, but its verdicts never emitted RETIRE under any
 * framing (binary/ternary, both option orders, discard wording — always
 * "keep"), so no model-driven retirement was possible. The 1.5B sibling
 * follows the three-way verdict format reliably and is still small enough
 * for bounded local CPU inference.
 *
 * Network rule: ONLY scripts/provision-llm.ts downloads the public files.
 * Everything here runs offline (env.allowRemoteModels=false). Missing,
 * disabled, invalid, timed-out, or uncertain model output NEVER changes
 * record state: callers treat it as "keep / retry" (see src/distill.ts).
 * There is no keyword/heuristic fallback: without the real model there are
 * no model decisions at all.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AppConfig } from "./config.js";
import {
  LLM_DEFAULT_MAX_NEW_TOKENS,
  LLM_DEFAULT_MAX_PROMPT_CHARS,
  LLM_DEFAULT_MODEL_DIR,
  LLM_DEFAULT_TIMEOUT_MS,
  resolveConfigDirPath,
} from "./config.js";
import { containsLoneSurrogateDeep, countCp, hasControl } from "./normalize.js";

export const LLM_MODEL_ID = "onnx-community/Qwen2.5-1.5B-Instruct";
export const LLM_MODEL_REVISION = "d54957e3af1be04546436e874a60fe386041b244";
export const LLM_MODEL_BASE = "Qwen/Qwen2.5-1.5B-Instruct";
export const LLM_MODEL_LICENSE = "apache-2.0";
export const LLM_RUNTIME = "@huggingface/transformers@4.3.1 + onnxruntime-node@1.30.0";
export const LLM_TASK = "text-generation";
/** Quantization variant selected at load (onnx-community layout: onnx/model_q4.onnx). */
export const LLM_DTYPE = "q4";
/** Files the provisioner fetches at the pinned revision (manifest records sha256). */
export const LLM_MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  "onnx/model_q4.onnx",
] as const;

export function resolveLlmDir(config: AppConfig, configPath: string): string {
  const rel = config.llm?.modelDir ?? LLM_DEFAULT_MODEL_DIR;
  return resolveConfigDirPath(configPath, rel);
}

export function llmTimeoutMs(config: AppConfig): number {
  const t = config.llm?.timeoutMs ?? LLM_DEFAULT_TIMEOUT_MS;
  return Number.isInteger(t) && t >= 500 && t <= 300000 ? t : LLM_DEFAULT_TIMEOUT_MS;
}

export function llmMaxNewTokens(config: AppConfig): number {
  const n = config.llm?.maxNewTokens ?? LLM_DEFAULT_MAX_NEW_TOKENS;
  return Number.isInteger(n) && n >= 1 && n <= 256 ? n : LLM_DEFAULT_MAX_NEW_TOKENS;
}

export function llmMaxPromptChars(config: AppConfig): number {
  const n = config.llm?.maxPromptChars ?? LLM_DEFAULT_MAX_PROMPT_CHARS;
  return Number.isInteger(n) && n >= 500 && n <= 8000 ? n : LLM_DEFAULT_MAX_PROMPT_CHARS;
}

/** True only when the operator explicitly enabled the llm section. Absent => false (fast, no model). */
export function llmEnabled(config: AppConfig): boolean {
  return config.llm?.enabled === true;
}

interface LlmManifestFile {
  sha256: string;
  bytes: number;
}
interface LlmManifest {
  model: string;
  revision: string;
  files: Record<string, LlmManifestFile>;
}

export function readLlmManifest(modelDir: string): LlmManifest | null {
  try {
    const raw = fs.readFileSync(path.join(modelDir, "manifest.json"), "utf8");
    const m = JSON.parse(raw) as Partial<LlmManifest>;
    if (m.model !== LLM_MODEL_ID || m.revision !== LLM_MODEL_REVISION) return null;
    if (typeof m.files !== "object" || m.files === null) return null;
    return m as LlmManifest;
  } catch {
    return null;
  }
}

/** True when every pinned file exists on disk (hash-checked by the provisioner). */
export function modelFilesPresent(modelDir: string): boolean {
  try {
    for (const f of LLM_MODEL_FILES) {
      const st = fs.statSync(path.join(modelDir, f));
      if (!st.isFile() || st.size === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------------- offline generative runtime (lazy, bounded) ---------------- */

type Generator = (prompt: string, opts?: Record<string, unknown>) => Promise<unknown>;

let cachedGenerator: Generator | null = null;
let cachedDir: string | null = null;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const gate = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(label)), Math.max(0, ms));
    (timer as unknown as { unref?: () => void }).unref?.();
  });
  return Promise.race([p, gate]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

async function loadGenerator(modelDir: string, timeoutMs: number): Promise<Generator> {
  if (cachedGenerator && cachedDir === modelDir) return cachedGenerator;
  const mod = await import("@huggingface/transformers");
  const env = (mod as unknown as { env: Record<string, unknown> }).env;
  // Offline-only: local files, never remote, never telemetry.
  env["allowRemoteModels"] = false;
  env["allowLocalModels"] = true;
  const pipeline = (mod as unknown as { pipeline: (...a: unknown[]) => Promise<Generator> }).pipeline;
  // dtype "q4" selects the quantized variant; onnx-community ports resolve
  // decoder sessions as onnx/model_<quant>.onnx (here onnx/model_q4.onnx).
  const generator = await withTimeout(
    pipeline(LLM_TASK, modelDir, { dtype: LLM_DTYPE, local_files_only: true } as unknown as undefined),
    timeoutMs,
    "llm load timeout",
  );
  cachedGenerator = generator;
  cachedDir = modelDir;
  return generator;
}

function generatedTextOf(out: unknown): string | null {
  try {
    const arr = Array.isArray(out) ? out : null;
    if (!arr || arr.length === 0) return null;
    const first = arr[0] as { generated_text?: unknown };
    return typeof first?.generated_text === "string" ? first.generated_text : null;
  } catch {
    return null;
  }
}

/**
 * Generate a greedy (deterministic) completion with the pinned local model.
 * Offline only. Resolves null on ANY failure (disabled/missing model,
 * timeout, bad output): callers degrade to keep/retry without state change.
 * Never throws for model reasons.
 */
export async function generateCompletion(
  prompt: string,
  modelDir: string,
  opts: { timeoutMs: number; maxNewTokens: number },
): Promise<string | null> {
  try {
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 8000) return null;
    if (!modelFilesPresent(modelDir)) return null;
    const generator = await loadGenerator(modelDir, opts.timeoutMs);
    const out = await withTimeout(
      generator(prompt, {
        max_new_tokens: opts.maxNewTokens,
        do_sample: false,
        return_full_text: false,
      } as unknown as Record<string, unknown>),
      opts.timeoutMs,
      "llm generate timeout",
    );
    const text = generatedTextOf(out);
    if (typeof text !== "string" || text.length === 0) return null;
    if (containsLoneSurrogateDeep(text) || hasControl(text.replace(/\n/g, ""))) return null;
    return text;
  } catch {
    return null;
  }
}

/** Forget the cached pipeline (tests/provisioning hygiene). Never throws. */
export function resetLlmRuntime(): void {
  cachedGenerator = null;
  cachedDir = null;
}

/* ---------------- strict validation of untrusted model text ---------------- */

export type LlmReviewVerdict =
  | { kind: "retire" }
  | { kind: "merge"; targetId: string }
  | { kind: "keep" }
  | { kind: "uncertain" };

const ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

/**
 * Parse a single-word review verdict out of raw model text. Strict:
 * exactly one of RETIRE / MERGE <id> / KEEP (case-insensitive) may appear;
 * zero or conflicting signals => uncertain (caller keeps state unchanged).
 * This parses MODEL output only; memory bodies are never keyword-scanned.
 */
export function parseReviewVerdict(raw: unknown): LlmReviewVerdict {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > 4000) return { kind: "uncertain" };
  const hits: Array<{ kind: "retire" | "merge" | "keep"; targetId?: string; at: number }> = [];
  const re = /\b(RETIRE|MERGE|KEEP)\b/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const word = (m[1] as string).toUpperCase();
    if (word === "RETIRE") hits.push({ kind: "retire", at: m.index });
    else if (word === "KEEP") hits.push({ kind: "keep", at: m.index });
    else {
      const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 160);
      const idm = /^\s+([A-Za-z0-9_-]{1,128})\b/.exec(after);
      if (idm && ID_RE.test(idm[1] as string)) {
        hits.push({ kind: "merge", targetId: idm[1] as string, at: m.index });
      } else {
        return { kind: "uncertain" };
      }
    }
  }
  if (hits.length !== 1) return { kind: "uncertain" };
  const h = hits[0] as { kind: "retire" | "merge" | "keep"; targetId?: string };
  if (h.kind === "retire") return { kind: "retire" };
  if (h.kind === "keep") return { kind: "keep" };
  return { kind: "merge", targetId: h.targetId as string };
}

/**
 * Validate a model-drafted summary body. Returns the trimmed body when it is
 * a bounded non-empty single text without control characters, else null
 * (caller keeps state unchanged). Never throws.
 */
export function parseSummaryBody(raw: unknown, bodyMaxCp: number): string | null {
  try {
    if (typeof raw !== "string") return null;
    const body = raw.replace(/\s+/g, " ").trim();
    if (body.length === 0) return null;
    if (countCp(body) < 1 || countCp(body) > bodyMaxCp) return null;
    if (hasControl(body) || containsLoneSurrogateDeep(body)) return null;
    return body;
  } catch {
    return null;
  }
}

function clip(s: string, maxCp: number): string {
  const cps = [...s];
  return cps.length <= maxCp ? s : cps.slice(0, maxCp).join("");
}

/** Code-point length. */
function cpLen(s: string): number {
  return [...s].length;
}

/** Preserve the structural tail (instructions + assistant cue): never slice the
 *  template from the front. Bodies are pre-clipped to fit; if maxCp is below
 *  the empty-template overhead (misconfiguration), keep the tail so the model
 *  still sees a valid assistant cue rather than a severed mid-sentence head. */
function tailClip(s: string, maxCp: number): string {
  const cps = [...s];
  return cps.length <= maxCp ? s : cps.slice(cps.length - maxCp).join("");
}

/** Clamp a caller-supplied maxPromptChars to the documented valid range. The
 *  true minimum is 500: the largest empty template (merge prompt) is 441
 *  code points, so below 500 no body budget remains. Startup config rejects
 *  smaller values; direct callers are clamped here. */
function clampMaxPromptChars(n: unknown): number {
  if (typeof n !== "number" || !Number.isFinite(n)) return 2000;
  const m = Math.floor(n);
  if (m < 500) return 500;
  if (m > 8000) return 8000;
  return m;
}

/**
 * Retire-gate prompt (stage 1 of a distill review). Generation-style on
 * purpose: single-token verdicts proved unusable on the pinned q4 model
 * (probes: bare RETIRE/KEEP/FEELING/1-way questions always echoed one biased
 * token regardless of content, 4-6/10 at best), while this extraction form
 * scored 10/10 across transient feelings, facts, preferences, uncertainty,
 * plans, and events. The model either states the lasting content it sees or
 * replies NONE; code maps strict-NONE to a retire candidate and any other
 * text to the merge/keep stage. The extracted sentence itself is NEVER
 * stored, audited, or reused — only the NONE-vs-content distinction drives
 * the decision, so no memory text is keyword-scanned and no template text is
 * substituted. General instruction only; no fixture answers.
 */
export function buildRetireGatePrompt(body: string, maxPromptChars: number): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const head =
    "<|im_start|>system\nYou judge one memory. Reply with only what is asked and nothing else.<|im_end|>\n" +
    "<|im_start|>user\nMemory: \"\"\"";
  const tail =
    "\"\"\"\n" +
    "What lasting fact, event, observation, preference, or plan does this memory record? " +
    "Reply with only that fact in one short sentence, or reply NONE if the memory is only a passing mood or feeling with no lasting content.<|im_end|>\n<|im_start|>assistant\n";
  const budget = Math.max(0, max - cpLen(head) - cpLen(tail));
  const clipped = clip(body, Math.min(600, budget));
  const full = head + clipped + tail;
  // Bodies are the only variable part, so this fits; tailClip is a guard that
  // preserves the assistant cue on any miscount.
  return tailClip(full, max);
}

export type RetireGateResult = { kind: "retire" } | { kind: "continue" } | { kind: "uncertain" };

/**
 * Parse retire-gate output. Strict: exactly NONE (case-insensitive,
 * surrounding whitespace allowed) means the model found no lasting content
 * (retire candidate). Any other non-empty text means it saw lasting content
 * (continue to merge/keep). Non-strings and empties are uncertain (caller
 * keeps state unchanged). Never throws. Parses MODEL output only.
 */
export function parseRetireGate(raw: unknown): RetireGateResult {
  if (typeof raw !== "string") return { kind: "uncertain" };
  if (/^\s*NONE\s*$/i.test(raw)) return { kind: "retire" };
  if (raw.length === 0 || raw.length > 4000) return { kind: "uncertain" };
  if (hasControl(raw.replace(/\n/g, "")) || containsLoneSurrogateDeep(raw)) return { kind: "uncertain" };
  return { kind: "continue" };
}

export type MergeChoice = { kind: "merge"; index: number } | { kind: "keep" } | { kind: "uncertain" };

/**
 * Positional merge prompt (stage 2 of a distill review). Peers are shown as
 * numbered options (1..N); the model replies MERGE <n> or KEEP. Code maps the
 * position to the actual same-scope peer id shown at that position, so the
 * small model never copies random record ids (prior probes: copied ids were
 * routinely mangled/hallucinated). Bounds: at most 6 peers, each clipped.
 */
export function buildMergePrompt(
  body: string,
  peers: Array<{ id: string; body: string }>,
  maxPromptChars: number,
): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const shown = peers.slice(0, 6);
  const sysHead = "<|im_start|>system\nYou are a memory curator. Reply with exactly one line and nothing else.<|im_end|>\n<|im_start|>user\n";
  const sysTail = "<|im_end|>\n<|im_start|>assistant\n";
  const fixedUserHead = "Memory under review:\n\"\"\"";
  const fixedUserMid1 = "\"\"\"\nOther memories in the same scope:\n";
  const fixedUserMid0 = "\"\"\"\nThere are no other memories in scope.\n";
  const fixedUserTail =
    "Valid answers (reply with exactly one of these lines):\n" +
    "- MERGE <n> (the memory under review says nearly the same thing as memory number n above; use its number, not its text)\n" +
    "- KEEP (anything else; when unsure, KEEP)\nAnswer:";
  // Fixed overhead with empty bodies; bodies share whatever remains.
  const overhead =
    cpLen(sysHead) + cpLen(sysTail) + cpLen(fixedUserHead) +
    (shown.length > 0 ? cpLen(fixedUserMid1) : cpLen(fixedUserMid0)) +
    cpLen(fixedUserTail) +
    shown.reduce((n, _, i) => n + cpLen(`${i + 1}. \"\"\"\"\"\"\n`), 0);
  let budget = Math.max(0, max - overhead);
  // Main body keeps up to 600, peers split the rest (up to 220 each).
  let mainBudget = Math.min(600, budget);
  budget = Math.max(0, budget - mainBudget);
  const perPeer = shown.length > 0 ? Math.floor(budget / shown.length) : 0;
  const peerBudgets = shown.map(() => Math.min(220, perPeer));
  // Hand any rounding remainder to the first peers.
  let used = mainBudget + peerBudgets.reduce((a, b) => a + b, 0);
  for (let i = 0; used < budget && i < peerBudgets.length; i++) {
    if (peerBudgets[i]! < 220) {
      peerBudgets[i]!++;
      used++;
    }
  }
  const main = clip(body, mainBudget);
  let user = `Memory under review:\n\"\"\"${main}\"\"\"\n`;
  if (shown.length > 0) {
    user += "Other memories in the same scope:\n";
    for (let i = 0; i < shown.length; i++) {
      user += `${i + 1}. \"\"\"${clip(shown[i]!.body, peerBudgets[i]! as number)}\"\"\"\n`;
    }
  } else {
    user += "There are no other memories in scope.\n";
  }
  user += fixedUserTail;
  return tailClip(`${sysHead}${user}${sysTail}`, max);
}

/**
 * Parse positional merge output. Strict: exactly one of KEEP / MERGE <n>
 * (case-insensitive, n an integer in 1..peerCount); zero or conflicting or
 * out-of-range signals => uncertain (caller keeps state unchanged). Parses
 * MODEL output only; memory bodies are never keyword-scanned.
 */
export function parseMergeChoice(raw: unknown, peerCount: number): MergeChoice {
  try {
    if (typeof raw !== "string" || raw.length === 0 || raw.length > 4000) return { kind: "uncertain" };
    if (!Number.isInteger(peerCount) || peerCount < 1 || peerCount > 6) return { kind: "uncertain" };
    const hits: Array<{ kind: "merge" | "keep"; index?: number; at: number }> = [];
    const re = /\b(MERGE|KEEP)\b/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(raw)) !== null) {
      const word = (m[1] as string).toUpperCase();
      if (word === "KEEP") {
        hits.push({ kind: "keep", at: m.index });
      } else {
        const after = raw.slice(m.index + m[0].length, m.index + m[0].length + 32);
        const nm = /^\s*(\d{1,3})\b/.exec(after);
        if (!nm) return { kind: "uncertain" };
        const n = Number.parseInt(nm[1] as string, 10);
        if (!Number.isInteger(n) || n < 1 || n > peerCount) return { kind: "uncertain" };
        hits.push({ kind: "merge", index: n - 1, at: m.index });
      }
    }
    if (hits.length !== 1) return { kind: "uncertain" };
    const h = hits[0]!;
    if (h.kind === "keep") return { kind: "keep" };
    return { kind: "merge", index: h.index as number };
  } catch {
    return { kind: "uncertain" };
  }
}

function clipShared(s: string, n: number): string {
  const c = [...s];
  return c.length <= n ? s : c.slice(0, n).join("");
}

/**
 * Shared-fact confirmation prompt (stage 2b, conservative). After a MERGE
 * position is proposed, the model must state the single fact both memories
 * record, or NONE when they differ. Strict-NONE rejects the merge (keep);
 * any other text confirms it and proceeds to summary drafting. The extracted
 * sentence is discarded, never stored or reused.
 */
export function buildConfirmPrompt(a: string, b: string, maxPromptChars: number): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const head =
    "<|im_start|>system\nYou judge two memories. Reply with only what is asked and nothing else.<|im_end|>\n" +
    "<|im_start|>user\nMemory 1: \"\"\"";
  const mid = "\"\"\"\nMemory 2: \"\"\"";
  const tail =
    "\"\"\"\n" +
    "What single fact do both memories record? Reply with only that shared fact in one short sentence, " +
    "or reply NONE if they record different facts. " +
    "Reply NONE unless both memories describe the same single fact. " +
    "Never join two different facts with 'and', ';', or a comma.<|im_end|>\n<|im_start|>assistant\n";
  const budget = Math.max(0, max - cpLen(head) - cpLen(mid) - cpLen(tail));
  const per = Math.floor(budget / 2);
  const ca = clip(a, Math.min(400, per + (budget % 2)));
  const cb = clip(b, Math.min(400, per));
  return tailClip(head + ca + mid + cb + tail, max);
}

export function buildSummaryPrompt(a: string, b: string, maxPromptChars: number): string {
  const max = clampMaxPromptChars(maxPromptChars);
  const head =
    "<|im_start|>system\nYou merge two related memories into one sentence. " +
    "Keep dates, names, facts and any uncertainty. Reply with only the merged sentence.<|im_end|>\n" +
    "<|im_start|>user\nMerge these related memories into one sentence.\n1. \"\"\"";
  const mid = "\"\"\"\n2. \"\"\"";
  const tail = "\"\"\"\nMerged:<|im_end|>\n<|im_start|>assistant\n";
  const budget = Math.max(0, max - cpLen(head) - cpLen(mid) - cpLen(tail));
  const per = Math.floor(budget / 2);
  const ca = clip(a, Math.min(600, per + (budget % 2)));
  const cb = clip(b, Math.min(600, per));
  return tailClip(head + ca + mid + cb + tail, max);
}
