# T6 acceptance manifest A1–A13 + A8b (automated vs manual)

Automated suite: `tests/acceptance.test.ts` (`npm run acceptance` =
`npm run build && node --test dist/tests/acceptance.test.js`): 14 tests pass
(A1–A13 + A8b). `npm test`: 88 tests, 87 pass, 1 skipped (real-TTY only).
Fake adapter under test: `src/fake-adapter.ts` (spawns the compiled CLI,
no shell, bounded I/O + timeout, fixed error map, current-recall citations
only). Seeded fake data only; no real user data, no LLM, no network.

| ID | Plan expectation (§14.11) | Automated test | Existing-suite reference | Manual remainder |
| --- | --- | --- | --- | --- |
| A1 | Unapproved candidates never leak into recall | `A1 no leakage of unapproved candidates` | `tests/t3.test.ts` approval-only recall | none |
| A2 | Approval → recall with fixed order, `recallId + snippet + truncated`; citations structural | `A2 approved recall via CLI+adapter` (+ `isCitationExposed` grant/out-of-exposure check) | `tests/t3.test.ts` recall shape/order | real-TTY `review` display + typed-`yes` `approve` (hand-run, §6 walkthrough) |
| A3 | Token/immutability binding: every token-bound field tamper is `CONFLICT`, no record; stored body/bodyHash mismatch is `CONFLICT` (stale-hash guard, re-checked in-txn) | `A3 approval immutability binding` (full-field tampers + body/bodyHash SQL-tamper matrix) | `tests/t2.test.ts`, `t2-review-fixes` token binding | real-TTY token transcription (hand-run) |
| A4 | `expiresAt` → `EXPIRED`, row retained | `A4 expiry` (row still selectable) | `tests/t2.test.ts` TTL/expiry | none |
| A5 | Same key+params → `deduplicated:true`; changed params → `CONFLICT`; missing key → `BAD_REQUEST` | `A5 idempotency` (store + CLI envelope) | `tests/t2.test.ts` idempotency, `tests/t4.test.ts` replay/`CONFLICT` | none |
| A6 | Deterministic repeat order; over-input `LIMIT_EXCEEDED` without truncation; bounded `snippet + truncated` | `A6 determinism and bounds` | `tests/t3.test.ts`, `t3-fix` scale/unicode | none |
| A7 | Correction supersede + archive exclusion from recall | `A7 correction and archive exclusion` | `tests/t4.test.ts` supersede/archive/exclusion | real-TTY `archive` typed-`yes` (hand-run) |
| A8 | No body/query in audit/exposures/errors; DB-down/startup-nonzero/timeout/malformed/over-budget → memoryless fixed-text fallback; no unaudited success | `A8 audit shrink-wrap and degraded fallback` (audit dump scan + adapter matrix: disabled/missing-config/corrupt-DB/garbage-stdout/over-budget) | `tests/t3.test.ts` audit-absence/rollback, `t4.test.ts` failing-audit rollback, `pr2-deadline-scope` timeout/scope | real timeout observation under load (operator note only) |
| A8b | Strict adapter envelope/budget hardening (local fixtures only, no network): single-LF-line JSON, exact shape, finite bounds degrade, UTF-8 fatal, SIGKILL deadline | `A8b fake-adapter strictness` (malformed envelopes/budgets degrade memoryless) | `tests/hardening.test.ts` stdin subprocess suite | none |
| A9 | JSON human ops `FORBIDDEN`; id-scope mismatch `FORBIDDEN_SCOPE`; actor/natural-language never authorizes | `A9 authorization and route separation` | `tests/t2.test.ts` TTY/`FORBIDDEN`, `protocol` envelope | real non-TTY refusal observation (hand-run: piped `approve` → `FORBIDDEN`) |
| A10 | Competing correction approvals: one winner, loser `CONFLICT` + rollback | `A10 correction race` (sequential) + `tests/t4.test.ts` worker-thread race suite | `tests/t4.test.ts` race-tightening (real shared-DB concurrency) | none beyond the referenced race suite |
| A11 | Pre-commit retry is fresh; committed replay survives restart/reopen and post-expiry (`deduplicated:true`) | `A11 idempotent rollback and restart` (close/reopen + post-expiry replay) | `tests/t2/t4` idempotent replay, `pr2` unknown-outcome replay | kill-during-commit observation (operator note only; never asserted) |
| A12 | Cross-scope records never surface; `audit/exposures` scope/`runId`/`recallId` match | `A12 scope exposure isolation` | `tests/t3.test.ts` revoked-scope, `t4` cross-scope | none |
| A13 | Each over-budget field `LIMIT_EXCEEDED`; emoji/combining input keeps codepoint/UTF-8 boundaries | `A13 overflow and unicode` | `tests/t3-fix.test.ts` surrogate/astral/scale | none |

Manual-only (never claimed as done by automation): real-TTY interactive
confirmation for `review` / `approve` / `reject` / `archive` (actual
terminal, human-typed `yes`; the suite's `approveCandidate` calls cover
the domain transition only), plus operator observations (kill-during-commit
replay, under-load timeout). The single `skip` in `npm test` remains that
real-TTY confirmation.
