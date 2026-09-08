# remind-memory-cli (T3 deterministic recall, hardened)

Local external-long-term-memory CLI foundation. Planning source: `plan.md`
section 14 (MVP proposal). **T1** delivered the runnable foundation
(boot, strict config, JSON envelopes, SQLite `scopes` init, protocol bound
tests). **T2** adds candidates + human review/approve/reject
(`candidate.create` / `candidate.get` over JSON; `review` / `approve` /
`reject` on the human TTY path; approval-token binding; idempotent writes;
metadata-only audit). **T3** adds deterministic `record.recall` atop
approved records only (literal normalization, tag-ALL/link/time filters,
fixed `createdAt DESC, id ASC` order, bounded prefix snippets, full-response
budget, per-recall `recallId` with metadata-only `audit` + `exposures` rows
in one fail-closed transaction). Remaining domain operations
(`record.correct-request`, `archive`) are **not implemented yet** (T4).
Valid automated envelopes for those honestly fail with `ok:false,
code:NOT_IMPLEMENTED`, a temporary status (fixed code/message, budgeted
like every other envelope). T4 replaces it with real domain results; this
CLI never returns `ok:true` for unimplemented domain ops.

Companion integration is unresolved (plan.md U11); this repo changes nothing
in Companion.

## Pinned environment (actual, verified)

- Node.js `24.12.0` (Supported LTS line), npm `11.6.2`
- `engines: node >=24.12.0 <25`, `packageManager: npm@11.6.2`
- TypeScript `5.9.3`, `@types/node` `24.10.1` (dev only)
- **Zero runtime dependencies**: SQLite via the Node built-in `node:sqlite`
  (`DatabaseSync`). Note: it still prints an `ExperimentalWarning` on this
  Node version; the warning goes to stderr and never touches stdout JSON.

## Quick start

```sh
npm ci
npm test        # build (tsc) + unit/smoke tests over dist/
npm run smoke   # manual CLI envelope walkthrough in a temp dir
cp memory.config.example.json memory.config.json  # local only, git-ignored
echo '{"v":1,"op":"record.recall","params":{"query":"booking","scope":"personal/default","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
```
Status (honest, verified): `npm test` builds with `tsc` and runs
`node:test` over `dist/tests/` — **46 tests pass, 1 skipped** (config
strictness, envelopes/bounds, CLI smoke, hardened stdin subprocess suite,
T2 candidates/approval/idempotency/scope/TTY-guard suite, 4 T2 review
regressions, plus 10 T3 recall regressions: approval-only/active-scope
filtering with revoked scope, literal normalization (`%_` quotes, no
wildcards), tag-ALL/link/time/order/ties/limits, Unicode codepoint
truncation with exact byte accounting, empty-recall audit, query absence in
audit/errors, recall-ID uniqueness with per-item exposures, forced audit
failure rollback, budget-overflow with no exposures, CLI end-to-end over
persistent seeded SQLite; the single skip is the manual real-TTY
interactive confirmation, exercised by hand only).
`npm run smoke` walks a strict valid recall / unknown / human-op envelopes
in a temp dir (recall returns `ok:true` with empty items on the fresh DB).
T4-T6 domain work (corrections/archive, retention docs,
fake adapter, A1-A13) is explicitly out of scope for T3.

## Interface

- `memory-cli --config <path>` reads **one LF-framed** stdin JSON line,
  writes **one** stdout JSON line (`{v, ok, code, message, data,
  deduplicated}`), exit `0`. The first LF terminates the request: the CLI
  answers without waiting for EOF, so a held-open pipe cannot hang it.
  Bytes already buffered after the first LF with non-whitespace content
  make it `BAD_REQUEST` (multiline); trailing whitespace-only bytes are
  ignored. EOF without LF also terminates the line; leading empty lines
  are skipped.
- Bounded stdin: raw UTF-8 bytes are capped at `32768` **while streaming**
  (before buffering/parsing), so overflow without a newline still returns
  `LIMIT_EXCEEDED`. The `timeouts.cliMs` deadline aborts a never-ending
  stdin with `TIMEOUT`. Line bytes are decoded as UTF-8 `fatal:true`;
  invalid bytes return `BAD_REQUEST`. Neither path waits indefinitely.
- Startup failures (missing `--config`, invalid config, DB open failure,
  empty/unreadable stdin) exit non-zero with **no stdout JSON** and a
  **fixed** stderr line only (`error: bad arguments` /
  `error: invalid config` / `error: store unavailable` / `error: bad
  input`): argv, config contents, and exception messages are never echoed.
  The `node:sqlite` `ExperimentalWarning` may also appear on stderr; it
  never touches stdout JSON and never carries request bytes.
- Config is file-only: unknown fields rejected; env vars / request JSON can
  never override limits. Scopes seed `scopes(scope PK)` additively.
- Response budget from `limits.responseMaxBytes` applies to **every**
  stdout envelope path (`OK`/`BAD_REQUEST`/`FORBIDDEN`/`NOT_IMPLEMENTED`/
  `LIMIT_EXCEEDED`/`TIMEOUT`/`STORE_UNAVAILABLE`): over-budget responses
  become fail-closed `LIMIT_EXCEEDED`, never truncated.
- Human-only ops over JSON return `FORBIDDEN`; unknown ops return
  `BAD_REQUEST`; `candidate.create`/`candidate.get`/`record.recall` execute
  against the store (T2-T3); `record.correct-request` returns
  `NOT_IMPLEMENTED` (honest T4 deferral) until T4.
- Review discloses only for authorized scopes (startup config AND `scopes`
  table); over-budget create/approve/reject fail closed with no orphan
  rows; a known committed `ok:true` is never replaced by `TIMEOUT` or a
  close failure (unknown outcomes keep idempotent replay).

## Layout

- `src/config.ts` — strict startup config load/validate
- `src/protocol.ts` — envelopes, fixed codes/messages, bounds
- `src/db.ts` — SQLite open + `scopes` seed + T2 domain tables
- `src/normalize.ts` — T2 exact normalization (NFKC/trim/collapse/ASCII
  fold), canonical times/hashes, approval-token binding, TTY escaping
- `src/store.ts` — T2 candidates + review/approve/reject + idempotency +
  metadata-only audit, plus T3 `record.recall` (strict params, literal
  normalized match, tag-ALL/link/time filters, fixed order, bounded
  snippets, full-budget gate, single-transaction audit/exposures;
  correct/archive honestly deferred to T4)
- `src/cli.ts` — CLI entry (`--config`, bounded LF-framed stdin, stdout line;
  `candidate.create/get` routed to the store, human `review/approve/reject`
  subcommands with TTY + `yes` confirmation)
- `tests/` — `node:test` suites (config/protocol/cli smoke/hardening subprocess/T2/T3)
- `memory.config.example.json` — fake scope (`personal/default`) only

## Roadmap (plan.md 14.12)

- [x] T1: this foundation
- [x] T2: candidates + review/approve/reject
- [x] T3: records + deterministic recall + exposure audit
- [ ] T4: correct-request/archive
- [ ] T5: retention documentation (no export/delete in MVP)
- [ ] T6: fake adapter + A1-A13 acceptance
