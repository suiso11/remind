import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

test("npm bin symlink runs the CLI entry point", {skip: process.platform === "win32"}, () => {
  const dir = mkdtempSync(join(tmpdir(), "remind-bin-"));
  try {
    const bin = join(dir, "memory-cli");
    symlinkSync(resolve(__dirname, "../src/cli.js"), bin);
    const result = spawnSync(bin, ["--help"], {encoding: "utf8"});
    assert.equal(result.error, undefined);
    assert.equal(result.status, 0);
    assert.match(result.stderr, /usage: memory-cli --config <path>/);
  } finally {
    rmSync(dir, {recursive: true, force: true});
  }
});
