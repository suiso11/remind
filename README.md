# remind-memory-cli (M1 自律連想記憶)

ローカル専用の自律連想記憶 CLI。AI が `event.append` で現物を追記し、`record.remember` で直接 active 記憶として書き込む。候補・承認・トークン・TTY の仕組みはない。全書き込みは呼出者指定 `idempotencyKey` で直接確定する。

正本は単一 SQLite のみ。Markdown Vault は正本から生成する派生投影であり、正本ではない。

## 前提

- Node.js `26.12.0`、npm `11.6.2`
- 依存なし（SQLite は Node 標準 `node:sqlite`）
- 例は Windows PowerShell のパイプ (1 行 JSON 入力、1 行 JSON 出力、終了コード `0`)

## 設定

`memory.config.example.json` を複写して使う。起動時ファイルのみ。上書きは不可。不明項目は起動失敗。

```powershell
Copy-Item memory.config.example.json memory.config.json
```

- `dbPath`: SQLite 正本の場所 (設定ファイルからの相対解決)。例 `./memory.db`
- `vaultPath`: Markdown 投影先 (必須、欠落は起動失敗)。例 `./vault`
- `allowedScopes`: 利用可能スコープ。例 `["personal/default"]`
- `limits`: `bodyMaxCp / queryMaxCp / tagsMax / linksMax / sourceRefsMax / limitDefault / limitMax / snippetMaxCp / responseMaxBytes` (+ `rawBodyMaxCp / rawPageMaxCp / rangeLimitMax / graphResponseMaxBytes / graphLimitMax`)
- `bodyMaxCp` は record 本文のみに適用する。raw 本文は `rawBodyMaxCp` (既定 8000、1..65536)、`event.get` の 1 頁は `rawPageMaxCp` (既定 2000、1..65536)、`event.range / episode.list / episode.windows` の `limit` 上限は `rangeLimitMax` (既定 50、1..1000) を使う。`graphResponseMaxBytes` (任意、既定 `responseMaxBytes`、`responseMaxBytes..1048576`) と `graphLimitMax` (任意、既定 `rangeLimitMax`、1..2000) は `graph.page / graph.local` だけに適用し、他 op の上限は変えない。`rangeLimitMax` を省略した場合は `max(50, limitDefault)` が既定になり、`limitDefault` が 51..100 でも起動失敗しない (明示した場合のみ `limitDefault <= rangeLimitMax` を検査する)。
- `episodes` (任意): `utcOffsetMinutes` (既定 0、-720..840)、`windowMaxCp` (既定 1200、200..4000)、`maxNewTokens` (既定 128、16..256)、`batchMax` (既定 5、1..50)。`utcOffsetMinutes` は `day` の日境界だけをずらし、保存時刻は UTC のまま。
- `timeouts`: `cliMs` (全体期限)、`busyMs` (SQLite 待機)
- `dbMaxBytes`: 上限超過の書き込みは `STORE_UNAVAILABLE` で巻き戻し。読み取りは継続する
- `requirePrivacy` (任意・既定 false): `true` のとき `privacy` を欠く `event.append / record.remember` は `BAD_REQUEST` で拒否する (下記「privacy metadata (F-I01-05)」)

`memory.config.json` は git 管理対象外。コミットしないこと。`requirePrivacy` は boolean 以外で起動失敗する。

## 書き込み: event.append -> record.remember -> recall

```powershell
npm run build
'{"v":1,"op":"event.append","idempotencyKey":"ev-001","params":{"eventId":"e-001","sessionId":"s1","turnId":"t1","body":"orchard walk raw note","provenance":{"source":"session:s1:turn:1","observedAt":"2026-09-01T00:00:00.000Z"},"scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.remember","idempotencyKey":"rem-001","params":{"body":"orchard persimmon harvest memo","kind":"user_fact","provenance":{"source":"session:s1:turn:1","observedAt":"2026-09-01T00:00:00.000Z"},"scope":"personal/default","tags":["orchard"],"links":[],"sourceRefs":["e-001"]}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.recall","params":{"query":"persimmon harvest","scope":"personal/default","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
```

- `event.append` の params は `eventId / sessionId / turnId / body / provenance{source, observedAt} / scope` (+任意 `runId`)。`idempotencyKey` (ASCII `A-Za-z0-9_-`、1..128文字) は必須。
- `record.remember` の params は `body / kind / provenance / scope / tags[] / links[] / sourceRefs[]` (+任意 `runId`)。`kind` は `user_fact | model_inference | summary | correction`。`sourceRefs[]` は同一 scope の既存 `eventId` のみ。欠落は `NOT_FOUND`、他 scope は `FORBIDDEN_SCOPE`。空配列は `model_inference / summary` かつ source に派生表示がある場合のみ許容。
- `record.recall` の params は `query / scope` (+任意 `tags[] / link / since / until / limit / runId`)。応答は `recallId + items[{id, snippet, truncated, tags, createdAt}]`。本文先頭の有界切り出しのみで、raw 本文は返さない。

## 読み取り・育成・保守

```powershell
'{"v":1,"op":"record.get","params":{"id":"<recordId>","scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.list","params":{"scope":"personal/default","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"graph.page","params":{"scope":"personal/default","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"graph.local","params":{"scope":"personal/default","id":"<recordId>","depth":1}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"graph.version","params":{"scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.feedback","idempotencyKey":"fb-001","params":{"recallId":"<recallId>","recordIds":["<recordId>"],"scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.correct","idempotencyKey":"corr-001","params":{"recordId":"<recordId>","body":"revised orchard memo","kind":"correction","provenance":{"source":"session:s1:turn:9","observedAt":"2026-09-02T00:00:00.000Z"},"scope":"personal/default","sourceRefs":["e-001"]}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.archive","idempotencyKey":"arc-001","params":{"id":"<recordId>","scope":"personal/default","reasonCode":"USER_ARCHIVED"}}' | node dist/src/cli.js --config ./memory.config.json
```

- `record.get` は status によらず同一 scope の 1 件を返す。`record.list` は既定 active のみ。順序 `createdAt DESC, id ASC`。`since` inclusive、`until` exclusive。
- `record.feedback` は引用・採用の明示報告のみ熱を加算する。見るだけでは加算しない。露出集合外の ID は全体拒否。
- `record.correct` は新 revision 追記 + 旧 `active -> superseded` を同一 txn で行う。並行訂正は勝者 1 件、敗者は `CONFLICT`。`kind` は `correction` 固定。任意の `tags[]` は `record.remember` と同じ検証 (`tagsMax` 超過は `LIMIT_EXCEEDED`、非配列・不正要素は `BAD_REQUEST`) を受け、省略時は訂正対象 (supersede 対象) の旧版 tags を `tagsMax` まで継承し、明示時は置換、`[]` は全消去する。
- `record.archive` は `active -> archived` の終端遷移 (復帰なし)。`reasonCode` は `USER_ARCHIVED / OBSOLETE / DUPLICATE` の固定コードのみ。行は保持され、削除ではない。
- `record.retire / record.reactivate` は `active <-> retired` の可逆遷移 (冪等、固定理由コード)。`record.list` に `status:"retired"` を指定すると引退済みを一覧できる。`record.search` は active + retired の明示的検索。
- `graph.page` は同一 scope の active (+任意 `includeRetired`) を `createdAt DESC, id ASC` で不透明 cursor 頁送りし、`nodes[{id, status, kind, label, tags, topics, createdAt, episode, out, danglingOut}] + nextCursor + version` を返す。`label` は空白畳み後の先頭 `snippetMaxCp` code point、`topics` は現在の派生 topic (sort 済み・最大 3)、`out` は同一 scope で status が対象に含まれる node のみ (それ以外は `danglingOut` 件数)。`out` の `kind` は `related / consolidation / similar` で、`similar` は派生 similar edge を小さい側の endpoint からのみ列挙する (対称な二重辺なし)。`limit` 既定は `limitDefault`、`limit < 1` は `BAD_REQUEST`、`limit > graphLimitMax` は `LIMIT_EXCEEDED`、不正 cursor は `BAD_REQUEST`。応答が `graphResponseMaxBytes` を超える場合は頁を縮め、1 件も収まらない場合のみ `LIMIT_EXCEEDED`。heat/exposure/usage は増やさない。
- `graph.local` は 1 件を中心とした Obsidian 風ローカルグラフを返す。params は `scope / id` (+任意 `depth` (既定 1、1..2) / `includeRetired` / `limit`)。中心は status 不問、隣接は同一 scope かつ active (+`includeRetired` 時 retired)。辺は `record.links` の outbound と backlink を無向に辿り、派生 similar edge も無向に辿る。`summary / correction` 由来の辺は `consolidation`、similar edge は `similar`、それ以外は `related` (格納方向のまま)。応答は `center + nodes[{id, status, kind, label, tags, topics, createdAt, episode, hop}] + edges[{from, to, kind}] + truncated + version`。順序は center → hop → `createdAt DESC, id ASC`。`limit` は `graphLimitMax` まで、応答が `graphResponseMaxBytes` を超える場合は遠い/新しい node から決定的に削り `truncated:true` にする (center 単体が収まらない場合のみ `LIMIT_EXCEEDED`)。中心 id が同一 scope に無い場合は `NOT_FOUND`。heat/exposure/usage は増やさない。
- `graph.version` は `scope` のみを受け取り、その scope の `{version}` (不透明文字列) を返す。record/link/status/episode ledger に加え、派生 `record_topics` / `similar_edges` の scope 別 max rowid・件数も含むため maintain.associate / topic.set の書込みで変化し、純粋な読み取りでは変化しない (global graph のキャッシュ判定用)。
- `bodyMaxCp` は record 本文のみの上限である。`event.append` の raw 本文は `rawBodyMaxCp` で受ける (record の上限を raw に流用しない)。

## raw 取出し (event.get / event.range / record.sources)

```powershell
'{"v":1,"op":"event.get","params":{"eventId":"e-001","scope":"personal/default","offset":0,"maxCp":2000}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"event.range","params":{"scope":"personal/default","sessionId":"s1","since":"2026-09-01T00:00:00.000Z","until":"2026-09-02T00:00:00.000Z","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.sources","params":{"id":"<recordId>","scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json
```

- `event.get` は raw 1 件を code point 頁で返す。params は `eventId / scope` (+任意 `offset / maxCp`)。応答は `eventId / sessionId / turnId / source / observedAt / createdAt / privacy / chunk / totalCp / offset / body / nextOffset`。`maxCp` 既定は `rawPageMaxCp`、`nextOffset` が `null` になるまで連結すると原文と一致する。`offset > totalCp` は `BAD_REQUEST`、`maxCp > rawPageMaxCp` は `LIMIT_EXCEEDED`、欠落は `NOT_FOUND`、他 scope は `FORBIDDEN_SCOPE`。
- `event.range` は raw を `observedAt ASC, eventId ASC` で頁送りする。params は `scope` (+任意 `sessionId / docId / since / until / cursor / limit`)。`since` inclusive、`until` exclusive。各 item は `eventId / sessionId / turnId / observedAt / chunk / totalCp / snippet / truncated`、`nextCursor` は不透明。`limit > rangeLimitMax` は `LIMIT_EXCEEDED`、形式不正 (`cursor` 含む) は `BAD_REQUEST`。
- `record.sources` は record の `sourceRefs` を raw に解決する。応答は `id / sources[{eventId, sessionId, observedAt, chunk, totalCp, span, excerpt, truncated} | {eventId, missing:true}]`。`span` があれば `excerpt` はその code point 範囲、legacy の文字列 ref なら本文先頭。欠落 raw は `missing:true` で捏造せず、record 欠落は `NOT_FOUND`、他 scope は `FORBIDDEN_SCOPE`。raw 読取りは heat・exposures を変えない。
- 上限超過は `LIMIT_EXCEEDED`、それ以外の形式不正は `BAD_REQUEST` (既存の `NOT_FOUND / FORBIDDEN_SCOPE / STORE_UNAVAILABLE` はそのまま)。

## 長文取込 (チャンク・npm run ingest)

```powershell
npm run ingest -- --config ./memory.config.json --scope personal/default --file ./doc.md --doc-id doc-001
```

- `--config / --scope / --file / --doc-id` は必須、`--session / --source` は任意。`--privacy-sensitivity <normal|sensitive>` と `--privacy-origin <conversation|self_activity>` は両方指定するか両方省略する (片方だけ・不正値は usage error で終了 2)。指定時は全チャンクの `event.append` に `privacy` として渡す。`requirePrivacy: true` の config で両方省略した場合は、DB を開く前に固定の `error: ingest failed BAD_REQUEST` で終了 2 になる。UTF-8 文書を `rawBodyMaxCp` 以下のチャンクに分割する。境界は段落 (`\n\n` / CRLF) → 行 (`\n`) → code point 強制切断の順で、surrogate pair を割らず、空白のみのチャンクは作らない。NFKC 正規化は code point を増やし得る (例: `…` → `...`) ため、各チャンクは raw 長と `normalizeBody` 後長の両方で `rawBodyMaxCp` 以下になるよう境界を選ぶ。
- 書込み前に全チャンクを検証する: raw 長・正規化後長が上限超過なら `LIMIT_EXCEEDED`、正規化後に空なら `BAD_REQUEST` で、DB を開かず 1 件も追記しない (fail closed)。
- 各チャンクは冪等な `event.append` になる: `eventId = <docId>-c<seq>`、`idempotencyKey = ingest-<docId>-<seq>`、`turnId = <seq>`、`sessionId` 既定 `doc:<docId>`、`source` 既定 `file:<basename>`、`observedAt` はファイル mtime、`chunk = {docId, seq}`。同じファイルの再実行は `deduplicated` で二重追記しない。
- 標準出力は 1 行 `{docId, chunks, appended, deduplicated}`。引数・config 不正は stderr + 終了 2、DB 起動失敗は終了 3。同じ `(docId, seq)` を別 `eventId` で追記すると `CONFLICT`。

## span 付き sourceRefs

```powershell
'{"v":1,"op":"record.remember","idempotencyKey":"rem-span-001","params":{"body":"orchard harvest span memo","kind":"user_fact","provenance":{"source":"session:s1:turn:1","observedAt":"2026-09-01T00:00:00.000Z"},"scope":"personal/default","sourceRefs":[{"eventId":"e-001","start":0,"end":18}]}}' | node dist/src/cli.js --config ./memory.config.json
```

- `sourceRefs[]` の各要素は legacy の `eventId` 文字列、または `{eventId, start, end}`。`start` inclusive、`end` exclusive の code point 範囲で、`start >= 0`、`end > start`、`end <= event の totalCp`。個数上限は `sourceRefsMax`。
- span 不正 (順序・範囲外・余分/欠落キー・非整数) は `BAD_REQUEST`。参照先は同一 scope の既存 event のみで、欠落は `NOT_FOUND`、他 scope は `FORBIDDEN_SCOPE`。文字列 ref は従来どおり本文全体を指し、`record.sources` の `excerpt` は先頭 `rawPageMaxCp` まで。
- `remember / correct` と育成系は同じ正規化 (sort + dedup) を共有する。文字列だけの legacy 入力は従来と同一 hash のため、再送の `deduplicated` は変わらない。

## エピソード (episode.list / episode.windows / maintain.episodes)

```powershell
'{"v":1,"op":"episode.list","params":{"scope":"personal/default","kind":"doc","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"episode.windows","params":{"scope":"personal/default","kind":"doc","episodeKey":"doc-001","limit":50}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"maintain.episodes","idempotencyKey":"ep-001","params":{"scope":"personal/default","kind":"session","limit":5}}' | node dist/src/cli.js --config ./memory.config.json
```

- `kind` は `session | doc | day`。`episodeKey` は session の `sessionId`、doc の `docId`、day は `utcOffsetMinutes` で切ったローカル日。既定 `batchMax` は 5 で、`maintain.episodes` の `limit` もこの上限を超えると `LIMIT_EXCEEDED`。
- `maintain.episodes` は write op (`idempotencyKey` 必須、`maintenance.timeoutMs` 予算、`maintain.distill` と同一 lease で単一 flight)。各 raw event を `windowMaxCp` 以下の span に分け、CJK 文書は日本語プロンプト + assistant prefill `要約：` で 1 window の要約を生成する。生成文は (1) `要約：` の除去を含む整形、(2) 要約中の固有名詞・数字などの anchor token が window raw に存在するかの決定的ガード、(3) window raw に対する厳密 YES/NO 検証、の順に通す。検証プロンプトは候補要約を常に全文含み、短縮するのは source 側だけである。候補全文と最小 source (`EPISODE_VERIFY_MIN_SOURCE_CP`、source がそれより短ければ全文) が予算に収まらない候補は検証不能として YES を問わず、window は verbatim に落とす (reduce の文は drop し、全滅時は extractive fallback)。内容拒否 (parse 失敗・anchor 不在・NO) の window は record を書かないのではなく、その window の raw 文を span 付き `summary` record として保存し `episode-window-verbatim` tag を付ける (`windowsVerbatim`)。normalizeBody 後に `bodyMaxCp` を超える候補も内容拒否として verbatim に落とし、tag は `tagsMax` に収まるよう優先順 (`episode-window` → verbatim marker) で slice する。timeout・モデル失敗時は何も書かず、その event から再試行可能に止める。
- 完了は raw event 単位で `episode_event_done` に記録する (最後の window canonical record + ledger と同一 transaction。window が無い再実行・修復時は fenced な done 行のみ)。`episode.list` の `stale` は timestamp 比較ではなく、done 行の無い pending raw event または `foldedRecordIds` に含まれない active window の有無で決まる。`coveredThrough` は互換のため残す report で、done event の `MAX(observedAt)` を返す (選択・staleness には使わない)。
- すべての canonical / ledger 書込みは run owner の lease fence を同じ transaction 内で再確認する。推論中に lease を失った場合は `CONFLICT` で全体を rollback し、部分書込みを残さない。
- privacy は `maintain.distill` と同じ規則で伝播する。window は raw event の sensitivity を `origin: self_activity` で継承し、episode は引用 window から `sensitive` 優先・全 known なら `normal`・unknown を含めば `null` とする。`requirePrivacy` 時に raw event の privacy が unknown なら、その event は書かず pending のまま残す。
- reduce は最大 5 window ずつ、各文の末尾に引用番号 `[1][3]` を要求する cited prompt で行う。各文は引用した window の raw span に (a) anchor ガード、(b) 文単位の厳密 YES/NO を通ったものだけを残す。全文が落ちた場合は検証済み window 要約を順に連結する extractive fallback とし、episode record は必ず前進する (`sentencesKept: 0`)。初回は `summary`、増分は `record.correct` の `correction`。
- 増分更新では既存 window を再生成せず、新規 window だけ書く。episode 作成 key は (scope, kind, episodeKey, 昇順 folded window record ids, body) の generation を含み、retire 後に同じ本文を再生成しても新規 active record を作る (同一 generation の再送は冪等)。episode 級要約は `record.correct` で旧版を `superseded` にし履歴を残す。訂正競合時は新 summary + 旧版 `archived` (`OBSOLETE`) に退避し、物理削除はしない。LLM 無効・欠落時は `{episodes:[], applied:0, degraded:true}` を返し、状態を変えない (エラーにしない)。
- reduce の生成・文検証が一時的失敗 (null / timeout / 例外) を返した場合は extractive を書かず episode を延期する (`reduceDeferred: true`、`stale` のまま、次回再試行)。内容拒否 (parse 失敗・anchor 不在・NO) だけが extractive fallback の対象。
- `record.correct` で episode / window record を訂正すると、旧 revision の episode ledger 所属 (`episode_summaries` の行と episode 級 `foldedRecordIds` の window id) を新 revision へ引き継ぐ。
- 応答 `episodes[{kind, episodeKey, windowsWritten, windowsVerbatim, windowsRejected, episodeRecordId, coveredThrough, sentencesKept, sentencesDropped, extractive}] + applied + degraded`。`windowsRejected` は verbatim 回復分も含むモデル拒否回数。`episode.list` は `items[{kind, episodeKey, startAt, endAt, eventCount, totalCp, summaryRecordIds, stale}] + nextCursor` を返し、`summaryRecordIds` は active の episode 要約のみ、`stale` は done 行の無い pending raw event または未 fold の active window があるとき true (`coveredThrough` は done event の最大 observedAt を返す互換 report で、判定には使わない)。`episode.windows` は active な window record を `recordId / eventId / span{start,end} / verbatim / snippet / truncated` で返す (`verbatim` は ledger の明示 field で、tag が `tagsMax` で落ちても保持される) (`limit` 上限は `rangeLimitMax`)。
- 実測 (実 Qwen2.5-1.5B CPU、`npm run smoke:episodes`): smoke OK、合計 161.5s。doc episode は model window 2 / verbatim 3、session `s-ep` は model window 1 / verbatim 2。両 episode body は extractive fallback (`sentencesKept: 0`) で、model が書いた window 要約に raw に無い固有名詞は無かった。以前の自由文 reduce は「Elena and her husband」という幻覚を受理したが、引用付き・raw 検証付き reduce に置換した。既知の制約: 漢字複合語の anchor (raw `金曜` に対する `金曜日` など) は偽陽性拒否となり verbatim に落ちる、verbatim window は後から再要約しない、`record_source_refs` の移行は BEGIN IMMEDIATE 内で検査・copy+swap・unique index 作成を行う。

## リンク・backlink・Markdown 投影

- `remember / correct` で複数の関連 `links[]` (不透明な record ref) を付与できる。関連先がない場合は 0 件でよい。恣意的な埋め草は書かない。
- backlink は正本 outbound からの派生表示であり、独立に書き込まない。グラフ走査は active・同一 scope に解決する ref のみ辿り、深さ上限 2・展開上限 40。dangling は保持して飛ばす。
- `vaultPath/<id>.md` に `[[ref]]` と backlink 節を持つ Obsidian 互換表示を投影する。正本は SQLite のみ。投影・索引の失敗は確定済み記憶を取り消さない。直接の Markdown 編集の取込みはない。編集は `record.correct` を使う。

## グラフ表示 (実装済み・派生投影)

- `npm run rebuild:graph -- --config ./memory.config.json --scope personal/default` で単一 scope の有界・自己完結・オフライン HTML グラフ (`<vault>/graph.html`、既定) を再構築する。正本は SQLite のみで不変。サーバ・外部資産 (CDN/フォント)・Obsidian 依存・テレメトリ・モデルは不要。表示・検索・選択は静的ファイル内のみで完結し、再活性化・heat 加算は起きない。
- 既定は active のみ。`--include-retired` で引退、`--include-history` で履歴 (`superseded`・`archived`) を明示的に含める (`record.search` の active+retired とは別の viewer 側選択で、検索プロトコルを広げない)。他 scope の辺・backlink・source 参照は含まず、未解決/dangling 参照は辺を引かず件数・識別子の標識表示に留める。
- 辺の種別は区別表示する: `related` ([[リンク]] 実線)、`consolidation` (summary/correction からの統合元指示・破線)、`supersedes` (訂正連鎖・点線)。訂正の新旧は `supersedes` 列で辿る。選択ノードの panel は snippet・tag・provenance 由来識別子・sourceRef ID・backlink と安全な投影 Markdown (`./<id>.md`) への導線のみを示し、raw 本文は埋め込まない (raw は DB に残る)。全 untrusted 文字列は escape し、埋め込み JSON は `</script>`  breakout 不可に直列化する。
- 起動時 bounds (既定 `300 ノード / 800 辺 / 512KiB`、`--max-nodes/--max-edges/--max-bytes` で変更): 読取りは `LIMIT+1` で有界・決定論的順序 (`createdAt DESC, id ASC`)、超過は黙って切詰めず固定エラー (`error: graph over bound`、終了 2) で既存 view を残す。書込みは owned view ファイルのみ原子置換 (temp+rename) で Markdown 投影に触れない。`--out` は単一 `.html` のみ。
- 実測 (合成 DB・8 記憶・scope 分離・訂正/引退/他 scope 含む): 既定 4 ノード・3 辺・8.2KB、全状態 6 ノード・4 辺・9.0KB、前後 canonical 行比較で DB 不変、超過時 `graph over bound` で prior view 保持を確認。実 headless ブラウザ (file://) で SVG 6 ノード・4 辺の描画、ノード/辺選択 panel、active 除外・履歴除外・検索絞込み、要求が当該 file のみ・console エラーなしを確認した (`tests/graph-view.test.ts` 8 件も通る)。
- renderer 選択: 依存なし・決定論配置 (build 時円配置) の inline SVG。canvas/WebGL・外部 JS を避け、DOM 選択可能・file:// 動作・再構築の安定性を優先した。Obsidian 固定依存は置かず、残る可視化の layout 高度化・資源 bounds 最終値は未決定のまま (`plan.md` §14.5)。

## 想起方式

語彙 (FTS5/BM25 + char-bigram) + raw 下降 (`record_source_refs` 経由で active・同一 scope レコードへ写像) + タグ・リンク種 + 有界グラフ展開に、M2 のベクトル候補 (ローカル多言語埋め込みのコサイン上位) を固定重みで融合する。同一の正本・索引・heat 状態では同一順序。同点は `createdAt DESC, id ASC`。超過は切り詰めず `LIMIT_EXCEEDED`。モデル・索引の欠落・無効時は語彙 + グラフに縮退して継続する (エラーにしない)。

- 派生 topic が空でなければ、正規化クエリ (NFKC lowercase) に 2 code point 以上の現在 topic が部分一致したとき、その topic を持つ active 記憶をタグ seed と同じ固定重みで候補に加える (`record.search` は active+retired)。
- 派生 similar edge があれば、seed・語彙上位から同じ深さ上限で無向に辿り、辺 score に比例し明示リンクより低い重みで融合する。どちらの派生表も空なら順位は従来と同一。

## 連想の派生層 (maintain.associate / topic.set / topic.pending)

- `maintain.associate` (write op、`idempotencyKey` 必須) は active 記憶の埋め込みから派生表だけを再構築する: `record_topics` (現在 bodyHash の 1〜3 話題。canonical tags > external > LLM) と `similar_edges` (同一 scope・active の top-K コサイン近傍)。canonical `record_links` は追加・削除しない。モデル欠落・無効時は適用 0 の縮退 OK。
- 設定 `associate.*` (任意・起動時のみ): `batchMax` 50 (上限 500)、`topK` 5、`minScore` 0.45、`topicMergeMin` 0.8、`topicBonus` 0.3、`llmTopics` false。`llmTopics` は既定 false。実測では pinned Qwen2.5-1.5B が Ninja H2 を「ゲーム機」、GSX-S1000F を「自転車」と分類したため、SLM による話題抽出を既定で行わない (タグと `topic.set` が優先)。
- `topic.set` は 1 件の active 記録に外部話題 (最大 3) を設定する。`topic.pending` はタグも外部話題も無い active 記録を返す。どちらも呼出側のより大きなモデルが話題を供給するための口であり、本 CLI 内で生成を強制しない。どちらも heat・露出を変えない。

## 話題クラスタ統合 (maintain.consolidate)

```powershell
'{"v":1,"op":"maintain.consolidate","idempotencyKey":"cons-001","params":{"scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json
```

- `maintain.consolidate` (write op、`idempotencyKey` 必須、`maintenance.timeoutMs` 予算) は `record_topics` の話題を単位に、`consolidate.minMembers` (既定 3) 件以上の active メンバーを持つ話題クラスタを 1 回の grounded summary に統合する。メンバーは現在 bodyHash の topic 行を持ち、この op 自身が書いた summary (`source = cultivation:llm-derived-cluster`) を除く。`limit` (既定 `consolidate.batchMax` 5) は処理する変更済みクラスタ数。scope ごとの回転 cursor (`consolidate_scope_state`) が最後に試行した話題を保持し、次回はその直後から始めるため、`no_grounded_sentences` / `deferred` の話題が小さい `limit` で後続話題を飢餓させない。
- クラスタの member fingerprint (member id と bodyHash の昇順組) が `cluster_summaries` の保存値と一致する場合はモデルを呼ばず、`unchanged` として返す (変更済みクラスタの処理上限は消費しない)。変更がある場合だけ `createdAt ASC` のメンバーを最大 `EPISODE_FOLD_MAX` (5) 件ずつ cited reduce prompt に渡す。各文は (a) 引用した全メンバー本文に anchor token が存在すること、(b) 引用本文に対する厳密 YES/NO、の両方を通った場合だけ残す。anchor 不在・NO の文は落とし、1 文も残らなければ extractive fallback を書かずに `no_grounded_sentences` として記録する (作り話を書かない)。
- 生成・文検証が一時的失敗 (null / timeout / 例外) の場合はそのクラスタを `deferred` として何も書かず、次回に再試行する。`requirePrivacy` で引用メンバーの privacy が unknown の場合も defer する。
- 書込みは `kind: summary`、`tags: [topic]` (`tagsMax` で有界)、`links`: 引用メンバー id (`linksMax` で有界)、`sourceRefs`: 引用メンバーの sourceRefs の和集合 (span 保持、`sourceRefsMax` で有界)、provenance `cultivation:llm-derived-cluster`、privacy は `deriveConsolidationPrivacy` (sensitive 優先・全 known なら normal・unknown を含めば null)。同一 topic の active summary がある場合は `record.correct` で旧版を `superseded` にして履歴を残す。ledger が `record.correct` で訂正済みの revision を指す場合は supersedes 連鎖を有界に辿り、現行 active revision を訂正する (二重 summary を作らない)。canonical record と `cluster_summaries` 行は同じ transaction で lease fence 下に書き、その transaction 内でメンバーの active 状態・topic bodyHash・fingerprint を再検証する。変化していれば何も書かず `deferred` を返す。
- 応答 `clusters[{topic, members, sentencesKept, sentencesDropped, recordId, outcome}] + applied + degraded`。`outcome` は `written / unchanged / no_grounded_sentences / deferred`。LLM 無効・欠落時は `{clusters:[], applied:0, degraded:true}` を返し、状態を変えない。設定 `consolidate{minMembers=3, batchMax=5}` は起動時のみ (任意)。
## 活性化による引退 (maintain.activation / activation.preview)

- 引退・再活性化は単一の多要素保持スコア `R` で決める。基底は ACT-R の基底活性で、そこへ kind・importance・nature・リンク・期限切れ・統合済みの加減点を足す。

| 要素 | 式 | config キー (既定) |
|---|---|---|
| base | `ln( Σ_j max(Δh_j, 1)^(-d) )`。`Δh_j` は作成・検証済み feedback 利用・訂正・再活性化・訂正前履歴の利用時刻 (時間、1 時間床) | `activation.decay` (0.5) |
| kind | `wKind[kind]` | `activation.wKind` (`user_fact:1.0, model_inference:0.0, summary:0.3, correction:1.0`) |
| importance | `wImportance × importance`。`importance ∈ [0,1]` は分類器の `n/3`、欠損は中立 0.5 | `activation.wImportance` (2.0) |
| nature | `wNature[nature]`。nature 欠損は 0 | `activation.wNature` (`FACT:1.0, PREFERENCE:1.0, RELATIONSHIP:1.2, PROJECT:1.0, OPINION:0.6, PLAN:0.6, EVENT:0.4, EMOTION:-0.8, TRANSIENT:-1.5, GREETING:-2.5, CHATOPS:-2.0`) |
| links | `wLinks × ln(1 + L)`。`L` は同一 scope で相手が active な正準 `record_links` の in/out 数 + 派生 `similar_edges` 数 × 0.5 | `activation.wLinks` (0.8) |
| expired | `nature` が `PLAN/EVENT/TRANSIENT` で本文中の絶対日付 (`YYYY-MM-DD`, `YYYY年M月D日`) の最新が `expiryGraceDays` より古いとき `-wExpired`。決定的 regex のみ | `activation.expiryGraceDays` (3), `activation.wExpired` (2.0) |
| consolidated | active なクラスタ要約 (`source = cultivation:llm-derived-cluster`) から `record_links` で引用され、importance < 2/3 のとき `-wConsolidated` | `activation.wConsolidated` (0.5) |

  `R = base + kind + importance + nature + links + expired + consolidated`。判定は `R < tauRetire` かつ `ageHours >=` nature 別の最小経過時間 (`minAgeHoursByNature`: `GREETING/CHATOPS:24`, `EMOTION/TRANSIENT:72`、他は `minAgeHours=72`) で引退、`R >= tauReactivate` (-0.5) で再活性化する。
- `activation.preview {scope, limit?, cursor?, includeRetired?}` は読み取り専用で、`R` 昇順の `{id,status,kind,label,nature,A,importance,factors,reason,uses,ageHours,decision}` を返す。`factors` は `{base,kind,importance,nature,links,expired,consolidated,total}` で合計は `A` と一致する。`reason` は retire のときだけ `OUTDATED / CONSOLIDATED / LOW_ACTIVATION`。heat・usage・audit・importance・status は一切書かない。`nextCursor` は採点時刻を内包して頁間の `R` を固定する。
- `maintain.activation {scope, limit?}` (write op、`idempotencyKey` 必須) は (a) 未採点・bodyHash 陳腐化・nature 欠損・分類器 version かモデル id (`source=llm:<version>:<model>`) が古い active+retired 記憶を最大 `activation.batchMax=20` (上限 200) 件だけ分類器で nature+importance 採点する。モデルを切り替えると旧 `llm:v2` 行を含む全採点が一度だけ陳腐化して再採点される。LLM 無効・欠落時は採点をスキップし `degraded:true` (ただし `activation.llm` があればグローバル `llm.enabled=false` でも分類器は動く)。(b) scope の `R` を再計算し、`activation.apply` が true のときだけ遷移を適用する。1 パス最大 2,000 件の有界スキャンと scope 別 continuation cursor は従来どおり。
- 引退理由は支配要因で決める: expired 適用 → `OUTDATED`、consolidated 点だけが閾値を跨がせた → `CONSOLIDATED`、それ以外 → `LOW_ACTIVATION`。再活性化は `STILL_USEFUL`。
- 自動引退の全理由 (`LOW_ACTIVATION` / 旧 `LOW_SIGNAL` / `OUTDATED` / `CONSOLIDATED`) を再検討する。`reconsiderLegacy` は廃止。利用者が `record.retire` で `NO_LONGER_USEFUL` にした行は自動再活性化しない。直近の再活性化が `USER_REQUESTED` の行は自動引退しない。
- `activation.protectImportance` (既定 0.66 ≒ 2/3) 以上の重要度は通常の `tauRetire` では引退せず `R < tauRetire - 1` を要求する。
- `activation.apply` は既定 **false**。false の間は状態を変えず `wouldRetire / wouldReactivate` を返す。応答 data は `{scored, scoreFailed, retired, reactivated, wouldRetire, wouldReactivate, degraded}`。全 `activation.*` キーは起動時に厳格検証し、未知キー・範囲外は起動エラーにする。

### Learned retention weights

- **ラベル**: `retention_examples` に 2 系統を蓄積する。(a) `exposures` の horizon (`activation.learn.labelHorizonMs`, 既定 6h) 経過後の露出で、同一 `(recallId,recordId)` の `usage` があれば正例、なければ負例 (weight 1)。(b) 監査台帳の明示遷移: `USER_REQUESTED` 再活性化は正例、`NO_LONGER_USEFUL` 引退は負例 (weight 5)。`recallId` は露出 ID または `audit:<rowid>` で、再実行しても再ラベルしない。
- **リーク規則**: 特徴量はラベル時刻 `ts` でスナップショットする。`base` は `ts` より厳密に前の事象だけを使うため、ラベル対象の `usage` は混入しない。kind/nature/importance/links/expired/consolidated は現在状態の近似で、その旨を snapshot に記録する。
- **モデル**: `R_w(x) = base + Σ_k w_k·φ_k(x)` は `computeRetentionFactors` と同じ因子構造 (kind, `wImportance·importance`, `wNature[label]`, `wLinks·ln(1+L)`, `−wExpired·expired`, `−wConsolidated·consolidated`)。`P(useful) = sigmoid(a·R_w + b)`、`a > 0`、`b` は学習。θ は平坦化した w (kind 4 + nature 11 + 4 スカラー) と `a,b`。
- **MAP 事前分布**: 事前重み = 現在の config/default (`activation.*`)。目的関数は重み付き log-loss + `lambda·Σ(w−prior)²`。`a,b` は正則化しないが `a ≥ 0.05` に clamp。最適化は決定的な full-batch Adam (lr 0.05, 600 反復、初期値 w=prior, a=1, b=0)。
- **ガードレール**: 各 step 後に射影する。`wImportance, wLinks, wExpired, wConsolidated ≥ 0`、`GREETING/CHATOPS/TRANSIENT/EMOTION` の nature 重み `≤ 0`、全重み `|w−prior| ≤ activation.learn.maxDrift` (既定 1.5)。
- **受理ゲート**: `activation.learn.enabled`、前回試行から `learnIntervalMs` (既定 1 日) 経過、前回試行以降の新規例 ≥ 50、全体 `n ≥ minExamples` (既定 300)、正例 ≥ `minPositives` (既定 30) を満たすときだけ試行する。ゲート skip は行を残さない。試行時は時刻順の末尾 20% を holdout とし、train で新重みを fit、baseline (最新 accepted、無ければ prior) は重み固定で `a,b` のみ train fit して比較を公平にする。holdout log-loss が baseline を `1e-4` 超で改善した場合だけ採用し、採用時は全例で再 fit して `accepted=1` を保存する。試行行 (`accepted=0` を含む) は常に損失付きで残す。
- **スコアリング**: `activation.preview` と `maintain.activation` の判定は最新 accepted 重みを使い、無ければ config 重みにフォールバックする。preview は `weightsVersion` (null = prior) と `weights` を返し、`maintain.activation` の `learn` は `{harvested, examples, positives, attempted, accepted, version, skipped, train, holdout, trainLoss, holdoutLoss, baselineHoldoutLoss}` を返す (`version` は試行行の `retention_weights.version`、skip 時は null)。
- **ロールバック**: `activation.learn.enabled=false` で採点は即座に config 重みへ戻る (最新 accepted は無視。行は保持)。learner を再有効化すれば次の accepted まで prior で採点する。
- **現状のデータ量に関する注意**: 学習は十分な露出・利用履歴が溜まってから意味を持つ。既定の `minExamples=300` / `minPositives=30` / 新規 50 件ゲートにより、小規模データでは試行自体が skip され、重みは prior のままになる。受理は holdout 改善のみを条件とするため、データが少ない間は保守的に無変更となる。

## 冪等・エラー

- 全書き込みは `idempotencyKey` 必須。欠落は `BAD_REQUEST`。同一キー + 同一 params の再送は保存済み応答を `deduplicated:true` で返す。params 改変は `CONFLICT`。
- 固定コードのみ: `OK / BAD_REQUEST / NOT_FOUND / CONFLICT / FORBIDDEN_SCOPE / STORE_UNAVAILABLE / LIMIT_EXCEEDED / TIMEOUT`。`message` は固定文言で本文・クエリを含まない。
- 旧世代の操作 (`candidate.create`、`candidate.get`、`approve`、`review`、`record.correct-request` 等) は未知 op として `BAD_REQUEST` で拒否される。

## 旧 DB の扱い

旧承認スキーマの DB (candidates 表等) は起動失敗 (stderr 固定文 + 非ゼロ終了) し、変更・削除・移行はしない。旧ファイルを退避し、`dbPath` に新しいファイルを指定すること。

現行スキーマは `user_version=12`。v2〜v11 の既存 DB は単一の `BEGIN IMMEDIATE` 移行でその場で更新する（拒否しない）。v11 までは `record_importance.source` の CHECK をモデル id 付き `llm:v2:<model>` を受け付ける形へ行保持のまま再構築する。v7 で `record_importance` が、v8 で `cluster_summaries` が作成され、v7 (`record_importance` 保持) からは既存の重要度行を保ったまま `cluster_summaries` だけを追加する。v8 (`cluster_summaries` 保持) からは既存行を保ったまま回転 cursor の `consolidate_scope_state` だけを追加する。既に v12 のファイルは DDL を伴わない fast path で開く。

## テスト

```powershell
npm test         # build + 全テスト
npm run smoke    # 一時 DB での event.append -> remember -> recall 確認
npm run acceptance  # M1 受け入れ 7 件
npm run provision:model  # 埋め込みモデルの取得 (唯一の M2 ネットワーク工程)
npm run rebuild:vectors  # 派生ベクトル索引の再構築 (オフライン)
npm run smoke:semantic   # 実モデルでの CLI 意味スモーク (一時 DB)
npm run eval:m2          # 合成データでの語彙/意味の比較評価 (一時 DB)
npm run eval:operations   # 運用ライフサイクル+規模の合成評価 (一時 DB、実 CLI)
npm run eval:decisions    # 記憶判断の合成評価 (MemProbe + 検索支持 + 反事実 + governance。--llm-config で consolidate、--labels で fit 入力)
npm run eval:fit -- --input <labels.jsonl>  # 評価ラベルのオフライン fit (n>=30/holdout/prevalence ゲート、autoApply:false)
npm run provision:llm    # 育成 LLM の取得 (唯一の M3 ネットワーク工程)
npm run smoke:m3         # 実 LLM での CLI 育成スモーク (一時 DB)
npm run ingest -- --config ./memory.config.json --scope personal/default --file ./doc.md --doc-id doc-001  # 長文チャンク取込
npm run smoke:episodes   # 実 LLM での取込 -> episode 索引スモーク (一時 DB)
```

<書き込み永続化失敗時の巻き戻しは `tests/m1-rollback.test.ts` で確認する (audit/operations の INSERT 拒否で 5 操作とも `STORE_UNAVAILABLE`・正本不変・再送で 1 件のみ確定)。露出上限の原子性は `tests/r06-exposure-cap.test.ts` (2 件: 実 recallId で厳密 1000 行・最古逐語刈り込み・消去後 feedback 行列・DELETE 拒否の全行巻戻し+再送成功) で確認する。 投影キューの耐久回復は `tests/r07-projection-recovery.test.ts` (3 件: close+reopen 永続 + 独立 future 行不変/分離回復・同一宛先 regular 最終 Markdown への実 rename 段階 primitive fault 保持/再 drain 復元・recall+feedback populated な 8 列 exposures/usage/heat を含む完全再構築 + exposure 有効/二重 heat なし)、実子プロセス CLI の境界・リプレイは `tests/r08-cli-boundary-replay.test.ts` (9 件: 先行 LF/EOF・多行・保持 TIMEOUT (cliMs 有界 assert)・不正 UTF-8・32768 境界・保持 multibyte streaming byte cap (20000 文字/40000 バイト)・起動 busy・実 worker TIMEOUT (positive threadId の BEGIN 到達、子時計での親 TIMEOUT+exit 有界: preload の実起動・実 stdout・実 exit 刻みを cliMs+1000 で assert し設定無視の 5000 固定を棄却、negative control で 5000 固定時に子時計 5016ms で fail 確認) 後の同キー再送単一確定→deduplicated replay) で確認する。fault 相は厳密 2500/10000 注入のまま、回復相は同一 DB・同一 scope・同一キー+同一 params を既存標準 (出荷例 5000/2000) で再送する (設定は冪等 hash ではない)。包装 bin 契約は `tests/r08-bin-entry.test.ts` (1 件: manifest 解決の platform 対応 launcher 経由で event.append 永続・remember/get 往復・同キー replay が正準効果ちょうど 1 件→deduplicated) で確認する。同一正本への同時訂正競合は `tests/m1-recall.test.ts` の共有ファイル競合試験 (2 件: 2 本の実 worker スレッドが各々の実 DatabaseSync で native BEGIN rendezvous し、ちょうど 1 件 OK/1 件 CONFLICT、勝者の正準/ref/link/heat/operation/成功 audit のみ残留、敗者残滓ゼロ; ready/done の settled outcome を起動直後に束縛し失敗時も全 settlement を消費する即時 lifecycle、無効 temp DB path での実 open 失敗前に ready が settled 失敗・両 completion 消費・両 worker 実 exit・fixture 除去の failure-edge) で確認する。build は外部 chmod なし (Node fs.chmodSync、win32 guard) で、Windows CI は chmod.exe を含む PATH だけを除去して chmod 不可を確認してから `npm test` する。全 226 件 (raw-read 16 件・episodes 12 件を含む) が Linux ローカルで成功、smoke も一時 DB/実 CLI で成功。独立 temp-only smoke (実 API での厳密 cap+DELETE 拒否/再送/feedback heat 行列、および POSIX symlink launcher 経由の write/read/replay) も成功。独立 native failure smoke (無効 DB path の実 worker error+exit 1/除去) と実コンパイル API の winning-key replay smoke (同キー再送 deduplicated) も成功。

記憶判断の合成評価 (memory-decisions-v1, seeded-only) は `npm run eval:decisions` (build + node dist/scripts/evaluate-memory-decisions.js) で実行する。一時 DB・実 CLI のみを使い、既定ではモデルを呼ばない。内容は (a) MemProbe の 4 パラダイム (干渉・誤情報・統合強度・再固定化) の stability/plasticity/SP-balance と historical/source/temporal fidelity、(b) CMP の検索支持診断 (required memory の支持失敗率と、active 記録のうち一度も露出されない割合)、(c) VitaBench 型の反事実ライフサイクル (同一チェックポイントから KEEP/RETIRE/CORRECT に分岐し、同一の未来列を再生して headroom・horizon reversal・oracle action 多様性を測る)、(d) Epistemics の governance (G1 poison-resistance（governance では常に skipped）、G2 reversibility、G3 metadata-only audit、G4 quality gate 対 no-op adversary、provenance/probe の leak 検査（count-matched は n/a）)。`--llm-config <path>` を渡したときだけ `maintain.consolidate` のモデル leg を実行し、合成 3 メンバーの話題クラスタで summary の kind/source/links（cluster 内のみ）/sources・member active・2 回目の unchanged を確認する (未指定は `status:"skipped"`)。`--labels <jsonl>` は決定時点の features と utility を出す（未来の probe 予定は含めない。診断用。現行 generator では hasConflict は false 固定、heat/exposures は 0 で、4 状態は同一特徴ベクトル）。`npm run eval:fit -- --input <jsonl>` は別スクリプトで MAP fit と n>=30・2 ストリーム以上の held-out stream・prevalence 2 水準以上・best fixed action 超えのゲートを実行し、`autoApply:false` を返す。品質閾値は持たず、harness/契約違反 (envelope 不正・CLI 失敗・設計した支持失敗・governance gate 失敗) のときだけ非ゼロで終了する。`tests/memory-decision-eval.test.ts` が exit 0・4 パラダイム・支持率・headroom/reversal・governance・labels を確認する。

  受け入れ条件は `docs/acceptance-manifest.md`、保持・育成方針は `docs/retention.md` を参照。M3 育成 (`record.retire / reactivate / search` + 有界キュー・単一 flight・二段階実モデル `maintain.distill`) は実装済みで、`tests/m3-state.test.ts` (23 件：回帰 9 件含む) と実モデル `npm run smoke:m3` が通る。終端 `archive` を可逆引退とみなさない。同一バッチの相互指名ペアは無順序ペアで 1 回のみ統合する (代表 1 件が要約、対は監査付き keep、重複サマリなし)。

## M2 セマンティック検索 (実装済み)

- モデル: `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (pinned revision `2c4055b1`、Apache-2.0、384 次元、量子化 ONNX)。ランタイムは `@huggingface/transformers@4.3.1 + onnxruntime-node@1.30.0`。取得は `npm run provision:model` のみが行い、想起・再構築の実行時は外部送信なしの完全オフライン。
- 設定は起動時 `vectors{modelDir, topK(既定 20・上限 60), timeoutMs, enabled}` (任意。欠落時は M1 の語彙 + グラフ動作)。`vec_notes` は正本から再構築可能な派生索引であり、`npm run rebuild:vectors` で再作成できる。正本表は変えない。
- `record.recall` は正規化クエリを同モデルで埋め込み (有界 `timeoutMs`)、ベクトル上位と語彙・raw・グラフを固定重みで融合する。書込みは埋め込まない (期限保護)。モデル欠落・無効・タイムアウト時は語彙 + グラフに縮退する。
- 実測 (合成 8 記憶・4 probe、`docs/m2-eval.json`): 語彙のみ hit@1 0.25 / hit@3 0.5 → 融合で hit@1 1.0 / hit@3 1.0。プロセス内遅延増分 +1ms 未満 (クエリ埋め込み warm 平均 ~2ms、冷間モデル load ~0.8s)。索引削除時は 4/4 で語彙順序に一致 (縮退確認)。実 CLI スモークでも言い換えクエリが対象を 1 位に引用し、語彙のみでは外すことを確認した。

## M3 育てる保守 (実装済み)

### LLM バックエンド (ローカル OpenAI 互換)

- `llm.backend` は `"onnx"` (既定。現行のプロセス内 Qwen2.5-1.5B) または `"openai"`。`openai` は OpenAI 互換の `/v1/chat/completions` を呼ぶ。
- `llm.baseUrl` は `openai` では必須で、`http(s)://127.0.0.1[:port]`、`http(s)://[::1][:port]`、`http(s)://localhost[:port]` のいずれか (任意で `/v1` を付加可能)。それ以外のホスト・任意パス・URL 内の資格情報は起動時に拒否する。外部送信は行わない。
- `llm.model` は必須。`llm.apiKeyEnv` はトークンを持つ**環境変数名**のみを指定し、鍵そのものを設定ファイルに書かない。`llm.disableThinking` は既定 true で、リクエストに `chat_template_kwargs: {"enable_thinking": false}` を付け、応答の `<think>…</think>` を除去する。
- `activation.llm` (任意) は保持分類器 (nature + importance) 専用の `{backend:"openai", baseUrl, model, timeoutMs?, apiKeyEnv?}`。指定時は分類器だけがこのエンドポイント/モデルを使い、`distill / consolidate / associate` はグローバル `llm` のまま。検証規則は `llm` と同じ (loopback のみ、`apiKeyEnv` は変数名のみ) で、分類器リクエストは常に `enable_thinking:false` を送る (35B の reasoning budget を消費させない)。実運用ではメインモデル `huihui-ornith-35b` を指し、9B は `llm` に残す。
- 例 (llama.cpp `llama-server`):

```json
"llm": {
  "backend": "openai",
  "enabled": true,
  "baseUrl": "http://127.0.0.1:18090",
  "model": "ornith-1.5-9b",
  "timeoutMs": 60000,
  "maxNewTokens": 48,
  "maxPromptChars": 2000
}
```

`llama-server -m <model.gguf> --host 127.0.0.1 --port 18090` で起動する。LiteLLM 等も localhost で待ち受けていれば同じ設定で使える。ONNX と同じく、接続失敗・HTTP エラー・タイムアウト・不正出力は state を変えず keep/再試行に縮退する (タイムアウト後は同一バックエンドの新規推論を当面拒否する)。この backend では `maintain.distill` 応答の `model` は設定した `llm.model`、`revision` は `null` になる (蒸留結果の来歴を実際の構成と一致させる)。ONNX backend は従来どおり固定 repo id と revision を返す。自動引退 (retire gate) は `llm.backend: "openai"` のときだけ実行する。ONNX の Qwen2.5-1.5B gate は実 DB 監査で 108/158 件を誤って `LOW_SIGNAL` 引退していた (中央値 作成後約 5 分、Ornith では 87/108 件が耐久 FACT/PREFERENCE/PLAN) ため、ONNX では gate を飛ばして統合/keep 段へ進む (統合挙動は不変)。

- 状態: `record.retire / record.reactivate` は `active <-> retired` の可逆遷移 (冪等、固定理由コード、メタデータのみ監査)。`superseded / archived` は動かさない。通常想起・一覧 (既定)・raw 下降・グラフ・ベクトルは active のみ。
- `record.search`: 利用者指示の明示的検索で active + retired を返す (`archived / superseded` 除外)。各 item は `revision` を含む。heat・再活性化・feedback 露出なし。
 - LLM: `onnx-community/Qwen2.5-1.5B-Instruct` (pinned revision `d54957e3af1be04546436e874a60fe386041b244`、基盤 `Qwen/Qwen2.5-1.5B-Instruct`、license `apache-2.0`、量子化 ONNX `onnx/model_q4.onnx`)。ランタイムは `@huggingface/transformers@4.3.1 + onnxruntime-node@1.30.0`。取得は `npm run provision:llm` のみが行い、想起・蒸留の実行時は外部送信なしの完全オフライン。greedy 生成のため同一入力には決定論的。旧 `Xenova/bloomz-560m` は実プロンプト検証で不適（保持ゲートは不確実・要約は繰返し幻覚）、`Qwen2.5-0.5B-Instruct` は `RETIRE` を一切出さず引退不能のため不採用。
 - `maintain.distill`: 有界バッチ (既定上限 20)・単一 flight (SQLite リース、TTL 既定 120000ms、crash 時は steal・再利用)・per-action 監査・失敗隔離・取消可能で、summary/consolidation を通常の冪等 op で直接・自律的に書く。判定は二段階＋確認の実モデル推論のみ（ヒューリスティック代替なし）：(1) 保持ゲート（`llm.backend: "openai"` のみ。単一ラベル分類。KEEP-type = `FACT / PREFERENCE / OPINION / PLAN / EVENT / RELATIONSHIP / PROJECT`、DROP-type = `GREETING / TRANSIENT / CHATOPS`。ラベル完全一致のみ採用し、前後空白・末尾句読点を除去、大文字小文字無視。不一致・`NONE`・空は uncertain で keep）。DROP でも、(a) `record_links` が inbound/outbound に 1 本でもある、または (b) `note_heat.usedCount > 0` なら keep。(2) 位置指定の統合選択（関連記憶を番号 `1..N` で提示し `MERGE <n> / KEEP`。コードが実際の同一 scope 有界入力に写像するため、モデルは record ID を複写しない。表示 2 件未満・範囲外・陳腐化は keep）。(3) 共有事実の確認（両記憶の共有事実の抽出か `NONE`。`NONE`・不確実は keep）。確認済みのみ実要約を草案し、正準 provenance（`cultivation:llm-derived`）・links（両源）・sourceRefs（和集合、コード再解決）で書く。推論は正準トランザクションの外、モデル文脈は同一 scope 最大 6 件の断片に有界。不確実・無効・失敗・欠落・タイムアウト時は状態不変 (keep/有界リトライ)。モデル欠落時は縮退 OK (適用 0・キュー不変)。応答は `distill{applied, reviewed, failed, deferred, batchId, nextCursor, degraded, model, revision}` で、`deferred` は grace period により延期した件数 (失敗にも適用にも数えない)。
  - `remember / correct / 検証済み feedback` の確定後に有界レビューをキューへ (0 リンク含む、インライン推論なし、キュー満杯でも書込み不変)。起動時 `cultivation{queueMax, batchMax, leaseTtlMs, reviewMaxAttempts}` (任意・既定 `500/20/120000/5`)、`llm{modelDir, timeoutMs, enabled, maxNewTokens, maxPromptChars}` (既定 `./models/qwen25-15b-instruct/60000/false/48/2000`)、`maintenance{timeoutMs}` (既定 120000)。キュー寿命：crash で孤立した `leased` 行は次回 steal 時に `pending` へ回収 (試行回数加算・上限で `failed`)、取消は `cancelled` 終端。drain の lease 所有者は実行ごとに一意 (`idempotencyKey#nonce`) のため同一キー並行 drain は単一 flight を失わず、再開 cursor は `(nextAt, queueId)` 複合で順序飛ばしなし。適用は lease 存続＋行 `leased` 存続の二重 fence を同一 txn 内で再検査し、取消後・奪取後の書込みを `CONFLICT` 無変更にする。`record.search` は派生索引 (FTS/bigram) 喪失時も正準 `bodyNorm` fallback で active + retired を返す。プロンプトは構造尾部 (指示＋assistant cue) を保って `maxPromptChars` (500..8000) に収める。
   - 実測 (一時 DB・6 記憶・実モデル、`npm run smoke:m3`): retire 往復・recall 除外・search 取戻し・実モデル drain（保持ゲートで一過性気分を実際の引退 1 件、位置指定＋共有事実確認＋相互合意＋無順序ペア重複排除で近似重複の実際の統合 1 件のみ、耐久事実・不確実記録は保全、原物は全件行保持、適用 2）・同一キー再送 `deduplicated`・欠落モデル縮退 (適用 0・正本不変)・他者 lease 下 `CONFLICT`・cancel の全 check が ok。重複サマリの deferred 課題は残さない。実モデル drain 中の同一キー競合は `CONFLICT`、完了後の再送は `deduplicated` になることを CLI 並行実行でも確認した (degraded 並行は先勝 drain＋後発 `deduplicated` 再送に直列化し二重 drain なし)。
   - 実モデルと決定論的証明の区別 (正直な申告): 実モデル drain の引退・統合判定は genuine のモデル生成であり、スタブをモデルの出力として主張しない。失敗隔離・リトライ・merge 位置写像・ゲート safeguard・相互ペア重複排除・孤立回収・縮退無変更・単一 flight・cursor 頁送り・取消 fence・重複投入・索引喪失 fallback・プロンプト構造保持の機構自体は手渡し decide／純粋関数による決定論的テスト (`tests/m3-state.test.ts` 23 件) でも証明する。

R13 M1 synthetic baseline 観測証拠 (baseline-v1, M1 lexical+graph, synthetic-only): `npm run evaluate:baseline` (build + node dist/scripts/evaluate-baseline.js) exit 0。12 queries x3 rounds=36 recalls (21 positive incl semantic-gap miss, 15 negative)。positive mean P@3 0.571/recall 0.857/RR 0.857、negative 15 valid-empty、latency success median ~62.7ms (min ~61.0/max ~103.5/p95 ~66.8)。corrupt probe は direct exit 3/empty stdout と adapter STORE_UNAVAILABLE degraded/empty citations を分離報告し contract ok (quality/degradation 除外、契約違反時は非ゼロ)。feedback は実 recallId のみ報告し、failed は invariants+非ゼロ (unavailable は正常)。setup は lens links を beacon/chart 実 ID で照合・sourceRefs [b1-lens] 完全一致・list P 厳密 8。`npm test` 101 pass (prior 80 + score 12 + evaluator integration 6 + validators 3)、acceptance 7 pass、smoke OK。

運用ライフサイクル+規模の合成評価 (operations-v1, synthetic-only, lexical): `npm run eval:operations` (build + node dist/scripts/evaluate-operations.js) exit 0。一時 DB・実 CLI のみで、会話形クエリを 3 規模 (10/30/60 件) で実行する。各規模で次を実証する: 訂正は旧版を `superseded` 化し通常想起から除外して最新版を返す、引退は通常想起から除外される一方で明示的 `record.search` (active+retired、`searchId` 応答・heat なし) が取戻し `reactivate` で想起に復帰する、`record.feedback` は露出検証済みの選択引用のみ heat+1 し範囲外 ID 混入は全体 `NOT_FOUND` で heat 不変、派生索引の部分欠落 (1 件の bigram 削除)・行数を保った 1 行 FTS 本文破損 (起動時修復 `maybeRebuildDerivedIndexes` が検知しない派生損傷、recall 後の DB 検証で損傷が残存することを確認) でも正準 `bodyNorm` fallback で想起が継続する (全空の FTS 表は起動時修復されるため fallback 実証には使えない)。派生索引の損傷を受けた正準 fallback ヒットは、平準の +1 のみではなく、健全な索引が与えるはずの語彙シグナルを代理順位 (メモリ上の正準 `bodyNorm` とクエリ正規化形の char-bigram 重複による決定論的順位、索引検査は canonical ヒット ID に有界な 2 クエリ・検査失敗時は「損傷あり」に倒す) で代用して受けるため、競合が上位の語彙スコアを持たない限り小さい top-k でも押し出されない。ただしこれは健全索引との完全同等ではない: 競合がクエリの char-bigram の大部分を共有して代理順位で上回る場合、raw/vector/seed の追加分を持つ場合、同点で createdAt が新しい場合、または損傷レコードが複数あり代理順位 0 を取れない場合は損傷レコードは依然圏外となりうる (残存条件の正直な報告)。評価は会話形クエリを limit 3 で主張し、一意 anchor クエリ (limit 10) も併せて主張する、設定 `cultivation.queueMax=8` で open review が有界のまま全正準書込みが確定する。報告は決定論的構造の単一行 JSON (規模別の retrieval 指標・CLI 遅延統計・DB バイト・正直に観測可能な資源量のみ)。観測例: 全規模で positive recall 1.0/RR 1.0 (P@3 0.333 は k=3 に対する 1 件的中の算術であり閾値ではない)、CLI 遅延 median ~69.5ms で規模に鈍感、DB 356KB/582KB/942KB と規模に比例。合否閾値を設けず、低スコア単独では exit 0 (invariant 違反時のみ非ゼロ)。語彙結果を意味/モデル品質と呼ばない。モデル leg は既定で不試行 (`--model-dir` 指定時のみ参照・取得なし) のため、実ベースラインはモデル不在でも完走する。制限: 検索語彙は合成 anchor 中心で実会話の言い換え耐性は主張しない、vault 投影は観測時点で未生成 (queue 滞留の best-effort) のため件数は 0 報告、RSS/heap は評価 harness プロセスの値であり CLI 子プロセスの資源ではない。再現は `npm run eval:operations` のみ。

R09 (M2/M3 承認ゲート用) 公式候補提案記録 (metadata のみ、未採用・未 pin・未 install・runtime 互換/採用主張なし):

- 第一候補 `intfloat/multilingual-e5-small` 公式 rev `614241f622f53c4eeff9890bdc4f31cfecc418b3`: card 宣言 MIT、日本語対応、384 dims、512 tokens、非英語含め query:/passage: prefix 必須、mask mean pool + L2 正規化。ONNX は LFS `470268510B` (`sha256:ca456c06b3a9505ddfd9131408916dd79290368331e7d76bb621f1cba6bc8665`)。根拠は https://huggingface.co/intfloat/multilingual-e5-small/raw/614241f622f53c4eeff9890bdc4f31cfecc418b3/README.md および https://huggingface.co/api/models/intfloat/multilingual-e5-small/tree/614241f622f53c4eeff9890bdc4f31cfecc418b3?recursive=true の公式 metadata (重み /resolve ダウンロードなし)。
- 第二候補 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` 公式 rev `e8f8c211226b894fcb81acc59f3b34ba3efd5f42` (40 chars; 旧稿の `8f8c211226b894fcb81acc59f3b34ba3efd5f42` 39 chars は先頭 `e` 脱落の誤記であり、metadata 到達不能ではなく不正入力だった): card 宣言 Apache-2.0、日本語対応、384 dims、SentenceTransformer 実効 128 tokens (base 512 ではない)、prefix なし mean pool、明示 L2 なし。ONNX は LFS `470301610B` (`sha256:10f7a088420252b26caf819236ca2c9d2987afd0fc06fec7553b542a5655a05a`)。card 根拠は https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/raw/e8f8c211226b894fcb81acc59f3b34ba3efd5f42/README.md、tree 根拠は https://huggingface.co/api/models/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/tree/e8f8c211226b894fcb81acc59f3b34ba3efd5f42?recursive=true、token 上限根拠は https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/raw/e8f8c211226b894fcb81acc59f3b34ba3efd5f42/sentence_bert_config.json (`max_seq_length: 128`、`do_lower_case: false`)、pooling 根拠は https://huggingface.co/sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2/raw/e8f8c211226b894fcb81acc59f3b34ba3efd5f42/1_Pooling/config.json (`word_embedding_dimension: 384`、`pooling_mode_mean_tokens: true`、`pooling_mode_cls_token: false`、`pooling_mode_max_tokens: false`、`pooling_mode_mean_sqrt_len_tokens: false`) の公式 metadata (重み /resolve ダウンロードなし)。
- 上記 hash は公式 tree API の LFS 宣言値であり、ダウンロード byte 検証ではない。card 宣言 license のみで単独 LICENSE ファイルは未確認、再配布条件は未精査。`onnxruntime-node` / Transformers.js は未採用・未 pin・未テストで install なし。M2 (model/runtime/chunk)、M3 (policy/quality threshold/integration) は承認ゲートに残り、R13 semantic 完成主張はしない。

## 未実装の明示

- Companion 連携、削除 (消去) API、エクスポート API、直接 Markdown 編集の取込みはない。`archive` は検索除外であり削除ではなく、可逆引退ではない。`archived` の明示的検索範囲は未決定。高度なスケジューリング (起動条件・熱重み調整) は任意の将来課題。`usedCount` は `record.feedback` の引用計数の累積のみ。
- Companion 連携の契約部分は I01 決定 (2026-10-18、F-I01-01..08) で採択済み (詳細は下記「I01/I04 契約決定の記録」)。削除 (消去) API、エクスポート API、直接 Markdown 編集の取込みは引き続き未実装であり、privacy metadata (F-I01-05) は同日の決定に基づき実装済み (詳細は下記「privacy metadata (F-I01-05・実装済み・追加のみ)」)。

## I01/I04 契約決定の記録 (2026-10-18・実装済み・追加のみ)

I01 (Companion 連携契約) と I04 (retrieval 契約) の決定 F-I01-01..08・F-I04-01..06 (decider haruka、source: companion_harness/docs/plan/decision_inputs_2026-10-18.md) を受けて、既存 op へ追加フィールドのみを実装した (新規 op・新規 error code なし、 既存の順序・上限・heat・露出・byte 予算の挙動不変):

- `record.recall` の各 item は元記録の `revision` と `kind` を含む (同じ行から付加的に返す。引用が実使用 revision を固定し、`model_inference` を `user_fact` と区別できる)。`recallId + items[{..., revision, kind}]`。
- `record.recall` 成功 data は必ず top-level `vector` 状態を持つ (F-I01-06): `"disabled"` (設定 `vectors` 無効/欠落)、`"used"` (クエリ埋め込みが計算されベクトル候補が実際に参加)、`"unavailable"` (有効だがモデル/索引/クエリ埋め込みが欠落または失敗で語彙+グラフ縮退で実行)。計算追加なし・順位変更なし・byte 予算 probe はそのまま正しい。
- `record.search` の各 item も `revision` を含む (PR #15、`feat/search-item-revision`)。
- 数値 `v` が 1 以外の JSON は `BAD_REQUEST` で固定メッセージ `unsupported protocol version` を返す (envelope は `v:1` のまま、新 error code なし)。`v` 欠落・非数値は従来どおり `bad request`。

これらは後方互換の付加フィールドであり、未知招来キーを検証する呼出側 (`src/fake-adapter.ts`・`scripts/baseline-score.ts`) は付加 superset を受け入れる。

## privacy metadata (F-I01-05・実装済み・追加のみ)

2026-10-18 の F-I01-05/F-I04-07 決定 (decider haruka、§12 U1 の決定記録バレット参照) を受けて、既存 3 書込 op への任意オプトインフィールド `privacy` のみを追加した (新規 op・新規 error code なし、既存の順序・上限・heat・露出・想起了動作の不変):

- `event.append / record.remember / record.correct` は任意の `privacy` `{sensitivity, origin}` を受け付ける。値は厳密にキー 2 つ `{sensitivity: "normal" | "sensitive", origin: "conversation" | "self_activity"}` で、余分な鍵・鍵欠落・列挙外・非オブジェクトは `BAD_REQUEST` (副作用なし)。
- `record.correct` で `privacy` を省略したときは訂正対象 (supersede 対象) の旧版の privacy を継承し、明示指定時は上書きする。
- 設定 `requirePrivacy` (既定 false): `true` のとき `privacy` を欠く `event.append / record.remember` は `BAD_REQUEST` で拒否する。
- `privacy` は `record.get` および `record.search` の各 item で返す。privacy を持たない旧世代の行は `privacy: null` と読み戻る。`record.recall` の出力・順位には影響しない (P4a: 保存と返却のみ)。
- 蒸留 (`maintain.distill`) が生成する記憶 (summary/consolidation) は origin を `self_activity` に固定し、sensitivity は伝播則に従う: source のいずれか 1 件でも `sensitive` なら `sensitive`、全 source が privacy 既知なら `normal`、それ以外 (privacy 不明の source を含む) は `null`。

## 本番構成 (2026-10-19 追記・追加のみ)

Companion との連携が本番運用中 (2026-10-19 現在):

- I01/I04 連携契約は 2026-10-18 に採用済み (decider haruka)。Companion は呼出ごとに remind CLI を spawn し、`COMPANION_MEMORY_JSON` 経由で memory JSON を渡す (一行 JSON 入出力の既存 CLI 契約を利用)。
- 本番 check-out: `~/remind_master`。設定: `~/.config/remind/memory.config.json`。データ: `~/.local/share/remind`。
- バックアップ・自動デプロイは companion_harness 側 `scripts/deploy` が管理 (companion_harness PRs #91/#92、同 PR は 2026-10-19 時点で open)。
- 育成 (cultivation) 用 LLM は現時点で無効 (disabled)。
