import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig } from "../src/config.js";

function tmpConfig(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-cfg-"));
  const p = path.join(dir, "memory.config.json");
  fs.writeFileSync(p, JSON.stringify(obj));
  return p;
}

const VALID = {
  dbPath: "./t1.db",
  allowedScopes: ["personal/default"],
  candidateTtlSec: 259200,
  limits: {
    bodyMaxCp: 2000,
    queryMaxCp: 500,
    tagsMax: 5,
    limitDefault: 10,
    limitMax: 25,
    snippetMaxCp: 200,
    responseMaxBytes: 8192,
  },
  timeouts: { cliMs: 5000, busyMs: 2000 },
  dbMaxBytes: 104857600,
};

describe("config", () => {
  it("loads the documented example values", () => {
    const cfg = loadConfig(tmpConfig(VALID));
    assert.equal(cfg.limits.limitDefault, 10);
    assert.deepEqual(cfg.allowedScopes, ["personal/default"]);
  });

  it("rejects unknown top-level fields", () => {
    assert.throws(() =>
      loadConfig(tmpConfig({ ...VALID, actor: "alice" })),
    );
  });

  it("rejects unknown nested fields", () => {
    assert.throws(() =>
      loadConfig(
        tmpConfig({ ...VALID, limits: { ...VALID.limits, extra: 1 } }),
      ),
    );
  });

  it("rejects missing sections and inverted limits", () => {
    const { limits: _drop, ...rest } = VALID;
    assert.throws(() => loadConfig(tmpConfig(rest)));
    assert.throws(() =>
      loadConfig(
        tmpConfig({
          ...VALID,
          limits: { ...VALID.limits, limitDefault: 30, limitMax: 25 },
        }),
      ),
    );
  });

  it("rejects empty/duplicate/control-char scopes", () => {
    assert.throws(() => loadConfig(tmpConfig({ ...VALID, allowedScopes: [] })));
    assert.throws(() =>
      loadConfig(
        tmpConfig({ ...VALID, allowedScopes: ["a", "a"] }),
      ),
    );
    assert.throws(() =>
      loadConfig(tmpConfig({ ...VALID, allowedScopes: ["bad\nscope"] })),
    );
  });

  it("rejects unreadable and non-JSON configs", () => {
    assert.throws(() => loadConfig(path.join(os.tmpdir(), "no-such-dir-xyz", "c.json")));
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-cfg-"));
    const p = path.join(dir, "c.json");
    fs.writeFileSync(p, "{not json");
    assert.throws(() => loadConfig(p));
  });
});
