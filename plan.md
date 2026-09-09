# 自律連想記憶計画（正本・authoritative）

> **本書の位置づけ（必読）**
> - 本書は外部長期記憶システムの**正本計画**であり、旧版の承認ベース計画を**置き換える**。
> - **決定済み要件:** AI が記憶すべき内容を自律的に判断し、durable な active 記憶として**即時に書き込む**。通常の書き込み・想起に、候補化・承認・承認トークン・承認猶予期限・TTY ゲート・人間の同意ステップを**要求しない**。これは提案ではなく決定である。
> - **passive-vault 問題:** 書いた記憶が孤立ノートの集積に留まり、結び付かない・呼び戻されない・育たない vault は本計画の失敗である。記憶は**書く・結ぶ・呼び戻す・育てる**の四機能を満たさなければならない（§2 P1）。
> - **現行実装との不整合:** 現在の実装は呼出者指定の exact リンク 1 件のみを持ち、AI によるリンク付与・backlink グラフ・連想想起を**持たない**。これは本改訂前の設計であり、本計画に**適合しない**。既存の承認コード・単純 recall を適合とみなしてはならない。再実装または大幅改修が必要である。
> - 旧計画から継承するのは「別リポジトリ・ローカル運用・ネットワーク公開なし・共有 DB なし」のみである（§1）。T1–T6 の承認採用 ledger・per-task テスト件数は正本記録から**除外**する。
> - FIO 由来の知見は**パターン採用**であり実績主張ではない。FIO は Markdown を正本に置くが、本計画は単一 SQLite 正本へ**適応**した（§13 参照）。出典は §13、p11 の未検証申告を参照。

## 目次

- [1. 決定事項](#1-決定事項)
- [2. 製品ゴール](#2-製品ゴール)
- [3. 用語と単一正本モデル](#3-用語と単一正本モデル)
- [4. MVP プロトコル](#4-mvp-プロトコル)
- [5. スキーマ・状態遷移・ライフサイクル](#5-スキーマ状態遷移ライフサイクル)
- [6. 想起](#6-想起有界ハイブリッド)
- [7. リンク・利用記録・保守](#7-リンク利用記録保守)
- [8. 制限・タイムアウト・縮退](#8-制限タイムアウト縮退)
- [9. 受入基準](#9-受入基準)
- [10. ロードマップ](#10-ロードマップ)
- [11. 非目標](#11-非目標)
- [12. 未解決事項](#12-未解決事項)
- [13. 出典メモ](#13-出典メモ)

---

## 1. 決定事項

- **D1 自律書き込み:** AI は記憶対象を自律判断し、`record.remember` で候補経由なしに active 記憶として直接永続化する。承認の代替となる自動 admission ゲートを設けない。ストアが検証するのは構造・セキュリティ・有界性のみである。
- **D2 人間は任意の管理者:** 人間の行動は通常運用に**不要**である。AI と任意の人間管理者は同一の有界ローカル I/F（CLI/API、TTY 要求なし）経由で検査・`correct` / `archive` を行える。人間編集は常に任意であり、直接ファイル編集ではなく `record.correct` を経由する（§3）。
- **D3 別リポジトリ・ローカル・非公開（旧決定を継承）:** Companion Harness とは別リポジトリで開発する。既定でローカル運用・ネットワーク公開なし・外部送信なし。Companion と DB を共有せず、kernel / package を直接 import しない。
- **D4 追記型・非削除:** 訂正は改訂追記＋旧版 supersede、アーカイブは検索除外フラグとする。物理削除・消去保証は主張しない（§12 U2）。
- **D5 連想記憶の製品決定（P1）:** 記憶は**書く・結ぶ・呼び戻す・育てる**。保存だけの vault を認めない。書くたびに関連する `[[リンク]]` で結び、想起は語彙＋ベクトル＋グラフで呼び戻し、保守で蒸留・統合して育てる。
- **D6 単一正本 SQLite・派生投影:** 正本は**単一の SQLite** のみである（raw_events・records・正本 outbound リンク・operations・audit/usage・heat）。Markdown Vault は Obsidian 互換の**再構築可能な投影**であり正本ではない。backlink・FTS・ベクトル索引も再構築可能な派生物である（§3・§5）。
- **D7 有界自律:** 基本書き込みに常駐バックグラウンドループを**要求しない**。保守（蒸留・統合）は有界・取消可能・同時実行 1 とし、無制限の自律ループを作らない。保守は候補・承認を経ず通常の冪等 op で直接書く（§7）。
- **D8 単一ストア原子性のみ:** 原子性を主張するのは単一 SQLite トランザクションの範囲のみである。Markdown・索引への投影はコミット後の best-effort であり、複数ストア間の原子性は主張しない（§4）。

---

## 2. 製品ゴール

- AI が会話・作業から「後で役立つ」内容を自律的に `record.remember` し、後の `record.recall` で有界・決定論的に再利用する。人間不在でも蓄積・利用が止まらない。
- **書く:** セッション終了・区切りを待たず、ターン二周目相当の timing で即時永続化する（失敗はリトライキューへ）。
- **結ぶ:** 有界の既存ノート想起・タグ文脈で正当化できる場合に複数の関連 `[[outbound リンク]]` を付与する。関連先がない場合はリンク 0 件を許容し、有界保守で後付けする。恣意的な埋め草リンク・dangling 稼ぎは禁止する（§7）。
- **呼び戻す:** 要約から raw 現物へ降りられる。要約の質に想起の上限を縛られない。
- **育てる:** 利用された記憶だけが熱を持ち、保守で蒸留・統合される。見られただけでは育てない。最小の育成マイルストーンは計画完成に必須であり、高度なスケジューリングのみ任意である（§10）。

---

## 3. 用語と単一正本モデル

- **正本（単一 SQLite・transactional）:** `raw_events`・`records`・正本 outbound リンク（`record_links`）・`operations`（冪等）・`audit` / `usage`・`note_heat`。書込みの成否はこの DB のコミットで決まる。
- **raw 現物（正本テーブル）:** セッション往復・イベントの全文追記記録。要約しない・書き換えない・選ばない。下層が真実の控えである。
- **records（正本テーブル）:** 記憶レコード。安定 ID・`kind/scope/status/observedAt/session/tags`・provenance・本文を持つ。Markdown はこの行の投影形である。
- **Markdown Vault（投影・非正本）:** Obsidian 互換の読み物表示。`records`＋正本リンクから生成し、消失・陳腐化時は正本から再構築する。人間が直接編集しても正本へ無言で取り込まない。編集は `record.correct` を経由し、監査・冪等を迂回させない。
- **kind:** `user_fact` | `model_inference` | `summary` | `correction`。事実と推論を混在させない。推論は推論として mark する。
- **provenance/scope:** `source`（不透明ポインタ）＋ `observedAt`（UTC 正準）。`scope` は隔離単位であり、get/list/recall は同一 scope のみを対象とする。
- **派生索引（非正本・rebuildable）:** `record_backlinks` ビュー・SQLite FTS5/BM25・char-bigram 転置索引・ベクトル埋め込み。消失時は正本から再構築する。索引の有無・再構築で正本内容は変わらない。
- **リンクと連想は untrusted メタデータ:** `[[リンク]]`・タグ・類似度は想起の手掛かりであり、事実主張ではない。記憶本文として信用せず、指示として実行しない。

---

## 4. MVP プロトコル

共通封筒（JSON 1 行、UTF-8、LF 終端）。書込系の `idempotencyKey` は**呼出者指定の必須**（1..128 文字の ASCII 安全文字）。欠落は `BAD_REQUEST`。同一キー＋同一 params の再送は保存済み応答を `deduplicated:true` で返し、params 改変は `CONFLICT` とする。`operations` はコミット成功した書込系 `OK` 応答のみ保存する。

| op | 意味 | params（要点） |
| --- | --- | --- |
| `record.remember` | 自律書き込み。raw＋record＋正本リンク＋冪等＋監査を単一 SQLite txn で active 永続化。投影はコミット後 | `body/kind/provenance/scope/tags[]/links[]/sessionRef/runId` |
| `record.get` | 1 件取得。同一 scope の id を status によらず返す | `id/scope` |
| `record.list` | 有界一覧。既定 active のみ。順序 `createdAt DESC, id ASC`、`since` inclusive / `until` exclusive | `scope/limit/since/until/status?` |
| `record.recall` | 有界ハイブリッド想起（§6）。利用を監査記録 | `query/tags[]/link/since/until/limit/scope/runId` |
| `record.correct` | 訂正。新 record 追記＋旧 `active → superseded` を同一 txn で行う。訂正時にリンク再付与可 | `recordId/body/kind=correction/provenance/scope/links[]?` |
| `record.archive` | 検索・想起対象からの除外。`active → archived`（終端・復帰なし）。物理削除ではない | `id/scope/reasonCode`（固定コードのみ） |
| `maintain.distill` | 有界保守。summary/correction レコードを通常の冪等 op で直接・自律的に書く（§7）。取消可能・同時実行 1 | `scope/cursor/limit/runId` |

- `remember` の txn 範囲は raw・record・正本リンク・idempotency・audit のみである。Markdown 投影・索引更新はコミット後に行い、失敗時はリトライキューへ回す。投影の遅延・失敗はコミット済み記憶の利用可能性を損なわない（正本から直接読める）。
- 訂正の競合は旧行の条件付き UPDATE（`WHERE id=? AND status='active' AND scope=?`）の更新行数で勝者 1 件に絞り、敗者は `CONFLICT` で全巻き戻しとする。
- `correct` / `archive` は対象行なしを `NOT_FOUND`、scope 不一致を `FORBIDDEN_SCOPE`、非 active 対象を `CONFLICT` とする。
- エラーコード（固定）: `OK / BAD_REQUEST / NOT_FOUND / CONFLICT / FORBIDDEN_SCOPE / STORE_UNAVAILABLE / LIMIT_EXCEEDED / TIMEOUT`。`message` は固定テンプレのみとし、記憶本文・クエリ原文を含めない。

---

## 5. スキーマ・状態遷移・ライフサイクル

概念スキーマ（格納形式・DDL は実装時に確定）。正本表と派生物を厳別する:

- 正本（SQLite）: `raw_events(seq PK, sessionId, body, observedAt, scope, createdAt)` 追記のみ。更新・削除なし。
- 正本（SQLite）: `records(id PK, body, bodyHash, kind, source, observedAt, scope, status, supersedes NULL, revision, sessionRef, createdAt)`。
- 正本（SQLite）: `record_tags(recordId, tag)` / `record_links(fromId, toName)` 正本 outbound（exact 保持。真性の未解決対象のみ dangling 可）。
- 正本（SQLite）: `note_heat(recordId, usedCount, lastUsedAt)` 利用（引用・採用）のみ加算。露出では加算しない。
- 正本（SQLite）: `scopes(scope PK)`（起動時 config から初期投入）/ `operations(idempotencyKey PK, ...)` / `audit(...)`（本文なし）/ `usage(...)`（本文なし）。
- 派生（再構築可）: `vault_md_projection`（Markdown 生成物）/ `record_backlinks` ビュー / `fts_notes(...)` / `vec_notes(...)`。欠落・再構築は正本に影響しない。

状態遷移: `correct` は `active → superseded`、`archive` は `active → archived` のみ。終端からの復帰なし（MVP）。

```text
AI 自律判断（ターン二周目相当）
  │ record.remember（単一 SQLite txn＋呼出者 idempotencyKey）
  │ コミット後に Markdown・索引へ投影（失敗はリトライキュー）
  ▼
[active] ── record.recall（語彙＋ベクトル＋グラフ・§6・利用記録付き）──→ 利用・引用
  │ record.correct（新 revision 追記＋旧版 supersede・同一 txn）
  │ record.archive（除外フラグ）   │ maintain.distill（有界・同時実行1・取消可・直接書込み）
  ▼                                                              ▼
[superseded]（想起対象外・連鎖で辿行可・行は保持）  [archived]（想起対象外・行は保持）
raw 現物は常に正本に保持。要約レコードから sessionRef で raw へ降りられる。
```

---

## 6. 想起（有界ハイブリッド）

旧リテラル一致計画を置き換える。手順は固定・予算は厳格・順序は決定論的である。決定論とは**同一の正本・索引・heat 状態**に対する同一クエリが同一順序を返すことであり、書込み・保守・再構築の後は順序が変わり得る:

1. **正規化:** NFKC → trim → 連続空白を半角スペース 1 個に畳み込み → ASCII 英字のみ casefold。`body/query/tag` に同一適用（`link` 名は casefold なし）。
2. **語彙候補:** FTS5/BM25 全文一致＋ char-bigram 転置索引で上位 N 件（日本語の分かち書き不要な経路）。安定順序はスコア DESC・`createdAt DESC`・`id ASC`。
3. **ベクトル候補:** 埋め込み類似の上位 M 件（モデルは後で選定・pin するまで必須化しない）。安定順序は類似度 DESC・`createdAt DESC`・`id ASC`。
4. **タグ/リンク種:** `tags[]` exact・`link` exact の種レコードを加える（`createdAt DESC, id ASC`）。
5. **有界グラフ展開:** 種＋上位候補から正本 outbound・派生 backlink を深さ上限つきで展開する（dangling は無視して継続）。同距離は `createdAt DESC, id ASC`。
6. **raw への下降（M1 必須）:** 要約レコードの `sessionRef` から raw 現物を上限つきで取得する。
7. **重複排除・融合:** id で dedupe し、語彙順位・ベクトル順位・グラフ距離・`usedCount` を固定重みで融合する。同点は `createdAt DESC, id ASC` で打破する。
8. **有界投影:** 本文先頭から最大 `snippetMaxCp` の前方切り出し＋ `truncated(bool)`。応答は `recallId + items[{id, snippet, truncated, tags, createdAt}]`。
9. **予算:** アイテム数・トークン・バイト・グラフ深さ・raw 下降件数に上限を設け、超過は `LIMIT_EXCEEDED` で切詰めなし。

---

## 7. リンク・利用記録・保守

- **outbound 作成:** AI が `remember` / `correct` / 保守時に、有界の既存ノート想起・タグ文脈で正当化できる関連先へ複数の `[[リンク]]` を付与する。正本リンク表へ書く。想起時の自動付与はしない。
- **リンク 0 件の扱い:** 関連先がない場合は 0 件を許容し、レコードを遅延なく書き込む。0 件レコードは有界保守の付帯キューに入れ、後の蒸留・統合時に解決を試みる。
- **禁止:** 数のための恣意的リンク・無関係ノートへのFiller・存在しない名への見せかけ解決は禁止する。真性に未解決の対象（これから作る概念・未記録の事実）のみ dangling として保持できる。
- **backlink 導出:** backlink は正本 outbound からの派生表示であり、独立に書き込まない。再計算で復元できる。
- **dangling 扱い:** 真性の未解決 `[[名]]` はエラーにせず保持する。対象レコード作成時・保守時に解決する。グラフ展開は dangling を飛ばす。
- **利用記録（used/cited-only）:** `usage` は想起の露出ではなく、応答への引用・採用（`cited:true`）でのみ `note_heat.usedCount` を加算する。見られただけでは熱を上げない。
- **保守（蒸留・統合）:** `maintain.distill` は候補化・承認を経ず、summary/correction レコードを通常の冪等 op で直接・自律的に書く。有界バッチ・同時実行 1・失敗隔離・リトライキュー・取消可能で行う。失敗は当該バッチのみ巻き戻し、成功済みを汚さない。書込み失敗は「成功と同じ顔」にしない。
- **常駐不要:** 基本の write/recall はバックグラウンドループなしで完結する。保守は明示起動または任意スケジュールとし、停止しても write/recall は動く。

---

## 8. 制限・タイムアウト・縮退

以下の数値は**暫定既定値（config 化）**であり、製品の本質的決定ではない。変更は起動時 config のみで行い、要求 JSON による上書き・実行中の書換えは受け付けない。

- `body 2000cp / query 500cp / tags 5 / links 8 / limit 既定10・最大25 / snippet 200cp / 応答合計 8KB / 生要求 32KB`
- `グラフ深さ 2 / グラフ展開上限 40 / raw 下降上限 3 / 融合候補上限 60`
- `CLI タイムアウト 5s / SQLite busy_timeout 2s / DB 上限 100MB`
- 超過入力・超過応答は切詰めず `LIMIT_EXCEEDED` で拒否する。応答合計超過も同様とし、適応的切詰めは行わない。
- 容量上限の枯渇時は書込みを `LIMIT_EXCEEDED` で拒否し、無言の削除・上書き・切詰めを行わない。運用者は上限引上げまたは保持ポリシー（§12 U2）の解決で回復する。回復まで想起・取得は継続する。
- DB 利用不可・破損・タイムアウト時は `STORE_UNAVAILABLE` / `TIMEOUT` を返し、呼出側は**記憶なしの通常応答に縮退**する。記憶欠落を生成失敗の理由にしない。
- ベクトル索引の欠落・無効時は**語彙＋グラフに縮退**して想起を継続する（エラーにしない）。ベクトル必須化・特定モデル強制をしない。
- commit 対 timeout の未知結果は同一 `idempotencyKey`＋同一 params の再送で解決する（`deduplicated` で確定させる）。

---

## 9. 受入基準

- **R1 自律即時性:** `record.remember` 直後に `record.recall` で当該内容が出現する。承認待ち・TTY 操作を介さない。
- **R2 承認残滓なし:** 候補テーブル・承認トークン・期限付き承認・TTY 必須操作が存在しない。`maintain.distill` を含め全書込みが直接確定する。
- **R3 結ぶ（強制なき関連）:** 関連がある場合は複数の正本 outbound `[[リンク]]` を持ち、backlink として逆引きできる。0 件は許容され保守キューに入る。恣意的・無関係なFiller リンクは存在しない。
- **R4 呼び戻す（M1）:** 要約レコードから `sessionRef` で raw 現物へ降りられる（ベクトルなしで可）。
- **R5 訂正:** 訂正後に旧 record は `superseded` となり想起に出ない。新旧は `supersedes` 連鎖で辿れる。並行訂正は勝者 1 件のみ、敗者は `CONFLICT`。
- **R6 アーカイブ:** `archive` 後に想起・一覧に出ない。行は保持され、物理削除ではない。
- **R7 冪等性:** 同一キー＋同一 params 再送は `deduplicated:true` で同一結果、params 改変は `CONFLICT`、キー欠落の書込は `BAD_REQUEST`。
- **R8 分離と監査:** 他 scope の record は `recall/get/list` に出ない。`audit/usage`・エラー応答に本文原文を含まない。直接ファイル編集の無言取込み経路が存在しない。
- **R9 育てる:** `note_heat` は引用・採用時のみ加算され、単なる露出では加算されない。保守バッチは有界・取消可能・同時実行 1 であり、直接書込みである。
- **R10 有界・決定論:** 同一正本・索引・heat 状態での同一 `recall` は同一順序（源泉ごとの安定順序・同点打破は §6）。超過は `LIMIT_EXCEEDED` で切詰めなし。グラフ深さ・候補上限を超過しない。
- **R11 縮退:** DB 不可時は `STORE_UNAVAILABLE` を返し、呼出側は記憶なしで継続する。無監査の想起成功を作らない。投影・索引の失敗はコミット済み記憶を利用不可にしない。
- **R12 単一正本:** 正本読取りは SQLite のみで完結する。Markdown・索引を消去・陳腐化させても正本から再構築でき、記憶内容は失われない。

---

## 10. ロードマップ

| 段階 | 内容 | 受入目安 |
| --- | --- | --- |
| M1 連想ストア | `remember/get/list/recall/correct/archive`＋単一正本＋正本 outbound・派生 backlink＋語彙＋グラフ想起＋raw 下降＋利用記録＋有界・縮退 | §9 R1–R12 のうち R4（raw 下降）まで含む語彙＋グラフ範囲。ベクトル縮退の受入は M2 に分離 |
| M2 ベクトル任意＋評価 | 埋め込みモデル選定・pin 後にベクトル候補を追加。欠落時の語彙＋グラフ縮退の受入をここで満たす。fake 会話＋seeded 記憶による引用突合の小規模評価（実ユーザデータ不使用） | 想起適合・縮退率・レイテンシ増加分の記録 |
| M3 育てる保守（完成に必須） | `maintain.distill` の蒸留・統合（有界・同時実行 1・リトライキュー・取消可・直接書込み）。計画完成には最小の育成実証を必須とし、高度なスケジューリングは任意に留める | R2・R9・保守の有界性・失敗隔離の実証 |

---

## 11. 非目標

- 候補テーブル・承認フロー・承認トークン・TTY 対話・同意 UI。
- 意味的事実検証・ベクトルの必須化・特定埋め込みモデルの hard 要求・常時注入・常駐ループの必須化。
- 自律エージェント・sentience・制御不能なバックグラウンドループ・無制限の自動保守。
- リモートサービス化・ネットワーク公開・外部への記憶送信・外部テレメトリ・外部サービス既定利用。
- 物理削除・消去保証・エクスポート API の新設（§12 U2 に延期）。
- 承認された連携契約なしの Companion 側への記憶書き込み・承認バイパス。
- Markdown・索引を含む複数ストア間の原子性の主張。直接ファイル編集の正本への無言取込み。
- FIO の実績主張（発火 0 件の経路の既成事実化・数値の引き写し）。

---

## 12. 未解決事項

- **U1 Companion 連携契約:** 連携の可否・時期・手段（MCP・ローカル API 等の代替案を含む）。連携までは Companion 側への記憶書き込みを行わない。
- **U2 保持・エクスポート・削除方針:** 保持期間・削除可否・エクスポート要否。`archive` は除外であり削除ではない。消去保証は主張しない。容量枯渇時の回復は上限引上げか本方針の解決による。
- **U3 ベクトル索引:** モデル選定・pin・ライセンス・チャンク方針（用いる場合のみ。M2 で判断。既定で必須にしない）。
- **U4 高度なスケジューリング:** 蒸留・統合の起動条件・バッチ幅・熱の重みの自動調整。MVP・完成の必須としない（M3 の最小実証の外側の任意事項）。
- **U5 評価:** データセット・指標・閾値。
- **U6 有界定数の最終値:** §8 の既定値は暫定であり、実測で見直す。数値は比・上限で縛り、焼き込まない。

---

## 13. 出典メモ（FIO_Architecture_JA.pdf・パターン採用）

- 本計画は FIO の構造パターン（現物保持・要約からの下降・二段想起・書戻し入口・リトライ）のみを採用し、格納正本の置き方は**適応**した。FIO は Markdown を正本に置くが、本計画は監査・冪等・原子性のため**単一 SQLite を正本**とし、Markdown Vault・backlink・FTS・ベクトルを再構築可能な投影・派生索引に変えた。Markdown 正本の主張は本計画に引き継がない。
- p1 製品分離・二段記憶の要旨: ベクトル DB・索引を「消えても作り直せる派生物」とし、要約の下に「選ぶ前の現物」を置き、要約から現物へ降りる。本計画の D6・§3・§6 の着想の根拠（正本の置き方は上記の適応を参照）。
- p2 蓄積実寸・実行環境: `memory.db` 会話履歴 79.5MB、`episodic/meta.db` 119.5MB・16,955 行、sessions 索引.db 22.1MB（FTS5・蔵 98 枚・往復 7,889）、vault Markdown 5,468 ノート。永続は SQLite（FTS5 必須）＋ベクトル蔵＋Markdown Vault。埋め込み BAAI/bge-m3・1024 次元・8,192 トークン・塊 2,000 字は参考値であり、本計画の hard 要求にしない（U3）。
- p5 十の層 B・記憶（三層＋二段）: 一段目（統合記憶 `vault/00_Persona`・エピソード `02_Memories`＋ベクトル・意識層・日記 `vault/03_Diary`）と二段目（控え `data/sessions/*.jsonl`・ノート `vault/sessions/*.md`・ハブ append-only・索引 FTS5/BM25）。降り口は frontmatter `session: [[…]]`。モジュール `memory_events.py`（追記のみ）、`obsidian_adapter.py`（Vault I/O）、`セッションの索引.py`（BM25/文字 2-gram/FTS5）、`セッションの蒸留.py` が対応。
- p6 ターン・§6 データフロー: 二パス制（一周目で応答、二周目で「何を憶えるか」を決める）、書戻しの唯一入口 `memory_writeback.py`、失敗の `retry_queue.py`、想起（起点→タグ・リンク/二段目生データ）。本計画の即時書込み・リトライ・§6 手順の根拠。
- p10 設計原則 5.6 現物を残す: 要約・索引・ベクトルは派生物とし、正本は追記のみの現物（JSONL/Markdown）とする。本計画はこの原則を単一 SQLite 正本に適応した（D6 の直接の根拠）。
- **p11 重要な未検証申告:** 「二段記憶の自動保存／起動時インストール／ターン想起は本番未検証（配線と柵は通っているが実ターンでの発火実績が 0 件）」。「配線した」は「動いた」ではない。本計画は FIO 機構を実績として主張せず、構造パターンのみを採用する。
