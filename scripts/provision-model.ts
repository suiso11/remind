/**
 * Explicit model provisioning (the ONLY network step in M2).
 *
 * Downloads the pinned public ONNX embedding files at the pinned revision:
 *   Xenova/paraphrase-multilingual-MiniLM-L12-v2 @ 2c4055b12046f11709e9df2c122e59ffbdc2f900
 *   (base sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2, Apache-2.0)
 * Runtime (@huggingface/transformers + onnxruntime-node) afterwards runs
 * fully offline from these local files; no queries/memories leave the host.
 *
 * Usage: node dist/scripts/provision-model.js [--dir <modelDir>] [--config <path>]
 * Writes <modelDir>/manifest.json with sha256+bytes per file. Idempotent:
 * skips files whose recorded hash already matches. Exit non-zero with a
 * fixed stderr line on any failure (no secrets, no body echo).
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  VECTOR_DIM,
  VECTOR_MODEL_FILES,
  VECTOR_MODEL_ID,
  VECTOR_MODEL_LICENSE,
  VECTOR_MODEL_REVISION,
} from "../src/vectors.js";

const BASE = `https://huggingface.co/${VECTOR_MODEL_ID}/resolve/${VECTOR_MODEL_REVISION}`;

function sha256File(p: string): { sha256: string; bytes: number } {
  const data = fs.readFileSync(p);
  return { sha256: createHash("sha256").update(data).digest("hex"), bytes: data.length };
}

async function fetchTo(url: string, dest: string): Promise<void> {
  const res = await fetch(url, { redirect: "follow" });
  if (!res.ok) throw new Error(`download failed: ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length === 0) throw new Error("download failed: empty file");
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, buf);
  fs.renameSync(tmp, dest);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  let dir = process.env["REMIND_MODEL_DIR"] ?? "./models/paraphrase-multilingual-MiniLM-L12-v2";
  let configPath: string | null = null;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--dir" && i + 1 < args.length) dir = args[++i]!;
    else if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i]!;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: provision-model [--dir <modelDir>] [--config <path>]\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }
  if (configPath) {
    try {
      const { loadConfig } = await import("../src/config.js");
      const cfg = loadConfig(configPath);
      if (cfg.vectors?.modelDir) {
        const { resolveConfigDirPath } = await import("../src/config.js");
        dir = resolveConfigDirPath(configPath, cfg.vectors.modelDir);
      }
    } catch {
      process.stderr.write("error: invalid config\n");
      process.exit(2);
    }
  }
  const modelDir = path.resolve(dir);
  try {
    const manifestPath = path.join(modelDir, "manifest.json");
    let prev: Record<string, { sha256: string; bytes: number }> = {};
    try {
      const m = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
        model?: string;
        revision?: string;
        files?: Record<string, { sha256: string; bytes: number }>;
      };
      if (m.model === VECTOR_MODEL_ID && m.revision === VECTOR_MODEL_REVISION && m.files) {
        prev = m.files;
      }
    } catch {
      /* fresh provision */
    }
    const files: Record<string, { sha256: string; bytes: number }> = {};
    for (const f of VECTOR_MODEL_FILES) {
      const dest = path.join(modelDir, f);
      let skip = false;
      if (prev[f]) {
        try {
          const cur = sha256File(dest);
          if (cur.sha256 === prev[f]!.sha256 && cur.bytes === prev[f]!.bytes) {
            files[f] = cur;
            skip = true;
          }
        } catch {
          /* re-download */
        }
      }
      if (!skip) {
        process.stderr.write(`provision: downloading ${f}\n`);
        await fetchTo(`${BASE}/${f}`, dest);
        files[f] = sha256File(dest);
      }
    }
    const manifest = {
      model: VECTOR_MODEL_ID,
      revision: VECTOR_MODEL_REVISION,
      license: VECTOR_MODEL_LICENSE,
      dim: VECTOR_DIM,
      files,
    };
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");
    const total = Object.values(files).reduce((n, f) => n + f.bytes, 0);
    process.stdout.write(JSON.stringify({ ok: true, model: VECTOR_MODEL_ID, revision: VECTOR_MODEL_REVISION, dim: VECTOR_DIM, files: Object.keys(files).length, bytes: total, dir: modelDir }) + "\n");
  } catch {
    process.stderr.write("error: model provisioning failed\n");
    process.exit(1);
  }
}

void main();
