# remind-memory-cli (T1 foundation)

Local external-long-term-memory CLI foundation. Planning source: `plan.md`
section 14 (MVP proposal). **T1 implements only the runnable foundation**
(boot, strict config, JSON envelopes, SQLite `scopes` init, protocol bound
tests). Domain operations (`candidate.*`, `record.*` tables, approvals,
recall search, corrections) are **not implemented yet** (T2-T4) and the CLI
says so honestly in its `data` payload.

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
echo '{"v":1,"op":"record.recall","params":{}}' | node dist/cli.js --config ./memory.config.json
```

## Interface

- `memory-cli --config <path>` reads **one** stdin JSON line, writes **one**
  stdout JSON line (`{v, ok, code, message, data, deduplicated}`), exit `0`.
- Startup failures (missing `--config`, invalid config, DB open failure,
  empty stdin) exit non-zero with **no stdout JSON** (stderr text only).
- Config is file-only: unknown fields rejected; env vars / request JSON can
  never override limits. Scopes seed `scopes(scope PK)` additively.
- Raw request cap `32768` bytes; response budget from
  `limits.responseMaxBytes` (fail-closed `LIMIT_EXCEEDED`, never truncated).
- Human-only ops over JSON return `FORBIDDEN`; unknown ops return
  `BAD_REQUEST`; valid automated ops return a T1 placeholder until T2-T4.

## Layout

- `src/config.ts` — strict startup config load/validate
- `src/protocol.ts` — envelopes, fixed codes/messages, bounds
- `src/db.ts` — SQLite open + `scopes` seed (T2-T4 tables go here)
- `src/cli.ts` — CLI entry (`--config`, stdin line, stdout line)
- `tests/` — `node:test` suites (config/protocol/cli smoke)
- `memory.config.example.json` — fake scope (`personal/default`) only

## Roadmap (plan.md 14.12)

- [x] T1: this foundation
- [ ] T2: candidates + review/approve/reject
- [ ] T3: records + deterministic recall + exposure audit
- [ ] T4: correct-request/archive
- [ ] T5: retention documentation (no export/delete in MVP)
- [ ] T6: fake adapter + A1-A13 acceptance
