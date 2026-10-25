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
 *   template; the model answers with one classification label, one verdict
 *   line, or one merged sentence
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
import type { ActivationLlmConfig, AppConfig, LlmBackend, LlmConfig } from "./config.js";
import {
  LLM_DEFAULT_MAX_NEW_TOKENS,
  LLM_DEFAULT_MAX_PROMPT_CHARS,
  LLM_DEFAULT_MODEL_DIR,
  LLM_DEFAULT_TIMEOUT_MS,
  isLoopbackHttpUrl,
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

/** Selected maintenance runtime; absent => "onnx" (existing behavior). */
export function llmBackend(config: AppConfig): LlmBackend {
  return config.llm?.backend === "openai" ? "openai" : "onnx";
}

/**
 * Model identity to report in maintenance responses. ONNX keeps the pinned
 * repo id + revision (unchanged contract). OpenAI-compatible reports the
 * operator-configured model name and no revision, because that backend's
 * weights are not resolved by this process (the local server owns them).
 */
export function activeModelLabel(config: AppConfig): { model: string; revision: string | null } {
  if (llmBackend(config) === "openai") {
    return { model: config.llm?.model ?? LLM_MODEL_ID, revision: null };
  }
  return { model: LLM_MODEL_ID, revision: LLM_MODEL_REVISION };
}

/**
 * True when maintenance may call the configured backend. ONNX needs the
 * pinned files on disk; OpenAI-compatible needs no files, only an enabled
 * section with a valid loopback baseUrl (config load already enforces it,
 * but programmatic configs are re-checked here).
 */
export function llmUsable(config: AppConfig, modelDir: string): boolean {
  if (!llmEnabled(config)) return false;
  if (llmBackend(config) === "openai") {
    return isLoopbackHttpUrl(config.llm?.baseUrl) && typeof config.llm?.model === "string" &&
      config.llm.model.length > 0;
  }
  return modelFilesPresent(modelDir);
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
// Single-flight for the expensive model load: concurrent callers share one
// in-flight load instead of starting one load each while cachedGenerator is
// still unset.
let inflightLoad: { dir: string; promise: Promise<Generator> } | null = null;
// Timeout poison: Promise.race cannot cancel an unexpired model load or
// generation — the underlying work keeps running. After a load/generation
// timeout for a model dir, no NEW model work is started for that dir (calls
// resolve null fast for bounded retry) until resetLlmRuntime() clears it.
// This is real ownership (refuse to start), not fake cancellation.
let poisonedDir: string | null = null;

/** True while new model work for `modelDir` is refused after a timeout. Never throws. */
export function isLlmPoisoned(modelDir: string): boolean {
  try {
    return poisonedDir !== null && poisonedDir === modelDir;
  } catch {
    return false;
  }
}

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

/** Reject as soon as `signal` aborts; the underlying work is left to settle. */
function abortable<T>(p: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return p;
  if (signal.aborted) return Promise.reject(new Error("llm aborted"));
  return new Promise<T>((resolve, reject) => {
    const onAbort = (): void => reject(new Error("llm aborted"));
    signal.addEventListener("abort", onAbort, { once: true });
    p.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

async function loadGenerator(modelDir: string, timeoutMs: number): Promise<Generator> {
  if (cachedGenerator && cachedDir === modelDir) return cachedGenerator;
  if (inflightLoad && inflightLoad.dir === modelDir) return inflightLoad.promise;
  const mod = await import("@huggingface/transformers");
  const env = (mod as unknown as { env: Record<string, unknown> }).env;
  // Offline-only: local files, never remote, never telemetry.
  env["allowRemoteModels"] = false;
  env["allowLocalModels"] = true;
  const pipeline = (mod as unknown as { pipeline: (...a: unknown[]) => Promise<Generator> }).pipeline;
  // dtype "q4" selects the quantized variant; onnx-community ports resolve
  // decoder sessions as onnx/model_<quant>.onnx (here onnx/model_q4.onnx).
  const started = ((): Promise<Generator> => {
    const p = withTimeout(
      pipeline(LLM_TASK, modelDir, { dtype: LLM_DTYPE, local_files_only: true } as unknown as undefined),
      timeoutMs,
      "llm load timeout",
    );
    return p.then(
      (generator) => {
        if (inflightLoad && inflightLoad.promise === p) inflightLoad = null;
        cachedGenerator = generator;
        cachedDir = modelDir;
        return generator;
      },
      (e) => {
        if (inflightLoad && inflightLoad.promise === p) inflightLoad = null;
        if (e instanceof Error && e.message === "llm load timeout") poisonedDir = modelDir;
        throw e;
      },
    );
  })();
  inflightLoad = { dir: modelDir, promise: started };
  return started;
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

/* ---------------- OpenAI-compatible loopback backend ---------------- */

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}
export interface ChatMlConversion {
  messages: ChatMessage[];
  /** Non-empty trailing assistant content (ChatML prefill). */
  prefill: string;
}

/**
 * Convert the existing ChatML prompt strings into OpenAI chat messages.
 * A trailing, unterminated assistant turn is an assistant prefill: it is sent
 * as a final assistant message (llama.cpp continuation) and echoed back to the
 * caller only when the server includes it in `message.content`. Returns null
 * for malformed role lines or a non-assistant open turn; the caller degrades.
 */
export function chatMlToMessages(prompt: string): ChatMlConversion | null {
  const START = "<|im_start|>";
  const END = "<|im_end|>";
  const messages: ChatMessage[] = [];
  let prefill = "";
  let pos = 0;
  while (pos < prompt.length) {
    const start = prompt.indexOf(START, pos);
    if (start < 0) break;
    const roleStart = start + START.length;
    const nl = prompt.indexOf("\n", roleStart);
    if (nl < 0) return null;
    const role = prompt.slice(roleStart, nl);
    if (role !== "system" && role !== "user" && role !== "assistant") return null;
    const contentStart = nl + 1;
    const end = prompt.indexOf(END, contentStart);
    if (end < 0) {
      if (role !== "assistant") return null;
      prefill = prompt.slice(contentStart);
      pos = prompt.length;
      break;
    }
    messages.push({ role, content: prompt.slice(contentStart, end) });
    pos = end + END.length;
  }
  if (messages.length === 0) return null;
  if (prefill.length > 0) messages.push({ role: "assistant", content: prefill });
  return { messages, prefill };
}

/** Remove any complete think block from model output. */
export function stripThinkingBlocks(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>\s*/gi, "").trim();
}

/** baseUrl (origin or origin/v1) -> OpenAI chat completions endpoint. */
export function openAiChatCompletionsUrl(baseUrl: string): string {
  const u = new URL(baseUrl);
  const p = u.pathname.replace(/\/+$/, "");
  return `${u.origin}${p === "" ? "/v1" : p}/chat/completions`;
}

async function generateOpenAiCompletion(
  prompt: string,
  opts: {
    timeoutMs: number;
    maxNewTokens: number;
    config?: AppConfig;
    signal?: AbortSignal;
    /**
     * Per-call classifier endpoint. When set it replaces the global
     * config.llm backend/model/baseUrl (loopback and model are re-checked
     * here for programmatic configs). The global llm stays the runtime for
     * every other caller.
     */
    llmOverride?: ActivationLlmConfig;
    /** Classifier calls must never let the 35B model spend reasoning budget. */
    forceDisableThinking?: boolean;
  },
): Promise<string | null> {
  const config = opts.config;
  const override = opts.llmOverride;
  const l = override ?? config?.llm;
  if (!config || !l) return null;
  if (override === undefined && llmBackend(config) !== "openai") return null;
  if (!isLoopbackHttpUrl(l.baseUrl) || typeof l.model !== "string" || l.model.length === 0) {
    return null;
  }
  const conv = chatMlToMessages(prompt);
  if (!conv) return null;
  const poisonKey = `openai:${l.baseUrl}`;
  if (poisonedDir !== null && poisonedDir === poisonKey) return null;

  const disableThinking =
    opts.forceDisableThinking === true ||
    ((l as LlmConfig).disableThinking !== false);
  const request: Record<string, unknown> = {
    model: l.model,
    messages: conv.messages,
    temperature: 0,
    max_tokens: opts.maxNewTokens,
    seed: 0,
    stream: false,
  };
  if (disableThinking) request["chat_template_kwargs"] = { enable_thinking: false };

  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json",
  };
  if (l.apiKeyEnv) {
    const token = process.env[l.apiKeyEnv];
    if (token) headers["authorization"] = `Bearer ${token}`;
  }

  let timedOut = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const ctrl = new AbortController();
  const external = opts.signal;
  const onExternalAbort = (): void => ctrl.abort();
  if (external) {
    if (external.aborted) ctrl.abort();
    else external.addEventListener("abort", onExternalAbort, { once: true });
  }
  timer = setTimeout(() => {
    timedOut = true;
    ctrl.abort();
  }, Math.max(1, opts.timeoutMs));
  (timer as unknown as { unref?: () => void }).unref?.();
  try {
    const res = await fetch(openAiChatCompletionsUrl(l.baseUrl), {
      method: "POST",
      headers,
      body: JSON.stringify(request),
      signal: ctrl.signal,
      // A loopback server must not be able to redirect the request to a
      // non-loopback host; refuse redirects instead of following them.
      redirect: "error",
    });
    if (!res.ok) return null;
    const json = (await res.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const raw = json?.choices?.[0]?.message?.content;
    if (typeof raw !== "string" || raw.length === 0) return null;
    let text = disableThinking ? stripThinkingBlocks(raw) : raw;
    // llama.cpp returns only the continuation for a final assistant message,
    // but some servers echo the prefill. Callers (episodes) strip 要約： as
    // well; removing it here keeps both server behaviors equivalent to ONNX.
    if (conv.prefill.length > 0 && text.startsWith(conv.prefill)) {
      text = text.slice(conv.prefill.length);
    }
    if (text.length === 0) return null;
    if (containsLoneSurrogateDeep(text) || hasControl(text.replace(/\n/g, ""))) return null;
    return text;
  } catch {
    // Only a timeout poisons the backend (same ownership rule as ONNX); an
    // ordinary network/HTTP error is retryable on the next call.
    if (timedOut) poisonedDir = poisonKey;
    return null;
  } finally {
    if (timer) clearTimeout(timer);
    if (external) external.removeEventListener("abort", onExternalAbort);
  }
}

/**
 * Generate a greedy (deterministic) completion with the pinned local model.
 * Offline only. Resolves null on ANY failure (disabled/missing model,
 * timeout, bad output): callers degrade to keep/retry without state change.
 * Never throws for model reasons.
 *
 * With opts.config.llm.backend === "openai", dispatch to a loopback-only
 * OpenAI-compatible server instead of loading ONNX files.
 */
export async function generateCompletion(
  prompt: string,
  modelDir: string,
  opts: {
    timeoutMs: number;
    maxNewTokens: number;
    config?: AppConfig;
    /** Optional external cancellation (e.g. a lost maintenance lease). */
    signal?: AbortSignal;
    /** Classifier-only endpoint override; leaves global callers untouched. */
    llmOverride?: ActivationLlmConfig;
    /** Classifier calls force `enable_thinking:false` even if llm disables it. */
    forceDisableThinking?: boolean;
  },
): Promise<string | null> {
  try {
    if (typeof prompt !== "string" || prompt.length === 0 || prompt.length > 8000) return null;
    if (opts.llmOverride !== undefined || (opts.config && llmBackend(opts.config) === "openai")) {
      return await generateOpenAiCompletion(prompt, opts);
    }
    if (!modelFilesPresent(modelDir)) return null;
    // Refuse to start new model work after a timeout for this dir (poison):
    // the timed-out load/generation is still running uncancelled, so piling
    // another 1.5B load/generation on top risks exhausting memory/CPU.
    if (poisonedDir !== null && poisonedDir === modelDir) return null;
    const generator = await loadGenerator(modelDir, opts.timeoutMs);
    let out: unknown;
    try {
      out = await abortable(
        withTimeout(
          generator(prompt, {
            max_new_tokens: opts.maxNewTokens,
            do_sample: false,
            return_full_text: false,
          } as unknown as Record<string, unknown>),
          opts.timeoutMs,
          "llm generate timeout",
        ),
        opts.signal,
      );
    } catch (e) {
      if (e instanceof Error && e.message === "llm generate timeout") poisonedDir = modelDir;
      return null;
    }
    const text = generatedTextOf(out);
    if (typeof text !== "string" || text.length === 0) return null;
    if (containsLoneSurrogateDeep(text) || hasControl(text.replace(/\n/g, ""))) return null;
    return text;
  } catch {
    return null;
  }
}

/** Forget the cached pipeline (tests/provisioning hygiene). Also clears the
 *  timeout poison and any shared in-flight load. Never throws. */
export function resetLlmRuntime(): void {
  cachedGenerator = null;
  cachedDir = null;
  inflightLoad = null;
  poisonedDir = null;
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

export type SharedFactResult = { kind: "shared" } | { kind: "none" } | { kind: "uncertain" };

/**
 * Parse shared-fact confirmation output (stage 2b). The prompt is
 * generation-style (state the shared fact, or NONE), so this is deliberately
 * NOT the label parser: exactly NONE (case-insensitive, optional trailing
 * punctuation) means the merge is rejected; any other non-empty text is a
 * stated shared fact; invalid/empty/non-string is uncertain (caller keeps).
 * Never throws. Parses MODEL output only.
 */
export function parseSharedFact(raw: unknown): SharedFactResult {
  if (typeof raw !== "string") return { kind: "uncertain" };
  if (raw.length === 0 || raw.length > 4000) return { kind: "uncertain" };
  if (hasControl(raw.replace(/\n/g, "")) || containsLoneSurrogateDeep(raw)) return { kind: "uncertain" };
  if (/^\s*NONE\s*[.!?,;:。！？、，；：]*\s*$/iu.test(raw)) return { kind: "none" };
  return raw.trim().length > 0 ? { kind: "shared" } : { kind: "uncertain" };
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
