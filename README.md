# remind-memory-cli (T1 foundation, hardened)

Local external-long-term-memory CLI foundation. Planning source: `plan.md`
section 14 (MVP proposal). **T1 implements only the runnable foundation**
(boot, strict config, JSON envelopes, SQLite `scopes` init, protocol bound
tests). Domain operations (`candidate.*`, `record.*` tables, approvals,
recall search, corrections) are **not implemented yet** (T2-T4). Valid
automated envelopes honestly fail with `ok:false, code:NOT_IMPLEMENTED`,
a **temporary T1-only status** (fixed code/message, budgeted like every
other envelope). T2-T4 replace it with real domain results; T1 never
returns `ok:true` for unimplemented domain ops.

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
echo '{"v":1,"op":"record.recall","params":{}}' | node dist/src/cli.js --config ./memory.config.json
```
Status (honest, verified): `npm test` builds with `tsc` and runs
`node:test` over `dist/tests/` — **22 tests pass** (config strictness,
envelopes/bounds, CLI smoke, hardened stdin subprocess suite). `npm run
smoke` walks valid/unknown/human-op envelopes in a temp dir. T2-T6 domain
work (candidates/records/recall/corrections, A1-A13) is explicitly out of
scope for T1.

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
  `BAD_REQUEST`; valid automated ops return `NOT_IMPLEMENTED` (T1-only,
  honest failure) until T2-T4.

## Layout

- `src/config.ts` — strict startup config load/validate
- `src/protocol.ts` — envelopes, fixed codes/messages, bounds
- `src/db.ts` — SQLite open + `scopes` seed (T2-T4 tables go here)
- `src/cli.ts` — CLI entry (`--config`, bounded LF-framed stdin, stdout line)
- `tests/` — `node:test` suites (config/protocol/cli smoke/hardening subprocess)
- `memory.config.example.json` — fake scope (`personal/default`) only

## Roadmap (plan.md 14.12)

- [x] T1: this foundation
- [ ] T2: candidates + review/approve/reject
- [ ] T3: records + deterministic recall + exposure audit
- [ ] T4: correct-request/archive
- [ ] T5: retention documentation (no export/delete in MVP)
- [ ] T6: fake adapter + A1-A13 acceptance
