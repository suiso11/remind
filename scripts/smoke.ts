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
// Point the example DB at the temp dir so smoke never touches the repo.
const parsed = JSON.parse(fs.readFileSync(cfg, "utf8"));
parsed.dbPath = path.join(dir, "smoke.db");
fs.writeFileSync(cfg, JSON.stringify(parsed));

const cases: Array<[string, string]> = [
  ["valid recall envelope", JSON.stringify({ v: 1, op: "record.recall", params: {} })],
  ["unknown op", JSON.stringify({ v: 1, op: "nope.nope", params: {} })],
  ["human op over JSON", JSON.stringify({ v: 1, op: "approve", params: {} })],
];

let failed = 0;
for (const [name, input] of cases) {
  const r = spawnSync(process.execPath, [cli, "--config", cfg], {
    input: input + "\n",
    encoding: "utf8",
  });
  const line = (r.stdout || "").trim();
  console.log(`--- ${name} (exit=${r.status})`);
  console.log(line || "(no stdout)");
  if (r.status !== 0 || line.length === 0) failed++;
}
if (failed > 0) {
  console.error(`smoke FAILED (${failed} cases)`);
  process.exit(1);
}
console.log("smoke OK");
