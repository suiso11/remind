# Retention, export, deletion (T5 adopted defaults — MVP)

Planning source: `plan.md` §14.9 (proposal) as adopted in §19. This file is
the T5 retention documentation: it states the **adopted MVP defaults** that
the implementation actually follows. It does not rewrite the planning
history (§§14–18 stay as written); where this file and an older paragraph
disagree, this file's "Adopted" label wins for the running code, and the
older paragraph remains as historical evidence.

Status labels used here: **Proposal** (§14, pre-approval recommendation),
**Adopted** (§§15–19, user-approved for this repo), **Implemented**
(verified by `npm test` / `npm run acceptance` in this branch).

## 1. Adopted: TTL is eligibility, not deletion

- `candidateTtlSec` (startup config, default 72h = 259200) bounds the
  **approval-eligibility window** only. `expiresAt = createdAt + ttlSec`.
- After `expiresAt`, `approve` answers `EXPIRED` (A4). The transition is
  `candidate → expired`, performed atomically (`lazyExpire`) — **the row is
  retained, never deleted**.
- Committed idempotent replays are exempt: resending the same
  `idempotencyKey` + same params after expiry returns the saved response
  with `deduplicated:true` (A11). `EXPIRED` applies to *new* approvals only.
- `ttlSec` per-request overrides are capped by the config value; request
  JSON can never extend the window beyond startup config.

## 2. Adopted: every terminal status is retained — no purge, no export, no erasure

- Retained rows: `candidate` / `approved` / `rejected` / `expired`
  candidates; `active` / `superseded` / `archived` records; plus the full
  `operations` / `audit` / `exposures` ledgers.
- There is **no purge job, no retention sweeper, no `DELETE` path** in the
  CLI, the store, or the fake adapter. `archive` sets
  `status='archived'` (search/recall exclusion only); `supersede` sets
  `status='superseded'`. Neither frees space and neither is deletion.
- `admin.export` is **not implemented** (plan U7, non-goal §13). The MVP
  offers no JSONL dump, no user-facing export, no external send, no
  telemetry. Do not add one without a U7 decision.
- No deletion/erasure API exists and none is claimed: SQLite file removal
  or `VACUUM` effects are **not** an erasure guarantee. If erasure is ever
  needed, it is a new U7 decision with its own design — not an operator
  `rm` presented as a feature.

## 3. DB / config handling

- The database file comes from startup config `dbPath` (resolved relative
  to the config file directory). Config is **file-only**: unknown fields
  rejected, env vars and request JSON can never override limits, scopes,
  TTL, timeouts, or `dbMaxBytes`.
- `scopes(scope PK)` is seeded additively at startup (existing rows are
  never deleted). Scope checks are `startup-config AND scopes-table`;
  revocation = removal from config (or row), enforced as `FORBIDDEN_SCOPE`.
- Back up by copying the SQLite file **while the CLI is not running**
  (or via a filesystem snapshot). There is no live-export command.
- File permissions (same OS user read/write only) are an **operational
  recommendation, not a security boundary**: a same-user process can read
  the DB file directly. The honest trust boundary is one local user
  (plan §14.1).

## 4. Audit never carries bodies

- `audit` / `exposures` rows are **metadata-only**: timestamps, op, target
  IDs, fixed codes, scope, byte counts, limits, `runId` (opaque caller
  correlation, never a permission), `recallId`, approver observation,
  `approvedAt`, token, `reasonCode`. No memory body, no raw query, no
  snippet text, no secrets — on success rows, failure rows, and error
  envelopes alike (A8).
- Fixed `message` templates only; `reasonCode` is `USER_REJECTED` /
  `USER_ARCHIVED` only. Audit/exposure write failure is fail-closed: the
  whole operation rolls back (`STORE_UNAVAILABLE`), never an unaudited
  success.

## 5. Capacity exhaustion: realistic operator recovery (no magic)

- Pre-commit caps: writes that would cross `dbMaxBytes` roll back with
  `STORE_UNAVAILABLE`; over-budget responses become `LIMIT_EXCEEDED`
  without partial writes or orphan rows (checked pre-commit).
- The `dbMaxBytes` check is a pragmatic best-effort (`PRAGMA
  page_count/page_size` + file/`-wal`/`-shm` totals), not an exact byte
  guarantee (page granularity, WAL checkpoint lag). Do not present it as
  exact.
- When the store is full / corrupt / unavailable, callers (including the
  fake adapter) **degrade to the ordinary memoryless response** and keep
  working without memory — memory absence is never a generation failure
  (A8, plan §14.10).
- Operator recovery (manual, honest, no automatic deletion):
  1. Stop writers. 2. Back up the DB file. 3. Free disk / raise
     `dbMaxBytes` in config (restart required — no live reload) /
     compact offline if appropriate. 4. Restart and replay with the same
     `idempotencyKey` + params (`deduplicated` tells committed vs fresh).
  5. If the file is corrupt beyond repair, restore the backup; the MVP
     provides no salvage/export tool. There is no automatic eviction,
     no "oldest deleted first", and no guarantee of continued writes
     while over cap.

## 6. Windows terminal: startup and seeded walkthrough (PowerShell)

```powershell
node --version   # 24.12.0 expected
npm --version    # 11.6.2 expected
npm ci
npm test         # build + full suite over dist/
npm run smoke    # CLI envelope walkthrough in a temp dir
npm run acceptance  # T6 A1-A13 acceptance over dist/

# Local config (git-ignored) + seeded walkthrough (fake data only):
Copy-Item memory.config.example.json memory.config.json
'{"v":1,"op":"candidate.create","idempotencyKey":"walk-001","params":{"body":"next wednesday booking check","kind":"user_fact","provenance":{"source":"session:s1:turn:3","observedAt":"2026-09-01T00:00:00.000Z"},"scope":"personal/default","tags":["予定"],"ttlSec":259200,"runId":"run-001"}}' | node dist/src/cli.js --config ./memory.config.json
# Human path is a real terminal (both stdin+stdout must be TTYs):
node dist/src/cli.js review --config ./memory.config.json --id <candId> --scope personal/default
node dist/src/cli.js approve --config ./memory.config.json --id <candId> --scope personal/default --token <approvalToken> --idempotency-key h-001
# (type `yes` at the `confirm:` prompt; `--confirm yes` flags are rejected)
'{"v":1,"op":"record.recall","params":{"query":"booking","scope":"personal/default","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
```

The seeded walkthrough uses fake conversation data only (plan §14.11
evaluation-set proposal: seeded fake set, no real user data). Approval
requires an actual TTY; automation (including CI and this repo's tests)
must not fake it — the automated suite covers everything else and the
manifest marks the TTY step manual-only.

## 7. Status consolidation (no history rewrite)

- §14 (incl. §14.9/§14.11) remains the **proposal**: candidate TTL,
  retention/export/deletion defaults, and A1–A13 expectations as
  recommended values, unimplemented at planning time.
- §§15–18 remain the **adoption evidence** for T1–T4 exactly as approved;
  their "out of scope" sentences for later tasks describe their own time,
  not the present.
- §19 is the **T5+T6 adoption record** (present branch): it completes the
  MVP proposal coverage (T5 docs here + T6 fake adapter and A1–A13) while
  leaving U1–U11 formal decisions (incl. U7 retention/export/deletion
  policy and U11 Companion contract) unresolved, exactly as before.
- Deferred explicitly (not part of this MVP): production Companion
  integration, vector indexes, consolidation/compression jobs,
  `used_memory` reheat semantics, background jobs, export/delete APIs.
