/**
 * M3 maintain.distill: bounded single-flight LLM cultivation drain.
 *
 * Built ONLY on the M3 state-core primitives (src/cultivation.ts):
 * acquireCultivationLease -> dequeueCultivationBatch -> applyCultivationBatch
 * -> completeCultivationReview -> releaseCultivationLease. No architecture is
 * reimplemented here; this module only supplies real offline model decisions
 * and the idempotent op envelope around them.
 *
 * Hard rules (plan §7 + retention safeguards):
 * - All model inference runs OUTSIDE canonical transactions. Lease/dequeue,
 *   apply, and settle are short separate transactions; no transaction spans
 *   an inference call.
 * - Model context is same-scope, bounded, and untrusted: at most 6 active
 *   same-scope peer snippets, clipped to fit llm.maxPromptChars. Bodies are
 *   never executed, never echoed into audit/errors.
 * - Two-stage model judgment (probe-grounded, see src/llm.ts): the pinned q4
 *   model cannot answer bare single-token verdicts reliably (always echoes
 *   one biased token regardless of content) and mangles copied record ids,
 *   so each review runs (1) a generation-style retire gate (model states the
 *   lasting content it sees, or NONE; strict-NONE becomes a retire candidate,
 *   anything else continues; uncertain keeps), then (2) a positional
 *   merge/keep choice (peers shown as numbers 1..N, model replies MERGE <n>
 *   or KEEP; code maps the position to the actual same-scope bounded peer
 *   shown there — the model never names ids), then (3) a shared-fact
 *   confirmation for any proposed merge (model states the shared fact or
 *   NONE; NONE or uncertain keeps, only a stated shared fact proceeds to
 *   summary drafting). A MERGE position survives only under mutual
 *   agreement: the chosen peer, when itself under review in the same batch,
 *   must propose straight back (one-sided positional-bias picks become
 *   audited keeps), and at least 2 peers must have been shown. Reciprocal
 *   survivors sharing one unordered source pair consolidate exactly once
 *   (deterministic smallest-recordId representative; the twin becomes an
 *   audited keep). Gate/confirmation
 *   extractions are discarded, never stored or reused.
 * - Code validates every model claim: verdicts parse to exactly one of
 *   RETIRE / MERGE <id> / KEEP (else keep); MERGE targets must exist,
 *   same-scope, active, and differ from self; summaries must be bounded
 *   non-empty text; sourceRefs stay the union the model... no: sourceRefs
 *   are re-resolved by code from the merged records (model never names raw
 *   ids); links must resolve to existing same-scope records.
 * - Uncertain / invalid / stale / error / missing / timed-out model output
 *   NEVER changes record state or body: uncertain/invalid parses become
 *   audited keep (no-change); inference failures mark the review failed for
 *   bounded retry (no apply at all); stale apply results are per-action
 *   no-change via applyCultivationBatch.
 * - No deletes, no TTL, no age-only retirement anywhere. Consolidation only
 *   INSERTs summary rows; sources are never auto-retired.
 * - No model (disabled section or missing files) => degraded OK with zero
 *   applies and zero review changes (no fake decisions, no heuristics).
 * - Single-flight: the global m3 lease is held for the whole drain; a live
 *   lease owned by another run => CONFLICT (transient, never stored, so the
 *   same key can be retried later).
 */
import { createHash, randomBytes } from "node:crypto";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { cultivationBounds, maintenanceTimeoutMs } from "./config.js";
import {
  canonicalSourceRefs,
  sourceRefKey,
  sourceRefFromColumns,
  type SourceRef,
} from "./sourceref.js";
import {
  RETIRE_REASONS,
  acquireCultivationLease,
  applyCultivationBatch,
  completeCultivationReview,
  dequeueCultivationBatch,
  encodeCultivationCursor,
  releaseCultivationLease,
  type CultivationAction,
  type CultivationReview,
} from "./cultivation.js";
import {
  activeModelLabel,
  buildConfirmPrompt,
  buildMergePrompt,
  buildRetireGatePrompt,
  buildSummaryPrompt,
  generateCompletion,
  llmUsable,
  llmMaxNewTokens,
  llmMaxPromptChars,
  llmTimeoutMs,
  parseMergeChoice,
  parseRetireGate,
  parseSummaryBody,
  resolveLlmDir,
} from "./llm.js";
import { countCp, hasControl, requestHashFor } from "./normalize.js";
import { applyResponseBudget, fail, ok, type ResponseEnvelope } from "./protocol.js";
import { isScopeAuthorized } from "./store.js";

export const DISTILL_OP = "maintain.distill";
/** Model-driven retire always files this fixed reason (transient/low-signal). */
export const DISTILL_RETIRE_REASON = "LOW_SIGNAL" as (typeof RETIRE_REASONS)[number];
/** Provenance source stamped on model-drafted summaries (contains "derived" for empty-ref rules). */
export const DISTILL_SUMMARY_SOURCE = "cultivation:llm-derived";
/** Bounded peer context per review (same-scope active snippets, untrusted). */
export const DISTILL_PEER_MAX = 6;

export interface DistillParams {
  scope: string;
  cursor: string | null;
  limit: number;
  runId: string | null;
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

function parseRunId(runId: unknown): string | null | "invalid" {
  if (runId === undefined || runId === null) return null;
  if (typeof runId !== "string") return "invalid";
  if (countCp(runId) < 1 || countCp(runId) > 256 || hasControl(runId)) return "invalid";
  return runId;
}

/**
 * Validate maintain.distill params (sync, no I/O). cursor is an opaque
 * resume marker (1..256 chars, no control); limit defaults to the
 * cultivation batchMax and is capped there (above => LIMIT_EXCEEDED).
 */
export function parseDistillParams(
  config: AppConfig,
  params: Record<string, unknown>,
): { ok: true; value: DistillParams } | { ok: false; res: ResponseEnvelope } {
  const allowed = new Set(["scope", "cursor", "limit", "runId"]);
  for (const k of Object.keys(params)) {
    if (!allowed.has(k)) return { ok: false, res: budgeted(bad(), config) };
  }
  const nScope = parseScope(params["scope"]);
  if (!nScope) return { ok: false, res: budgeted(bad(), config) };
  const nRunId = parseRunId(params["runId"]);
  if (nRunId === "invalid") return { ok: false, res: budgeted(bad(), config) };
  let nCursor: string | null = null;
  const cursor = params["cursor"];
  if (cursor !== undefined && cursor !== null) {
    if (typeof cursor !== "string") return { ok: false, res: budgeted(bad(), config) };
    if (countCp(cursor) < 1 || countCp(cursor) > 256 || hasControl(cursor)) {
      return { ok: false, res: budgeted(bad(), config) };
    }
    nCursor = cursor;
  }
  const bounds = cultivationBounds(config);
  let nLimit = bounds.batchMax;
  if (params["limit"] !== undefined) {
    const limit = params["limit"];
    if (typeof limit !== "number" || !Number.isInteger(limit)) {
      return { ok: false, res: budgeted(bad(), config) };
    }
    if (limit < 1) return { ok: false, res: budgeted(bad(), config) };
    if (limit > bounds.batchMax) return { ok: false, res: budgeted(fail("LIMIT_EXCEEDED"), config) };
    nLimit = limit;
  }
  return { ok: true, value: { scope: nScope, cursor: nCursor, limit: nLimit, runId: nRunId } };
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

function storeDistillResult(
  db: DatabaseSync,
  config: AppConfig,
  key: string,
  reqHash: string,
  stored: ResponseEnvelope,
  scope: string,
  runId: string | null,
  now: string,
  limitN: number | null,
): void {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.prepare(
      `INSERT INTO operations(idempotencyKey, op, requestHash, responseJson, createdAt) VALUES (?, ?, ?, ?, ?)`,
    ).run(key, DISTILL_OP, reqHash, JSON.stringify(stored), now);
    db.prepare(
      `INSERT INTO audit(ts, op, targetId, code, scope, bytes, limitN, runId, recallId, reasonCode)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, NULL, NULL)`,
    ).run(now, DISTILL_OP, stored.code, scope, Buffer.byteLength(JSON.stringify(stored), "utf8"), limitN, runId);
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

interface RecordRow {
  id: string;
  body: string;
  scope: string;
  status: string;
  revision: number;
}

function loadRecord(db: DatabaseSync, id: string): RecordRow | null {
  try {
    const row = db
      .prepare(`SELECT id, body, scope, status, revision FROM records WHERE id = ?`)
      .get(id) as RecordRow | undefined;
    return row ?? null;
  } catch {
    return null;
  }
}

function loadPeers(db: DatabaseSync, scope: string, selfId: string): Array<{ id: string; body: string }> {
  try {
    return db
      .prepare(
        `SELECT id, body FROM records WHERE scope = ? AND status = 'active' AND id != ?
         ORDER BY createdAt DESC, id ASC LIMIT ?`,
      )
      .all(scope, selfId, DISTILL_PEER_MAX) as Array<{ id: string; body: string }>;
  } catch {
    return [];
  }
}

/**
 * Load refs with span provenance intact. Legacy rows (both span columns NULL)
 * come back as plain eventId strings, so all-string unions keep hashing and
 * storing exactly as before.
 */
function loadSourceRefs(db: DatabaseSync, recordId: string): SourceRef[] {
  try {
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
  } catch {
    return [];
  }
}

function loadTags(db: DatabaseSync, recordId: string, tagsMax: number): string[] {
  try {
    const rows = db
      .prepare(`SELECT tag FROM record_tags WHERE recordId = ? ORDER BY tag ASC LIMIT ?`)
      .all(recordId, Math.max(1, tagsMax)) as Array<{ tag: string }>;
    return rows.map((r) => r.tag);
  } catch {
    return [];
  }
}

function shaHex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex");
}

export interface DistillDecide {
  (prompt: string, maxNewTokens: number): Promise<string | null>;
}

interface PlannedItem {
  review: CultivationReview;
  /**
   * No action + retry=true => inference failure: mark failed (bounded retry),
   * apply nothing. No action + retry=false => poison/done: settle done so a
   * stale queue entry can never wedge the drain.
   */
  action: CultivationAction | null;
  retry: boolean;
}

/**
 * Run one bounded maintain.distill drain. Idempotent per caller key: same
 * key + same params replays the stored envelope; changed params => CONFLICT.
 * Lease contention => transient CONFLICT (never stored).
 */
export async function maintainDistill(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
  params: Record<string, unknown>,
  idempotencyKey: string,
  decideOverride?: DistillDecide,
  nowOverride?: string,
): Promise<ResponseEnvelope> {
  const parsed = parseDistillParams(config, params);
  if (!parsed.ok) return parsed.res;
  const p = parsed.value;
  const reqHash = requestHashFor(DISTILL_OP, {
    cursor: p.cursor,
    limit: p.limit,
    runId: p.runId,
    scope: p.scope,
  });

  let saved: StoredOp | null = null;
  try {
    saved = readOperation(db, idempotencyKey);
  } catch {
    return budgeted(fail("STORE_UNAVAILABLE"), config);
  }
  if (saved) {
    if (saved.op !== DISTILL_OP) return budgeted(conflict(), config);
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
  const nowValid = (nowOverride ?? new Date().toISOString()) as string;
  if (!Number.isFinite(Date.parse(nowValid))) return budgeted(fail("STORE_UNAVAILABLE"), config);

  // Single-flight across processes: one holder at a time. The lease owner is
  // unique per execution (caller key + nonce), never the bare caller key: two
  // concurrent drains under the same idempotencyKey hold different owners, so
  // the second is refused CONFLICT instead of both draining before either
  // stores its operations row (singleflight + duplicate consolidation).
  const execOwner = `${idempotencyKey}#${randomBytes(8).toString("hex")}`;
  // Thread nowValid (the drain's clock: nowOverride in tests, wall clock in
  // production) through the lease/dequeue/fence path so liveness checks share
  // one clock. Wall-clock acquire here would see a test-fixed lease as
  // expired (or vice versa) and break single-flight fencing.
  const lease = acquireCultivationLease(db, config, { owner: execOwner, scope: p.scope, now: nowValid });
  if (!lease.acquired) return budgeted(conflict(), config);

  let batchId: string | null = null;
  let items: CultivationReview[] = [];
  try {
    // Degraded path first: no model => no dequeue, no state change. Reviews
    // stay pending for a future provisioned run; the lease is released below.
    // (Dequeueing before this check leased rows that were never settled.)
    const modelDir = resolveLlmDir(config, configPath);
    const usable = llmUsable(config, modelDir);
    const modelLabel = activeModelLabel(config);
    if (!usable) {
      const stored = budgeted(
        ok({ distill: { applied: 0, reviewed: 0, failed: 0, batchId: null, nextCursor: p.cursor, degraded: true, reason: "model unavailable", ...modelLabel } }),
        config,
      );
      try {
        storeDistillResult(db, config, idempotencyKey, reqHash, stored, p.scope, p.runId, nowValid, 0);
      } catch (e) {
        return handleStoreRace(db, config, idempotencyKey, reqHash, e);
      }
      return stored;
    }

    const batch = dequeueCultivationBatch(db, config, {
      owner: execOwner,
      scope: p.scope,
      limit: p.limit,
      cursor: p.cursor,
      now: nowValid,
    });
    batchId = batch.batchId;
    items = batch.items;
    if (items.length === 0) {
      const stored = budgeted(
        ok({ distill: { applied: 0, reviewed: 0, failed: 0, batchId: null, nextCursor: p.cursor, degraded: false, ...modelLabel } }),
        config,
      );
      try {
        storeDistillResult(db, config, idempotencyKey, reqHash, stored, p.scope, p.runId, nowValid, 0);
      } catch (e) {
        return handleStoreRace(db, config, idempotencyKey, reqHash, e);
      }
      return stored;
    }

    // --- Inference phase (NO transaction held): one bounded call per review.
    // The lease is renewed between model calls (same-owner heartbeat) and the
    // whole drain is bounded by maintenance.timeoutMs: multi-generation
    // batches can outlive one lease TTL, but a stolen/expired lease or an
    // overrun deadline aborts before any commit (fenced, nothing applied).
    const timeoutMs = llmTimeoutMs(config);
    const maxNewTokens = llmMaxNewTokens(config);
    const maxPromptChars = llmMaxPromptChars(config);
    const maintenanceMs = maintenanceTimeoutMs(config);
    const startedMs = Date.now();
    const overDeadline = (): boolean => Date.now() - startedMs > maintenanceMs;
    // Renewal clock: production heartbeats use a fresh wall-clock timestamp
    // per renewal so a multi-generation drain keeps extending the lease; the
    // fixed drain clock is used only when the caller passed an explicit
    // nowOverride (deterministic tests).
    const testClock = nowOverride !== undefined;
    const renewNow = (): string => (testClock ? nowValid : new Date().toISOString());
    const renewOrAbort = (): boolean => {
      if (overDeadline()) return false;
      const r = acquireCultivationLease(db, config, { owner: execOwner, scope: p.scope, now: renewNow() });
      return r.acquired;
    };
    // Inference-failure latch: the LLM runtime cannot cancel an unexpired
    // load/generation (Promise.race only rejects the wrapper), so after the
    // first timed-out/failed inference this drain issues NO further model
    // calls — remaining reviews go straight to bounded retry. This aborts the
    // batch's model work instead of accumulating one live inference per
    // subsequent review while an earlier load is still running.
    let inferencePoisoned = false;
    // Ownership-guarded settle for lost-lease paths: only rows still leased
    // under this batch are failed for retry. Rows already reclaimed or
    // re-leased by the stealing owner carry a different (or NULL) batchId and
    // are left for the owner/reclaim path, never reset by this stale run.
    const settleOwned = (queueIds: string[]): void => {
      for (const qid of queueIds) {
        if (batchId) completeCultivationReview(db, config, qid, "failed", nowValid, { batchId });
        else completeCultivationReview(db, config, qid, "failed", nowValid);
      }
    };
    const decide: DistillDecide =
      decideOverride ?? ((prompt) => generateCompletion(prompt, modelDir, { timeoutMs, maxNewTokens, config }));
    const planned: PlannedItem[] = [];
    interface StagedProposal {
      review: CultivationReview;
      target: RecordRow;
      shown: Array<{ id: string; body: string }>;
      otherId: string;
    }
    const staged: StagedProposal[] = [];
    const keepOf = (id: string, rev: number): CultivationAction => ({
      recordId: id, action: "keep", expectedRevision: rev, expectedStatus: "active",
    });
    for (const review of items) {
      // Bounded renewal: heartbeat the lease between model calls and stop the
      // drain before the maintenance deadline. A lost lease or an overrun
      // aborts with nothing applied (owned leased rows go back for bounded
      // retry; rows already taken by a new owner are left alone).
      if (!renewOrAbort()) {
        settleOwned(items.map((it) => it.queueId));
        return budgeted(overDeadline() ? fail("TIMEOUT") : conflict(), config);
      }
      if (inferencePoisoned) {
        // A prior inference in this drain already timed out/failed: issue no
        // further model calls, bounded retry for the rest.
        planned.push({ review, action: null, retry: true });
        continue;
      }
      const target = loadRecord(db, review.recordId);
      if (!target || target.scope !== p.scope) {
        // Stale queue entry (record vanished or rescoped — cannot happen via
        // canonical ops): keep no-change when the row exists, else settle
        // done with no apply so the entry can never wedge the drain.
        planned.push({
          review,
          action: target ? { recordId: target.id, action: "keep", expectedRevision: target.revision } : null,
          retry: false,
        });
        continue;
      }
      if (target.status !== "active") {
        planned.push({ review, action: { recordId: target.id, action: "keep" }, retry: false });
        continue;
      }
      const peers = loadPeers(db, p.scope, target.id);
      // Stage 1 (retention gate): lasting content, or NONE for a pure
      // passing mood. Uncertain/invalid => audited keep, never a mutation.
      let gateRaw: string | null = null;
      try {
        gateRaw = await decide(buildRetireGatePrompt(target.body, maxPromptChars), Math.min(maxNewTokens, 32));
      } catch {
        gateRaw = null;
      }
      if (gateRaw === null) {
        inferencePoisoned = true; // uncancelled inference: stop issuing model calls
        planned.push({ review, action: null, retry: true }); // inference failure => retry, no apply
        if (!renewOrAbort()) {
          settleOwned(items.map((it) => it.queueId));
          return budgeted(overDeadline() ? fail("TIMEOUT") : conflict(), config);
        }
        continue;
      }
      const gate = parseRetireGate(gateRaw);
      if (gate.kind === "uncertain") {
        planned.push({ review, action: keepOf(target.id, target.revision), retry: false });
        continue;
      }
      if (gate.kind === "retire") {
        planned.push({
          review,
          action: { recordId: target.id, action: "retire", reasonCode: DISTILL_RETIRE_REASON, expectedRevision: target.revision, expectedStatus: "active" },
          retry: false,
        });
        continue;
      }
      // Stage 2a (positional merge/keep): at least 2 peers must be shown for
      // a real choice; a single peer cannot demonstrate one. The model names
      // a position, code resolves it to the peer actually shown there.
      if (peers.length < 2) {
        planned.push({ review, action: keepOf(target.id, target.revision), retry: false });
        continue;
      }
      const shown = peers.slice(0, DISTILL_PEER_MAX);
      let choiceRaw: string | null = null;
      try {
        choiceRaw = await decide(buildMergePrompt(target.body, shown, maxPromptChars), Math.min(maxNewTokens, 8));
      } catch {
        choiceRaw = null;
      }
      if (choiceRaw === null) {
        inferencePoisoned = true; // uncancelled inference: stop issuing model calls
        planned.push({ review, action: null, retry: true });
        continue;
      }
      const choice = parseMergeChoice(choiceRaw, shown.length);
      if (choice.kind !== "merge") {
        planned.push({ review, action: keepOf(target.id, target.revision), retry: false });
        continue;
      }
      // Positional mapping is validated against the actual same-scope
      // bounded input shown to the model; out-of-range or stale targets keep.
      const chosenListed = shown[choice.index] ?? null;
      const other = chosenListed ? loadRecord(db, chosenListed.id) : null;
      if (!other || other.scope !== p.scope || other.status !== "active" || other.id === target.id) {
        planned.push({ review, action: keepOf(target.id, target.revision), retry: false });
        continue;
      }
      staged.push({ review, target, shown, otherId: other.id });
    }
    // Mutual-agreement filter (model-driven, code-enforced): a merge
    // proposal survives only when the chosen peer is not under review in
    // this batch, or it proposes straight back at the proposer (both model
    // judgments agree they say the same thing). One-sided picks — the
    // observed positional-bias failure mode — become audited keeps.
    // Crucially, a peer that IS under review in this batch but produced no
    // reciprocal proposal (KEEP, RETIRE, inference failure, or a merge aimed
    // elsewhere) has explicitly declined: its absence from proposalByRecord
    // is not permission, and the one-sided merge becomes an audited keep.
    const proposalByRecord = new Map(staged.map((s) => [s.target.id, s.otherId]));
    const underReview = new Set(items.map((it) => it.recordId));
    const survivors: StagedProposal[] = [];
    for (const s of staged) {
      const back = proposalByRecord.get(s.otherId);
      if (back === s.target.id || (back === undefined && !underReview.has(s.otherId))) {
        survivors.push(s);
      } else {
        planned.push({ review: s.review, action: keepOf(s.target.id, s.target.revision), retry: false });
      }
    }
    // Same-batch reciprocal dedup (code-enforced): mutual proposals (A->B
    // and B->A) share one canonical unordered source set and must
    // consolidate exactly once. Group survivors by sorted pair; the
    // deterministic representative (smallest recordId, queueId tiebreak)
    // drafts the single model-generated summary, the rest become audited
    // keeps so every queue entry still resolves to done with originals kept.
    const byPair = new Map<string, StagedProposal[]>();
    for (const s of survivors) {
      const key = [s.target.id, s.otherId].sort().join("\0");
      const list = byPair.get(key);
      if (list) list.push(s);
      else byPair.set(key, [s]);
    }
    const deduped: StagedProposal[] = [];
    for (const list of byPair.values()) {
      if (list.length === 1) {
        deduped.push(list[0]!);
        continue;
      }
      const ordered = [...list].sort((a, b) =>
        a.target.id < b.target.id ? -1 : a.target.id > b.target.id ? 1
        : a.review.queueId < b.review.queueId ? -1 : a.review.queueId > b.review.queueId ? 1 : 0,
      );
      deduped.push(ordered[0]!);
      for (const extra of ordered.slice(1)) {
        planned.push({ review: extra.review, action: keepOf(extra.target.id, extra.target.revision), retry: false });
      }
    }
    for (const s of deduped) {
      if (!renewOrAbort()) {
        settleOwned(items.map((it) => it.queueId));
        return budgeted(overDeadline() ? fail("TIMEOUT") : conflict(), config);
      }
      if (inferencePoisoned) {
        planned.push({ review: s.review, action: null, retry: true });
        continue;
      }
      const target = s.target;
      const other = loadRecord(db, s.otherId);
      if (!other || other.scope !== p.scope || other.status !== "active" || other.id === target.id) {
        planned.push({ review: s.review, action: keepOf(target.id, target.revision), retry: false });
        continue;
      }
      // Capture the peer's live revision/status with the action so the apply
      // transaction re-validates BOTH sources atomically: a peer corrected,
      // retired, or archived during the confirmation/summary inference below
      // (or before the commit) becomes a CONFLICT no-change there.
      const peerGuard = { recordId: other.id, expectedRevision: other.revision, expectedStatus: "active" as const };
      // Stage 2b (shared-fact confirmation, conservative): the model must
      // state the fact both memories share; NONE/uncertain keeps. This is a
      // second real model judgment, not a heuristic substitute.
      let confirmRaw: string | null = null;
      try {
        confirmRaw = await decide(buildConfirmPrompt(target.body, other.body, maxPromptChars), Math.min(maxNewTokens, 32));
      } catch {
        confirmRaw = null;
      }
      if (confirmRaw === null) {
        inferencePoisoned = true; // uncancelled inference: stop issuing model calls
        planned.push({ review: s.review, action: null, retry: true });
        continue;
      }
      const confirm = parseRetireGate(confirmRaw);
      if (confirm.kind !== "continue") {
        planned.push({ review: s.review, action: keepOf(target.id, target.revision), retry: false });
        continue;
      }
      let summaryRaw: string | null = null;
      try {
        summaryRaw = await decide(buildSummaryPrompt(target.body, other.body, maxPromptChars), maxNewTokens);
      } catch {
        summaryRaw = null;
      }
      const summaryBody = parseSummaryBody(summaryRaw, config.limits.bodyMaxCp);
      if (summaryRaw === null || summaryBody === null) {
        if (summaryRaw === null) {
          inferencePoisoned = true; // uncancelled inference: stop issuing model calls
          planned.push({ review: s.review, action: null, retry: true }); // summary-stage failure => retry
        } else {
          planned.push({ review: s.review, action: keepOf(target.id, target.revision), retry: false });
        }
        continue;
      }
      // Provenance union is conservative: when both sources together carry
      // more distinct source refs than sourceRefsMax, the merge is skipped
      // (audited keep) rather than written with truncated provenance.
      // Union by (eventId,start,end): distinct spans on the same event survive.
      const refByKey = new Map<string, SourceRef>();
      for (const r of [...loadSourceRefs(db, target.id), ...loadSourceRefs(db, other.id)]) {
        refByKey.set(sourceRefKey(r), r);
      }
      const refUnion = canonicalSourceRefs([...refByKey.values()]);
      if (refUnion.length > config.limits.sourceRefsMax) {
        planned.push({ review: s.review, action: keepOf(target.id, target.revision), retry: false });
        continue;
      }
      const refs = refUnion;
      const tags = [...new Set([...loadTags(db, target.id, config.limits.tagsMax), ...loadTags(db, other.id, config.limits.tagsMax)])]
        .sort()
        .slice(0, config.limits.tagsMax);
      planned.push({
        review: s.review,
        action: {
          recordId: target.id,
          action: "consolidate",
          expectedRevision: target.revision,
          expectedStatus: "active",
          peer: peerGuard,
          summary: {
            body: summaryBody,
            provenance: { source: DISTILL_SUMMARY_SOURCE, observedAt: nowValid },
            tags,
            links: [target.id, other.id].sort(),
            sourceRefs: refs,
          },
        },
        retry: false,
      });
    }

    // --- Apply phase: ONE bounded transactional batch of code-validated actions.
    // Fenced: the commit requires the lease to still be held by this execution
    // and each mutating action requires its queue row to still be leased under
    // this batchId, so a review cancelled after dequeue becomes an audited
    // no-change instead of a post-cancel mutation.
    if (!renewOrAbort()) {
      settleOwned(items.map((it) => it.queueId));
      return budgeted(overDeadline() ? fail("TIMEOUT") : conflict(), config);
    }
    const actions = planned.filter((x) => x.action !== null).map((x) => x.action as CultivationAction);
    const guards = items.map((it) => ({ queueId: it.queueId, recordId: it.recordId }));
    let applied = 0;
    const failedIds: string[] = [];
    if (actions.length > 0) {
      const innerKey = `distill-${shaHex(idempotencyKey).slice(0, 32)}`;
      let res = applyCultivationBatch(
        db,
        config,
        { scope: p.scope, runId: p.runId, idempotencyKey: innerKey, actions, fence: { owner: execOwner, batchId: batchId ?? undefined, guards } },
        nowValid,
      );
      if (!res.ok && res.code === "CONFLICT") {
        // Same derived key ran with different (older) decisions, e.g. after
        // a crash between apply and the outer store: retry once with a fresh
        // key so this batch still drains instead of wedging. The retry keeps
        // the same fence so cancelled rows still cannot mutate.
        res = applyCultivationBatch(
          db,
          config,
          { scope: p.scope, runId: p.runId, idempotencyKey: `distill-r-${randomBytes(8).toString("hex")}`, actions, fence: { owner: execOwner, batchId: batchId ?? undefined, guards } },
          nowValid,
        );
      }
      if (res.ok) {
        const results = ((res.data as { cultivation?: { results?: Array<{ recordId: string; applied: boolean; code: string }> } } | null)?.cultivation?.results) ?? [];
        const byId = new Map(results.map((r) => [r.recordId, r]));
        for (const pl of planned) {
          if (pl.action === null) {
            failedIds.push(pl.review.queueId);
            continue;
          }
          const r = byId.get(pl.action.recordId);
          if (r?.applied) applied++;
        }
      } else {
        // Whole-batch failure: isolate it — memory untouched (the single
        // apply transaction rolled back, so nothing was applied). Settle is
        // ownership-guarded: on a fence CONFLICT (lease stolen) the rows may
        // already belong to the new owner's batch, so only rows still leased
        // under this batch go back for bounded retry; the rest stay with the
        // owner/reclaim path. On STORE_UNAVAILABLE with the lease still held
        // the guard matches every owned row (same outcome as before).
        for (const pl of planned) failedIds.push(pl.review.queueId);
        settleOwned(failedIds);
        // res is a failure envelope here (never OK): propagate its fixed code.
        const code = (res.code === "OK" ? "STORE_UNAVAILABLE" : res.code) as Exclude<ResponseEnvelope["code"], "OK">;
        return budgeted(fail(code), config);
      }
    } else {
      for (const pl of planned) failedIds.push(pl.review.queueId);
    }

    // --- Settle phase: done for decided reviews, failed (retry) for inference failures.
    let failed = 0;
    for (const pl of planned) {
      if (pl.action === null && pl.retry) {
        if (completeCultivationReview(db, config, pl.review.queueId, "failed", nowValid)) failed++;
      } else {
        completeCultivationReview(db, config, pl.review.queueId, "done", nowValid);
      }
    }
    // Composite keyset cursor matching dequeue order (nextAt, queueId): the
    // marker is the last dequeued row, so the next page resumes past it with
    // no skip and no repeat. A bare max-queueId marker would skip rows whose
    // nextAt is newer but whose id sorts smaller.
    const last = items.length > 0 ? items[items.length - 1]! : null;
    const nextCursor = last ? encodeCultivationCursor(last.nextAt, last.queueId) : p.cursor;
    const stored = budgeted(
      ok({ distill: { applied, reviewed: items.length, failed, batchId, nextCursor, degraded: false, ...modelLabel } }),
      config,
    );
    try {
      storeDistillResult(db, config, idempotencyKey, reqHash, stored, p.scope, p.runId, nowValid, items.length);
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
    if (again && again.op === DISTILL_OP && again.requestHash === reqHash) {
      try {
        const replay = JSON.parse(again.responseJson) as ResponseEnvelope;
        return budgeted({ ...replay, deduplicated: true }, config);
      } catch {
        return budgeted(fail("STORE_UNAVAILABLE"), config);
      }
    }
    return budgeted(conflict(), config);
  }
  return budgeted(fail("STORE_UNAVAILABLE"), config);
}
