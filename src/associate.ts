/**
 * maintain.associate: derived, rebuildable semantic association layer.
 *
 * Canonical `record_links` stay caller-authored: this module never adds or
 * removes them. It maintains only derived, rebuildable tables:
 * - vec_notes: active record embeddings (shared with M2 recall; same pinned
 *   model, same normalization, same upsert helper). The bodyHash column stores
 *   a hash of the actual embedding input (body, plus "\n話題: ..." when SLM
 *   topics exist), so a topic change re-embeds the record.
 * - record_topics: 1-3 SLM-extracted general-category topics per active
 *   record for the current bodyHash.
 * - similar_edges: union over every active embedded record r in one scope of
 *   r's top-K cosine neighbours. A peer sharing at least one topic gets an
 *   additive `topicBonus` (capped at 1) before the minScore check, because
 *   world-knowledge-only links (two motorcycle memories) score far below
 *   unrelated text on MiniLM. Unordered pairs are canonicalized (min, max)
 *   and keep the maximum score any record assigned.
 * - associate_scope_state: one fingerprint per scope (edge settings + model
 *   id + sorted (recordId, embedding-input hash) of active embedded records).
 *   A mismatch means the whole scope's edges are stale and are rebuilt in a
 *   single transaction: newly embedded records, re-embeddings, topic changes,
 *   status changes and config changes all move the fingerprint.
 *
 * Embedding remains incremental and bounded by `limit` (default
 * associate.batchMax, cap 500): at most that many active records are embedded
 * per run. Edge recomputation runs after embedding whenever the fingerprint
 * differs, including when `remaining > 0`, so a partial graph is still the
 * correct union of the vectors that currently exist. The recompute is brute
 * force O(n^2) over the scope and is intentionally not capped; at the
 * documented target of ~2000 active vectors per scope this is bounded work.
 * Missing model / vectors disabled is an OK degraded result with zero applied
 * work; an embedding failure writes no edges (derived writes are always
 * rebuildable).
 *
 * Threshold note (measured with the pinned multilingual MiniLM):
 *   bike corpus (rows/cols: H2 intake, GSX-S1000F, ZX-4R SE, speed, miso, dentist)
 *       H2=1.000 0.145 0.187 0.275 0.291 0.083
 *     GSX =0.145 1.000 0.465 0.181 -0.011 0.103
 *     ZX4R=0.187 0.465 1.000 0.293 0.070 0.084
 *     speed=0.275 0.181 0.293 1.000 0.105 0.078
 *     miso=0.291 -0.011 0.070 0.105 1.000 0.129
 *     dentist=0.083 0.103 0.084 0.078 0.129 1.000
 *   strongest bike/bike pair = 0.4649 (GSX-S1000F, ZX-4R SE); strongest
 *   bike/unrelated pair = 0.2911 (H2 intake, miso). minScore 0.45 therefore
 *   links the bike pair and excludes both unrelated memories. The specific
 *   H2/GSX pair scores 0.145 on this model, below any threshold that does not
 *   also admit unrelated text; that is a model limitation, not a tuning knob.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig, AssociateConfig } from "./config.js";
import { associateBounds, maintenanceTimeoutMs, rangeLimitMax } from "./config.js";
import {
  acquireCultivationLease,
  releaseCultivationLease,
} from "./cultivation.js";
import {
  containsLoneSurrogateDeep,
  countCp,
  hasControl,
  bodyHashFor,
  normalizeField,
  requestHashFor,
} from "./normalize.js";
import {
  generateCompletion,
  llmEnabled,
  llmMaxNewTokens,
  llmMaxPromptChars,
  llmTimeoutMs,
  modelFilesPresent as llmModelFilesPresent,
  resolveLlmDir,
} from "./llm.js";
import { applyResponseBudget, fail, ok, type ResponseEnvelope } from "./protocol.js";
import {
  VECTOR_DIM,
  VECTOR_MODEL_ID,
  VECTOR_MODEL_REVISION,
  cosine,
  deserializeVec,
  embedTexts,
  isValidVector,
  modelFilesPresent,
  resolveModelDir,
  vectorTimeoutMs,
  vectorsEnabled,
} from "./vectors.js";
import {
  isScopeAuthorized,
  upsertRecordVector,
} from "./store.js";

export const ASSOCIATE_OP = "maintain.associate";

export interface AssociateParams {
  scope: string;
  limit: number;
}

/** Injectable embedder (production: embedTexts with the pinned local model). */
export type AssociateEmbed = (
  texts: string[],
  modelDir: string,
  timeoutMs: number,
) => Promise<Float32Array[] | null>;

/** Injectable SLM generator (production: generateCompletion with Qwen2.5-1.5B). */
export type AssociateGenerate = (
  prompt: string,
  maxNewTokens: number,
) => Promise<string | null>;

const TOPIC_MAX = 3;
const TOPIC_MAX_CP = 12;
const TOPIC_TOKEN_BUDGET = 24;

/**
 * Japanese ChatML prompt for SLM topic extraction. The few-shot examples are
 * deliberately non-motorcycle so the model learns "brand/model -> general
 * category" rather than copying the corpus vocabulary.
 */
export function buildTopicPrompt(body: string, maxPromptChars = 2000): string {
  const head =
    "<|im_start|>system\n" +
    "あなたは記憶の話題分類器です。記憶が何についてなのか、一般的なカテゴリ名を1〜3個だけ日本語で出力してください。\n" +
    "商品名・ブランド名・型番・人名は、それが属する一般的なカテゴリに置き換えてください。\n" +
    "出力はカテゴリ名を「、」で区切った1行だけ。説明や文は書かないでください。\n" +
    "例：\n" +
    "「iPhone 15のカメラが気に入っている」→ スマートフォン、カメラ\n" +
    "「明日は歯医者の予約」→ 健康、予定\n" +
    "「来週の会議の資料を作る」→ 仕事、予定\n" +
    "<|im_end|>\n" +
    "<|im_start|>user\n";
  const tail = "<|im_end|>\n<|im_start|>assistant\n";
  const room = Math.max(1, maxPromptChars - countCp(head) - countCp(tail));
  const cps = [...body];
  const shown = cps.length > room ? cps.slice(0, room).join("") : body;
  return head + shown + tail;
}

/**
 * Strict topic parser: split only on 、 , ， ／ / and newlines; strip
 * bullets/quotes/trailing punctuation; accept 1..12 code points; reject
 * sentence punctuation and whitespace; dedupe by NFKC-lowercase; max 3.
 */
export function parseTopicResponse(raw: string | null | undefined): string[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[、,，／/\n\r]+|[」』”’】\]）)]+[「『“‘【\[（(]+/u)) {
    let t = part.trim();
    t = t.replace(/^(?:[-*・•>]|\d+[.)、])?\s*/u, "");
    t = t.replace(/^[「『"'“”‘’【\[（(]+/u, "");
    t = t.replace(/[「」『』"'“”‘’】\]）)。．.!?！？:：;；]+$/u, "");
    t = t.trim();
    if (t.length === 0) continue;
    if (/[。．.!?！？;；:：\s]/u.test(t)) continue;
    const cps = [...t];
    if (cps.length < 1 || cps.length > TOPIC_MAX_CP) continue;
    const key = normalizeField(t, true);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
    if (out.length >= TOPIC_MAX) break;
  }
  return out;
}

/** Precedence metadata stored with every record topic. */
export type TopicOrigin = "tag" | "external" | "llm";

function isWhiteSpaceCp(ch: string): boolean {
  return /^\p{White_Space}$/u.test(ch);
}

/**
 * Canonicalize one topic string: NFKC, trim White_Space, 1..12 code points,
 * no control characters. Canonical tags and external topics pass through the
 * same helper before they reach record_topics.
 */
export function canonicalizeTopic(raw: string): string | null {
  if (typeof raw !== "string" || containsLoneSurrogateDeep(raw)) return null;
  const cps = [...raw.normalize("NFKC")];
  let start = 0;
  let end = cps.length;
  while (start < end && isWhiteSpaceCp(cps[start]!)) start++;
  while (end > start && isWhiteSpaceCp(cps[end - 1]!)) end--;
  const t = cps.slice(start, end).join("");
  if (countCp(t) < 1 || countCp(t) > TOPIC_MAX_CP || hasControl(t)) return null;
  return t;
}

/** Canonicalize, dedupe by NFKC-lowercase, and sort a topic list. */
export function canonicalizeTopicList(raws: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of raws) {
    const t = canonicalizeTopic(raw);
    if (t === null) continue;
    const key = normalizeField(t, true);
    if (key.length === 0 || seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out.sort();
}

/** Text actually embedded for a record (body + topics when topics exist). */
function embeddingInput(bodyNorm: string, topics: string[] | undefined): string {
  return topics && topics.length > 0 ? `${bodyNorm}\n話題: ${topics.join("、")}` : bodyNorm;
}

/** Stable hash of the embedding input, stored in vec_notes.bodyHash. */
function embeddingInputHash(bodyNorm: string, topics: string[] | undefined): string {
  return bodyHashFor(embeddingInput(bodyNorm, topics));
}

/**
 * Map parsed topics onto existing scope topics: exact NFKC-lowercase match
 * first, then embedding cosine >= topicMergeMin. New topics join the
 * candidate set so near-duplicates inside one output also converge.
 */
async function canonicalizeTopics(
  parsed: string[],
  existing: string[],
  embed: AssociateEmbed,
  modelDir: string,
  timeoutMs: number,
  mergeMin: number,
): Promise<string[]> {
  const candidates = [...existing];
  const vectors = new Map<string, Float32Array>();
  const keyOf = (s: string): string => normalizeField(s, true);
  const needVectors =
    candidates.length > 0 || parsed.length > 1;
  if (needVectors) {
    const texts = [...new Set([...parsed, ...candidates])];
    let vecs: Float32Array[] | null = null;
    try {
      vecs = await embed(texts, modelDir, timeoutMs);
    } catch {
      vecs = null;
    }
    if (vecs && vecs.length === texts.length) {
      for (let i = 0; i < texts.length; i++) {
        const v = vecs[i];
        if (v) vectors.set(texts[i]!, v);
      }
    }
  }
  const out: string[] = [];
  const outKeys = new Set<string>();
  for (const topic of parsed) {
    const key = keyOf(topic);
    let chosen = candidates.find((c) => keyOf(c) === key);
    if (chosen === undefined) {
      const tv = vectors.get(topic);
      if (tv) {
        let bestTopic: string | null = null;
        let best = -Infinity;
        for (const c of candidates) {
          const cv = vectors.get(c);
          if (!cv) continue;
          const sim = cosine(tv, cv);
          if (!Number.isFinite(sim)) continue;
          if (sim > best + 1e-9 || (Math.abs(sim - best) <= 1e-9 && bestTopic !== null && c < bestTopic)) {
            best = sim;
            bestTopic = c;
          }
        }
        if (bestTopic !== null && best >= mergeMin) chosen = bestTopic;
      }
    }
    const result = chosen ?? topic;
    const resultKey = keyOf(result);
    if (outKeys.has(resultKey)) continue;
    outKeys.add(resultKey);
    out.push(result);
    if (!candidates.includes(result)) {
      candidates.push(result);
      const tv = vectors.get(topic);
      if (tv) vectors.set(result, tv);
    }
  }
  return out.sort();
}

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

/** Strict maintain.associate params (sync, no I/O). */
export function parseAssociateParams(
  config: AppConfig,
  params: Record<string, unknown>,
): { ok: true; value: AssociateParams } | { ok: false; res: ResponseEnvelope } {
  const allowed = new Set(["scope", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: budgeted(bad(), config) };
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return { ok: false, res: budgeted(bad(), config) };
  const bounds = associateBounds(config);
  let limit = bounds.batchMax;
  if (params["limit"] !== undefined) {
    const v = params["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, res: budgeted(bad(), config) };
    }
    if (v > bounds.batchMax) {
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

function storeAssociateResult(
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
    ).run(key, ASSOCIATE_OP, reqHash, JSON.stringify(stored), now);
    db.prepare(
      `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
       VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      now,
      ASSOCIATE_OP,
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
  op: string,
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
    if (again && again.op === op && again.requestHash === reqHash) {
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

interface ActiveRow {
  id: string;
  bodyNorm: string;
  bodyHash: string;
  createdAt: string;
  vec: Float32Array | null;
  vecHash: string | null;
}

function changedRows(result: { changes?: number | bigint }): number {
  const n = result.changes;
  return typeof n === "bigint" ? Number(n) : typeof n === "number" ? n : 0;
}

/** All active records in one scope, each with its current usable vector (if any). */
function loadActiveRows(db: DatabaseSync, scope: string): ActiveRow[] {
  const rows = db
    .prepare(
      `SELECT r.id AS id, r.bodyNorm AS bodyNorm, r.bodyHash AS bodyHash,
              r.createdAt AS createdAt, v.vec AS vec, v.dim AS dim, v.bodyHash AS vecHash
       FROM records r
       LEFT JOIN vec_notes v ON v.recordId = r.id
       WHERE r.scope = ? AND r.status = 'active'
       ORDER BY r.createdAt ASC, r.id ASC`,
    )
    .all(scope) as Array<{
      id: string;
      bodyNorm: string;
      bodyHash: string;
      createdAt: string;
      vec: Buffer | Uint8Array | null;
      dim: number | null;
      vecHash: string | null;
    }>;
  return rows.map((r) => ({
    id: r.id,
    bodyNorm: r.bodyNorm,
    bodyHash: r.bodyHash,
    createdAt: r.createdAt,
    vec: r.vec !== null && r.dim === VECTOR_DIM ? deserializeVec(r.vec, VECTOR_DIM) : null,
    vecHash: r.vecHash,
  }));
}

/** Last successful whole-scope edge fingerprint, or null when never computed. */
function loadScopeFingerprint(db: DatabaseSync, scope: string): string | null {
  const row = db
    .prepare(`SELECT fingerprint FROM associate_scope_state WHERE scope = ?`)
    .get(scope) as { fingerprint: string } | undefined;
  return row?.fingerprint ?? null;
}

/**
 * Hash of everything that determines the scope's edge set: the scoring
 * settings, the pinned model identity, and the sorted per-active-embedded
 * record (id, current embedding-input hash, stored embedding-input hash).
 * Comparing both hashes matters: a topic change dirties the scope even before
 * the record is re-embedded, and the subsequent vector write dirties it again
 * so the edges are rebuilt against the new vector. New/removed records and
 * config changes move the value directly.
 */
function computeScopeFingerprint(
  bounds: Required<AssociateConfig>,
  records: ActiveRow[],
  topicsById: Map<string, string[]>,
): string {
  const embedded = records
    .filter((r) => r.vec !== null)
    .map((r) => [
      r.id,
      embeddingInputHash(r.bodyNorm, topicsById.get(r.id)),
      r.vecHash ?? "",
    ] as [string, string, string])
    .sort((x, y) =>
      x[0] < y[0]
        ? -1
        : x[0] > y[0]
          ? 1
          : x[1] < y[1]
            ? -1
            : x[1] > y[1]
              ? 1
              : x[2] < y[2]
                ? -1
                : x[2] > y[2]
                  ? 1
                  : 0,
    );
  return createHash("sha256")
    .update(
      JSON.stringify({
        v: 2,
        topK: bounds.topK,
        minScore: bounds.minScore,
        topicBonus: bounds.topicBonus,
        topicMergeMin: bounds.topicMergeMin,
        model: `${VECTOR_MODEL_ID}@${VECTOR_MODEL_REVISION}`,
        records: embedded,
      }),
    )
    .digest("hex");
}

/** NFKC-lowercase topic sets for cheap shared-topic detection. */
function buildTopicSets(topicsById: Map<string, string[]>): Map<string, Set<string>> {
  const sets = new Map<string, Set<string>>();
  for (const [id, list] of topicsById) {
    if (list.length > 0) sets.set(id, new Set(list.map((t) => normalizeField(t, true))));
  }
  return sets;
}

function sharesTopic(
  topicSets: Map<string, Set<string>>,
  a: string,
  b: string,
): boolean {
  const ta = topicSets.get(a);
  const tb = topicSets.get(b);
  if (!ta || !tb) return false;
  const [small, large] = ta.size <= tb.size ? [ta, tb] : [tb, ta];
  for (const t of small) {
    if (large.has(t)) return true;
  }
  return false;
}

interface ScopeEdgeResult {
  written: number;
  removed: number;
  scanned: number;
}

/**
 * Recompute the WHOLE scope's similar-edge set from the vectors that exist
 * now, then replace only the rows whose pair/score changed in one
 * transaction. Desired set = union over every embedded record r of r's
 * top-K peers (topic-adjusted score >= minScore), deduped as (min,max) with
 * the maximum score. O(n^2) per scope; intentionally uncapped (see header).
 */
function recomputeScopeEdges(
  db: DatabaseSync,
  scope: string,
  active: ActiveRow[],
  topicsById: Map<string, string[]>,
  bounds: Required<AssociateConfig>,
  fingerprint: string,
  now: string,
): ScopeEdgeResult {
  const vecById = new Map<string, Float32Array>();
  for (const row of active) {
    if (row.vec !== null) vecById.set(row.id, row.vec);
  }
  const topicSets = buildTopicSets(topicsById);
  const desired = new Map<string, { a: string; b: string; score: number }>();
  for (const [id, self] of vecById) {
    const scored: Array<{ id: string; score: number }> = [];
    for (const [peerId, peerVec] of vecById) {
      if (peerId === id) continue;
      let score = cosine(self, peerVec);
      if (!Number.isFinite(score)) continue;
      if (sharesTopic(topicSets, id, peerId)) score = Math.min(1, score + bounds.topicBonus);
      if (score < bounds.minScore) continue;
      scored.push({ id: peerId, score });
    }
    scored.sort((x, y) =>
      y.score !== x.score ? y.score - x.score : x.id < y.id ? -1 : x.id > y.id ? 1 : 0,
    );
    for (const edge of scored.slice(0, bounds.topK)) {
      const a = id < edge.id ? id : edge.id;
      const b = id < edge.id ? edge.id : id;
      const key = `${a}\u0000${b}`;
      const prev = desired.get(key);
      if (prev === undefined || edge.score > prev.score) {
        desired.set(key, { a, b, score: edge.score });
      }
    }
  }

  let written = 0;
  let removed = 0;
  db.exec("BEGIN IMMEDIATE");
  try {
    const existingRows = db
      .prepare(`SELECT a, b, score FROM similar_edges WHERE scope = ?`)
      .all(scope) as Array<{ a: string; b: string; score: number }>;
    const existing = new Map<string, number>();
    for (const row of existingRows) existing.set(`${row.a}\u0000${row.b}`, row.score);
    const del = db.prepare(`DELETE FROM similar_edges WHERE scope = ? AND a = ? AND b = ?`);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO similar_edges(scope, a, b, score, computedAt) VALUES (?, ?, ?, ?, ?)`,
    );
    const EPS = 1e-12;
    for (const [key, row] of existingRows.map((r) => [`${r.a}\u0000${r.b}`, r] as const)) {
      const want = desired.get(key);
      if (want !== undefined && Math.abs(want.score - row.score) <= EPS) continue;
      del.run(scope, row.a, row.b);
      if (want === undefined) removed++;
    }
    for (const [key, edge] of desired) {
      const prior = existing.get(key);
      if (prior !== undefined && Math.abs(prior - edge.score) <= EPS) continue;
      ins.run(scope, edge.a, edge.b, edge.score, now);
      written++;
    }
    db.prepare(
      `INSERT INTO associate_scope_state(scope, fingerprint, computedAt) VALUES (?, ?, ?)
       ON CONFLICT(scope) DO UPDATE SET fingerprint = excluded.fingerprint, computedAt = excluded.computedAt`,
    ).run(scope, fingerprint, now);
    db.exec("COMMIT");
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
  return { written, removed, scanned: vecById.size };
}

/** Canonical tags per active record (record_tags is caller-authored). */
function loadTagTopics(db: DatabaseSync, scope: string): Map<string, string[]> {
  const rows = db
    .prepare(
      `SELECT t.recordId AS recordId, t.tag AS tag
       FROM record_tags t JOIN records r ON r.id = t.recordId
       WHERE r.scope = ? AND r.status = 'active'
       ORDER BY t.recordId ASC, t.tag ASC`,
    )
    .all(scope) as Array<{ recordId: string; tag: string }>;
  const out = new Map<string, string[]>();
  for (const r of rows) {
    const list = out.get(r.recordId);
    if (list) list.push(r.tag);
    else out.set(r.recordId, [r.tag]);
  }
  return out;
}

/** Topic rows whose bodyHash still matches the canonical record body. */
function loadCurrentTopicRows(
  db: DatabaseSync,
  scope: string,
): Map<string, Array<{ topic: string; origin: TopicOrigin }>> {
  const rows = db
    .prepare(
      `SELECT t.recordId AS recordId, t.topic AS topic, t.origin AS origin
       FROM record_topics t JOIN records r ON r.id = t.recordId
       WHERE r.scope = ? AND r.status = 'active' AND t.bodyHash = r.bodyHash
       ORDER BY t.recordId ASC, t.topic ASC`,
    )
    .all(scope) as Array<{ recordId: string; topic: string; origin: TopicOrigin }>;
  const out = new Map<string, Array<{ topic: string; origin: TopicOrigin }>>();
  for (const r of rows) {
    const list = out.get(r.recordId);
    const item = { topic: r.topic, origin: r.origin };
    if (list) list.push(item);
    else out.set(r.recordId, [item]);
  }
  return out;
}

function topicRowsMatch(
  rows: Array<{ topic: string; origin: TopicOrigin }>,
  topics: string[],
  origin: TopicOrigin,
): boolean {
  if (rows.length !== topics.length) return false;
  for (const row of rows) {
    if (row.origin !== origin) return false;
  }
  const got = rows.map((r) => r.topic).sort();
  const want = [...topics].sort();
  for (let i = 0; i < got.length; i++) {
    if (got[i] !== want[i]) return false;
  }
  return true;
}

interface TopicWrite {
  recordId: string;
  bodyHash: string;
  topics: string[];
  origin: TopicOrigin;
}

interface TopicState {
  /** Effective topics per active record (tags > external > llm). */
  topicsById: Map<string, string[]>;
  tagged: Set<string>;
  external: Set<string>;
  /** Rows that must be rewritten to enforce precedence/current bodyHash. */
  reconcile: TopicWrite[];
}

/**
 * Resolve the effective topic source per record. Canonical tags always win,
 * then externally supplied topics for the current bodyHash, then LLM topics.
 * A record with tag/external topics is therefore never exposed to the LLM.
 */
function loadTopicState(
  db: DatabaseSync,
  scope: string,
  active: ActiveRow[],
): TopicState {
  const tags = loadTagTopics(db, scope);
  const current = loadCurrentTopicRows(db, scope);
  const topicsById = new Map<string, string[]>();
  const tagged = new Set<string>();
  const external = new Set<string>();
  const reconcile: TopicWrite[] = [];
  for (const row of active) {
    const rawTags = tags.get(row.id) ?? [];
    const rows = current.get(row.id) ?? [];
    if (rawTags.length > 0) {
      tagged.add(row.id);
      const topics = canonicalizeTopicList(rawTags);
      topicsById.set(row.id, topics);
      if (!topicRowsMatch(rows, topics, "tag")) {
        reconcile.push({ recordId: row.id, bodyHash: row.bodyHash, topics, origin: "tag" });
      }
      continue;
    }
    const ext = canonicalizeTopicList(
      rows.filter((r) => r.origin === "external").map((r) => r.topic),
    );
    if (ext.length > 0) {
      external.add(row.id);
      topicsById.set(row.id, ext);
      if (!topicRowsMatch(rows, ext, "external")) {
        reconcile.push({ recordId: row.id, bodyHash: row.bodyHash, topics: ext, origin: "external" });
      }
      continue;
    }
    const llm = canonicalizeTopicList(rows.filter((r) => r.origin === "llm").map((r) => r.topic));
    if (llm.length > 0) {
      topicsById.set(row.id, llm);
      if (!topicRowsMatch(rows, llm, "llm")) {
        reconcile.push({ recordId: row.id, bodyHash: row.bodyHash, topics: llm, origin: "llm" });
      }
    } else {
      topicsById.set(row.id, []);
    }
  }
  return { topicsById, tagged, external, reconcile };
}

/** Replace all derived topics for the given records in one transaction. */
function writeTopics(db: DatabaseSync, writes: TopicWrite[]): void {
  if (writes.length === 0) return;
  db.exec("BEGIN IMMEDIATE");
  try {
    const del = db.prepare(`DELETE FROM record_topics WHERE recordId = ?`);
    const ins = db.prepare(
      `INSERT OR REPLACE INTO record_topics(recordId, topic, bodyHash, origin) VALUES (?, ?, ?, ?)`,
    );
    for (const w of writes) {
      del.run(w.recordId);
      for (const topic of w.topics) ins.run(w.recordId, topic, w.bodyHash, w.origin);
    }
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

/**
 * Drop derived rows for records that left the active set, and edges touching
 * them. Returns the number of edge rows removed.
 */
function pruneInactive(db: DatabaseSync, scope: string): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    let removed = 0;
    const edge = db
      .prepare(
        `DELETE FROM similar_edges
         WHERE scope = ?
           AND (
             NOT EXISTS (SELECT 1 FROM records r WHERE r.id = similar_edges.a AND r.scope = ? AND r.status = 'active')
             OR NOT EXISTS (SELECT 1 FROM records r WHERE r.id = similar_edges.b AND r.scope = ? AND r.status = 'active')
           )`,
      )
      .run(scope, scope, scope);
    removed += changedRows(edge);
    db.prepare(
      `DELETE FROM vec_notes WHERE recordId IN
         (SELECT id FROM records WHERE scope = ? AND status != 'active')`,
    ).run(scope);
    db.prepare(
      `DELETE FROM record_topics WHERE recordId IN
         (SELECT id FROM records WHERE scope = ? AND status != 'active')`,
    ).run(scope);
    db.exec("COMMIT");
    return removed;
  } catch (e) {
    try {
      db.exec("ROLLBACK");
    } catch {
      /* ignore */
    }
    throw e;
  }
}

/**
 * Active records still needing an embedding or (when topic extraction is
 * enabled/usable) SLM topics, i.e. the incremental work left after `limit`.
 * Edge freshness is tracked separately by the scope fingerprint.
 */
function countRemaining(db: DatabaseSync, scope: string, extractTopics: boolean): number {
  const active = loadActiveRows(db, scope);
  const topicState = loadTopicState(db, scope, active);
  const topics = topicState.topicsById;
  let n = 0;
  for (const r of active) {
    const list = topics.get(r.id);
    const inputHash = embeddingInputHash(r.bodyNorm, list);
    if (r.vec === null || r.vecHash !== inputHash) {
      n++;
      continue;
    }
    if (
      extractTopics &&
      !topicState.tagged.has(r.id) &&
      !topicState.external.has(r.id) &&
      (list === undefined || list.length === 0)
    ) {
      n++;
    }
  }
  return n;
}

function zeroData(
  degraded: boolean,
  edgesRemoved = 0,
  remaining = 0,
  topicsWritten = 0,
  topicsFailed = 0,
  topicsDegraded = false,
): Record<string, unknown> {
  return {
    applied: 0,
    embedded: 0,
    edgesWritten: 0,
    edgesRemoved,
    scanned: 0,
    remaining,
    topicsWritten,
    topicsFailed,
    topicsDegraded,
    degraded,
  };
}

/**
 * Run one bounded maintain.associate pass. Idempotent per caller key: same
 * key + same params replays the stored envelope; changed params => CONFLICT.
 * Shares the cultivation single-flight lease (the same leaseId as
 * maintain.distill / maintain.episodes). Lease contention => transient
 * CONFLICT (never stored).
 */
export async function maintainAssociate(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
  params: Record<string, unknown>,
  idempotencyKey: string,
  embedOverride?: AssociateEmbed,
  nowOverride?: string,
  generateOverride?: AssociateGenerate,
): Promise<ResponseEnvelope> {
  const parsed = parseAssociateParams(config, params);
  if (!parsed.ok) return parsed.res;
  const p = parsed.value;
  const reqHash = requestHashFor(ASSOCIATE_OP, { limit: p.limit, scope: p.scope });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== ASSOCIATE_OP) return budgeted(conflict(), config);
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
  const lease = acquireCultivationLease(db, config, { owner: execOwner, scope: p.scope, now: nowValid });
  if (!lease.acquired) return budgeted(conflict(), config);

  try {
    const bounds = associateBounds(config);
    const modelDir = resolveModelDir(config, configPath);
    const modelUsable = vectorsEnabled(config) && modelFilesPresent(modelDir);
    const usable = modelUsable || (embedOverride !== undefined && config.vectors === undefined);
    const llmModelDir = resolveLlmDir(config, configPath);
    const llmModelUsable = llmEnabled(config) && llmModelFilesPresent(llmModelDir);
    // An injected generator against a config without an llm section is the
    // test model itself (same convention as maintain.episodes). llmTopics is
    // opt-in: when false the generator is never invoked, even if configured.
    const topicsUsable =
      bounds.llmTopics &&
      (llmModelUsable || (generateOverride !== undefined && config.llm === undefined));
    const topicsDegraded = bounds.llmTopics && !topicsUsable;
    if (!usable) {
      let remaining = 0;
      try {
        remaining = countRemaining(db, p.scope, topicsUsable);
      } catch {
        /* diagnostics only */
      }
      const stored = budgeted(
        ok({ associate: zeroData(true, 0, remaining, 0, 0, topicsDegraded) }),
        config,
      );
      try {
        storeAssociateResult(db, idempotencyKey, reqHash, stored, p.scope, nowValid, 0);
      } catch (e) {
        return handleStoreRace(db, config, idempotencyKey, ASSOCIATE_OP, reqHash, e);
      }
      return stored;
    }

    const maintenanceMs = maintenanceTimeoutMs(config);
    const startedMs = Date.now();
    const overDeadline = (): boolean => Date.now() - startedMs > maintenanceMs;
    const testClock = nowOverride !== undefined;
    const renewNow = (): string => (testClock ? nowValid : new Date().toISOString());
    const renew = (): boolean =>
      acquireCultivationLease(db, config, { owner: execOwner, scope: p.scope, now: renewNow() }).acquired;

    // Step a: drop derived rows for records that are no longer active.
    let edgesRemoved = 0;
    try {
      edgesRemoved = pruneInactive(db, p.scope);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }

    let active: ActiveRow[];
    let topicState: TopicState;
    let priorFingerprint: string | null;
    try {
      active = loadActiveRows(db, p.scope);
      topicState = loadTopicState(db, p.scope, active);
      priorFingerprint = loadScopeFingerprint(db, p.scope);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    const topicsById = topicState.topicsById;

    // Enforce tag > external > llm precedence for the current bodyHash before
    // selecting work, so a tagged/external record never reaches the LLM.
    let topicsWritten = 0;
    if (topicState.reconcile.length > 0) {
      try {
        writeTopics(db, topicState.reconcile);
        topicsWritten += topicState.reconcile.length;
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
    }

    interface WorkItem {
      row: ActiveRow;
      current: boolean;
      topicsDirty: boolean;
    }
    const work: WorkItem[] = [];
    for (const row of active) {
      const topics = topicsById.get(row.id);
      const inputHash = embeddingInputHash(row.bodyNorm, topics);
      const current = row.vec !== null && row.vecHash === inputHash;
      const topicsDirty =
        (topics === undefined || topics.length === 0) &&
        !topicState.tagged.has(row.id) &&
        !topicState.external.has(row.id);
      // Topic extraction only selects work when llmTopics is enabled and the
      // SLM is usable: otherwise missing topics are intentional and must not
      // keep every record dirty forever. Edge freshness is separate: see the
      // scope fingerprint below.
      if (!current || (topicsDirty && topicsUsable)) {
        work.push({ row, current, topicsDirty });
      }
    }
    const selected = work.slice(0, p.limit);

    // Step a (continued): SLM topic extraction for selected dirty records,
    // before embedding. Extraction failure leaves the record dirty for topics
    // but never blocks the embedding/scan below.
    let topicsFailed = 0;
    if (topicsUsable) {
      const generate: AssociateGenerate =
        generateOverride ??
        ((prompt, tokens) =>
          generateCompletion(prompt, llmModelDir, {
            timeoutMs: llmTimeoutMs(config),
            maxNewTokens: tokens,
          }));
      const existingTopics: string[] = [];
      const seenTopics = new Set<string>();
      for (const list of topicsById.values()) {
        for (const t of list) {
          const key = normalizeField(t, true);
          if (seenTopics.has(key)) continue;
          seenTopics.add(key);
          existingTopics.push(t);
        }
      }
      const writes: TopicWrite[] = [];
      const topicBudget = (): number =>
        Math.min(
          vectorTimeoutMs(config),
          Math.max(500, maintenanceMs - (Date.now() - startedMs)),
        );
      for (const w of selected) {
        if (!w.topicsDirty) continue;
        // Whole-operation deadline reached: stop extracting; the record stays
        // dirty for topics and the next run retries it.
        if (overDeadline()) break;
        const prompt = buildTopicPrompt(w.row.bodyNorm, llmMaxPromptChars(config));
        let raw: string | null = null;
        try {
          raw = await generate(prompt, TOPIC_TOKEN_BUDGET);
        } catch {
          raw = null;
        }
        const parsedTopics = parseTopicResponse(raw);
        if (parsedTopics.length === 0) {
          topicsFailed++;
          continue;
        }
        let canon: string[];
        try {
          canon = await canonicalizeTopics(
            parsedTopics,
            existingTopics,
            embedOverride ?? embedTexts,
            modelDir,
            topicBudget(),
            bounds.topicMergeMin,
          );
        } catch {
          canon = parsedTopics;
        }
        if (canon.length === 0) {
          topicsFailed++;
          continue;
        }
        writes.push({ recordId: w.row.id, bodyHash: w.row.bodyHash, topics: canon, origin: "llm" });
        topicsById.set(w.row.id, canon);
        for (const t of canon) {
          const key = normalizeField(t, true);
          if (seenTopics.has(key)) continue;
          seenTopics.add(key);
          existingTopics.push(t);
        }
      }
      if (writes.length > 0) {
        try {
          writeTopics(db, writes);
        } catch {
          return budgeted(fail("STORE_UNAVAILABLE"), config);
        }
      }
      topicsWritten += writes.length;
    }

    // Step a (continued): embed selected records whose embedding input (body
    // plus current topics) is not the one stored in vec_notes.
    const toEmbed = selected.filter((w) => {
      const inputHash = embeddingInputHash(w.row.bodyNorm, topicsById.get(w.row.id));
      return w.row.vec === null || w.row.vecHash !== inputHash;
    });
    let embedded = 0;
    if (toEmbed.length > 0) {
      if (overDeadline()) return budgeted(fail("TIMEOUT"), config);
      const budget = Math.min(
        vectorTimeoutMs(config),
        Math.max(500, maintenanceMs - (Date.now() - startedMs)),
      );
      const vectors = await (embedOverride ?? embedTexts)(
        toEmbed.map((w) => embeddingInput(w.row.bodyNorm, topicsById.get(w.row.id))),
        modelDir,
        budget,
      );
      if (!vectors || vectors.length !== toEmbed.length) {
        // No edges are written from a failed embedding pass; vectors that
        // were already current remain usable, and this is reported degraded.
        let remaining = 0;
        try {
          remaining = countRemaining(db, p.scope, topicsUsable);
        } catch {
          /* diagnostics only */
        }
        const stored = budgeted(
          ok({
            associate: zeroData(
              true,
              edgesRemoved,
              remaining,
              topicsWritten,
              topicsFailed,
              topicsDegraded,
            ),
          }),
          config,
        );
        try {
          storeAssociateResult(db, idempotencyKey, reqHash, stored, p.scope, nowValid, 0);
        } catch (e) {
          return handleStoreRace(db, config, idempotencyKey, ASSOCIATE_OP, reqHash, e);
        }
        return stored;
      }
      for (let i = 0; i < toEmbed.length; i++) {
        const w = toEmbed[i]!;
        const vec = vectors[i];
        if (!vec || !isValidVector(vec, VECTOR_DIM)) continue;
        const inputHash = embeddingInputHash(w.row.bodyNorm, topicsById.get(w.row.id));
        if (upsertRecordVector(db, w.row.id, vec, inputHash, nowValid, VECTOR_DIM)) {
          embedded++;
          // Keep the in-memory row in sync so the fingerprint below reflects
          // the vector just written (no extra SELECT).
          w.row.vec = vec;
          w.row.vecHash = inputHash;
        }
      }
    }

    // Step b: recompute the WHOLE scope edge set when the fingerprint moved.
    // This runs after embedding (including when remaining > 0), so a partial
    // graph is always the union of the vectors that exist right now.
    let edgesWritten = 0;
    let scanned = 0;
    const fingerprint = computeScopeFingerprint(bounds, active, topicsById);
    if (fingerprint !== priorFingerprint) {
      if (overDeadline()) return budgeted(fail("TIMEOUT"), config);
      if (!renew()) return budgeted(conflict(), config);
      try {
        const result = recomputeScopeEdges(
          db,
          p.scope,
          active,
          topicsById,
          bounds,
          fingerprint,
          nowValid,
        );
        edgesWritten = result.written;
        edgesRemoved += result.removed;
        scanned = result.scanned;
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
    }

    let remaining = 0;
    try {
      remaining = countRemaining(db, p.scope, topicsUsable);
    } catch {
      /* diagnostics only */
    }
    const stored = budgeted(
      ok({
        associate: {
          applied: embedded,
          embedded,
          edgesWritten,
          edgesRemoved,
          scanned,
          remaining,
          topicsWritten,
          topicsFailed,
          topicsDegraded,
          degraded: false,
        },
      }),
      config,
    );
    try {
      storeAssociateResult(db, idempotencyKey, reqHash, stored, p.scope, nowValid, p.limit);
    } catch (e) {
      return handleStoreRace(db, config, idempotencyKey, ASSOCIATE_OP, reqHash, e);
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

/* ------------------------------------------------------------------ */
/* Topic ops: external topics + pending extraction work                */
/* ------------------------------------------------------------------ */

function parseRecordId(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (countCp(v) < 1 || countCp(v) > 256 || hasControl(v)) return null;
  return v;
}

function parseBodyHash(v: unknown): string | null {
  if (typeof v !== "string") return null;
  if (countCp(v) < 1 || countCp(v) > 256 || hasControl(v)) return null;
  return v;
}

interface StoredRecordRow {
  id: string;
  scope: string;
  status: string;
  bodyHash: string;
}

/**
 * topic.set: replace the externally supplied topics for one active record.
 * Canonical tags still win (precedence tag > external > llm), so this is
 * effective for records without tags. Replacing topics deletes the derived
 * vector so the next maintain.associate re-embeds the record; the changed
 * embedding-input hash moves the scope fingerprint and rebuilds the edges
 * (the topic text and topic bonus both change them).
 *
 * Idempotent per caller key: same key + same normalized params replays the
 * stored envelope; a different request under that key is CONFLICT.
 */
export function topicSet(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
  idempotencyKey: string,
  nowOverride?: string,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope", "id", "bodyHash", "topics"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return budgeted(bad(), config);
  const id = parseRecordId(params["id"]);
  if (!id) return budgeted(bad(), config);
  const bodyHash = parseBodyHash(params["bodyHash"]);
  if (!bodyHash) return budgeted(bad(), config);
  const rawTopics = params["topics"];
  if (!Array.isArray(rawTopics) || rawTopics.length < 1 || rawTopics.length > TOPIC_MAX) {
    return budgeted(bad(), config);
  }
  const topics: string[] = [];
  const seen = new Set<string>();
  for (const raw of rawTopics) {
    if (typeof raw !== "string") return budgeted(bad(), config);
    const t = canonicalizeTopic(raw);
    if (t === null) return budgeted(bad(), config);
    const key = normalizeField(t, true);
    if (seen.has(key)) continue;
    seen.add(key);
    topics.push(t);
  }
  if (topics.length === 0) return budgeted(bad(), config);
  topics.sort();
  const reqHash = requestHashFor("topic.set", { bodyHash, id, scope, topics });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== "topic.set") return budgeted(conflict(), config);
    const denied = scopeGate(db, config, scope);
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
    const denied = scopeGate(db, config, scope);
    if (denied) return denied;
  }
  const now = nowOverride ?? new Date().toISOString();
  if (!Number.isFinite(Date.parse(now))) return budgeted(fail("STORE_UNAVAILABLE"), config);

  let record: StoredRecordRow | undefined;
  try {
    record = db
      .prepare(`SELECT id, scope, status, bodyHash FROM records WHERE id = ?`)
      .get(id) as StoredRecordRow | undefined;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (!record || record.scope !== scope || record.status !== "active") {
    return budgeted(fail("NOT_FOUND"), config);
  }
  if (record.bodyHash !== bodyHash) return budgeted(conflict(), config);

  const stored = budgeted(ok({ topic: { id, bodyHash, topics, origin: "external" } }), config);
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      // Replace only external/llm rows: canonical tag rows are untouched and
      // continue to take precedence for tagged records.
      db.prepare(`DELETE FROM record_topics WHERE recordId = ? AND origin IN ('external','llm')`).run(id);
      const ins = db.prepare(
        `INSERT OR REPLACE INTO record_topics(recordId, topic, bodyHash, origin) VALUES (?, ?, ?, 'external')`,
      );
      for (const t of topics) ins.run(id, t, bodyHash);
      // Derived cache only: force re-embedding on the next associate. The
      // resulting hash change moves the scope fingerprint and rebuilds edges.
      db.prepare(`DELETE FROM vec_notes WHERE recordId = ?`).run(id);
      db.prepare(
        `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, 'topic.set', ?, ?, ?)`,
      ).run(idempotencyKey, reqHash, JSON.stringify(stored), now);
      db.prepare(
        `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
         VALUES (?, 'topic.set', ?, ?, ?, ?, NULL, NULL, NULL, NULL)`,
      ).run(now, id, stored.code, scope, Buffer.byteLength(JSON.stringify(stored), "utf8"));
      db.exec("COMMIT");
    } catch (e) {
      try {
        db.exec("ROLLBACK");
      } catch {
        /* ignore */
      }
      throw e;
    }
  } catch (e) {
    return handleStoreRace(db, config, idempotencyKey, "topic.set", reqHash, e);
  }
  return stored;
}

/**
 * topic.pending: active records in one scope that still lack canonical tags or
 * external topics for their current bodyHash. LLM-only records are included
 * (they remain candidates if extraction is enabled). Read-only: no heat,
 * exposure, or usage writes. `remaining` counts pending records not returned
 * by this bounded page.
 */
export function topicPending(
  db: DatabaseSync,
  config: AppConfig,
  params: Record<string, unknown>,
): ResponseEnvelope {
  if (containsLoneSurrogateDeep(params)) return budgeted(bad(), config);
  const allowed = new Set(["scope", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return budgeted(bad(), config);
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return budgeted(bad(), config);
  let limit = config.limits.limitDefault;
  if (params["limit"] !== undefined) {
    const v = params["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return budgeted(bad(), config);
    }
    if (v > rangeLimitMax(config)) return budgeted(fail("LIMIT_EXCEEDED"), config);
    limit = v;
  }
  {
    const denied = scopeGate(db, config, scope);
    if (denied) return denied;
  }
  const where = `FROM records r
    WHERE r.scope = ? AND r.status = 'active'
      AND NOT EXISTS (SELECT 1 FROM record_tags t WHERE t.recordId = r.id)
      AND NOT EXISTS (
        SELECT 1 FROM record_topics t
        WHERE t.recordId = r.id AND t.bodyHash = r.bodyHash AND t.origin = 'external'
      )`;
  let rows: Array<{ id: string; bodyHash: string; body: string }>;
  let total = 0;
  try {
    rows = db
      .prepare(
        `SELECT r.id AS id, r.bodyHash AS bodyHash, r.body AS body
         ${where}
         ORDER BY r.createdAt DESC, r.id ASC
         LIMIT ?`,
      )
      .all(scope, limit) as Array<{ id: string; bodyHash: string; body: string }>;
    const countRow = db
      .prepare(`SELECT COUNT(*) AS n ${where}`)
      .get(scope) as { n: number } | undefined;
    total = countRow?.n ?? rows.length;
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  const maxCp = Math.max(1, 2 * config.limits.snippetMaxCp);
  const items = rows.map((r) => {
    const cps = [...r.body];
    const truncated = cps.length > maxCp;
    return {
      id: r.id,
      bodyHash: r.bodyHash,
      body: truncated ? cps.slice(0, maxCp).join("") : r.body,
      truncated,
    };
  });
  const remaining = Math.max(0, total - items.length);
  return budgeted(ok({ items, remaining }), config);
}
