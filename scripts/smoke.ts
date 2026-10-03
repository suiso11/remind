import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");
const cli = path.join(repoRoot, "dist", "src", "cli.js");

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-smoke-"));
const cfg = path.join(dir, "memory.config.json");
fs.copyFileSync(
  path.join(repoRoot, "memory.config.example.json"),
  cfg,
);
// Point the example DB and vault at the temp dir so smoke never touches the repo.
const parsed = JSON.parse(fs.readFileSync(cfg, "utf8"));
parsed.dbPath = path.join(dir, "smoke.db");
parsed.vaultPath = path.join(dir, "vault");
fs.writeFileSync(cfg, JSON.stringify(parsed));

const SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";

function run(line: string): { status: number | null; body: Record<string, unknown> | null; raw: string } {
  const r = spawnSync(process.execPath, [cli, "--config", cfg], {
    input: line + "\n",
    encoding: "utf8",
    timeout: 20000,
  });
  const raw = ((r.stdout || "").split("\n")[0] ?? "").trim();
  let body: Record<string, unknown> | null = null;
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return { status: r.status, body, raw };
}

function check(name: string, cond: boolean, detail: string): void {
  console.log(`${cond ? "ok" : "FAIL"} ${name} ${detail}`);
  if (!cond) {
    console.error(`smoke FAILED at ${name}: ${detail}`);
    process.exit(1);
  }
}

const dataOf = (b: Record<string, unknown> | null): Record<string, unknown> =>
  (b?.["data"] as Record<string, unknown>) ?? {};

// 1) event.append on the temp DB.
const ev = run(
  JSON.stringify({
    v: 1,
    op: "event.append",
    idempotencyKey: "smoke-ev-1",
    params: {
      eventId: "e-smoke-1",
      sessionId: "s1",
      turnId: "t1",
      body: "smoke orchard walk raw note",
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: SCOPE,
    },
  }),
);
check("event.append", ev.status === 0 && ev.body?.["code"] === "OK", ev.raw);
check(
  "event.append data",
  (dataOf(ev.body)["event"] as { eventId?: string } | undefined)?.eventId === "e-smoke-1",
  ev.raw,
);

// 2) record.remember referencing the same temp raw event.
const rem = run(
  JSON.stringify({
    v: 1,
    op: "record.remember",
    idempotencyKey: "smoke-rem-1",
    params: {
      body: "smoke orchard persimmon harvest memo",
      kind: "user_fact",
      provenance: { source: "session:s1:turn:1", observedAt: OBS },
      scope: SCOPE,
      tags: ["orchard"],
      sourceRefs: ["e-smoke-1"],
    },
  }),
);
check("record.remember", rem.status === 0 && rem.body?.["code"] === "OK", rem.raw);
const recordId = (dataOf(rem.body)["record"] as { id?: string } | undefined)?.id;
check("record.remember id", typeof recordId === "string" && recordId.length > 0, rem.raw);

// 3) record.recall finds the remembered record by lexical query.
const rec = run(
  JSON.stringify({
    v: 1,
    op: "record.recall",
    params: { query: "persimmon harvest", scope: SCOPE, limit: 10 },
  }),
);
const items = (dataOf(rec.body)["items"] as Array<{ id?: string }> | undefined) ?? [];
check("record.recall", rec.status === 0 && rec.body?.["code"] === "OK", rec.raw);
check(
  "record.recall hit",
  items.some((i) => i.id === recordId),
  JSON.stringify(items.map((i) => i.id)),
);

// 4) Approval-era ops stay rejected as unknown ops.
for (const op of ["candidate.create", "approve"]) {
  const r = run(JSON.stringify({ v: 1, op, idempotencyKey: "smoke-old-1", params: {} }));
  check(
    `old op rejected (${op})`,
    r.status === 0 && r.body?.["code"] === "BAD_REQUEST",
    r.raw,
  );
}

console.log("smoke OK");
