/**
 * P3 maintain.consolidate: one grounded summary per topic cluster.
 *
 * Unlike maintain.distill's pairwise merge, this op treats a topic from the
 * derived record_topics layer (PR #29) as a cluster: all active records whose
 * current topics include that topic (excluding summaries produced by this op)
 * are folded with the cited-reduce prompt used by episode summaries. Every
 * generated sentence must cite in-range members, pass the deterministic
 * anchor guard against the cited member bodies, and pass a strict YES/NO
 * claim check against those same bodies. Ungrounded sentences are dropped;
 * when none survive, nothing is written (there is deliberately no extractive
 * fallback for clusters).
 *
 * Safety envelope mirrors maintain.episodes:
 * - Strict params; idempotencyKey replay / CONFLICT.
 * - The shared M3 cultivation lease makes this mutually exclusive with
 *   maintain.distill / maintain.episodes / maintain.associate.
 * - Inference runs outside DB transactions; canonical writes are fenced in
 *   one transaction with the cluster_summaries ledger row.
 * - llm disabled/missing => degraded OK with zero writes.
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import {
  consolidateBounds,
  episodesBounds,
  maintenanceTimeoutMs,
  requirePrivacyEnabled,
} from "./config.js";
import {
  acquireCultivationLease,
  isCultivationLeaseHeldBy,
  releaseCultivationLease,
} from "./cultivation.js";
import {
  buildEpisodeCitedReducePrompt,
  buildEpisodeClaimPrompt,
  EPISODE_FOLD_MAX,
  missingAnchorTokens,
  parseCitedSentences,
  parseEpisodeYes,
  promptLanguageFor,
  stripSummaryCue,
} from "./episodes.js";
import {
  generateCompletion,
  llmEnabled,
  llmMaxPromptChars,
  llmTimeoutMs,
  modelFilesPresent,
  parseSummaryBody,
  resolveLlmDir,
} from "./llm.js";
import { countCp, hasControl, normalizeBody, requestHashFor } from "./normalize.js";
import { deriveConsolidationPrivacy } from "./privacy.js";
import { applyResponseBudget, fail, ok, type ResponseEnvelope } from "./protocol.js";
import { clipTextToNormalizedCp } from "./split.js";
import {
  sourceRefFromColumns,
  sourceRefKey,
  type SourceRef,
} from "./sourceref.js";
import {
  correctRecord,
  getClusterSummary,
  getConsolidateCursor,
  isScopeAuthorized,
  rememberRecord,
  setConsolidateCursor,
  upsertClusterSummary,
  type CanonicalWriteFence,
} from "./store.js";

export const CONSOLIDATE_OP = "maintain.consolidate";
/** Provenance source for cluster summaries (contains "derived"). */
export const CLUSTER_SUMMARY_SOURCE = "cultivation:llm-derived-cluster";

export interface ConsolidateGenerate {
  (prompt: string, maxNewTokens: number): Promise<string | null>;
}

export interface ConsolidateParams {
  scope: string;
  limit: number;
}

type ClusterOutcome = "written" | "unchanged" | "no_grounded_sentences" | "deferred";

interface ClusterResult {
  topic: string;
  members: number;
  sentencesKept: number;
  sentencesDropped: number;
  recordId: string | null;
  outcome: ClusterOutcome;
}

interface ClusterMember {
  id: string;
  body: string;
  bodyHash: string;
  createdAt: string;
  observedAt: string;
  privacySensitivity: string | null;
}

interface StoredOp {
  op: string;
  requestHash: string;
  responseJson: string;
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

/** Strict maintain.consolidate params (sync, no I/O). */
export function parseConsolidateParams(
  config: AppConfig,
  params: Record<string, unknown>,
): { ok: true; value: ConsolidateParams } | { ok: false; res: ResponseEnvelope } {
  const allowed = new Set(["scope", "limit"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: budgeted(bad(), config) };
  }
  const scope = parseScope(params["scope"]);
  if (!scope) return { ok: false, res: budgeted(bad(), config) };
  const bounds = consolidateBounds(config);
  let limit = bounds.batchMax;
  if (params["limit"] !== undefined) {
    const v = params["limit"];
    if (typeof v !== "number" || !Number.isInteger(v) || v < 1) {
      return { ok: false, res: budgeted(bad(), config) };
    }
    if (v > bounds.batchMax) return { ok: false, res: budgeted(fail("LIMIT_EXCEEDED"), config) };
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

function readOperation(db: DatabaseSync, key: string): StoredOp | null {
  const row = db
    .prepare(`SELECT op, requestHash, responseJson FROM operations WHERE idempotencyKey = ?`)
    .get(key) as StoredOp | undefined;
  return row ?? null;
}

function storeConsolidateResult(
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
    ).run(key, CONSOLIDATE_OP, reqHash, JSON.stringify(stored), now);
    db.prepare(
      `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
       VALUES (?, ?, NULL, ?, ?, ?, ?, NULL, NULL, NULL)`,
    ).run(
      now,
      CONSOLIDATE_OP,
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
    if (again && again.op === CONSOLIDATE_OP && again.requestHash === reqHash) {
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

function shaHex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

/* ------------------------------------------------------------------ */
/* Cluster selection                                                   */
/* ------------------------------------------------------------------ */

/**
 * Topics with at least minMembers active member records. Membership requires
 * a current record_topics row (bodyHash still matches the canonical body) and
 * excludes summaries produced by this op, so a cluster summary can never
 * recursively feed its own cluster.
 */
function listClusterTopics(
  db: DatabaseSync,
  scope: string,
  minMembers: number,
): string[] {
  const rows = db
    .prepare(
      `SELECT t.topic AS topic
       FROM record_topics t
       JOIN records r ON r.id = t.recordId
       WHERE r.scope = ? AND r.status = 'active'
         AND t.bodyHash = r.bodyHash
         AND r.source <> ?
       GROUP BY t.topic
       HAVING COUNT(*) >= ?
       ORDER BY t.topic ASC`,
    )
    .all(scope, CLUSTER_SUMMARY_SOURCE, minMembers) as Array<{ topic: string }>;
  return rows.map((r) => r.topic);
}

/** Active members of one topic in fold order (createdAt ASC, id ASC). */
function loadClusterMembers(
  db: DatabaseSync,
  scope: string,
  topic: string,
): ClusterMember[] {
  return db
    .prepare(
      `SELECT r.id AS id, r.body AS body, r.bodyHash AS bodyHash,
              r.createdAt AS createdAt, r.observedAt AS observedAt,
              r.privacySensitivity AS privacySensitivity
       FROM record_topics t
       JOIN records r ON r.id = t.recordId
       WHERE r.scope = ? AND t.topic = ? AND r.status = 'active'
         AND t.bodyHash = r.bodyHash
         AND r.source <> ?
       ORDER BY r.createdAt ASC, r.id ASC`,
    )
    .all(scope, topic, CLUSTER_SUMMARY_SOURCE) as unknown as ClusterMember[];
}

function memberFingerprint(members: ClusterMember[]): string {
  const sorted = [...members]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((m) => [m.id, m.bodyHash]);
  return shaHex(JSON.stringify(sorted));
}

function memberSourceRefs(db: DatabaseSync, recordId: string): SourceRef[] {
  const rows = db
    .prepare(
      `SELECT eventId, spanStart, spanEnd FROM record_source_refs
       WHERE recordId = ?
       ORDER BY eventId ASC, spanStart ASC NULLS FIRST, spanEnd ASC NULLS FIRST`,
    )
    .all(recordId) as Array<{
    eventId: string;
    spanStart: number | null;
    spanEnd: number | null;
  }>;
  return rows.map((r) => sourceRefFromColumns(r.eventId, r.spanStart, r.spanEnd));
}

/** Bound tags like maintain.episodes: keep priority order, never over-budget. */
function boundTags(tags: string[], max: number): string[] {
  return tags.slice(0, Math.max(0, max));
}

function fencedWrite(
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

/** Bounded supersedes walk: the ledger may point at a user-corrected revision. */
const MAX_SUPERSEDES_WALK = 32;

/**
 * Resolve the ledger's record id to the currently active revision. A user can
 * correct a generated summary through record.correct, which supersedes the
 * ledger's row and creates a new active revision; consolidation must follow
 * that chain (bounded) so it supersedes the corrected summary instead of
 * creating a duplicate. Returns null when the ledger has no usable active
 * revision (retired/archived/missing/cyclic).
 */
function activeClusterRecord(
  db: DatabaseSync,
  scope: string,
  topic: string,
): string | null {
  const row = getClusterSummary(db, scope, topic);
  if (!row) return null;
  const seen = new Set<string>();
  let current = row.recordId;
  for (let i = 0; i < MAX_SUPERSEDES_WALK; i++) {
    if (seen.has(current)) return null;
    seen.add(current);
    const rec = db
      .prepare(`SELECT id, status FROM records WHERE id = ? AND scope = ?`)
      .get(current, scope) as { id: string; status: string } | undefined;
    if (!rec) return null;
    if (rec.status === "active") return rec.id;
    if (rec.status !== "superseded") return null;
    const next = db
      .prepare(
        `SELECT id FROM records
         WHERE supersedes = ? AND scope = ? AND status IN ('active','superseded')
         ORDER BY revision DESC, id ASC LIMIT 1`,
      )
      .get(current, scope) as { id: string } | undefined;
    if (!next) return null;
    current = next.id;
  }
  return null;
}

/**
 * Rotate the alphabetically ordered topic list so a bounded pass starts just
 * after the last attempted topic. Deterministic, wraps once, and does not
 * remove any topic.
 */
function rotateTopics(topics: string[], after: string | null): string[] {
  if (after === null || topics.length < 2) return topics;
  const idx = topics.findIndex((t) => t > after);
  if (idx < 0) return topics;
  return topics.slice(idx).concat(topics.slice(0, idx));
}

/* ------------------------------------------------------------------ */
/* main                                                                */
/* ------------------------------------------------------------------ */

/**
 * Run one bounded maintain.consolidate pass. Idempotent per caller key: same
 * key + same params replays the stored envelope; changed params => CONFLICT.
 * Lease contention => transient CONFLICT (never stored).
 */
export async function maintainConsolidate(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
  params: Record<string, unknown>,
  idempotencyKey: string,
  generateOverride?: ConsolidateGenerate,
  nowOverride?: string,
): Promise<ResponseEnvelope> {
  const parsed = parseConsolidateParams(config, params);
  if (!parsed.ok) return parsed.res;
  const p = parsed.value;
  const reqHash = requestHashFor(CONSOLIDATE_OP, {
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
    if (saved.op !== CONSOLIDATE_OP) return budgeted(conflict(), config);
    const denied = scopeGate(db, config, p.scope);
    if (denied) return denied;
    if (saved.requestHash !== reqHash) return budgeted(conflict(), config);
    try {
      return budgeted(
        { ...(JSON.parse(saved.responseJson) as ResponseEnvelope), deduplicated: true },
        config,
      );
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

  // Shared with maintain.distill / episodes / associate: they never overlap.
  const execOwner = `${idempotencyKey}#${randomBytes(8).toString("hex")}`;
  const lease = acquireCultivationLease(db, config, {
    owner: execOwner,
    scope: p.scope,
    now: nowValid,
  });
  if (!lease.acquired) return budgeted(conflict(), config);

  try {
    const modelDir = resolveLlmDir(config, configPath);
    const modelUsable = llmEnabled(config) && modelFilesPresent(modelDir);
    const usable =
      modelUsable || (generateOverride !== undefined && config.llm === undefined);
    if (!usable) {
      const stored = budgeted(ok({ clusters: [], applied: 0, degraded: true }), config);
      try {
        storeConsolidateResult(db, config, idempotencyKey, reqHash, stored, p.scope, nowValid, 0);
      } catch (e) {
        return handleStoreRace(db, config, idempotencyKey, reqHash, e);
      }
      return stored;
    }

    const bounds = consolidateBounds(config);
    const maxPromptChars = llmMaxPromptChars(config);
    const timeoutMs = llmTimeoutMs(config);
    const maxNewTokens = episodesBounds(config).maxNewTokens;
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
    const generate: ConsolidateGenerate =
      generateOverride ??
      ((prompt, tokens) =>
        generateCompletion(prompt, modelDir, { timeoutMs, maxNewTokens: tokens }));

    let topics: string[];
    try {
      topics = listClusterTopics(db, p.scope, bounds.minMembers);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }

    let cursor: string | null = null;
    try {
      cursor = getConsolidateCursor(db, p.scope);
    } catch {
      return budgeted(fail("STORE_UNAVAILABLE"), config);
    }
    topics = rotateTopics(topics, cursor);

    const results: ClusterResult[] = [];
    let applied = 0;
    let processed = 0;
    let unchangedReported = 0;

    for (const topic of topics) {
      if (processed >= p.limit) break;

      let members: ClusterMember[];
      try {
        members = loadClusterMembers(db, p.scope, topic);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (members.length < bounds.minMembers) continue;
      const fingerprint = memberFingerprint(members);

      let storedLedger: ReturnType<typeof getClusterSummary> = null;
      try {
        storedLedger = getClusterSummary(db, p.scope, topic);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
      if (storedLedger !== null && storedLedger.memberFingerprint === fingerprint) {
        // Unchanged cluster: no model calls and no canonical writes. Report
        // it (bounded) so callers can distinguish "nothing to do" from a
        // fully empty scope, but never consume the changed-cluster budget.
        if (unchangedReported < p.limit) {
          unchangedReported++;
          results.push({
            topic,
            members: members.length,
            sentencesKept: 0,
            sentencesDropped: 0,
            recordId: storedLedger.recordId,
            outcome: "unchanged",
          });
        }
        continue;
      }

      processed++;
      // Rotation progress is derived and bounded: record the attempted topic
      // before inference so a permanently rejected or deferred cluster cannot
      // monopolise every small-limit run.
      try {
        setConsolidateCursor(db, p.scope, topic, nowValid);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }

      let sentencesKept = 0;
      let sentencesDropped = 0;
      const kept: Array<{ text: string; memberIds: string[] }> = [];
      let deferred = false;
      let aborted = false;

      for (let start = 0; start < members.length; start += EPISODE_FOLD_MAX) {
        const group = members.slice(start, start + EPISODE_FOLD_MAX);
        const state = renewOrAbort();
        if (state !== "ok") {
          aborted = true;
          break;
        }
        const sourceText = group.map((m) => m.body).join("\n");
        let rawMerge: string | null = null;
        try {
          rawMerge = await generate(
            buildEpisodeCitedReducePrompt(
              group.map((m) => m.body),
              maxPromptChars,
              sourceText,
            ),
            maxNewTokens,
          );
        } catch {
          rawMerge = null;
        }
        if (rawMerge === null) {
          // Transient generation failure: defer the whole cluster (no write).
          deferred = true;
          break;
        }
        if (promptLanguageFor(sourceText) === "cjk") {
          rawMerge = stripSummaryCue(rawMerge);
        }
        const mergeBody = parseSummaryBody(rawMerge, config.limits.bodyMaxCp);
        if (mergeBody === null) {
          // Unparseable model output: this fold contributes no grounded text.
          continue;
        }

        const parsedSentences = parseCitedSentences(mergeBody, group.length);
        sentencesDropped += parsedSentences.dropped;
        for (const sentence of parsedSentences.sentences) {
          const cited = sentence.citations.map((i) => group[i - 1]!);
          const citedBodies = cited.map((m) => m.body).join("\n");
          if (missingAnchorTokens(sentence.text, citedBodies).length > 0) {
            sentencesDropped++;
            continue;
          }
          const claimState = renewOrAbort();
          if (claimState !== "ok") {
            aborted = true;
            break;
          }
          const claimPrompt = buildEpisodeClaimPrompt(
            citedBodies,
            sentence.text,
            maxPromptChars,
          );
          if (claimPrompt === null) {
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
            // Transient verification failure: defer, never treat as a
            // content rejection.
            deferred = true;
            break;
          }
          if (!parseEpisodeYes(rawVerify)) {
            sentencesDropped++;
            continue;
          }
          kept.push({
            text: sentence.text,
            memberIds: cited.map((m) => m.id),
          });
        }
        if (deferred || aborted) break;
      }

      if (aborted) {
        return budgeted(overDeadline() ? fail("TIMEOUT") : conflict(), config);
      }
      if (deferred) {
        results.push({
          topic,
          members: members.length,
          sentencesKept: 0,
          sentencesDropped,
          recordId: null,
          outcome: "deferred",
        });
        continue;
      }

      // Budget the joined body in BOTH raw and normalized code points.
      const bodyMaxCp = config.limits.bodyMaxCp;
      const parts: string[] = [];
      const budgets = { raw: 0, norm: 0 };
      const citedMemberIds: string[] = [];
      const citedSeen = new Set<string>();
      for (const k of kept) {
        const text = clipTextToNormalizedCp(k.text, bodyMaxCp);
        const sep = parts.length === 0 ? 0 : 1;
        const rawCp = countCp(text);
        const normCp = countCp(normalizeBody(text));
        if (budgets.raw + sep + rawCp > bodyMaxCp || budgets.norm + sep + normCp > bodyMaxCp) {
          sentencesDropped += kept.length - sentencesKept;
          break;
        }
        parts.push(text);
        budgets.raw += sep + rawCp;
        budgets.norm += sep + normCp;
        sentencesKept++;
        for (const id of k.memberIds) {
          if (!citedSeen.has(id)) {
            citedSeen.add(id);
            citedMemberIds.push(id);
          }
        }
      }
      const finalSummary = parts.join(" ");
      if (sentencesKept === 0 || finalSummary.length === 0) {
        results.push({
          topic,
          members: members.length,
          sentencesKept: 0,
          sentencesDropped,
          recordId: null,
          outcome: "no_grounded_sentences",
        });
        continue;
      }

      const citedMembers = members.filter((m) => citedSeen.has(m.id));
      const privacy = deriveConsolidationPrivacy(
        citedMembers.map((m) => m.privacySensitivity),
      );
      if (requirePrivacyEnabled(config) && privacy === null) {
        results.push({
          topic,
          members: members.length,
          sentencesKept,
          sentencesDropped,
          recordId: null,
          outcome: "deferred",
        });
        continue;
      }

      // Links = cited member ids (first citation order), bounded.
      const links = citedMemberIds.slice(0, Math.max(0, config.limits.linksMax));
      // sourceRefs = union of cited members' sourceRefs, spans preserved.
      const refs: SourceRef[] = [];
      const refKeys = new Set<string>();
      for (const m of citedMembers) {
        let memberRefs: SourceRef[];
        try {
          memberRefs = memberSourceRefs(db, m.id);
        } catch {
          return budgeted(fail("STORE_UNAVAILABLE"), config);
        }
        for (const ref of memberRefs) {
          if (refs.length >= config.limits.sourceRefsMax) break;
          const key = sourceRefKey(ref);
          if (refKeys.has(key)) continue;
          refKeys.add(key);
          refs.push(ref);
        }
        if (refs.length >= config.limits.sourceRefsMax) break;
      }

      const observedAt = members.reduce(
        (max, m) => (m.observedAt > max ? m.observedAt : max),
        members[0]!.observedAt,
      );
      const provenance = { source: CLUSTER_SUMMARY_SOURCE, observedAt };
      const privacyParam = privacy !== null ? { privacy } : {};
      const generationKey = shaHex(
        [p.scope, topic, fingerprint, finalSummary].join("\u0000"),
      ).slice(0, 48);
      const ledgerRow = (recordId: string) => ({
        scope: p.scope,
        topic,
        recordId,
        memberFingerprint: fingerprint,
        createdAt: nowValid,
      });
      const writeLedger = (txDb: DatabaseSync, recordId: string): void => {
        upsertClusterSummary(txDb, ledgerRow(recordId));
      };

      // Membership can change while inference is in flight (ordinary record
      // writes do not take the cultivation lease). Re-check inside the
      // canonical transaction; on any change write nothing and defer.
      let stale = false;
      const revalidateMembership = (txDb: DatabaseSync): void => {
        let current: ClusterMember[];
        try {
          current = loadClusterMembers(txDb, p.scope, topic);
        } catch {
          stale = true;
          throw new Error("cluster changed");
        }
        if (
          current.length < bounds.minMembers ||
          memberFingerprint(current) !== fingerprint
        ) {
          stale = true;
          throw new Error("cluster changed");
        }
      };

      const prior = activeClusterRecord(db, p.scope, topic);
      let newRecordId: string | null = null;
      if (prior !== null) {
        const correctKey = `clsc-${shaHex(
          [generationKey, prior].join("\u0000"),
        ).slice(0, 48)}`;
        const cr = correctRecord(
          db,
          config,
          {
            recordId: prior,
            body: finalSummary,
            kind: "correction",
            provenance,
            scope: p.scope,
            links,
            sourceRefs: refs,
            ...privacyParam,
          },
          correctKey,
          nowValid,
          {
            owner: execOwner,
            now: renewNow(),
            beforeWrite: revalidateMembership,
            afterInsert: (txDb, recordId) => writeLedger(txDb, recordId),
          },
        );
        if (cr.ok) {
          newRecordId =
            ((cr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
            null;
          if (newRecordId !== null && cr.deduplicated) {
            const okLedger = fencedWrite(
              db,
              { owner: execOwner, now: renewNow() },
              (txDb) => writeLedger(txDb, newRecordId as string),
            );
            if (!okLedger) return budgeted(conflict(), config);
          }
        } else if (!stale && !isCultivationLeaseHeldBy(db, execOwner, renewNow())) {
          return budgeted(conflict(), config);
        }
      } else {
        const rememberKey = `cls-${generationKey}`;
        const rr = rememberRecord(
          db,
          config,
          {
            body: finalSummary,
            kind: "summary",
            provenance,
            scope: p.scope,
            tags: boundTags([topic], config.limits.tagsMax),
            links,
            sourceRefs: refs,
            ...privacyParam,
          },
          rememberKey,
          nowValid,
          {
            owner: execOwner,
            now: renewNow(),
            beforeWrite: revalidateMembership,
            afterInsert: (txDb, recordId) => writeLedger(txDb, recordId),
          },
        );
        if (rr.ok) {
          newRecordId =
            ((rr.data as { record?: { id?: unknown } } | null)?.record?.id as string | undefined) ??
            null;
          if (newRecordId !== null && rr.deduplicated) {
            const okLedger = fencedWrite(
              db,
              { owner: execOwner, now: renewNow() },
              (txDb) => writeLedger(txDb, newRecordId as string),
            );
            if (!okLedger) return budgeted(conflict(), config);
          }
        } else if (!stale && !isCultivationLeaseHeldBy(db, execOwner, renewNow())) {
          return budgeted(conflict(), config);
        }
      }

      if (newRecordId === null) {
        results.push({
          topic,
          members: members.length,
          sentencesKept,
          sentencesDropped,
          recordId: null,
          outcome: "deferred",
        });
        continue;
      }

      applied++;
      results.push({
        topic,
        members: members.length,
        sentencesKept,
        sentencesDropped,
        recordId: newRecordId,
        outcome: "written",
      });

      if (overDeadline()) {
        return budgeted(fail("TIMEOUT"), config);
      }
    }

    const stored = budgeted(
      ok({ clusters: results, applied, degraded: false }),
      config,
    );
    try {
      storeConsolidateResult(db, config, idempotencyKey, reqHash, stored, p.scope, nowValid, p.limit);
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
