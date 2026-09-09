/**
 * M1 Obsidian-compatible Markdown projection (derived, rebuildable).
 *
 * The canonical store is SQLite only. After a record write commits, the
 * record is rendered to `vaultPath/<id>.md` with `[[ref]]` outbound links
 * and a derived backlinks section. Writes are atomic per file (temp +
 * rename). Projection failure never rolls back or hides committed canonical
 * memory: failures stay in `projection_queue` for retry.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { AppConfig } from "./config.js";
import { resolveVaultPath } from "./config.js";

/** Max projection files written per drain call (bounded maintenance). */
export const PROJECTION_DRAIN_MAX = 50;
/**
 * Legacy attempt-count export (kept for compatibility). Failed queue rows are
 * NEVER deleted: this count only bounds the exponential backoff exponent so
 * retries stay deterministic and bounded. Queue rows are retained with a
 * capped `nextAt` backoff; only success dequeues.
 */
export const PROJECTION_ATTEMPTS_MAX = 5;
/** Base delay for projection retry backoff (deterministic, no jitter). */
export const PROJECTION_RETRY_BASE_MS = 1000;
/** Upper bound for projection retry backoff (retries never sleep longer). */
export const PROJECTION_RETRY_CAP_MS = 300_000;

export interface ProjectionRecord {
  id: string;
  body: string;
  kind: string;
  scope: string;
  status: string;
  source: string;
  observedAt: string;
  createdAt: string;
  supersedes: string | null;
  revision: number;
  tags: string[];
  links: string[];
  sourceRefs: string[];
}

export function readProjectionRecord(
  db: DatabaseSync,
  id: string,
): ProjectionRecord | null {
  const row = db
    .prepare(
      `SELECT id, body, kind, scope, status, source, observedAt, createdAt, supersedes, revision
       FROM records WHERE id = ?`,
    )
    .get(id) as
    | {
        id: string;
        body: string;
        kind: string;
        scope: string;
        status: string;
        source: string;
        observedAt: string;
        createdAt: string;
        supersedes: string | null;
        revision: number;
      }
    | undefined;
  if (!row) return null;
  const tags = (
    db
      .prepare(`SELECT tag FROM record_tags WHERE recordId = ? ORDER BY tag ASC`)
      .all(id) as Array<{ tag: string }>
  ).map((r) => r.tag);
  const links = (
    db
      .prepare(`SELECT toRef FROM record_links WHERE fromId = ? ORDER BY toRef ASC`)
      .all(id) as Array<{ toRef: string }>
  ).map((r) => r.toRef);
  const sourceRefs = (
    db
      .prepare(`SELECT eventId FROM record_source_refs WHERE recordId = ? ORDER BY eventId ASC`)
      .all(id) as Array<{ eventId: string }>
  ).map((r) => r.eventId);
  return { ...row, tags, links, sourceRefs };
}

/** Active same-scope records linking TO this record (derived backlinks). */
export function readBacklinks(
  db: DatabaseSync,
  id: string,
  scope: string,
): string[] {
  const rows = db
    .prepare(
      `SELECT l.fromId AS fromId FROM record_links l
       JOIN records r ON r.id = l.fromId
       WHERE l.toRef = ? AND r.scope = ? AND r.status = 'active'
       ORDER BY r.createdAt DESC, r.id ASC`,
    )
    .all(id, scope) as Array<{ fromId: string }>;
  return rows.map((r) => r.fromId);
}

function yamlScalar(s: string): string {
  return JSON.stringify(s);
}

export function renderMarkdown(
  rec: ProjectionRecord,
  backlinks: string[],
): string {
  const lines: string[] = [];
  lines.push("---");
  lines.push(`id: ${yamlScalar(rec.id)}`);
  lines.push(`kind: ${yamlScalar(rec.kind)}`);
  lines.push(`scope: ${yamlScalar(rec.scope)}`);
  lines.push(`status: ${yamlScalar(rec.status)}`);
  lines.push(`source: ${yamlScalar(rec.source)}`);
  lines.push(`observedAt: ${yamlScalar(rec.observedAt)}`);
  lines.push(`createdAt: ${yamlScalar(rec.createdAt)}`);
  lines.push(`revision: ${rec.revision}`);
  lines.push(`supersedes: ${rec.supersedes === null ? "null" : yamlScalar(rec.supersedes)}`);
  lines.push(`tags: [${rec.tags.map(yamlScalar).join(", ")}]`);
  lines.push("---");
  lines.push("");
  lines.push(`# ${rec.id}`);
  lines.push("");
  lines.push(rec.body);
  lines.push("");
  if (rec.links.length > 0) {
    lines.push("## Links");
    lines.push("");
    for (const l of rec.links) lines.push(`- [[${l}]]`);
    lines.push("");
  }
  if (backlinks.length > 0) {
    lines.push("## Backlinks");
    lines.push("");
    for (const b of backlinks) lines.push(`- [[${b}]]`);
    lines.push("");
  }
  if (rec.sourceRefs.length > 0) {
    lines.push("## Sources");
    lines.push("");
    for (const s of rec.sourceRefs) lines.push(`- ${s}`);
    lines.push("");
  }
  return lines.join("\n");
}

function safeFileName(id: string): string | null {
  if (id.length === 0 || id.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(id)) return null;
  return `${id}.md`;
}

/** Queue a record for (re)projection. Best-effort: never throws. */
export function enqueueProjection(db: DatabaseSync, recordId: string): void {
  try {
    db.prepare(
      `INSERT OR IGNORE INTO projection_queue(recordId, attempts, nextAt) VALUES (?, 0, ?)`,
    ).run(recordId, new Date().toISOString());
  } catch {
    /* projection is best-effort; the commit already succeeded */
  }
}

/**
 * Deterministic capped exponential backoff for a failed projection.
 * `attempts` is the new (post-increment) failure count, 1-indexed:
 * base * 2^(attempts-1) capped at PROJECTION_RETRY_CAP_MS. The exponent is
 * clamped via PROJECTION_ATTEMPTS_MAX so the delay stays bounded even after
 * many consecutive failures. Pure: never throws.
 */
export function projectionBackoffMs(attempts: number): number {
  const n = Number.isFinite(attempts) ? Math.max(1, Math.floor(attempts)) : 1;
  const shift = Math.min(n - 1, Math.max(0, PROJECTION_ATTEMPTS_MAX + 3));
  const delay = PROJECTION_RETRY_BASE_MS * Math.pow(2, shift);
  return Math.min(delay, PROJECTION_RETRY_CAP_MS);
}

/** Write one record file atomically (temp + rename). Throws on failure. */
export function projectOneRecord(
  db: DatabaseSync,
  vaultDir: string,
  recordId: string,
): void {
  const rec = readProjectionRecord(db, recordId);
  if (!rec) return; // Row gone (should not happen: no deletes); treat as done.
  const name = safeFileName(rec.id);
  if (!name) return;
  const backlinks = readBacklinks(db, rec.id, rec.scope);
  const md = renderMarkdown(rec, backlinks);
  fs.mkdirSync(vaultDir, { recursive: true });
  const tmp = path.join(vaultDir, `.${rec.id}.${process.pid}.tmp`);
  fs.writeFileSync(tmp, md, "utf8");
  fs.renameSync(tmp, path.join(vaultDir, name));
}

/**
 * Bounded queue drain: project up to PROJECTION_DRAIN_MAX due queued records
 * (`nextAt <= now`, ordered by nextAt). Success dequeues; failure retains the
 * row with attempts+1 and a capped exponential `nextAt` backoff so a stuck
 * record never blocks newer due work and is never forgotten. Never throws;
 * returns {projected, failed}.
 */
export function drainProjection(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
): { projected: number; failed: number } {
  const vaultDir = resolveVaultPath(configPath, config.vaultPath);
  let projected = 0;
  let failed = 0;
  let queued: Array<{ recordId: string; attempts: number }>;
  try {
    const nowIso = new Date().toISOString();
    queued = db
      .prepare(
        `SELECT recordId, attempts FROM projection_queue WHERE nextAt <= ? ORDER BY nextAt ASC, recordId ASC LIMIT ?`,
      )
      .all(nowIso, PROJECTION_DRAIN_MAX) as Array<{ recordId: string; attempts: number }>;
  } catch {
    return { projected: 0, failed: 1 };
  }
  for (const q of queued) {
    try {
      projectOneRecord(db, vaultDir, q.recordId);
      try {
        db.prepare(`DELETE FROM projection_queue WHERE recordId = ?`).run(q.recordId);
      } catch {
        /* dequeue failure: will retry next drain; harmless */
      }
      projected++;
    } catch {
      failed++;
      try {
        // Never delete on failure: retain with capped exponential backoff.
        const nextAttempts = q.attempts + 1;
        const nextAt = new Date(Date.now() + projectionBackoffMs(nextAttempts)).toISOString();
        db.prepare(`UPDATE projection_queue SET attempts = ?, nextAt = ? WHERE recordId = ?`).run(
          nextAttempts,
          nextAt,
          q.recordId,
        );
      } catch {
        /* ignore */
      }
    }
  }
  return { projected, failed };
}

/**
 * Exported rebuild: re-render every record file from canonical SQLite.
 * Vault content (incl. [[ref]] links and backlinks) is restored without
 * changing canonical rows. Returns the number of files written.
 */
export function rebuildVault(
  db: DatabaseSync,
  config: AppConfig,
  configPath: string,
): number {
  const vaultDir = resolveVaultPath(configPath, config.vaultPath);
  const rows = db
    .prepare(`SELECT id FROM records ORDER BY createdAt ASC, id ASC`)
    .all() as Array<{ id: string }>;
  let n = 0;
  for (const r of rows) {
    projectOneRecord(db, vaultDir, r.id);
    n++;
  }
  try {
    db.prepare(`DELETE FROM projection_queue`).run();
  } catch {
    /* ignore */
  }
  return n;
}
