# remind-memory-cli (M1 自律連想記憶)

ローカル専用の自律連想記憶 CLI。AI が `event.append` で現物を追記し、`record.remember` で直接 active 記憶として書き込む。候補・承認・トークン・TTY の仕組みはない。全書き込みは呼出者指定 `idempotencyKey` で直接確定する。

正本は単一 SQLite のみ。Markdown Vault は正本から生成する派生投影であり、正本ではない。

## 前提

- Node.js `24.12.0`、npm `11.6.2`
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
- `limits`: `bodyMaxCp / queryMaxCp / tagsMax / linksMax / sourceRefsMax / limitDefault / limitMax / snippetMaxCp / responseMaxBytes`
- `timeouts`: `cliMs` (全体期限)、`busyMs` (SQLite 待機)
- `dbMaxBytes`: 上限超過の書き込みは `STORE_UNAVAILABLE` で巻き戻し。読み取りは継続する

`memory.config.json` は git 管理対象外。コミットしないこと。

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
'{"v":1,"op":"record.feedback","idempotencyKey":"fb-001","params":{"recallId":"<recallId>","recordIds":["<recordId>"],"scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.correct","idempotencyKey":"corr-001","params":{"recordId":"<recordId>","body":"revised orchard memo","kind":"correction","provenance":{"source":"session:s1:turn:9","observedAt":"2026-09-02T00:00:00.000Z"},"scope":"personal/default","sourceRefs":["e-001"]}}' | node dist/src/cli.js --config ./memory.config.json
'{"v":1,"op":"record.archive","idempotencyKey":"arc-001","params":{"id":"<recordId>","scope":"personal/default","reasonCode":"USER_ARCHIVED"}}' | node dist/src/cli.js --config ./memory.config.json
```

- `record.get` は status によらず同一 scope の 1 件を返す。`record.list` は既定 active のみ。順序 `createdAt DESC, id ASC`。`since` inclusive、`until` exclusive。
- `record.feedback` は引用・採用の明示報告のみ熱を加算する。見るだけでは加算しない。露出集合外の ID は全体拒否。
- `record.correct` は新 revision 追記 + 旧 `active -> superseded` を同一 txn で行う。並行訂正は勝者 1 件、敗者は `CONFLICT`。`kind` は `correction` 固定。
- `record.archive` は `active -> archived` の終端遷移 (復帰なし)。`reasonCode` は `USER_ARCHIVED / OBSOLETE / DUPLICATE` の固定コードのみ。行は保持され、削除ではない。

## リンク・backlink・Markdown 投影

- `remember / correct` で複数の関連 `links[]` (不透明な record ref) を付与できる。関連先がない場合は 0 件でよい。恣意的な埋め草は書かない。
- backlink は正本 outbound からの派生表示であり、独立に書き込まない。グラフ走査は active・同一 scope に解決する ref のみ辿り、深さ上限 2・展開上限 40。dangling は保持して飛ばす。
- `vaultPath/<id>.md` に `[[ref]]` と backlink 節を持つ Obsidian 互換表示を投影する。正本は SQLite のみ。投影・索引の失敗は確定済み記憶を取り消さない。直接の Markdown 編集の取込みはない。編集は `record.correct` を使う。

## 想起方式

語彙 (FTS5/BM25 + char-bigram) + raw 下降 (`record_source_refs` 経由で active・同一 scope レコードへ写像) + タグ・リンク種 + 有界グラフ展開の融合。同一の正本・索引・heat 状態では同一順序。同点は `createdAt DESC, id ASC`。超過は切り詰めず `LIMIT_EXCEEDED`。

## 冪等・エラー

- 全書き込みは `idempotencyKey` 必須。欠落は `BAD_REQUEST`。同一キー + 同一 params の再送は保存済み応答を `deduplicated:true` で返す。params 改変は `CONFLICT`。
- 固定コードのみ: `OK / BAD_REQUEST / NOT_FOUND / CONFLICT / FORBIDDEN_SCOPE / STORE_UNAVAILABLE / LIMIT_EXCEEDED / TIMEOUT`。`message` は固定文言で本文・クエリを含まない。
- 旧世代の操作 (`candidate.create`、`candidate.get`、`approve`、`review`、`record.correct-request` 等) は未知 op として `BAD_REQUEST` で拒否される。

## 旧 DB の扱い

旧承認スキーマの DB (candidates 表等) は起動失敗 (stderr 固定文 + 非ゼロ終了) し、変更・削除・移行はしない。旧ファイルを退避し、`dbPath` に新しいファイルを指定すること。

## テスト

```powershell
npm test         # build + 全テスト
npm run smoke    # 一時 DB での event.append -> remember -> recall 確認
npm run acceptance  # M1 受け入れ 7 件
```

受け入れ条件は `docs/acceptance-manifest.md`、保持方針は `docs/retention.md` を参照。

## 未実装の明示

- M2 ベクトル意味検索は未実装。想起は語彙 + グラフに縮退して動作する。
- M3 `maintain.distill` (蒸留・統合) は未実装。
- Companion 連携、削除 (消去) API、エクスポート API、直接 Markdown 編集の取込みはない。`archive` は検索除外であり削除ではない。
