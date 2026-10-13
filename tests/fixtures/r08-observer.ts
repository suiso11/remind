/**
 * R08 test-only preload observer (no production path change).
 *
 * Loaded via `node --require <dist/tests/fixtures/r08-observer.js>` in the
 * real child CLI only. Node inherits the flag into Worker.execArgv, so this
 * module runs in BOTH the CLI parent thread (threadId 0) and the real store
 * worker thread (threadId > 0) without touching production sources.
 *
 * - Parent (threadId 0): wraps stdin `on`/`addListener` registration. The
 *   first 'data' listener is installed by readFirstLine(), which runs AFTER
 *   initDb, so writing the owned ready marker proves startup is past initDb.
 *   Listener semantics are preserved exactly (pass-through, same return).
 * - Worker (threadId > 0): wraps DatabaseSync.prototype.exec to observe the
 *   actual native SQLite boundary. On the first statement containing BEGIN
 *   it appends an owned temp marker with the real positive worker threadId,
 *   then calls through to the original exec unmodified (pass-through =
 *   SQLITE_OK semantics: never denies, never fakes results/timeouts).
 *
 * It never touches parentPort (a probe there would be consumed by the
 * deadline race), never returns fake op/success/timeout envelopes, and is a
 * no-op when R08_OBS_DIR is unset (all other suites, production runs).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { threadId } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const OBS_DIR = process.env["R08_OBS_DIR"] ?? "";
const READY_NAME = "r08-child-ready";
const WORKER_NAME = "r08-worker-begin";

function marker(p: string): string {
  return path.join(OBS_DIR, p);
}

function writeOnce(file: string, text: string): void {
  try {
    if (OBS_DIR.length === 0) return;
    if (fs.existsSync(file)) return;
    fs.writeFileSync(file, text, "utf8");
  } catch {
    /* observer must never break the CLI */
  }
}

try {
  if (OBS_DIR.length > 0 && threadId === 0) {
    const stdin = process.stdin as unknown as {
      on: (...a: unknown[]) => unknown;
      addListener: (...a: unknown[]) => unknown;
    };
    for (const m of ["on", "addListener"] as const) {
      try {
        const orig = (stdin[m] as (...a: unknown[]) => unknown).bind(stdin);
        (stdin[m] as (...a: unknown[]) => unknown) = (...a: unknown[]) => {
          try {
            if (a[0] === "data") writeOnce(marker(READY_NAME), "ready\n");
          } catch {
            /* ignore */
          }
          return orig(...a);
        };
      } catch {
        /* ignore */
      }
    }
  }
} catch {
  /* ignore */
}

try {
  if (OBS_DIR.length > 0 && threadId > 0) {
    const proto = DatabaseSync.prototype as unknown as {
      exec: (sql: string, ...rest: unknown[]) => unknown;
    };
    const origExec = proto.exec;
    let logged = false;
    const wrapped = function (
      this: unknown,
      sql: string,
      ...rest: unknown[]
    ): unknown {
      try {
        if (!logged && typeof sql === "string" && /BEGIN/i.test(sql)) {
          logged = true;
          writeOnce(
            marker(WORKER_NAME),
            `threadId=${threadId} sql=${sql.slice(0, 64)}\n`,
          );
        }
      } catch {
        /* ignore */
      }
      return (origExec as (...a: unknown[]) => unknown).call(this, sql, ...rest);
    };
    try {
      proto.exec = wrapped as (sql: string, ...rest: unknown[]) => unknown;
    } catch {
      /* ignore */
    }
  }
} catch {
  /* ignore */
}
