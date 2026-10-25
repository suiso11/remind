/**
 * Bounded activation-input loader.
 *
 * Extracted from activation.ts so the retention learner can snapshot record
 * features without importing the scoring/operations module. activation.ts
 * re-exports these symbols.
 */
import type { DatabaseSync } from "node:sqlite";
import { REACTIVATE_REASONS, RETIRE_REASONS } from "./cultivation.js";
import { nowIso } from "./normalize.js";
import {
  NATURE_LABELS,
  isExpiredDated,
  type ActivationKind,
  type ActivationStatus,
  type NatureLabel,
} from "./retention_model.js";

/** Maximum candidate records considered by one preview scan. */
export const ACTIVATION_MAX_RECORDS = 2000;
/** Maximum supersedes-chain hops followed for predecessor usage. */
export const ACTIVATION_CHAIN_MAX = 32;
/** Chunk size for bounded IN queries (well below SQLite's variable limit). */
const SQL_CHUNK = 300;
const CLUSTER_SUMMARY_SOURCE = "cultivation:llm-derived-cluster";

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

/**
 * Every audit op that can move a record between active and retired. User
 * transitions are staged by Companion as record.retire/record.reactivate
 * (NO_LONGER_USEFUL / USER_REQUESTED), but cultivation batches audit the same
 * transitions as maintain.cultivate; older databases may also carry
 * maintain.cultivation/maintain.distill/maintain.activation target rows.
 */
const TRANSITION_AUDIT_OPS = [
  "record.retire",
  "record.reactivate",
  "maintain.cultivate",
  "maintain.cultivation",
  "maintain.distill",
  "maintain.activation",
] as const;

const TRANSITION_REASON_CODES = [...RETIRE_REASONS, ...REACTIVATE_REASONS] as const;

interface TransitionHistory {
  /** Timestamps of reactivation audit rows (event-frequency input). */
  reactivationTimes: Map<string, string[]>;
  /** Reason of the latest reactivation row, whichever op wrote it. */
  latestReactivationReasons: Map<string, string | null>;
  /** Reason of the latest retirement row, whichever op wrote it. */
  retireReasons: Map<string, string | null>;
}

/**
 * Single ordered scan over active<->retired transitions. Retire and
 * reactivate reason-code sets are disjoint (fixed codes), so one query can
 * classify each row and keep only the latest per target: `ORDER BY ts, rowid`
 * makes later rows overwrite earlier ones (latest event wins).
 */
function loadTransitionHistory(
  db: DatabaseSync,
  ids: string[],
): TransitionHistory {
  const reactivationTimes = new Map<string, string[]>();
  const latestReactivationReasons = new Map<string, string | null>();
  const retireReasons = new Map<string, string | null>();
  const retireCodes = new Set<string>(RETIRE_REASONS);
  for (const chunkIds of chunk(ids)) {
    const found = db
      .prepare(
        `SELECT targetId, ts, reasonCode FROM audit
          WHERE op IN (${placeholders(TRANSITION_AUDIT_OPS.length)})
            AND targetId IN (${placeholders(chunkIds.length)})
            AND reasonCode IN (${placeholders(TRANSITION_REASON_CODES.length)})
          ORDER BY ts ASC, rowid ASC`,
      )
      .all(
        ...TRANSITION_AUDIT_OPS,
        ...chunkIds,
        ...TRANSITION_REASON_CODES,
      ) as unknown as Array<{ targetId: string; ts: string; reasonCode: string | null }>;
    for (const row of found) {
      if (row.reasonCode === null) continue;
      if (retireCodes.has(row.reasonCode)) {
        retireReasons.set(row.targetId, row.reasonCode);
        continue;
      }
      const list = reactivationTimes.get(row.targetId);
      if (list) list.push(row.ts);
      else reactivationTimes.set(row.targetId, [row.ts]);
      latestReactivationReasons.set(row.targetId, row.reasonCode);
    }
  }
  return { reactivationTimes, latestReactivationReasons, retireReasons };
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
  /**
   * Restrict the scan to these record ids (any status). Used by the retention
   * learner to snapshot features for already-exposed records without changing
   * the default active/retired candidate behavior.
   */
  recordIds?: string[];
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
  const idList =
    options.recordIds !== undefined && options.recordIds.length > 0
      ? [...new Set(options.recordIds)]
      : null;
  // Explicit ids intentionally bypass the status filter so the learner can
  // snapshot a row that was exposed before it was archived/superseded.
  const statusFilter = idList === null ? `AND status IN ${statuses}` : "";
  const idFilter = idList === null ? "" : `AND id IN (${placeholders(idList.length)})`;
  const rows = db
    .prepare(
      `SELECT id, body, bodyHash, kind, status, createdAt, supersedes
         FROM records
        WHERE scope = ? ${statusFilter} ${idFilter} ${keyset}
        ORDER BY createdAt ASC, id ASC
        LIMIT ?`,
    )
    .all(
      ...([
        scope,
        ...(idList ?? []),
        ...(after ? [after.createdAt, after.createdAt, after.id] : []),
        maxRecords,
      ] as Array<string | number>),
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

  // Active<->retired transition history from ANY op that can perform it.
  // Retirements are mostly written by maintain.cultivate on behalf of
  // maintain.distill (reasonCode LOW_SIGNAL); user actions are staged as
  // record.retire/reactivate; maintain.activation reuses those ops with
  // LOW_ACTIVATION/STILL_USEFUL. Filtering by the fixed retire+reactivate
  // codes excludes cultivate keep rows (reasonCode null) and per-batch
  // summary audit rows. The latest transition per kind wins.
  const { reactivationTimes, latestReactivationReasons, retireReasons } =
    loadTransitionHistory(db, candidateIds);

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
