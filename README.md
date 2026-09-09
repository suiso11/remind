# remind-memory-cli

ローカル専用の外部長期記憶 CLI（T1–T6 MVP）。SQLite に候補・レコード・監査証跡を保存し、自動処理は 1 行 JSON、承認などの重要操作は人間の端末でのみ行います。

## 前提条件

- Node.js `24.12.0`、npm `11.6.2`
- ランタイム依存なし（SQLite は Node 標準 `node:sqlite` を使用）
- Windows PowerShell の例を中心に記載（パイプの 1 行 JSON は他シェルでも同様）

## セットアップ / ビルド

```powershell
npm ci
npm run build
Copy-Item memory.config.example.json memory.config.json
```

- `memory.config.json` はローカル専用（git 管理対象外）。コミットしないでください。
- `dbPath` は設定ファイルからの相対パスとして解決されます。

## 設定（`memory.config.example.json`）

- `dbPath`: SQLite ファイルの場所（例 `./memory.db`）
- `allowedScopes`: 利用可能なスコープ（例 `["personal/default"]`）
- `candidateTtlSec`: 承認の有効期限（例 259200 = 72 時間）。期限切れは削除ではなく承認不可（`EXPIRED`）になります
- `limits`: 本文・クエリ・タグ・件数・応答サイズの上限
- `timeouts`: `cliMs`（全体期限）、`busyMs`（SQLite 待機）
- `dbMaxBytes`: DB サイズの上限（超過する書き込みはロールバックし `STORE_UNAVAILABLE`）

起動時設定はファイルのみです。不明な項目は起動失敗、環境変数やリクエスト JSON での上書きはできません。

## 使い方：JSON 自動操作

基本形（標準入力に 1 行 JSON、標準出力に 1 行 JSON、終了コード `0`）：

```powershell
'{"v":1,"op":"record.recall","params":{"query":"booking","scope":"personal/default","limit":10}}' | node dist/src/cli.js --config ./memory.config.json
```

自動処理で実行できる操作は 4 つのみです（`src/protocol.ts`、`src/cli.ts` で確認）：

| 操作 | 用途 | 注意 |
| --- | --- | --- |
| `candidate.create` | 候補の登録 | `idempotencyKey` 必須 |
| `candidate.get` | 候補メタデータの参照（本文なし） | `params: {id, scope}` |
| `record.recall` | 承認済み・有効な記録の検索 | 承認済みのみ対象 |
| `record.correct-request` | 訂正候補の登録 | `idempotencyKey` 必須 |

例：

```powershell
# 候補の登録
'{"v":1,"op":"candidate.create","idempotencyKey":"walk-001","params":{"body":"next wednesday booking check","kind":"user_fact","provenance":{"source":"session:s1:turn:3","observedAt":"2026-09-01T00:00:00.000Z"},"scope":"personal/default","tags":["schedule"],"ttlSec":259200,"runId":"run-001"}}' | node dist/src/cli.js --config ./memory.config.json

# 候補メタデータの参照
'{"v":1,"op":"candidate.get","params":{"id":"<candId>","scope":"personal/default"}}' | node dist/src/cli.js --config ./memory.config.json

# 検索（承認済み active のみ、本文の断片を返す）
'{"v":1,"op":"record.recall","params":{"query":"booking","scope":"personal/default","limit":10}}' | node dist/src/cli.js --config ./memory.config.json

# 訂正候補の登録（<recordId> は訂正対象の記録 ID）
'{"v":1,"op":"record.correct-request","idempotencyKey":"corr-001","params":{"recordId":"<recordId>","body":"corrected text","provenance":{"source":"session:s1:turn:9","observedAt":"2026-09-02T00:00:00.000Z"},"scope":"personal/default","runId":"run-002"}}' | node dist/src/cli.js --config ./memory.config.json
```

- 書き込み操作は同じ `idempotencyKey` + 同じ内容なら再送可（`deduplicated:true`）。内容を変えた再送は `CONFLICT` です。
- JSON 経由の `approve` / `reject` / `archive` は `FORBIDDEN` になります。未知の操作は `BAD_REQUEST` です。

## 使い方：人間の端末操作（TTY 必須）

`review` / `approve` / `reject` / `archive` は実際の端末でのみ実行できます。**標準入力と標準出力の両方が TTY** である必要があります（リダイレクトやパイプでは不可）。

- `review` は表示のみで、確認入力は不要です。
- `approve` / `reject` / `archive` は確認プロンプトに `yes` と手入力が必要です。`--confirm` のようなフラグは受け付けません。

```powershell
# 内容確認（本文・承認トークンを端末に表示）
node dist/src/cli.js review --config ./memory.config.json --id <candId> --scope personal/default

# 承認（<approvalToken> は review に表示されたもの）
node dist/src/cli.js approve --config ./memory.config.json --id <candId> --scope personal/default --token <approvalToken> --idempotency-key h-001

# 否認
node dist/src/cli.js reject --config ./memory.config.json --id <candId> --scope personal/default --token <approvalToken> --idempotency-key h-002 --reason-code USER_REJECTED

# アーカイブ（トークン不要、記録が検索対象外になる）
node dist/src/cli.js archive --config ./memory.config.json --id <recordId> --scope personal/default --idempotency-key h-003 --reason-code USER_ARCHIVED
```

TTY でない `approve` / `reject` / `archive` は `FORBIDDEN`、TTY でない `review` はエラーを返し、本文やトークンは出しません。

## テスト

`package.json` のスクリプトと対応（`src/cli.ts`・`src/protocol.ts` に対する内容）：

```powershell
npm test         # build + 全テスト
npm run smoke    # 一時ディレクトリでの CLI 動作確認
npm run acceptance  # A1-A13 + A8b の受け入れテスト
```

- `npm test` の 1 件のスキップは、実際の端末での確認操作のみ手動のためです。
- 詳しい受け入れ条件は `docs/acceptance-manifest.md`、保持の方針は `docs/retention.md` を参照してください。

## データと安全な動作

- 監査（`audit` / `exposures`）はメタデータのみで、本文・クエリ・断片は記録しません。
- 期限切れ・アーカイブ・supersede はいずれも行を残します。削除する処理はありません。
- 応答サイズ上限を超える応答は切り詰めず `LIMIT_EXCEEDED` で失敗します。
- 標準入力はバイト数上限と期限で保護され、DB 操作は残り時間で打ち切られ `TIMEOUT` になります。タイムアウト後の確定状態は不明なものとして扱い、同じキーでの再送で確認します。
- バックアップは CLI 停止中に SQLite ファイルをコピーしてください。稼働中のエクスポート機能はありません。

## 現時点の制限（明確にないもの）

- Companion 連携はありません。
- エクスポート機能・削除（消去）API はありません。`archive` は検索対象外にするだけで、削除ではありません。
- ベクトル検索・自動要約・バックグラウンド処理はありません。
- 訂正の競合は 1 件のみが勝者となり、敗者は `CONFLICT` でロールバックします。
- 同一 OS ユーザーが DB ファイルを直接読める前提のローカル単独利用です。ファイル権限は運用上の推奨であり、厳密な境界ではありません。
