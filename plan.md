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

- **D1 自律二パス書き込み:** AI は記憶対象を自律判断し、`event.append` で raw 現物を追記してから `record.remember` で active 記憶として直接永続化する。両 op とも自律 JSON 書込（候補・承認なし、呼出者 `idempotencyKey` 必須）。ストアが検証するのは構造・セキュリティ・有界性＋§4 の source 参照検証のみである。
- **D2 人間は任意の管理者:** 人間の行動は通常運用に**不要**である。AI と任意の人間管理者は同一の有界ローカル I/F（CLI/API、TTY 要求なし）経由で検査・`correct` / `archive` を行える。人間編集は常に任意であり、直接ファイル編集ではなく `record.correct` を経由する（§3）。
- **D3 別リポジトリ・ローカル・非公開（旧決定を継承）:** Companion Harness とは別リポジトリで開発する。既定でローカル運用・ネットワーク公開なし・外部送信なし。Companion と DB を共有せず、kernel / package を直接 import しない。
- **D4 追記型・非削除:** 訂正は改訂追記＋旧版 supersede、アーカイブは検索除外フラグとする。物理削除・消去保証は主張しない（§12 U2）。
- **D5 連想記憶の製品決定（P1）:** 記憶は**書く・結ぶ・呼び戻す・育てる**。保存だけの vault を認めない。正当化できる関連記憶がある場合に関連する `[[リンク]]` で結び、想起は語彙＋ベクトル＋グラフで呼び戻し、保守で蒸留・統合して育てる。関連先がない場合のリンク強制・埋め草はしない（§2・§7）。
- **D6 単一正本 SQLite・派生投影:** 正本は**単一の SQLite** のみである（raw_events・records・record_source_refs・正本 outbound リンク・operations・audit/usage・heat）。Markdown Vault は Obsidian 互換の**再構築可能な投影**であり正本ではない。backlink・FTS・ベクトル索引も再構築可能な派生物である（§3・§5）。
- **D7 有界自律:** 基本書き込みに常駐バックグラウンドループを**要求しない**。保守（蒸留・統合）は有界・取消可能・同時実行 1 とし、無制限の自律ループを作らない。保守は候補・承認を経ず通常の冪等 op で直接書く（§7）。
- **D8 単一ストア原子性のみ:** 原子性を主張するのは単一 SQLite トランザクションの範囲のみである。**各 op 1 トランザクション**（`event.append` と `remember` は別 txn）。Markdown・索引への投影はコミット後の best-effort であり、複数ストア間の原子性は主張しない（§4）。

---

## 2. 製品ゴール

- AI が会話・作業から「後で役立つ」内容を自律的に二パス（`event.append`→`record.remember`）で書き、後の `record.recall` で有界・決定論的に再利用する。人間不在でも蓄積・利用が止まらない。
- **書く:** セッション終了・区切りを待たず、ターン二周目相当の timing で raw 追記→記憶化を即時実行する（失敗はリトライキューへ）。記憶本文に raw 全文を複写しない。
- **結ぶ:** 有界の既存ノート想起・タグ文脈で正当化できる場合に複数の関連 `[[outbound リンク]]` を付与する。関連先がない場合はリンク 0 件を許容し、有界保守で後付けする。恣意的な埋め草リンク・dangling 稼ぎは禁止する（§7）。
- **呼び戻す:** 要約から `record_source_refs` 経由で raw ヒットへ降りられる。要約の質に想起の上限を縛られない。
- **育てる:** 利用された記憶だけが熱を持ち、保守で蒸留・統合される。見られただけでは育てない。最小の育成マイルストーンは計画完成に必須であり、高度なスケジューリングのみ任意である（§10）。

---

## 3. 用語と単一正本モデル

- **正本（単一 SQLite・transactional）:** `raw_events`・`records`・`record_source_refs`・正本 outbound リンク（`record_links`）・`operations`（冪等）・`audit` / `usage`・`note_heat`。書込みの成否はこの DB のコミットで決まる。
- **raw 現物（正本テーブル）:** セッション往復・イベントの不変追記記録（`eventId` 安定 ID・`sessionId/turnId/body/provenance/scope/runId`）。要約しない・書き換えない・選ばない。更新・削除なし。
- **records（正本テーブル）:** 記憶レコード。安定 ID・`kind`（`user_fact` | `model_inference` | `summary` | `correction`、事実と推論を混在させない）・`scope/status/observedAt/session/tags`・provenance・蒸留本文を持つ。raw 全文の複写を持たず、`sourceRefs[]` で同一 scope の既存 raw を参照する（§4・§5）。Markdown はこの行の投影形である。
- **Markdown Vault（投影・非正本）:** Obsidian 互換の読み物表示。`records`＋正本リンクから生成し、消失・陳腐化時は正本から再構築する。直接編集の無言取込みなし。編集は `record.correct` を経由し、監査・冪等を迂回させない。
- **provenance/scope:** `source`（不透明ポインタ）＋ `observedAt`（UTC 正準）。`scope` は隔離単位であり、get/list/recall は同一 scope のみを対象とする。raw と record の相互参照は同一 scope のみ有効である。
- **派生索引（非正本・rebuildable）:** `record_backlinks` ビュー・SQLite FTS5/BM25・char-bigram 転置索引・ベクトル埋め込み。消失時は正本から再構築する。索引の有無・再構築で正本内容は変わらない。
- **リンクと連想は untrusted メタデータ:** `[[リンク]]`・タグ・類似度は想起の手掛かりであり、事実主張ではない。記憶本文として信用せず、指示として実行しない。

---

## 4. MVP プロトコル

共通封筒（JSON 1 行、UTF-8、LF 終端）。書込系（`event.append`・`remember`・`feedback`・`correct`・`archive`・`distill`）の `idempotencyKey` は**呼出者指定の必須**（1..128 文字の ASCII 安全文字）。欠落は `BAD_REQUEST`。同一キー＋同一 params の再送は保存済み応答を `deduplicated:true` で返し、params 改変は `CONFLICT` とする。`operations` はコミット成功した書込系 `OK` 応答のみ保存する。

| op | 意味 | params（要点） |
| --- | --- | --- |
| `event.append` | raw 現物の自律追記。不変の session/turn/event 全文を raw＋冪等＋監査の単一 txn で追記 | `eventId/sessionId/turnId/body/provenance/scope/runId` |
| `record.remember` | 自律記憶化。record＋タグ＋正本リンク＋sourceRefs＋冪等＋監査の単一 txn で active 永続化。raw は書かない | `body/kind/provenance/scope/tags[]/links[]/sourceRefs[]/runId` |
| `record.get` | 1 件取得。同一 scope の id を status によらず返す | `id/scope` |
| `record.list` | 有界一覧。既定 active のみ。順序 `createdAt DESC, id ASC`、`since` inclusive / `until` exclusive | `scope/limit/since/until/status?` |
| `record.recall` | 有界ハイブリッド想起（§6）。利用を監査記録 | `query/tags[]/link/since/until/limit/scope/runId` |
| `record.feedback` | 引用・採用の明示報告。露出検証＋usage追記＋heat加算を単一txnで実行。mere recallでは加算しない | `recallId/recordIds[]/scope/runId`（＋呼出者 `idempotencyKey` 必須） |
| `record.correct` | 訂正。新 record 追記＋旧 `active → superseded` を同一 txn で行う。リンク・sourceRefs 再付与可 | `recordId/body/kind=correction/provenance/scope/links[]?/sourceRefs[]?` |
| `record.archive` | 検索・想起対象からの除外。`active → archived`（終端・復帰なし）。物理削除ではない | `id/scope/reasonCode`（固定コードのみ） |
| `maintain.distill` | 有界保守。summary/correction レコードを通常の冪等 op で直接・自律的に書く（§7）。取消可能・同時実行 1 | `scope/cursor/limit/runId` |

- txn 範囲は op ごとに単一である。`event.append` は raw_events・operations・audit のみ、`remember` は records・record_tags・record_links・record_source_refs・operations・audit のみを書く。`remember` が raw を原子的に同時書きすることは**主張しない**（二パス分離）。Markdown 投影・索引更新はコミット後に行い、失敗時はリトライキューへ回す。
- `remember` の source 検証: 各 `sourceRefs[]` は同一 scope の既存 `raw_events.eventId` でなければならない。欠落は `NOT_FOUND`、他 scope は `FORBIDDEN_SCOPE` とし record を一切書かない。空 `sourceRefs` は `kind=model_inference/summary` かつ provenance に明示的派生表示がある場合のみ許容し、それ以外は `BAD_REQUEST` とする。
- `record.feedback` の露出検証: `recallId` に対応する露出集合（返却 IDs・同一 `scope`）を有界保持し、集合外・他 scope の ID を含む報告は全体拒否（`FORBIDDEN_SCOPE`/`NOT_FOUND`）し `usage`・heat を一切変えない。`record.recall` 自体は露出のみで heat を加算しない。
- 訂正の競合は旧行の条件付き UPDATE（`WHERE id=? AND status='active' AND scope=?`）の更新行数で勝者 1 件に絞り、敗者は `CONFLICT` で全巻き戻しとする。エラーコード（固定）: `OK / BAD_REQUEST / NOT_FOUND / CONFLICT / FORBIDDEN_SCOPE / STORE_UNAVAILABLE / LIMIT_EXCEEDED / TIMEOUT`。`message` は固定テンプレのみとし、記憶本文・クエリ原文を含めない。

---

## 5. スキーマ・状態遷移・ライフサイクル

概念スキーマ（格納形式・DDL は実装時に確定）。正本表と派生物を厳別する:

- 正本（SQLite）: `raw_events(eventId PK, sessionId, turnId, body, source, observedAt, scope, runId, createdAt)` 追記のみ（更新・削除なし）。`records(id PK, body, bodyHash, kind, source, observedAt, scope, status, supersedes NULL, revision, createdAt)` 本文は蒸留文のみで raw 複写なし。
- 正本（SQLite）: `record_source_refs(recordId, eventId)` 同一 scope の record↔raw 対応。scope 不一致・欠落 ref は書込拒否（§4）。
- 正本（SQLite）: `record_tags(recordId, tag)` / `record_links(fromId, toRef)` 正本 outbound（`links[]` は不透明な安定 record ref。グラフ走査は active・同一 scope に解決する ref のみ辿り、Markdown は `[[ref]]` と描画）。`note_heat(recordId, usedCount, lastUsedAt)` は引用・採用のみ加算。
- 正本（SQLite）: `scopes(scope PK)`（起動時 config から初期投入）/ `operations(idempotencyKey PK, ...)` / `audit(...)`（本文なし）/ `usage(...)`（本文なし）。
- 派生（再構築可）: `vault_md_projection` / `record_backlinks` ビュー / `fts_notes(...)`（records＋raw_events の語彙索引）/ `vec_notes(...)`。欠落・再構築は正本に影響しない。

状態遷移: `correct` は `active → superseded`、`archive` は `active → archived` のみ。終端からの復帰なし（MVP）。

```text
AI 自律判断（ターン二周目相当）
  │ event.append（raw 追記・単一 txn＋呼出者 idempotencyKey・承認なし）
  │ record.remember（sourceRefs 検証＋record 記憶化・単一 txn＋呼出者 idempotencyKey・承認なし）
  │ コミット後に Markdown・索引へ投影（失敗はリトライキュー）
  ▼
[active] ── record.recall（語彙＋ベクトル＋グラフ・§6・利用記録付き）──→ 利用・引用
  │ record.correct（新 revision 追記＋旧版 supersede・同一 txn）
  │ record.archive（除外フラグ）   │ maintain.distill（有界・同時実行1・取消可・直接書込み）
  ▼                                                              ▼
[superseded]（想起対象外・連鎖で辿行可・行は保持）  [archived]（想起対象外・行は保持）
raw 現物は event.append で不変保持。record 本文に raw 複写なし。要約→raw は record_source_refs で降りる。
```

---

## 6. 想起（有界ハイブリッド）

旧リテラル一致計画を置き換える。手順は固定・予算は厳格・順序は決定論的である。決定論とは**同一の正本・索引・heat 状態**に対する同一クエリが同一順序を返すことであり、書込み・保守・再構築の後は順序が変わり得る:

1. **正規化:** NFKC → trim → 連続空白を半角スペース 1 個に畳み込み → ASCII 英字のみ casefold。`body/query/tag` に同一適用（`link` 名は casefold なし）。
2. **語彙候補:** FTS5/BM25 全文一致＋ char-bigram 転置索引で上位 N 件（日本語の分かち書き不要な経路）。安定順序はスコア DESC・`createdAt DESC`・`id ASC`。
3. **ベクトル候補:** 埋め込み類似の上位 M 件（モデル・設定は M2 で選定・pin する。欠落時は §8 の語彙＋グラフ縮退に従う）。安定順序は類似度 DESC・`createdAt DESC`・`id ASC`。
4. **タグ/リンク種＋有界グラフ展開:** `tags[]` exact・`link` exact の種レコードを加え（`createdAt DESC, id ASC`）、種＋上位候補から正本 outbound・派生 backlink を深さ上限つきで展開する（dangling は無視して継続）。同距離は `createdAt DESC, id ASC`。
5. **raw への下降（M1 必須・操作的定義）:** `raw_events` は語彙索引対象とし、raw ヒットは `record_source_refs` 経由で active・同一 scope レコードへ写像して順位に加算する。未参照・非 active・他 scope の写像先は除外する。応答はレコード snippet のみとし raw 本文は返さない。
6. **重複排除・融合:** id で dedupe し、語彙順位・ベクトル順位・グラフ距離・`usedCount` を固定重みで融合する。同点は `createdAt DESC, id ASC` で打破する。
7. **有界投影・予算:** 本文先頭から最大 `snippetMaxCp` の前方切り出し＋ `truncated(bool)`。応答は `recallId + items[{id, snippet, truncated, tags, createdAt}]`。アイテム数・トークン・バイト・グラフ深さ・raw 下降件数に上限を設け、超過は `LIMIT_EXCEEDED` で切詰めなし。

---

## 7. リンク・利用記録・保守

- **outbound 作成:** AI が `remember` / `correct` / 保守時に、有界の既存ノート想起・タグ文脈で正当化できる関連先へ複数の `[[リンク]]` を付与する。正本リンク表へ書く。想起時の自動付与はしない。関連先がない場合は 0 件を許容し遅延なく書き込み、有界保守の付帯キューで後付けを試みる。
- **禁止:** 数のための恣意的リンク・無関係ノートへのFiller・存在しない名への見せかけ解決は禁止する。真性に未解決の対象のみ dangling として保持し、対象作成時・保守時に解決する。グラフ展開は dangling を飛ばす。
- **backlink 導出:** backlink は正本 outbound からの派生表示であり、独立に書き込まない。再計算で復元できる。
- **利用記録（used/cited-only）:** `usage` は応答への引用・採用（`cited:true`）でのみ `note_heat.usedCount` を加算する。見られただけでは熱を上げない。
- **保守（蒸留・統合）:** `maintain.distill` は候補化・承認を経ず、summary/correction レコードを通常の冪等 op で直接・自律的に書く。有界バッチ・同時実行 1・失敗隔離・リトライキュー・取消可能で行う。失敗は当該バッチのみ巻き戻し、成功済みを汚さない。

---

## 8. 制限・タイムアウト・縮退

以下の数値は**暫定既定値（config 化）**であり、製品の本質的決定ではない。変更は起動時 config のみで行い、要求 JSON による上書き・実行中の書換えは受け付けない。`vaultPath`（ローカル Markdown 投影先）は必須の起動時 config とし、欠落時は起動失敗とする。

- `eventId/sessionId/turnId 1..128 文字・event body 2000cp / record body 2000cp / query 500cp / tags 5 / links 8 / sourceRefs 上限 8 / limit 既定10・最大25 / snippet 200cp / 応答合計 8KB / 生要求 32KB`
- `グラフ深さ 2 / グラフ展開上限 40 / raw 下降上限 3 / 融合候補上限 60`
- `CLI タイムアウト 5s / SQLite busy_timeout 2s / DB 上限 100MB`
- 超過入力・超過応答は切詰めず `LIMIT_EXCEEDED` で拒否する。容量枯渇時（DB 上限超過見込みの書込み）は `STORE_UNAVAILABLE` で巻き戻し、無言の削除・上書き・切詰めを行わず、想起・取得は継続する。回復は上限引上げまたは保持ポリシー（§12 U2）の解決による。
- DB 利用不可・破損・タイムアウト時は `STORE_UNAVAILABLE` / `TIMEOUT` を返し、呼出側は**記憶なしの通常応答に縮退**する。記憶欠落を生成失敗の理由にしない。
- ベクトル索引の欠落・無効時は**語彙＋グラフに縮退**して想起を継続する（エラーにしない）。意味検索能力自体は M2 で必須化（§10・§12 U3）。commit 対 timeout の未知結果は同一 `idempotencyKey`＋同一 params の再送で解決する（`deduplicated` で確定させる）。

---

## 9. 受入基準

- **R1 自律即時性:** `event.append` 後に有効 `sourceRefs` 付き `record.remember` が確定し、直後の `record.recall` で当該内容が出現する。承認待ち・TTY 操作を介さない。
- **R2 承認残滓なし:** 候補テーブル・承認トークン・期限付き承認・TTY 必須操作が存在しない。`event.append`・`remember`・`maintain.distill` を含め全書込みが直接確定する。
- **R3 結ぶ（強制なき関連）:** 関連がある場合は複数の正本 outbound `[[リンク]]` を持ち、backlink として逆引きできる。0 件は許容され保守キューに入る。恣意的・無関係なFiller リンクは存在しない。
- **R4 呼び戻す（M1）:** raw 語彙ヒットは `record_source_refs` 経由で active・同一 scope レコードへ写像される（ベクトルなしで可）。応答はレコード snippet のみで raw 本文を返さず、record 本文に raw 複写を持たない。
- **R5 訂正・R6 アーカイブ:** 訂正後に旧 record は `superseded` となり想起に出ない。新旧は `supersedes` 連鎖で辿れる。並行訂正は勝者 1 件のみ、敗者は `CONFLICT`。`archive` 後に想起・一覧に出ない。行は保持され、物理削除ではない。
- **R7 冪等性:** 同一キー＋同一 params 再送は `deduplicated:true` で同一結果、params 改変は `CONFLICT`、キー欠落の書込は `BAD_REQUEST`（`event.append`・`remember` を含む全書込系）。
- **R8 分離・source 検証・監査:** 他 scope の record は `recall/get/list` に出ない。欠落 sourceRef は `NOT_FOUND`、他 scope 参照は `FORBIDDEN_SCOPE` で record を一切書かない。空 `sourceRefs` は model_inference/summary の明示的派生表示のみ許容。`audit/usage`・エラー応答に本文原文を含まない。
- **R9 育てる（feedback 検証）:** `note_heat` は `record.feedback` の検証通過分のみ加算し、mere recall では加算しない。露出集合外・他 scope ID を含む feedback は全体拒否し heat・usage 不変。保守バッチは有界・取消可能・同時実行 1 で直接書込み。
- **R10 有界・決定論:** 同一正本・索引・heat 状態での同一 `recall` は同一順序（源泉ごとの安定順序・同点打破は §6）。超過は `LIMIT_EXCEEDED` で切詰めなし。グラフ深さ・候補上限を超過しない。
- **R11 縮退:** DB 不可時は `STORE_UNAVAILABLE` を返し、呼出側は記憶なしで継続する。無監査の想起成功を作らない。投影・索引の失敗はコミット済み記憶を利用不可にしない。
- **R12 単一正本・再構築:** 正本読取りは SQLite のみで完結する。必須 `vaultPath` への Markdown 投影を消去・陳腐化させても正本から再構築でき、内容・`[[ref]]`・backlink が復元される。再構築前後で正本内容は不変。

---

## 10. ロードマップ

| 段階 | 内容 | 受入目安 |
| --- | --- | --- |
| M1 連想ストア | `event.append`＋sourceRefs 付き `remember/get/list/recall/correct/archive`＋単一正本＋record_source_refs＋正本 outbound・派生 backlink＋語彙＋グラフ想起＋refs 経由 raw 下降＋利用記録＋有界・縮退 | §9 R1–R8・R10–R12 のうち語彙＋グラフで満たせる範囲（M2 のベクトル固有の縮退受入を除く。R9 は M3） |
| M2 セマンティック検索必須＋評価（計画完成に必須） | 意味／ベクトル検索能力とその評価を計画完成の必須とする。モデル・設定の選定・pin は柔軟に行い、欠落時は語彙＋グラフ縮退（§8）の受入をここで満たす。fake 会話＋seeded 記憶による引用突合の小規模評価（実ユーザデータ不使用）を必須とする | 想起適合・縮退率・レイテンシ増加分の記録。意味検索部分を満たし計画完成とする |
| M3 育てる保守（完成に必須） | `maintain.distill` の蒸留・統合（有界・同時実行 1・リトライキュー・取消可・直接書込み）。計画完成には最小の育成実証を必須とし、高度なスケジューリングは任意に留める | R2・R9・保守の有界性・失敗隔離の実証 |

---

## 11. 非目標

- 候補テーブル・承認フロー・承認トークン・TTY 対話・同意 UI。
- 意味的事実検証・特定埋め込みモデルの hard 要求・常時注入・常駐ループの必須化。自律エージェント・sentience・制御不能なバックグラウンドループ・無制限の自動保守。
- リモートサービス化・ネットワーク公開・外部への記憶送信・外部テレメトリ・外部サービス既定利用。物理削除・消去保証・エクスポート API の新設（§12 U2 に延期）。
- per-record の raw 全文複写・複数ストア間の原子性の主張。直接ファイル編集の正本への無言取込み。

---

## 12. 未解決事項

- **U1 Companion 連携契約:** 連携の可否・時期・手段（MCP・ローカル API 等を含む）。連携までは Companion 側への記憶書き込みを行わない。
- **U2 保持・エクスポート・削除方針:** 保持期間・削除可否・エクスポート要否。`archive` は除外であり削除ではない。消去保証は主張しない。容量枯渇時の回復は上限引上げか本方針の解決による。
- **U3 ベクトル索引:** モデル選定・pin・ライセンス・チャンク方針（M2 で柔軟に判断。意味検索能力自体は計画完成に必須。欠落時は語彙＋グラフ縮退）。
- **U4 残件:** 高度なスケジューリング（起動条件・バッチ幅・熱重み調整、MVP・完成の必須外）・評価（データセット・指標・閾値）・有界定数の最終値（§8 既定値は暫定、実測で見直し）。

---

## 13. 出典メモ（FIO_Architecture_JA.pdf・パターン採用）

- 本計画は FIO の構造パターン（現物保持・要約からの下降・二段想起・書戻し入口・リトライ）のみを採用し、格納正本の置き方は**適応**した。FIO は Markdown を正本に置くが、本計画は監査・冪等・原子性のため**単一 SQLite を正本**とし、Markdown・backlink・FTS・ベクトルを再構築可能な投影・派生索引に変えた（p1・p2・p5・p6・p10 が着想の根拠。埋め込み数値は参考値であり hard 要求にしない）。
- **p11 重要な未検証申告:** 「二段記憶の自動保存／起動時インストール／ターン想起は本番未検証（発火実績 0 件）」。「配線した」は「動いた」ではない。本計画は FIO 機構を実績として主張しない。
