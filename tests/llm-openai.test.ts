/**
 * OpenAI-compatible loopback LLM backend.
 *
 * The server is a real node:http listener on 127.0.0.1:0 so fetch/AbortController,
 * message conversion, auth headers, and the maintenance flows run end-to-end
 * without external network or model files.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import type { AddressInfo } from "node:net";
import { DatabaseSync } from "node:sqlite";
import { isLoopbackHttpUrl, loadConfig, type AppConfig, type LlmConfig } from "../src/config.js";
import { initDb } from "../src/db.js";
import { eventAppend, getRecord, rememberRecord } from "../src/store.js";
import { maintainDistill } from "../src/distill.js";
import { maintainEpisodes } from "../src/episodes.js";
import { maintainAssociate } from "../src/associate.js";
import {
  chatMlToMessages,
  generateCompletion,
  llmUsable,
  openAiChatCompletionsUrl,
  resetLlmRuntime,
  stripThinkingBlocks,
} from "../src/llm.js";
import { VECTOR_DIM, normalizeVec } from "../src/vectors.js";

const SCOPE = "personal/default";
const OBS = "2026-09-01T00:00:00.000Z";
const T1 = "2026-09-01T01:00:00.000Z";
const DRAIN_NOW = "2026-12-01T00:00:00.000Z";

interface Captured {
  url: string;
  headers: http.IncomingHttpHeaders;
  body: {
    model?: string;
    messages?: Array<{ role: string; content: string }>;
    temperature?: number;
    max_tokens?: number;
    seed?: number;
    chat_template_kwargs?: { enable_thinking?: boolean };
  };
}
interface ScriptResult {
  content?: string;
  status?: number;
  delayMs?: number;
  location?: string;
}

async function withServer<T>(
  script: (body: Captured["body"]) => ScriptResult,
  fn: (baseUrl: string, requests: Captured[]) => Promise<T>,
): Promise<T> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
    });
    req.on("end", () => {
      const body = JSON.parse(raw) as Captured["body"];
      requests.push({ url: req.url ?? "", headers: req.headers, body });
      const result = script(body);
      const send = (): void => {
        res.statusCode = result.status ?? 200;
        if (result.location) res.setHeader("location", result.location);
        res.setHeader("content-type", "application/json");
        if (result.status !== undefined && result.status >= 400) {
          res.end(JSON.stringify({ error: { message: "scripted failure" } }));
          return;
        }
        if (result.status !== undefined && result.status >= 300) {
          res.end();
          return;
        }
        res.end(JSON.stringify({ choices: [{ message: { content: result.content ?? "" } }] }));
      };
      if (result.delayMs !== undefined) setTimeout(send, result.delayMs);
      else send();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;
  try {
    return await fn(`http://127.0.0.1:${port}`, requests);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function baseConfig(dir: string): AppConfig {
  return {
    dbPath: path.join(dir, "t.db"),
    vaultPath: path.join(dir, "vault"),
    allowedScopes: [SCOPE],
    limits: {
      bodyMaxCp: 2000,
      queryMaxCp: 500,
      tagsMax: 5,
      linksMax: 10,
      sourceRefsMax: 10,
      limitDefault: 10,
      limitMax: 25,
      snippetMaxCp: 200,
      responseMaxBytes: 8192,
    },
    timeouts: { cliMs: 5000, busyMs: 2000 },
    dbMaxBytes: 104857600,
  };
}

function openAiLlm(baseUrl: string, extra: Partial<LlmConfig> = {}): LlmConfig {
  return {
    backend: "openai",
    modelDir: path.join("/nonexistent", "onnx-model"),
    baseUrl,
    model: "ornith-test",
    enabled: true,
    timeoutMs: 5000,
    maxNewTokens: 48,
    maxPromptChars: 2000,
    ...extra,
  };
}

interface Ctx {
  dir: string;
  config: AppConfig;
  configPath: string;
  db: DatabaseSync;
  cleanup: () => void;
}

function setup(llm: LlmConfig): Ctx {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "llm-openai-"));
  const config = baseConfig(dir);
  config.llm = llm;
  const configPath = path.join(dir, "memory.config.json");
  const { db } = initDb(config, configPath);
  return {
    dir,
    config,
    configPath,
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        /* ignore */
      }
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function remember(db: DatabaseSync, config: AppConfig, body: string, key: string): string {
  const eventId = `ev-${key}`;
  const er = eventAppend(
    db,
    config,
    {
      eventId,
      sessionId: "s1",
      turnId: "t1",
      body: `raw ${key}`,
      provenance: { source: `session:s1:turn:${key}`, observedAt: OBS },
      scope: SCOPE,
    },
    `evk-${key}`,
    OBS,
  );
  assert.equal(er.ok, true, JSON.stringify(er));
  const res = rememberRecord(
    db,
    config,
    {
      body,
      kind: "user_fact",
      provenance: { source: `session:s1:turn:${key}`, observedAt: OBS },
      scope: SCOPE,
      sourceRefs: [eventId],
    },
    `rem-${key}`,
    OBS,
  );
  assert.equal(res.ok, true, JSON.stringify(res));
  return (res.data as { record: { id: string } }).record.id;
}

function systemText(body: Captured["body"]): string {
  return (body.messages ?? []).map((m) => m.content).join("\n");
}

const cfgDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "llm-config-"));

describe("llm backend config validation", () => {
  it("defaults to onnx and keeps the openai fields out of onnx configs", () => {
    const dir = cfgDir();
    try {
      const example = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "memory.config.example.json"), "utf8"),
      ) as Record<string, unknown>;
      const p = path.join(dir, "c.json");
      fs.writeFileSync(p, JSON.stringify(example));
      const cfg = loadConfig(p);
      assert.equal(cfg.llm?.backend, "onnx");
      const withUrl = { ...example, llm: { ...(example["llm"] as object), baseUrl: "http://127.0.0.1:8080" } };
      fs.writeFileSync(p, JSON.stringify(withUrl));
      assert.throws(() => loadConfig(p), /requires llm\.backend "openai"/);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("accepts loopback http(s) origins and origin/v1 only", () => {
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:8080"), true);
    assert.equal(isLoopbackHttpUrl("http://localhost:8080/v1"), true);
    assert.equal(isLoopbackHttpUrl("https://[::1]:8443/"), true);
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1:8080/api"), false);
    assert.equal(isLoopbackHttpUrl("http://127.0.0.1.evil.com:8080"), false);
    assert.equal(isLoopbackHttpUrl("http://[::2]:8080"), false);
    assert.equal(isLoopbackHttpUrl("ftp://127.0.0.1:8080"), false);
    assert.equal(isLoopbackHttpUrl("http://user:pass@127.0.0.1:8080"), false);
  });

  it("rejects non-loopback and malformed openai configs at startup", () => {
    const dir = cfgDir();
    try {
      const example = JSON.parse(
        fs.readFileSync(path.join(process.cwd(), "memory.config.example.json"), "utf8"),
      ) as Record<string, unknown>;
      const p = path.join(dir, "c.json");
      const write = (llm: Record<string, unknown>): void =>
        fs.writeFileSync(p, JSON.stringify({ ...example, llm }));
      write({ backend: "openai", enabled: true, baseUrl: "http://example.com:8080", model: "m" });
      assert.throws(() => loadConfig(p), /loopback/);
      write({ backend: "openai", enabled: true, baseUrl: "http://127.0.0.1:8080" });
      assert.throws(() => loadConfig(p), /llm\.model/);
      write({ backend: "openai", enabled: true, baseUrl: "http://127.0.0.1:8080", model: "m", apiKeyEnv: "BAD-NAME" });
      assert.throws(() => loadConfig(p), /llm\.apiKeyEnv/);
      write({ backend: "openai", enabled: true, baseUrl: "http://127.0.0.1:8080", model: "m", disableThinking: "no" });
      assert.throws(() => loadConfig(p), /llm\.disableThinking/);
      write({ backend: "openai", enabled: true, baseUrl: "http://127.0.0.1:8080", model: "m", nope: 1 });
      assert.throws(() => loadConfig(p), /unknown llm field: nope/);
      write({ backend: "openai", enabled: true, baseUrl: "http://localhost:8080/v1", model: "m" });
      const cfg = loadConfig(p);
      assert.equal(cfg.llm?.backend, "openai");
      assert.equal(cfg.llm?.disableThinking, true);
      assert.equal(llmUsable(cfg, path.join(dir, "missing")), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("llmUsable keeps onnx file-based and openai file-free", () => {
    const dir = cfgDir();
    try {
      const onnx = baseConfig(dir);
      onnx.llm = { enabled: true, modelDir: path.join(dir, "missing"), timeoutMs: 5000, maxNewTokens: 48, maxPromptChars: 2000 };
      assert.equal(llmUsable(onnx, path.join(dir, "missing")), false);
      const openai = baseConfig(dir);
      openai.llm = openAiLlm("http://127.0.0.1:9999");
      assert.equal(llmUsable(openai, path.join(dir, "missing")), true);
      openai.llm.enabled = false;
      assert.equal(llmUsable(openai, path.join(dir, "missing")), false);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("ChatML conversion and response normalization", () => {
  const prompt =
    "<|im_start|>system\nYou summarize.<|im_end|>\n" +
    "<|im_start|>user\nText<|im_end|>\n" +
    "<|im_start|>assistant\n要約：";

  it("converts roles and preserves a trailing assistant prefill", () => {
    const conv = chatMlToMessages(prompt);
    assert.ok(conv);
    assert.deepEqual(conv.messages, [
      { role: "system", content: "You summarize." },
      { role: "user", content: "Text" },
      { role: "assistant", content: "要約：" },
    ]);
    assert.equal(conv.prefill, "要約：");
  });

  it("rejects malformed roles and non-assistant open turns", () => {
    assert.equal(chatMlToMessages("<|im_start|>tool\nx<|im_end|>"), null);
    assert.equal(chatMlToMessages("<|im_start|>user\nx"), null);
  });

  it("strips think blocks and accepts origin/v1 base URLs", () => {
    assert.equal(stripThinkingBlocks("<think>hidden</think>\nOK"), "OK");
    assert.equal(stripThinkingBlocks("a<THINK>b</THINK>c"), "ac");
    assert.equal(openAiChatCompletionsUrl("http://127.0.0.1:8080"), "http://127.0.0.1:8080/v1/chat/completions");
    assert.equal(openAiChatCompletionsUrl("http://127.0.0.1:8080/v1/"), "http://127.0.0.1:8080/v1/chat/completions");
  });
});

describe("openai generateCompletion", () => {
  it("sends ChatML as messages, prefill, greedy params, and strips the echoed cue", async () => {
    await withServer(
      () => ({ content: "要約：青い自転車を買った。" }),
      async (url, requests) => {
        const config = baseConfig(os.tmpdir());
        config.llm = openAiLlm(url, { maxNewTokens: 8 });
        const prompt =
          "<|im_start|>system\nYou summarize.<|im_end|>\n" +
          "<|im_start|>user\nText<|im_end|>\n" +
          "<|im_start|>assistant\n要約：";
        const out = await generateCompletion(prompt, "/nonexistent", {
          timeoutMs: 2000,
          maxNewTokens: 8,
          config,
        });
        assert.equal(out, "青い自転車を買った。");
        assert.equal(requests.length, 1);
        const req = requests[0]!;
        assert.equal(req.url, "/v1/chat/completions");
        assert.equal(req.body.model, "ornith-test");
        assert.equal(req.body.temperature, 0);
        assert.equal(req.body.max_tokens, 8);
        assert.equal(req.body.seed, 0);
        assert.deepEqual(req.body.chat_template_kwargs, { enable_thinking: false });
        assert.deepEqual(req.body.messages, [
          { role: "system", content: "You summarize." },
          { role: "user", content: "Text" },
          { role: "assistant", content: "要約：" },
        ]);
      },
    );
    resetLlmRuntime();
  });

  it("strips think blocks by default and disables the template", async () => {
    await withServer(
      () => ({ content: "<think>secret</think>\nOK" }),
      async (url, requests) => {
        const config = baseConfig(os.tmpdir());
        config.llm = openAiLlm(url);
        const prompt = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n";
        const out = await generateCompletion(prompt, "/nonexistent", { timeoutMs: 2000, maxNewTokens: 8, config });
        assert.equal(out, "OK");
        assert.deepEqual(requests[0]!.body.chat_template_kwargs, { enable_thinking: false });
      },
    );
    resetLlmRuntime();
  });

  it("keeps think blocks when disableThinking is false and sends no template kwargs", async () => {
    await withServer(
      () => ({ content: "<think>kept</think>" }),
      async (url, requests) => {
        const config = baseConfig(os.tmpdir());
        config.llm = openAiLlm(url, { disableThinking: false });
        const prompt = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n";
        const out = await generateCompletion(prompt, "/nonexistent", { timeoutMs: 2000, maxNewTokens: 8, config });
        assert.equal(out, "<think>kept</think>");
        assert.equal(requests[0]!.body.chat_template_kwargs, undefined);
      },
    );
    resetLlmRuntime();
  });

  it("sends the bearer token from apiKeyEnv and returns null on non-2xx", async () => {
    process.env["REMIND_TEST_LLM_TOKEN"] = "test-secret";
    try {
      await withServer(
        () => ({ status: 500 }),
        async (url, requests) => {
          const config = baseConfig(os.tmpdir());
          config.llm = openAiLlm(url, { apiKeyEnv: "REMIND_TEST_LLM_TOKEN" });
          const prompt = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n";
          const out = await generateCompletion(prompt, "/nonexistent", { timeoutMs: 2000, maxNewTokens: 8, config });
          assert.equal(out, null);
          assert.equal(requests[0]!.headers["authorization"], "Bearer test-secret");
        },
      );
    } finally {
      delete process.env["REMIND_TEST_LLM_TOKEN"];
      resetLlmRuntime();
    }
  });

  it("does not follow a redirect away from the loopback endpoint", async () => {
    let redirectedHits = 0;
    const outside = http.createServer((_req, res) => {
      redirectedHits++;
      res.end(JSON.stringify({ choices: [{ message: { content: "leaked" } }] }));
    });
    await new Promise<void>((resolve) => outside.listen(0, "127.0.0.1", resolve));
    const outsideUrl = `http://127.0.0.1:${(outside.address() as AddressInfo).port}/leak`;
    try {
      await withServer(
        () => ({ status: 302, location: outsideUrl }),
        async (url) => {
          const config = baseConfig(os.tmpdir());
          config.llm = openAiLlm(url);
          const prompt = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n";
          const out = await generateCompletion(prompt, "/nonexistent", { timeoutMs: 2000, maxNewTokens: 8, config });
          assert.equal(out, null);
        },
      );
      assert.equal(redirectedHits, 0, "redirect target must never be contacted");
    } finally {
      outside.closeAllConnections();
      await new Promise<void>((resolve) => outside.close(() => resolve()));
      resetLlmRuntime();
    }
  });

  it("aborts on timeout, returns null, and poisons further calls", async () => {
    await withServer(
      () => ({ content: "late", delayMs: 500 }),
      async (url, requests) => {
        const config = baseConfig(os.tmpdir());
        config.llm = openAiLlm(url);
        const prompt = "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\n";
        const started = Date.now();
        const first = await generateCompletion(prompt, "/nonexistent", { timeoutMs: 100, maxNewTokens: 8, config });
        assert.equal(first, null);
        assert.ok(Date.now() - started < 450, "timeout must abort promptly");
        const second = await generateCompletion(prompt, "/nonexistent", { timeoutMs: 100, maxNewTokens: 8, config });
        assert.equal(second, null);
        assert.equal(requests.length, 1, "poisoned backend must refuse new work");
      },
    );
    resetLlmRuntime();
  });
});

describe("openai backend maintenance flows", () => {
  it("runs maintain.distill through the server and applies a retire verdict", async () => {
    await withServer(
      (body) => {
        const text = systemText(body);
        if (text.includes("You judge one memory")) return { content: "NONE" };
        return { content: "KEEP" };
      },
      async (url, requests) => {
        const ctx = setup(openAiLlm(url));
        try {
          const id = remember(ctx.db, ctx.config, "a passing mood with no lasting content", "distill-1");
          const res = await maintainDistill(
            ctx.db,
            ctx.config,
            ctx.configPath,
            { scope: SCOPE, limit: 5 },
            "openai-distill-1",
            undefined,
            DRAIN_NOW,
          );
          assert.equal(res.ok, true, JSON.stringify(res));
          const d = (res.data as { distill: { reviewed: number; applied: number } }).distill;
          assert.equal(d.reviewed, 1);
          assert.equal(d.applied, 1);
          const got = getRecord(ctx.db, ctx.config, { id, scope: SCOPE });
          assert.equal((got.data as { record: { status: string } }).record.status, "retired");
          assert.ok(requests.length >= 1);
          assert.equal(requests[0]!.url, "/v1/chat/completions");
          assert.ok(systemText(requests[0]!.body).includes("You judge one memory"));
        } finally {
          ctx.cleanup();
        }
      },
    );
    resetLlmRuntime();
  });

  it("runs maintain.episodes end-to-end through the server", async () => {
    await withServer(
      (body) => {
        const text = systemText(body);
        if (text.includes("You summarize part of an episode")) {
          return { content: "The blue bicycle was bought at the shop on Monday." };
        }
        if (text.includes("You verify a summary")) return { content: "YES" };
        if (text.includes("You summarize an episode from numbered notes")) {
          return { content: "The blue bicycle was bought at the shop on Monday. [1]" };
        }
        if (text.includes("You verify a claim")) return { content: "YES" };
        return { content: "NO" };
      },
      async (url, requests) => {
        const ctx = setup(openAiLlm(url));
        try {
          const body = "The blue bicycle was bought at the shop on Monday.";
          const er = eventAppend(
            ctx.db,
            ctx.config,
            {
              eventId: "ep-1",
              sessionId: "s1",
              turnId: "t1",
              body,
              provenance: { source: "session:s1:turn:1", observedAt: OBS },
              scope: SCOPE,
            },
            "openai-ep-ev-1",
            OBS,
          );
          assert.equal(er.ok, true, JSON.stringify(er));
          const res = await maintainEpisodes(
            ctx.db,
            ctx.config,
            ctx.configPath,
            { scope: SCOPE, kind: "session" },
            "openai-ep-1",
            undefined,
            T1,
          );
          assert.equal(res.ok, true, JSON.stringify(res));
          const data = res.data as {
            applied: number;
            episodes: Array<{ episodeRecordId: string | null }>;
          };
          assert.ok(data.applied > 0, JSON.stringify(data));
          assert.equal(data.episodes.length, 1);
          assert.ok(data.episodes[0]?.episodeRecordId);
          assert.ok(requests.length >= 3, `expected window/verify/reduce calls, got ${requests.length}`);
        } finally {
          ctx.cleanup();
        }
      },
    );
    resetLlmRuntime();
  });

  it("runs maintain.associate topic extraction through the server", async () => {
    await withServer(
      (body) => {
        const text = systemText(body);
        if (text.includes("記憶の話題分類器")) return { content: "乗り物、整備" };
        return { content: "NONE" };
      },
      async (url, requests) => {
        const ctx = setup(openAiLlm(url));
        try {
          ctx.config.associate = {
            batchMax: 50,
            topK: 5,
            minScore: 0.45,
            llmTopics: true,
          };
          const id = remember(ctx.db, ctx.config, "motorcycle maintenance notes", "assoc-1");
          const v = new Float32Array(VECTOR_DIM);
          v[0] = 1;
          const vec = normalizeVec(v);
          // Distinct directions so topic canonicalization does not merge the
          // two topics via the near-synonym threshold.
          const embed = async (texts: string[]): Promise<Float32Array[] | null> =>
            texts.map((_, i) => {
              const out = new Float32Array(vec);
              if (i > 0) out[1] = 1;
              return normalizeVec(out);
            });
          const res = await maintainAssociate(
            ctx.db,
            ctx.config,
            ctx.configPath,
            { scope: SCOPE },
            "openai-assoc-1",
            embed,
            T1,
            undefined,
          );
          assert.equal(res.ok, true, JSON.stringify(res));
          const d = (res.data as { associate: { topicsWritten: number; topicsDegraded: boolean } }).associate;
          assert.equal(d.topicsDegraded, false);
          assert.equal(d.topicsWritten, 1);
          const rows = ctx.db
            .prepare(`SELECT topic, origin FROM record_topics WHERE recordId=? ORDER BY topic`)
            .all(id) as Array<{ topic: string; origin: string }>;
          assert.deepEqual(rows.map((r) => r.topic).sort(), ["乗り物", "整備"].sort());
          assert.equal(rows[0]?.origin, "llm");
          assert.ok(requests.some((r) => systemText(r.body).includes("記憶の話題分類器")));
        } finally {
          ctx.cleanup();
        }
      },
    );
    resetLlmRuntime();
  });
});
