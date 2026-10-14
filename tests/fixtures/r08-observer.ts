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
 *
 * Child-clock deadline proof (parent thread only): the module records
 * Date.now() once at load (via --require this runs before cli.js, so it is
 * the actual CLI start anchor on the child clock, ahead of initDb/ready/
 * request) and wraps the real stdout write + process.exit pass-through to
 * stamp the actual response/exit times. Every wrapper calls the native
 * original and returns its result unchanged; the stamps are side files only.
 * The suite measures response/start and exit/start on this clock, so parent
 * spawn/bootstrap/poll scheduling cannot mask a wrong hardcoded deadline.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { threadId } from "node:worker_threads";
import { DatabaseSync } from "node:sqlite";

const OBS_DIR = process.env["R08_OBS_DIR"] ?? "";
const READY_NAME = "r08-child-ready";
const WORKER_NAME = "r08-worker-begin";
const START_NAME = "r08-child-start";
const RESPONSE_NAME = "r08-child-response";
const EXIT_NAME = "r08-child-exit";

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
    // Actual CLI start on the child clock: first application Date.now call,
    // ahead of cli.js load, initDb, the ready barrier, and the request.
    const childStart = Date.now();
    writeOnce(marker(START_NAME), `${childStart}\n`);
    let responseLogged = false;
    const stampResponse = (): void => {
      if (responseLogged) return;
      responseLogged = true;
      writeOnce(marker(RESPONSE_NAME), `${Date.now()}\n`);
    };
    try {
      // Mutate the REAL shared module object: this fixture's `import *`
      // copy is a getter view, so assigning on it would be invisible to
      // cli.js. The CLI's own getter view reads this same object, so the
      // wrapper below observes the true stdout write path.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fsReal = require("node:fs") as {
        writeSync: (...a: unknown[]) => unknown;
      };
      const origWriteSync = fsReal.writeSync.bind(fsReal);
      fsReal.writeSync = (...a: unknown[]): unknown => {
        try {
          if (a[0] === 1) stampResponse();
        } catch {
          /* ignore */
        }
        return (origWriteSync as (...b: unknown[]) => unknown)(...a);
      };
    } catch {
      /* observer must never break the CLI */
    }
    try {
      const out = process.stdout as unknown as {
        write: (...a: unknown[]) => unknown;
      };
      const origStdoutWrite = out.write.bind(out);
      out.write = (...a: unknown[]): unknown => {
        try {
          stampResponse();
        } catch {
          /* ignore */
        }
        return (origStdoutWrite as (...b: unknown[]) => unknown)(...a);
      };
    } catch {
      /* ignore */
    }
    try {
      const origExit = process.exit.bind(process);
      (process as unknown as { exit: (...a: unknown[]) => never }).exit = ((
        ...a: unknown[]
      ): never => {
        try {
          writeOnce(marker(EXIT_NAME), `${Date.now()} code=${String(a[0] ?? "")}\n`);
        } catch {
          /* ignore */
        }
        return (origExit as (...b: unknown[]) => never)(...a);
      }) as (...a: unknown[]) => never;
    } catch {
      /* ignore */
    }
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
