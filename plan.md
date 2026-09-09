# 自律記憶計画（正本・authoritative）

> **本書の位置づけ（必読）**
> - 本書は外部長期記憶システムの**正本計画**であり、旧版の承認ベース計画を**置き換える**。
> - **決定済み要件:** AI が記憶すべき内容を自律的に判断し、 durable な active 記憶として**即時に書き込む**。通常の書き込み・想起に、候補化・承認・承認トークン・承認猶予期限・TTY ゲート・人間の同意ステップを**要求しない**。これは提案ではなく決定である。
> - **現行実装との不整合:** 現在の実装（candidate → 人手 review/approve → record）は**本改訂前の設計**であり、本計画に**適合しない**。既存の承認コードを適合とみなしてはならない。再実装または大幅改修が必要である。
> - 旧計画から継承するのは「別リポジトリ・ローカル運用・ネットワーク公開なし・共有 DB なし」のみである（§1）。T1–T6 の承認採用 ledger・per-task テスト件数は正本記録から**除外**する。

## 目次

- [1. 決定事項](#1-決定事項)
- [2. 製品ゴール](#2-製品ゴール)
- [3. 用語と記録モデル](#3-用語と記録モデル)
- [4. MVP プロトコル](#4-mvp-プロトコル)
- [5. スキーマ・状態遷移・ライフサイクル](#5-スキーマ状態遷移ライフサイクル)
- [6. 想起](#6-想起決定論的有界)
- [7. 監査と露出記録](#7-監査と露出記録メタのみ)
- [8. 制限・タイムアウト・縮退](#8-制限タイムアウト縮退)
- [9. 受入基準](#9-受入基準)
- [10. ロードマップ](#10-ロードマップ)
- [11. 非目標](#11-非目標)
- [12. 未解決事項](#12-未解決事項)

---

## 1. 決定事項

- **D1 自律書き込み:** AI は記憶対象を自律判断し、`record.remember` で候補経由なしに active 記憶として直接永続化する。承認の代替となる自動 admission ゲート（自動承認・自動採否・意味的フィルタ）を設けない。ストアが検証するのは構造・セキュリティ・有界性のみであり、AI の記憶内容を意味的に審査しない。
- **D2 人間は任意の管理者:** 人間の行動は通常運用に**不要**である。AI と任意の人間管理者は同一の有界ローカル I/F（CLI/API、TTY 要求なし）経由で `correct` / `archive` を呼べる。人間が行うのは検査・訂正・アーカイブのみである。
- **D3 別リポジトリ・ローカル・非公開（旧決定を継承）:** Companion Harness とは別リポジトリで開発する。既定でローカル運用・ネットワーク公開なし。Companion と DB を共有せず、kernel / package を直接 import しない。
- **D4 追記型・非削除:** 訂正は改訂追記＋旧版 supersede、アーカイブは検索除外フラグとする。物理削除・消去保証は主張しない（§12 U2）。

---

## 2. 製品ゴール

- AI が会話・作業から「後で役立つ」内容を自律的に `record.remember` し、後の `record.recall` で有界・決定論的に再利用する。
- 人間不在でも記憶は蓄積・利用される。通常の write/recall が人間待ちで止まらない。
- 人間の管理者は任意であり、誤りの訂正と不要記憶のアーカイブに限定される。

---

## 3. 用語と記録モデル

- **record:** 内容不変（immutable）の記憶レコード。更新は新 revision の追記で表し、既存行を書き換えない。
- **kind:** `user_fact`（ユーザ事実）| `model_inference`（モデル推論）| `summary`（要約）| `correction`（訂正）。ユーザ事実とモデル推論を同一レコードに混在させない。推論は推論として mark し、検証済み事実として扱わない。
- **provenance:** `source`（由来ポインタ・不透明）+ `observedAt`（UTC 正準ミリ秒 RFC3339）。Companion 由来 ID は不透明参照とし、DB 結合キーにしない。
- **scope:** 記憶の隔離単位。`get/list/recall` は同一 scope のみを対象とし、他 scope を露出しない。
- **記憶本文は untrusted:** 指示として信用しない。system/データ分離・サイズ上限で防御し、テキスト sanitization による解決を主張しない。

---

## 4. MVP プロトコル

共通封筒（JSON 1 行、UTF-8、LF 終端）。書込系の `idempotencyKey` は**呼出者指定の必須**（1..128 文字の ASCII 安全文字）。欠落は `BAD_REQUEST`。同一キー＋同一 params の再送は保存済み応答を `deduplicated:true` で返し、params 改変は `CONFLICT` とする。`operations` はコミット成功した書込系 `OK` 応答のみ保存し、失敗はキーを確保しない。

| op | 意味 | params（要点） |
| --- | --- | --- |
| `record.remember` | 自律書き込み。1 トランザクションで `active` として直接永続化 | `body/kind/provenance/scope/tags[]/link/runId` |
| `record.get` | 1 件取得。同一 scope の id を status によらず返す（active/superseded/archived） | `id/scope` |
| `record.list` | 有界一覧。既定は active のみ、任意の `status` 指定で履歴検査可。順序は `createdAt DESC, id ASC`、`since` inclusive / `until` exclusive | `scope/limit/since/until/status?` |
| `record.recall` | 決定論的想起（§6）。露出を監査記録 | `query/tags[]/link/since/until/limit/scope/runId` |
| `record.correct` | 訂正。新 record 追記＋旧 `active → superseded` を同一トランザクションで行う | `recordId/body/kind=correction/provenance/scope` |
| `record.archive` | 検索・想起対象からの除外。`active → archived`（終端・復帰なし）。物理削除ではない | `id/scope/reasonCode`（固定コードのみ） |

- 訂正の競合は旧行の条件付き UPDATE（`WHERE id=? AND status='active' AND scope=?`）の更新行数で勝者 1 件に絞り、敗者は `CONFLICT` で全巻き戻しとし新規レコードを書き込まない（再送は呼出者が行う）。
- `correct` / `archive` は対象行なしを `NOT_FOUND`、scope 不一致を `FORBIDDEN_SCOPE`、非 active 対象を `CONFLICT` とする。
- エラーコード（固定）: `OK / BAD_REQUEST / NOT_FOUND / CONFLICT / FORBIDDEN_SCOPE / STORE_UNAVAILABLE / LIMIT_EXCEEDED / TIMEOUT`。`message` は固定テンプレのみとし、記憶本文・クエリ原文を含めない。

---

## 5. スキーマ・状態遷移・ライフサイクル

概念スキーマ（格納形式・DDL は実装時に確定）:

- `records(id PK, body, bodyHash, kind, source, observedAt, scope, status, supersedes NULL, revision, createdAt)`
- `record_tags(recordId, tag)` / `record_links(fromId, toName)`（決定論的 exact 一致用。意味リンクを作らない）
- `scopes(scope PK)`（起動時 config から初期投入。判定は起動時一覧 AND DB 行）
- `operations(idempotencyKey PK, op, requestHash, responseJson, createdAt)`
- `audit(ts, op, targetId, code, scope, bytes, limit, runId, recallId, reasonCode)`（本文なし）
- `exposures(ts, recallId, runId, scope, recordId, snippetBytes, truncated, limit)`（本文なし）

状態遷移: `correct` は `active → superseded`、`archive` は `active → archived` のみ。終端からの復帰なし（MVP）。

ライフサイクル:

```text
AI 自律判断
  │ record.remember（呼出者指定 idempotencyKey）
  ▼
[active] ── record.recall/get/list（同一 scope・有界・監査付き）──→ 利用
  │ record.correct（新 revision 追記＋旧版 supersede・同一 txn）  │ record.archive（除外フラグ・同一 txn で監査）
  ▼                                                              ▼
[superseded]（想起対象外・連鎖で辿行可・行は保持）  [archived]（検索・想起対象外・行は保持・物理削除ではない）

AI と任意の人間管理: 検査（get/list/recall）→ correct / archive（同一ローカル I/F・TTY 不要）
```

---

## 6. 想起（決定論的・有界）

- **正規化:** NFKC → trim → 連続空白を半角スペース 1 個に畳み込み → ASCII 英字のみ casefold。`body/query/tag` に同一適用（`link` 名は casefold なし）。
- **一致:** 本文リテラル部分一致（ワイルドカードなし）AND タグ exact 一致 AND リンク名 exact 一致 AND 時刻範囲（`createdAt` に対する `since` inclusive / `until` exclusive）。意味類似・曖昧一致・LLM クエリ生成を使わない。
- **順序:** `createdAt DESC, id ASC` の固定順。スコア順・ランダム順を使わない。
- **有界投影:** 本文先頭から最大 `snippetMaxCp` の前方切り出し＋ `truncated(bool)` を返す。応答は `recallId + items[{id, snippet, truncated, tags, createdAt}]`。

---

## 7. 監査と露出記録（メタのみ）

- `remember/correct/archive/recall` と露出を `audit` + `exposures` に記録し、`recallId` で突合できる。
- 記録項目はメタのみとし、記憶本文・クエリ原文・snippet 全文・シークレットを含めない。
- 監査・露出の書込み失敗は fail closed とし、無監査の成功応答を作らない（`record.recall` も例外としない）。

---

## 8. 制限・タイムアウト・縮退

以下の数値は**暫定既定値（config 化）**であり、製品の本質的決定ではない。変更は起動時 config のみで行い、要求 JSON による上書き・実行中の書換えは受け付けない。

- `body 2000cp / query 500cp / tags 5 / limit 既定10・最大25 / snippet 200cp / 応答合計 8KB / 生要求 32KB`
- `CLI タイムアウト 5s / SQLite busy_timeout 2s / DB 上限 100MB`（超過時は書込み拒否）
- 超過入力・超過応答は切詰めず `LIMIT_EXCEEDED` で拒否する。個別上限内でも応答合計 8KB 超は `LIMIT_EXCEEDED` とし、適応的切詰めは行わない。
- DB 利用不可・破損・タイムアウト時は `STORE_UNAVAILABLE` / `TIMEOUT` を返し、呼出側は**記憶なしの通常応答に縮退**する。記憶欠落を生成失敗の理由にしない。診断は固定コードのみとする。
- commit 対 timeout の未知結果は同一 `idempotencyKey`＋同一 params の再送で解決する（`deduplicated` で確定させる）。

---

## 9. 受入基準

- **R1 自律即時性:** `record.remember` 直後に `record.recall` で当該内容が出現する。承認待ち・TTY 操作を介さない。
- **R2 承認残滓なし:** 候補テーブル・承認トークン・期限付き承認・TTY 必須操作が存在しない。
- **R3 訂正:** 訂正後に旧 record は `superseded` となり想起に出ない。新旧は `supersedes` 連鎖で辿れる。並行訂正は勝者 1 件のみ、敗者は `CONFLICT`。
- **R4 アーカイブ:** `archive` 後に想起・一覧に出ない。行は保持され、物理削除ではない。
- **R5 冪等性:** 同一キー＋同一 params 再送は `deduplicated:true` で同一結果、params 改変は `CONFLICT`、キー欠落の書込は `BAD_REQUEST`。
- **R6 分離と監査:** 他 scope の record は `recall/get/list` に出ない。`audit/exposures`・エラー応答に本文原文を含まない。
- **R7 縮退:** DB 不可時は `STORE_UNAVAILABLE` を返し、呼出側は記憶なしで継続する。無監査の想起成功を作らない。
- **R8 有界・決定論:** 同一 `recall` は同一順序。超過は `LIMIT_EXCEEDED` で切詰めなし。

---

## 10. ロードマップ

| 段階 | 内容 | 受入目安 |
| --- | --- | --- |
| M1 自律ストア | `remember/get/list/recall/correct/archive`＋決定論的想起＋本文なし監査＋有界・縮退 | §9 R1–R8 |
| M2 評価 | fake 会話＋seeded 記憶による引用突合ベースの小規模評価（実ユーザデータ不使用） | 想起適合・縮退率・レイテンシ増加分の記録 |
| M3 任意拡張 | vector・統合/圧縮・保守トリガは M1–M2 の結果を見て別途判断。採用は必須としない | 別途計画 |

---

## 11. 非目標

- 候補テーブル・承認フロー・承認トークン・TTY 対話・同意 UI。
- 意味的事実検証・RAG/vector の必須化・特定埋め込みモデルや次元の指定・常時注入。
- 自律エージェント・sentience・制御不能なバックグラウンドループ。
- リモートサービス化・ネットワーク公開・外部への記憶送信・外部テレメトリ。
- 物理削除・消去保証・エクスポート API の新設（§12 U2 に延期）。
- 承認された連携契約なしの Companion 側への記憶書き込み・承認バイパス。

---

## 12. 未解決事項

- **U1 Companion 連携契約:** 連携の可否・時期・手段（MCP・ローカル API 等の代替案を含む）。連携までは Companion 側への記憶書き込みを行わない。
- **U2 保持・エクスポート・削除方針:** 保持期間・削除可否・エクスポート要否。`archive` は除外であり削除ではない。消去保証は主張しない。
- **U3 ベクトル索引:** 要否・モデル・pin・ライセンス（用いる場合のみ）。
- **U4 統合/圧縮・維持トリガ:** 要否・頻度・しきい値。MVP の必須としない。
- **U5 評価:** データセット・指標・閾値。
- **U6 有界定数の最終値:** §8 の既定値は暫定であり、実測で見直す。
