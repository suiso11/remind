/**
 * M2 local semantic vectors (pinned multilingual embedding model).
 *
 * Model (pinned, public, local-only at runtime):
 * - repo: Xenova/paraphrase-multilingual-MiniLM-L12-v2 (ONNX, transformers.js)
 * - revision: 2c4055b12046f11709e9df2c122e59ffbdc2f900
 * - base: sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2
 * - license: Apache-2.0 (base model card; Xenova port carries no separate license)
 * - runtime: @huggingface/transformers 4.3.1 + onnxruntime-node 1.30.0 (pinned)
 * - file: onnx/model_quantized.onnx (+ tokenizer.json, config.json, tokenizer_config.json)
 * - dim: 384. Pooling: attention-masked mean, L2-normalized. Cosine on normalized vecs.
 *
 * Network rule: ONLY scripts/provision-model.ts downloads the public files.
 * Everything here runs offline (env.allowRemoteModels=false, localFilesOnly).
 * Missing/invalid model or vectors => recall degrades to lexical+graph (§8),
 * never an error. Derived table vec_notes is rebuildable and never canonical.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { AppConfig } from "./config.js";
import { resolveConfigDirPath } from "./config.js";

export const VECTOR_MODEL_ID = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";
export const VECTOR_MODEL_REVISION = "2c4055b12046f11709e9df2c122e59ffbdc2f900";
export const VECTOR_MODEL_BASE = "sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2";
export const VECTOR_MODEL_LICENSE = "Apache-2.0";
export const VECTOR_RUNTIME = "@huggingface/transformers@4.3.1 + onnxruntime-node@1.30.0";
export const VECTOR_DIM = 384;
export const VECTOR_MODEL_FILE = "onnx/model_quantized.onnx";
/** Files the provisioner fetches at the pinned revision (manifest records sha256). */
export const VECTOR_MODEL_FILES = [
  "config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "special_tokens_map.json",
  VECTOR_MODEL_FILE,
] as const;
export const VECTOR_DEFAULT_TOP_K = 20;
export const VECTOR_DEFAULT_TIMEOUT_MS = 15000;
export const VECTOR_DEFAULT_MODEL_DIR = "./models/paraphrase-multilingual-MiniLM-L12-v2";

export type VectorStatus = "disabled" | "missing" | "invalid" | "ok";

export function resolveModelDir(config: AppConfig, configPath: string): string {
  const rel = config.vectors?.modelDir ?? VECTOR_DEFAULT_MODEL_DIR;
  return resolveConfigDirPath(configPath, rel);
}

export function vectorTopK(config: AppConfig): number {
  const k = config.vectors?.topK ?? VECTOR_DEFAULT_TOP_K;
  return Number.isInteger(k) && k >= 1 && k <= 60 ? k : VECTOR_DEFAULT_TOP_K;
}

export function vectorTimeoutMs(config: AppConfig): number {
  const t = config.vectors?.timeoutMs ?? VECTOR_DEFAULT_TIMEOUT_MS;
  return Number.isInteger(t) && t >= 500 && t <= 60000 ? t : VECTOR_DEFAULT_TIMEOUT_MS;
}

/** True only when the operator explicitly enabled the vectors section. Absent
 *  (or enabled:false) => false: existing configurations without the optional
 *  block keep the prior lexical-plus-graph behavior (M1) instead of silently
 *  enabling semantic recall because a default model directory happens to
 *  exist. Same convention as the optional llm section. */
export function vectorsEnabled(config: AppConfig): boolean {
  return config.vectors?.enabled === true;
}

/**
 * Bound a vector query-embedding call by the remaining recall deadline.
 * Returns the embedding budget (ms), or null when embedding must be skipped
 * outright so the lexical fallback still fits: the reserve leaves room for
 * the fallback recall inside the same operation budget. Unknown remaining
 * (legacy callers) => the configured timeout, unchanged.
 */
export function vectorEmbedBudgetMs(
  configuredMs: number,
  remainingMs: number | undefined,
  elapsedMs: number,
): number | null {
  const configured = Number.isFinite(configuredMs) && configuredMs > 0 ? Math.floor(configuredMs) : 0;
  if (configured <= 0) return null;
  if (remainingMs === undefined || !Number.isFinite(remainingMs)) return configured;
  const remaining = Math.floor(remainingMs) - Math.max(0, Math.floor(elapsedMs));
  // Reserve for the lexical+graph fallback recall inside the same budget.
  const RESERVE_MS = 750;
  const MIN_EMBED_MS = 500;
  const budget = Math.min(configured, remaining - RESERVE_MS);
  return budget >= MIN_EMBED_MS ? budget : null;
}

interface ManifestFile { sha256: string; bytes: number }
interface ModelManifest {
  model: string;
  revision: string;
  dim: number;
  files: Record<string, ManifestFile>;
}

export function readModelManifest(modelDir: string): ModelManifest | null {
  try {
    const raw = fs.readFileSync(path.join(modelDir, "manifest.json"), "utf8");
    const m = JSON.parse(raw) as Partial<ModelManifest>;
    if (m.model !== VECTOR_MODEL_ID || m.revision !== VECTOR_MODEL_REVISION) return null;
    if (m.dim !== VECTOR_DIM || typeof m.files !== "object" || m.files === null) return null;
    return m as ModelManifest;
  } catch {
    return null;
  }
}

/** True when every pinned file exists on disk (hash-checked by the provisioner). */
export function modelFilesPresent(modelDir: string): boolean {
  try {
    for (const f of VECTOR_MODEL_FILES) {
      const st = fs.statSync(path.join(modelDir, f));
      if (!st.isFile() || st.size === 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/* ---------------- pure vector math (no model needed) ---------------- */

export function isValidVector(v: unknown, dim: number = VECTOR_DIM): v is Float32Array | number[] {
  if (dim < 1 || !Number.isInteger(dim)) return false;
  const a: ArrayLike<number> | null =
    v instanceof Float32Array ? v : Array.isArray(v) ? v : null;
  if (!a || a.length !== dim) return false;
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    const x = a[i] as number;
    if (typeof x !== "number" || !Number.isFinite(x)) return false;
    norm += x * x;
  }
  // Reject zero/near-zero vectors (no direction => no signal).
  return norm > 1e-12;
}

/** L2-normalize in place (Float32Array) or into a copy for plain arrays. */
export function normalizeVec(v: Float32Array): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i]! * v[i]!;
  norm = Math.sqrt(norm);
  if (!(norm > 0) || !Number.isFinite(norm)) return v;
  for (let i = 0; i < v.length; i++) v[i] = v[i]! / norm;
  return v;
}

/** Cosine similarity. Returns -1..1; invalid input => -2 (sorts last, never throws). */
export function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  try {
    if (a.length !== b.length || a.length === 0) return -2;
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
      const x = a[i] as number;
      const y = b[i] as number;
      if (!Number.isFinite(x) || !Number.isFinite(y)) return -2;
      dot += x * y;
      na += x * x;
      nb += y * y;
    }
    if (!(na > 0) || !(nb > 0)) return -2;
    return dot / (Math.sqrt(na) * Math.sqrt(nb));
  } catch {
    return -2;
  }
}

export function serializeVec(v: Float32Array): Buffer {
  return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
}

export function deserializeVec(buf: Buffer | Uint8Array, dim: number = VECTOR_DIM): Float32Array | null {
  try {
    const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (b.length !== dim * 4) return null;
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i++) out[i] = b.readFloatLE(i * 4);
    return isValidVector(out, dim) ? out : null;
  } catch {
    return null;
  }
}

/* ---------------- offline embedding runtime (lazy, bounded) ---------------- */

type Extractor = (texts: string[], opts?: Record<string, unknown>) => Promise<unknown>;

let cachedExtractor: Extractor | null = null;
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

async function loadExtractor(modelDir: string, timeoutMs: number): Promise<Extractor> {
  if (cachedExtractor && cachedDir === modelDir) return cachedExtractor;
  const mod = await import("@huggingface/transformers");
  const env = (mod as unknown as { env: Record<string, unknown> }).env;
  // Offline-only: local files, never remote, never telemetry.
  env["allowRemoteModels"] = false;
  env["allowLocalModels"] = true;
  const pipeline = (mod as unknown as { pipeline: (...a: unknown[]) => Promise<Extractor> }).pipeline;
  // dtype "q8" selects the pinned onnx/model_quantized.onnx file offline.
  const extractor = await withTimeout(
    pipeline("feature-extraction", modelDir, { dtype: "q8", local_files_only: true } as unknown as undefined),
    timeoutMs,
    "vector model load timeout",
  );
  cachedExtractor = extractor;
  cachedDir = modelDir;
  return extractor;
}

function toFloat32(row: unknown, dim: number): Float32Array | null {
  try {
    const arr = Array.isArray(row) ? row : null;
    if (!arr || arr.length !== dim) return null;
    const out = new Float32Array(dim);
    for (let i = 0; i < dim; i++) {
      const x = (arr[i] as number);
      if (typeof x !== "number" || !Number.isFinite(x)) return null;
      out[i] = x;
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * Normalize extractor output to per-text L2-normalized vectors.
 * With {pooling:"mean", normalize:true} the output is already
 * [batch, hidden]; without pooling it is [batch, seq, hidden] and we
 * mean-pool over tokens. Single (unbatched) [seq, hidden] and [hidden]
 * forms are handled too. Returns null on any shape mismatch. Never throws.
 */
function poolMeanNormalize(output: unknown, dim: number): Float32Array[] | null {
  try {
    const o = output as {
      tolist?: () => unknown;
    };
    if (typeof o.tolist !== "function") return null;
    const listed = o.tolist() as unknown;
    if (!Array.isArray(listed) || listed.length === 0) return null;
    const first = (listed as unknown[])[0];
    // [batch, hidden]: each row is a plain number vector.
    if (Array.isArray(first) && (first as unknown[]).length === dim && typeof (first as unknown[])[0] === "number") {
      const out: Float32Array[] = [];
      for (const row of listed as unknown[][]) {
        const v = toFloat32(row, dim);
        if (!v) return null;
        out.push(normalizeVec(v));
      }
      return out;
    }
    // [hidden]: single unbatched embedding.
    if (typeof first === "number" && (listed as unknown[]).length === dim) {
      const v = toFloat32(listed as unknown[], dim);
      return v ? [normalizeVec(v)] : null;
    }
    // [batch, seq, hidden]: mean-pool each sequence.
    if (Array.isArray(first) && Array.isArray((first as unknown[])[0])) {
      const out: Float32Array[] = [];
      for (const seq of listed as unknown[][][]) {
        const acc = new Float64Array(dim);
        let n = 0;
        for (const tok of seq) {
          if (!Array.isArray(tok) || tok.length !== dim) return null;
          for (let i = 0; i < dim; i++) {
            const x = tok[i] as number;
            if (typeof x !== "number" || !Number.isFinite(x)) return null;
            acc[i]! += x;
          }
          n++;
        }
        if (n === 0) return null;
        const row = new Float32Array(dim);
        for (let i = 0; i < dim; i++) row[i] = acc[i]! / n;
        out.push(normalizeVec(row));
      }
      return out;
    }
    // [seq, hidden]: single unbatched sequence.
    if (Array.isArray(first) && typeof (first as unknown[])[0] === "number") {
      const seq = listed as unknown[][];
      const acc = new Float64Array(dim);
      let n = 0;
      for (const tok of seq) {
        if (!Array.isArray(tok)) {
          const v = toFloat32(seq as unknown[], dim);
          return v ? [normalizeVec(v)] : null;
        }
        if (tok.length !== dim) return null;
        for (let i = 0; i < dim; i++) {
          const x = tok[i] as number;
          if (typeof x !== "number" || !Number.isFinite(x)) return null;
          acc[i]! += x;
        }
        n++;
      }
      if (n === 0) return null;
      const row = new Float32Array(dim);
      for (let i = 0; i < dim; i++) row[i] = acc[i]! / n;
      return [normalizeVec(row)];
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Embed normalized texts with the pinned local model. Offline only.
 * Resolves null on ANY failure (missing/invalid model, timeout, bad output):
 * callers degrade to lexical+graph. Never throws for model reasons.
 */
export async function embedTexts(
  texts: string[],
  modelDir: string,
  timeoutMs: number,
): Promise<Float32Array[] | null> {
  try {
    if (texts.length === 0) return [];
    if (!modelFilesPresent(modelDir)) return null;
    for (const t of texts) {
      if (typeof t !== "string" || t.length === 0 || t.length > 4000) return null;
    }
    const extractor = await loadExtractor(modelDir, timeoutMs);
    const out = await withTimeout(
      (extractor as Extractor)(texts, { pooling: "mean", normalize: true } as unknown as Record<string, unknown>),
      timeoutMs,
      "vector embed timeout",
    );
    // transformers v4 feature-extraction with pooling already returns
    // per-text normalized embeddings; still re-normalize defensively.
    const pooled = poolMeanNormalize(out, VECTOR_DIM);
    if (pooled && pooled.length === texts.length) {
      const checked = pooled.map((v) => toFloat32(Array.from(v), VECTOR_DIM)).map((v) => (v ? normalizeVec(v) : null));
      if (checked.every((v) => v && isValidVector(v, VECTOR_DIM))) return checked as Float32Array[];
    }
    // Fallback: extractor may return raw arrays per text.
    if (Array.isArray(out)) {
      const rows = (out as unknown[]).map((r) => toFloat32(r, VECTOR_DIM)).map((v) => (v ? normalizeVec(v) : null));
      if (rows.length === texts.length && rows.every((v) => v && isValidVector(v, VECTOR_DIM))) {
        return rows as Float32Array[];
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Forget the cached pipeline (tests/provisioning hygiene). Never throws. */
export function resetVectorRuntime(): void {
  cachedExtractor = null;
  cachedDir = null;
}
