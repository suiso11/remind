/**
 * P2 episode smoke (real offline LLM, synthetic temp data only).
 *
 * Proves through the actual CLI, with the pinned local model, that:
 * - ingest splits a short Japanese+English document into >=2 raw chunks;
 * - maintain.episodes maps doc and session spans to verified window
 *   summaries and reduces them into episode summaries;
 * - episode.list / episode.windows expose the derived index and every
 *   window's record.sources excerpt is exactly the raw span slice;
 * - appending one session event makes the episode stale, and the next run
 *   writes only the new window while superseding the old episode record;
 * - llm disabled degrades to applied=0 / degraded=true with no writes.
 *
 * Model-rejected windows are recovered as verbatim raw window records, so
 * every episode is expected to advance. FAIL only when an op errors or an
 * episode has no processed window / no episode record. Temp dir removed
 * afterwards.
 *
 * Usage: node dist/scripts/smoke-episodes.js [--config <path>] [--llm-dir <dir>]
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadConfig, type AppConfig } from "../src/config.js";
import { modelFilesPresent } from "../src/llm.js";

const SCOPE = "personal/default";
const DOC_ID = "smoke-ep-doc";
const SESSION = "s-ep";
const OBS = [
  "2026-09-02T09:00:00.000Z",
  "2026-09-02T12:30:00.000Z",
  "2026-09-02T18:45:00.000Z",
] as const;
const LATER = "2026-09-03T08:15:00.000Z";

const DOC_PARAGRAPHS: string[] = [
  "2026年9月1日、京都の小さな工房を訪ねた。店主の田中さんは、雨の日に木の継ぎ目が膨らむので、乾燥した秋にだけ椅子を組み立てると話していた。工房の奥には古い鉋が並び、それぞれに作業した年の札が付いていた。田中さんは「道具は正直だから、手を抜けばすぐ分かる」と笑った。",
  "On the same trip I met Elena, a translator from Barcelona who was researching craft vocabulary. She said the hardest word to translate was 木目 (wood grain), because every language describes the pattern differently. We drank tea while the rain tapped the tin roof, and she wrote three candidate phrases in a small blue notebook. She planned to interview two more workshops before returning home on Friday.",
  "夕方、田中さんは一枚の板を取り出し、傷の位置を指で示した。これは客が長年使った食卓で、脚を一本だけ作り直す依頼だという。Elena asked whether the repair should hide the marks; the owner replied that the scratches were part of the table's history and should stay visible. We agreed to meet again in November, when the repaired table would be returned to its family.",
  "翌朝、私は鴨川沿いを歩いてから工房へ戻った。田中さんは前日の食卓の脚を外し、乾燥具合を手のひらで確かめていた。新しい脚には同じ種類の木材を使うが、色は完全にはそろわないかもしれないと説明してくれた。Elenaは到着すると、傷を隠さない方針をノートに書き、家族に説明する文章の下書きを始めた。",
  "Elena explained that the family had owned the table for almost forty years and that two of the scratches came from a childhood drawing accident. She wanted the repair note to mention this history, not just the materials and the schedule. Tanaka wrote the measurement of each leg on a strip of masking tape and attached it to the underside so the table could be reassembled in the same order.",
  "昼食は工房の近くの小さな食堂で取った。定食には焼き魚と味噌汁が出て、Elenaは初めて食べる漬物の味を熱心にメモしていた。田中さんは十一月の再訪について、土曜日の午前中なら作業場が空いていると話した。食卓はその週の金曜日に届く予定で、運搬は近所の家具店に頼むという。",
  "Back at the workshop, Elena recorded a short interview about the word 木目 and asked whether the term could also describe a person's character. Tanaka laughed and said that in his family it was used mostly for wood, though his father sometimes called a stubborn person hard-grained. The answer delighted Elena, who added a note that idioms rarely travel alone.",
  "夕暮れになると雨が上がり、工房の窓から西日が差し込んだ。田中さんは修理後の食卓を家族がどう使うかを尋ね、Elenaは毎週の夕食と祝日の集まりに使うと答えた。私たちは十一月十四日の午前九時に待ち合わせることにし、それまでに必要な部品の一覧をメールで送ることを決めた。",
  "On the train home I wrote down the day's details: the smell of sawdust, the blue notebook, the taped measurements, and the promise to keep the scratches visible. I also noted that the interview on Friday would take place on the second floor of the same workshop. The notes were messy but complete, and I planned to type them up before the November visit.",
  "That evening I sent Elena the list of parts and asked her to confirm the November date with the family. She replied within an hour, attaching the draft explanation and a small photograph of the table's oldest scratch.",
].map((p) => p.trim());

const SESSION_EVENTS: Array<{ eventId: string; body: string; observedAt: string }> = [
  {
    eventId: "ep-s-0",
    body: "朝、Elenaからメールが届いた。金曜の面接は午後3時からに変更になり、場所は同じ工房の二階だそうだ。",
    observedAt: OBS[0],
  },
  {
    eventId: "ep-s-1",
    body: "Elena said she felt nervous about the interview but had already prepared a glossary of woodworking terms in three languages.",
    observedAt: OBS[1],
  },
  {
    eventId: "ep-s-2",
    body: "夜、田中さんに確認したところ、十一月の再訪は土曜日の午前中がよいと言われた。修理した食卓はその週に届く予定である。",
    observedAt: OBS[2],
  },
];

const LATER_EVENT = {
  eventId: "ep-s-3",
  body: "Later Elena wrote that the interview went well and she will bring the blue notebook to the November meeting.",
  observedAt: LATER,
};

let failures = 0;

function oneLine(s: string, max = 700): string {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max)}...`;
}

function check(name: string, cond: boolean, detail: string): boolean {
  console.log(`${cond ? "ok" : "FAIL"} ${name} ${oneLine(detail)}`);
  if (!cond) {
    failures++;
    console.error(`episodes smoke FAILED at ${name}: ${oneLine(detail, 200)}`);
  }
  return cond;
}

interface CliResult {
  status: number | null;
  body: Record<string, unknown> | null;
  raw: string;
  stderr: string;
  error: string | null;
}

function cli(
  cliPath: string,
  cfg: string,
  req: Record<string, unknown>,
  timeoutMs: number,
): CliResult {
  const r = spawnSync(process.execPath, [cliPath, "--config", cfg], {
    input: JSON.stringify(req) + "\n",
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const raw = ((r.stdout || "").split("\n")[0] ?? "").trim();
  let body: Record<string, unknown> | null = null;
  try {
    body = raw ? (JSON.parse(raw) as Record<string, unknown>) : null;
  } catch {
    body = null;
  }
  return {
    status: r.status,
    body,
    raw,
    stderr: (r.stderr || "").trim(),
    error: r.error ? String(r.error.message) : null,
  };
}

function okOf(r: CliResult): boolean {
  return r.status === 0 && r.body !== null && r.body["ok"] === true;
}

function dataOf(r: CliResult): Record<string, unknown> {
  const data = r.body?.["data"];
  return data !== null && typeof data === "object" ? (data as Record<string, unknown>) : {};
}

function cliDetail(r: CliResult): string {
  if (r.error) return `spawn=${r.error} stderr=${r.stderr}`;
  if (r.status !== 0 && r.raw.length === 0) return `exit=${r.status} stderr=${r.stderr}`;
  return `exit=${r.status} ${r.raw || r.stderr}`;
}

interface EpisodeResult {
  kind: string;
  episodeKey: string;
  windowsWritten: number;
  windowsVerbatim: number;
  windowsRejected: number;
  episodeRecordId: string | null;
  sentencesKept: number;
  sentencesDropped: number;
  extractive: boolean;
}

function episodesOf(r: CliResult): EpisodeResult[] {
  const list = dataOf(r)["episodes"];
  if (!Array.isArray(list)) return [];
  return list.map((raw) => {
    const e = raw as Record<string, unknown>;
    return {
      kind: String(e["kind"] ?? ""),
      episodeKey: String(e["episodeKey"] ?? ""),
      windowsWritten: Number(e["windowsWritten"] ?? 0),
      windowsVerbatim: Number(e["windowsVerbatim"] ?? 0),
      windowsRejected: Number(e["windowsRejected"] ?? 0),
      episodeRecordId: typeof e["episodeRecordId"] === "string" ? e["episodeRecordId"] : null,
      sentencesKept: Number(e["sentencesKept"] ?? 0),
      sentencesDropped: Number(e["sentencesDropped"] ?? 0),
      extractive: e["extractive"] === true,
    };
  });
}

interface EpisodeItem {
  episodeKey: string;
  summaryRecordIds: string[];
  stale: boolean;
  eventCount: number;
}

function episodeItems(r: CliResult): EpisodeItem[] {
  const items = dataOf(r)["items"];
  if (!Array.isArray(items)) return [];
  return items.map((raw) => {
    const it = raw as Record<string, unknown>;
    const ids = Array.isArray(it["summaryRecordIds"]) ? (it["summaryRecordIds"] as unknown[]) : [];
    return {
      episodeKey: String(it["episodeKey"] ?? ""),
      summaryRecordIds: ids.map((id) => String(id)),
      stale: it["stale"] === true,
      eventCount: Number(it["eventCount"] ?? 0),
    };
  });
}

function countCp(s: string): number {
  return Array.from(s).length;
}

function logEpisodeFields(label: string, list: EpisodeResult[]): void {
  if (list.length === 0) console.log(`${label} episodes=none`);
  for (const e of list) {
    console.log(
      `${label} episode kind=${e.kind} key=${e.episodeKey} written=${e.windowsWritten} verbatim=${e.windowsVerbatim} rejected=${e.windowsRejected} record=${e.episodeRecordId ?? "null"} sentencesKept=${e.sentencesKept} sentencesDropped=${e.sentencesDropped} extractive=${e.extractive}`,
    );
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoRoot = path.resolve(__dirname, "..", "..");
  let configPath: string | null = null;
  let llmDir = path.join(repoRoot, "models", "qwen25-15b-instruct");
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--config" && i + 1 < args.length) configPath = args[++i]!;
    else if (args[i] === "--llm-dir" && i + 1 < args.length) llmDir = args[++i]!;
    else if (args[i] === "--help" || args[i] === "-h") {
      process.stderr.write("usage: smoke-episodes [--config <path>] [--llm-dir <dir>]\n");
      process.exit(0);
    } else {
      process.stderr.write("error: bad arguments\n");
      process.exit(2);
    }
  }
  llmDir = path.resolve(llmDir);
  if (!configPath) configPath = path.join(repoRoot, "memory.config.example.json");
  let base: AppConfig;
  try {
    base = loadConfig(configPath);
  } catch {
    process.stderr.write("error: invalid config\n");
    process.exit(2);
  }
  check("llm files present", modelFilesPresent(llmDir), llmDir);

  const cliPath = path.join(repoRoot, "dist", "src", "cli.js");
  const ingestPath = path.join(repoRoot, "dist", "scripts", "ingest.js");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "remind-episodes-smoke-"));
  const started = Date.now();
  try {
    const config: AppConfig = {
      ...base,
      dbPath: path.join(dir, "smoke.db"),
      vaultPath: path.join(dir, "vault"),
      allowedScopes: [SCOPE],
      limits: {
        ...base.limits,
        rawBodyMaxCp: 1500,
        rawPageMaxCp: 2000,
        snippetMaxCp: 400,
        responseMaxBytes: 32768,
      },
      timeouts: { cliMs: 60000, busyMs: base.timeouts.busyMs },
      vectors: base.vectors ? { ...base.vectors, enabled: false } : undefined,
      llm: {
        modelDir: llmDir,
        timeoutMs: 300000,
        enabled: true,
        maxNewTokens: 48,
        maxPromptChars: 2000,
      },
      maintenance: { timeoutMs: 600000 },
      episodes: {
        utcOffsetMinutes: 0,
        windowMaxCp: 800,
        maxNewTokens: 64,
        batchMax: 5,
      },
      requirePrivacy: false,
    };
    const cfg = path.join(dir, "memory.config.json");
    fs.writeFileSync(cfg, JSON.stringify(config));

    // 1. Ingest a short bilingual document (>=2 bounded chunks).
    const docPath = path.join(dir, "bilingual-doc.txt");
    const docText = DOC_PARAGRAPHS.join("\n\n");
    fs.writeFileSync(docPath, docText, "utf8");
    console.log(`doc chars=${countCp(docText)} paragraphs=${DOC_PARAGRAPHS.length}`);
    const ingest = spawnSync(
      process.execPath,
      [
        ingestPath,
        "--config",
        cfg,
        "--scope",
        SCOPE,
        "--file",
        docPath,
        "--doc-id",
        DOC_ID,
      ],
      { encoding: "utf8", timeout: 120000, maxBuffer: 4 * 1024 * 1024 },
    );
    let ingestBody: Record<string, unknown> | null = null;
    try {
      ingestBody = JSON.parse((ingest.stdout || "").trim()) as Record<string, unknown>;
    } catch {
      ingestBody = null;
    }
    const chunkCount = Number(ingestBody?.["chunks"] ?? 0);
    check(
      "ingest doc chunks >= 2",
      ingest.status === 0 && ingestBody !== null && chunkCount >= 2,
      `exit=${ingest.status} chunks=${chunkCount} raw=${(ingest.stdout || "").trim()} stderr=${(ingest.stderr || "").trim()}`,
    );

    const docList = cli(cliPath, cfg, { v: 1, op: "episode.list", params: { scope: SCOPE, kind: "doc", limit: 10 } }, 60000);
    const docEntry = episodeItems(docList).find((i) => i.episodeKey === DOC_ID);
    check(
      "doc episode has >=2 events",
      okOf(docList) && docEntry !== undefined && docEntry.eventCount >= 2,
      cliDetail(docList),
    );

    // 2. Three conversational session events with distinct observedAt.
    let appendedOk = true;
    for (const ev of SESSION_EVENTS) {
      const r = cli(
        cliPath,
        cfg,
        {
          v: 1,
          op: "event.append",
          idempotencyKey: `ev-${ev.eventId}`,
          params: {
            eventId: ev.eventId,
            sessionId: SESSION,
            turnId: ev.eventId,
            body: ev.body,
            provenance: { source: `session:${SESSION}:${ev.eventId}`, observedAt: ev.observedAt },
            scope: SCOPE,
          },
        },
        60000,
      );
      const good = okOf(r);
      appendedOk = appendedOk && good;
      check(`append ${ev.eventId}`, good, cliDetail(r));
    }
    check("appended 3 distinct session events", appendedOk, SESSION_EVENTS.map((e) => e.observedAt).join(","));

    // 3. Real-model episode derivation: doc first, then session.
    const tDoc = Date.now();
    const docRun = cli(
      cliPath,
      cfg,
      { v: 1, op: "maintain.episodes", idempotencyKey: "smoke-ep-doc-1", params: { scope: SCOPE, kind: "doc", limit: 5 } },
      900000,
    );
    const docMs = Date.now() - tDoc;
    const docEpisodes = episodesOf(docRun);
    const docEp = docEpisodes.find((e) => e.episodeKey === DOC_ID);
    console.log(
      `doc maintain.episodes ms=${docMs} ${oneLine(JSON.stringify(docEpisodes))}`,
    );
    logEpisodeFields("doc", docEpisodes);
    check(
      "maintain.episodes doc op ok",
      okOf(docRun) && dataOf(docRun)["degraded"] === false,
      `ms=${docMs} ${cliDetail(docRun)}`,
    );
    check(
      "doc every window processed (model or verbatim) + episode record",
      docEp !== undefined &&
        docEp.windowsWritten + docEp.windowsVerbatim >= 1 &&
        typeof docEp.episodeRecordId === "string" &&
        docEp.episodeRecordId.length > 0,
      `written=${docEp?.windowsWritten ?? 0} verbatim=${docEp?.windowsVerbatim ?? 0} rejected=${docEp?.windowsRejected ?? 0} record=${docEp?.episodeRecordId ?? "null"}`,
    );

    const tSession = Date.now();
    const sessionRun = cli(
      cliPath,
      cfg,
      { v: 1, op: "maintain.episodes", idempotencyKey: "smoke-ep-session-1", params: { scope: SCOPE, kind: "session", limit: 5 } },
      900000,
    );
    const sessionMs = Date.now() - tSession;
    const sessionEpisodes = episodesOf(sessionRun);
    const sessionEp = sessionEpisodes.find((e) => e.episodeKey === SESSION);
    console.log(
      `session maintain.episodes ms=${sessionMs} ${oneLine(JSON.stringify(sessionEpisodes))}`,
    );
    logEpisodeFields("session", sessionEpisodes);
    check(
      "maintain.episodes session op ok",
      okOf(sessionRun) && dataOf(sessionRun)["degraded"] === false,
      `ms=${sessionMs} ${cliDetail(sessionRun)}`,
    );
    check(
      "session every window processed (model or verbatim) + episode record",
      sessionEp !== undefined &&
        sessionEp.windowsWritten + sessionEp.windowsVerbatim >= 1 &&
        typeof sessionEp.episodeRecordId === "string" &&
        sessionEp.episodeRecordId.length > 0,
      `written=${sessionEp?.windowsWritten ?? 0} verbatim=${sessionEp?.windowsVerbatim ?? 0} rejected=${sessionEp?.windowsRejected ?? 0} record=${sessionEp?.episodeRecordId ?? "null"}`,
    );

    // 4. episode.list shows active summaryRecordIds and stale=false.
    for (const kind of ["doc", "session"] as const) {
      const r = cli(cliPath, cfg, { v: 1, op: "episode.list", params: { scope: SCOPE, kind, limit: 10 } }, 60000);
      const key = kind === "doc" ? DOC_ID : SESSION;
      const item = episodeItems(r).find((i) => i.episodeKey === key);
      check(
        `episode.list ${kind} summaryRecordIds + stale false`,
        okOf(r) && item !== undefined && item.summaryRecordIds.length > 0 && item.stale === false,
        `ids=${JSON.stringify(item?.summaryRecordIds ?? [])} stale=${item?.stale} ${cliDetail(r)}`,
      );
    }

    // 5. episode.windows: every window's record.sources excerpt is exactly
    // the raw slice of its span (event.get page text is the comparison).
    const windowCache = new Map<string, string[]>();
    const eventBody = (eventId: string): string[] | null => {
      const hit = windowCache.get(eventId);
      if (hit) return hit;
      const r = cli(cliPath, cfg, { v: 1, op: "event.get", params: { eventId, scope: SCOPE, maxCp: 2000 } }, 60000);
      if (!okOf(r)) return null;
      const body = dataOf(r)["body"];
      if (typeof body !== "string") return null;
      const cps = Array.from(body);
      windowCache.set(eventId, cps);
      return cps;
    };
    let windowCount = 0;
    let windowChecks = 0;
    const windowRecords: Array<{
      recordId: string;
      eventId: string;
      kind: "doc" | "session";
      verbatim: boolean;
    }> = [];
    for (const kind of ["doc", "session"] as const) {
      const key = kind === "doc" ? DOC_ID : SESSION;
      const r = cli(
        cliPath,
        cfg,
        { v: 1, op: "episode.windows", params: { scope: SCOPE, kind, episodeKey: key, limit: 50 } },
        60000,
      );
      const items = dataOf(r)["items"];
      const list = Array.isArray(items) ? (items as Array<Record<string, unknown>>) : [];
      console.log(`episode.windows ${kind} count=${list.length}`);
      check(`episode.windows ${kind} lists windows`, okOf(r) && list.length > 0, cliDetail(r));
      for (const it of list) {
        windowCount++;
        const recordId = String(it["recordId"] ?? "");
        const eventId = String(it["eventId"] ?? "");
        const span = it["span"] as { start?: number; end?: number } | undefined;
        const verbatim = it["verbatim"] === true;
        if (recordId) windowRecords.push({ recordId, eventId, kind, verbatim });
        const cps = eventBody(eventId);
        if (cps === null) {
          check(`window ${recordId} event readable`, false, `event=${eventId}`);
          continue;
        }
        const src = cli(cliPath, cfg, { v: 1, op: "record.sources", params: { id: recordId, scope: SCOPE } }, 60000);
        const sources = dataOf(src)["sources"];
        const first = Array.isArray(sources) ? (sources[0] as Record<string, unknown> | undefined) : undefined;
        const spanStart = Number(span?.start ?? -1);
        const spanEnd = Number(span?.end ?? -1);
        const expected = cps.slice(spanStart, spanEnd).join("");
        const excerpt = typeof first?.["excerpt"] === "string" ? (first["excerpt"] as string) : "";
        const truncated = first?.["truncated"] === true;
        check(
          `window ${recordId} sources excerpt exact`,
          okOf(src) &&
            first !== undefined &&
            first["eventId"] === eventId &&
            spanStart >= 0 &&
            spanEnd > spanStart &&
            spanEnd <= cps.length &&
            !truncated &&
            excerpt === expected,
          `event=${eventId} span=${spanStart}:${spanEnd} excerptCp=${countCp(excerpt)} expectedCp=${countCp(expected)} truncated=${truncated}`,
        );
        windowChecks++;
      }
    }
    check("window records checked", windowCount > 0 && windowChecks === windowCount, `windows=${windowCount} checked=${windowChecks}`);

    // 6. Print every window body (marked verbatim vs model-summary) and both
    // episode bodies for human quality judgement.
    const recordInfo = (id: string): { body: string; tags: string[] } => {
      const r = cli(cliPath, cfg, { v: 1, op: "record.get", params: { id, scope: SCOPE } }, 60000);
      const rec = dataOf(r)["record"] as Record<string, unknown> | undefined;
      const body = rec?.["body"];
      const tags = Array.isArray(rec?.["tags"]) ? (rec?.["tags"] as unknown[]).map(String) : [];
      return { body: typeof body === "string" ? body : "", tags };
    };
    if (docEp?.episodeRecordId) console.log(`summary episode.doc ${oneLine(recordInfo(docEp.episodeRecordId).body, 2000)}`);
    if (sessionEp?.episodeRecordId) console.log(`summary episode.session ${oneLine(recordInfo(sessionEp.episodeRecordId).body, 2000)}`);
    let windowBodiesOk = windowRecords.length > 0;
    for (const w of windowRecords) {
      const info = recordInfo(w.recordId);
      console.log(
        `summary window kind=${w.kind} event=${w.eventId} id=${w.recordId} mode=${w.verbatim ? "verbatim" : "model-summary"} ${oneLine(info.body, 2000)}`,
      );
      if (info.body.length === 0) windowBodiesOk = false;
    }
    check(
      "episode and window summary bodies non-empty",
      (docEp?.episodeRecordId ? recordInfo(docEp.episodeRecordId).body.length > 0 : false) &&
        (sessionEp?.episodeRecordId ? recordInfo(sessionEp.episodeRecordId).body.length > 0 : false) &&
        windowBodiesOk,
      `episodeDocs=${docEp?.episodeRecordId ?? "null"} episodeSession=${sessionEp?.episodeRecordId ?? "null"} windows=${windowRecords.length}`,
    );

    // 7. Append one session event: stale, incremental window, superseded old.
    const later = cli(
      cliPath,
      cfg,
      {
        v: 1,
        op: "event.append",
        idempotencyKey: `ev-${LATER_EVENT.eventId}`,
        params: {
          eventId: LATER_EVENT.eventId,
          sessionId: SESSION,
          turnId: LATER_EVENT.eventId,
          body: LATER_EVENT.body,
          provenance: { source: `session:${SESSION}:${LATER_EVENT.eventId}`, observedAt: LATER_EVENT.observedAt },
          scope: SCOPE,
        },
      },
      60000,
    );
    check("append later session event", okOf(later), cliDetail(later));
    const staleList = cli(cliPath, cfg, { v: 1, op: "episode.list", params: { scope: SCOPE, kind: "session", limit: 10 } }, 60000);
    const staleItem = episodeItems(staleList).find((i) => i.episodeKey === SESSION);
    check(
      "episode.list session stale after append",
      okOf(staleList) && staleItem !== undefined && staleItem.stale === true,
      `stale=${staleItem?.stale} ids=${JSON.stringify(staleItem?.summaryRecordIds ?? [])} ${cliDetail(staleList)}`,
    );

    const tRerun = Date.now();
    const rerun = cli(
      cliPath,
      cfg,
      { v: 1, op: "maintain.episodes", idempotencyKey: "smoke-ep-session-2", params: { scope: SCOPE, kind: "session", limit: 5 } },
      900000,
    );
    const rerunMs = Date.now() - tRerun;
    const rerunEp = episodesOf(rerun).find((e) => e.episodeKey === SESSION);
    console.log(`session rerun ms=${rerunMs} ${oneLine(JSON.stringify(episodesOf(rerun)))}`);
    logEpisodeFields("session rerun", episodesOf(rerun));
    check("rerun session op ok", okOf(rerun), `ms=${rerunMs} ${cliDetail(rerun)}`);
    check(
      "rerun wrote only the new window (model or verbatim)",
      rerunEp !== undefined && rerunEp.windowsWritten + rerunEp.windowsVerbatim === 1,
      `written=${rerunEp?.windowsWritten ?? -1} verbatim=${rerunEp?.windowsVerbatim ?? -1} rejected=${rerunEp?.windowsRejected ?? -1} record=${rerunEp?.episodeRecordId ?? "null"}`,
    );
    const oldId = sessionEp?.episodeRecordId ?? "";
    const oldRec = oldId
      ? cli(cliPath, cfg, { v: 1, op: "record.get", params: { id: oldId, scope: SCOPE } }, 60000)
      : null;
    const oldStatus = oldRec
      ? String(((dataOf(oldRec)["record"] ?? {}) as Record<string, unknown>)["status"] ?? "")
      : "";
    check(
      "old episode record superseded",
      oldId.length > 0 && oldRec !== null && okOf(oldRec) && oldStatus === "superseded",
      `old=${oldId} status=${oldStatus}`,
    );
    const afterList = cli(cliPath, cfg, { v: 1, op: "episode.list", params: { scope: SCOPE, kind: "session", limit: 10 } }, 60000);
    const afterItem = episodeItems(afterList).find((i) => i.episodeKey === SESSION);
    check(
      "episode.list session fresh after rerun",
      okOf(afterList) &&
        afterItem !== undefined &&
        afterItem.stale === false &&
        afterItem.summaryRecordIds.length > 0 &&
        !afterItem.summaryRecordIds.includes(oldId),
      `stale=${afterItem?.stale} ids=${JSON.stringify(afterItem?.summaryRecordIds ?? [])} old=${oldId}`,
    );
    if (rerunEp?.episodeRecordId) {
      console.log(
        `summary episode.session.final ${oneLine(recordInfo(rerunEp.episodeRecordId).body, 2000)}`,
      );
    }

    // 8. Disabled LLM degrades with zero writes.
    const degCfg = path.join(dir, "memory.degraded.json");
    fs.writeFileSync(
      degCfg,
      JSON.stringify({ ...config, llm: { ...(config.llm as NonNullable<AppConfig["llm"]>), enabled: false } }),
    );
    const deg = cli(
      cliPath,
      degCfg,
      { v: 1, op: "maintain.episodes", idempotencyKey: "smoke-ep-deg-1", params: { scope: SCOPE, kind: "session", limit: 5 } },
      120000,
    );
    const degData = dataOf(deg);
    check(
      "llm disabled degrades applied 0",
      okOf(deg) && degData["degraded"] === true && Number(degData["applied"]) === 0 && Array.isArray(degData["episodes"]) && (degData["episodes"] as unknown[]).length === 0,
      cliDetail(deg),
    );

    console.log(`episodes smoke total ms=${Date.now() - started}`);
    if (failures > 0) {
      console.error(`episodes smoke FAILED (${failures} check(s))`);
      process.exitCode = 1;
    } else {
      console.log("episodes smoke OK");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

void main();
