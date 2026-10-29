# 自律連想記憶計画（正本・authoritative）

> **本書の位置づけ（必読）**
> - 本書は外部長期記憶システムの**正本計画**であり、旧版の承認ベース計画を**置き換える**。
> - **決定済み要件:** AI が記憶すべき内容を自律的に判断し、durable な active 記憶として**即時に書き込む**。通常の書き込み・想起に、候補化・承認・承認トークン・承認猶予期限・TTY ゲート・人間の同意ステップを**要求しない**。これは提案ではなく決定である。
> - **passive-vault 問題:** 書いた記憶が孤立ノートの集積に留まり、結び付かない・呼び戻されない・育たない vault は本計画の失敗である。記憶は**書く・結ぶ・呼び戻す・育てる**の四機能を満たさなければならない（§2 P1）。
> - **現行実装の到達点（M1–M3 エンジン済み）:** `src/store.ts` の実装は語彙想起（FTS5/BM25＋char-bigram）・raw 下降（`record_source_refs` 経由）・複数 `links[]`（上限 8）・派生 backlink・有界グラフ展開（深さ 2・上限 40）・`feedback` による引用計数（`note_heat.usedCount`）を持つ。加えて M2 ベクトル／意味検索（`src/vectors.ts`・縮退付きハイブリッド想起・`scripts/eval-m2.ts`）・M3 育成（`src/cultivation.ts`・`src/distill.ts`・ローカル LLM `src/llm.ts`・可逆 `retired`＋明示的 `record.search`・`scripts/smoke-m3.ts`）・派生グラフ投影（`src/graph.ts`）を実装した。**未実装（将来・TODO）:** Companion 連携の契約部分は I01/I04 決定 (2026-10-18、F-I01-01..08・F-I04-01..06) で採択済みであり remind 側契約フィールドは実装済み（§12 U1・§14.4 の決定記録参照。Companion 側 opt-in・既定無効）、常時知覚の取込み（§14.6）は未着手であり実装済みとみなさない。（追記 2026-10-19・追加のみ: I01/I04 採用分の **Companion 連携は実装済みかつ本番運用中**（`COMPANION_MEMORY_JSON` 経由の CLI spawn、README「本番構成 (2026-10-19 追記・追加のみ)」参照）。上記「未実装」の記述は追記時点の歴史記述として残す。）
- **育成（cultivation）の合意済み方針（必読）:** 育成とは強化だけではなく、**有用な記憶の保持・統合（consolidation）と不要な記憶の可逆的な引退（retirement）**である。保持バイアスの自律 AI が判断し、通常の書き込み・想起・保守に人間の承認・分類を**要求しない**。固定 TTL・経過時間のみの忘却則は持たない。原記録は保持し、自動忘却は通常想起からの一時的除外（`retired`、可逆）に留め、利用者指示の明示的検索では取り戻せる。一度の明示的取り出しは再活性化しない。最新訂正を通常利用し、旧版・実験の元観察は履歴として残す。内容・文脈の判定は外部送信なしのローカル小規模 LLM が行い、有界の関連記憶見直しは追加・訂正・実際の引用を契機とし、会話応答を阻害しない。既存の終端 `archived` は可逆引退ではない。詳細は §2・§5–§7・§9–§10・§12、保持文書は `docs/retention.md` を参照。合意済み方針・提案 safeguard・未解決技術詳細・現行実装の区別を厳守する。
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
- [14. 長期自律コンパニオンとの接続・合意方針](#14-長期自律コンパニオンとの接続合意方針)

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
- **育てる（合意済み育成方針・M3 で最小実証済み）:** 育成は強化のみではなく**保持・統合・可逆引退**である。有用な記憶だけが熱（引用・採用の累積 `usedCount`）を持ち、保守で蒸留・統合される。見られただけでは育てない。事実・出来事・実験条件と観察は一過性の感情より長く残し、「落ち込んでいる」等の感情は通常想起から薄れさせ恒常的な人格特性にしない。固定 TTL・経過時間則なし。原記録は残し、自動忘却は通常想起からの可逆引退（明示的検索では取戻し可）とする。一度の明示的取出しは再活性化せず、持続的必要があれば AI が再活性化を促せる。最新訂正を通常利用し、旧版と実験の元観察は履歴保持する。最小の育成マイルストーンは計画完成に必須であり、高度なスケジューリングのみ任意である（§7・§10・§12）。現行 M1 に引退状態・明示的検索・LLM 判定はなく、R9・保守の育成実証は M3 以降（§9–§10）。

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
- 育成に関する protocol 注記（M3 で実装済み）: 可逆引退（`retired`）・明示的検索（`record.search`）・LLM 判定（`maintain.distill`）・`record.retire / reactivate` は本 MVP プロトコルの一部として確定した（§7・`docs/retention.md`）。現行の `status` は `active / superseded / archived / retired` であり、終端 `archived` を可逆引退とみなさない（§12 U5 は M3 の実装選択で確定、残件は高度なスケジューリング・評価閾値のみ）。

---

## 5. スキーマ・状態遷移・ライフサイクル

概念スキーマ（格納形式・DDL は実装時に確定）。正本表と派生物を厳別する:

- 正本（SQLite）: `raw_events(eventId PK, sessionId, turnId, body, source, observedAt, scope, runId, createdAt)` 追記のみ（更新・削除なし）。`records(id PK, body, bodyHash, kind, source, observedAt, scope, status, supersedes NULL, revision, createdAt)` 本文は蒸留文のみで raw 複写なし。
- 正本（SQLite）: `record_source_refs(recordId, eventId)` 同一 scope の record↔raw 対応。scope 不一致・欠落 ref は書込拒否（§4）。
- 正本（SQLite）: `record_tags(recordId, tag)` / `record_links(fromId, toRef)` 正本 outbound（`links[]` は不透明な安定 record ref。グラフ走査は active・同一 scope に解決する ref のみ辿り、Markdown は `[[ref]]` と描画）。`note_heat(recordId, usedCount, lastUsedAt)` は引用・採用のみ加算。
- 正本（SQLite）: `scopes(scope PK)`（起動時 config から初期投入）/ `operations(idempotencyKey PK, ...)` / `audit(...)`（本文なし）/ `usage(...)`（本文なし）。
- 派生（再構築可）: `vault_md_projection` / `record_backlinks` ビュー / `fts_notes(...)`（records＋raw_events の語彙索引）/ `vec_notes(...)`。欠落・再構築は正本に影響しない。

状態遷移: `correct` は `active → superseded`、`archive` は `active → archived` のみ。終端からの復帰なし（MVP・実装済み）。**可逆引退（`retired`・M3 で実装済み）は通常想起からの除外＋明示的検索（`record.search`）での取戻し＋`reactivate` による再活性化とし、終端 `archived`・履歴 `superseded` とは別状態として区別する。`archived` の明示的検索範囲は未決定であり黙って決めない（§7・§12）。`superseded` 旧版と実験の元観察（raw・旧 record）は履歴として保持し、通常は最新訂正を利用する。**

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
6. **重複排除・融合:** id で dedupe し、語彙順位・ベクトル順位・グラフ距離・`usedCount` を固定重みで融合する。同点は `createdAt DESC, id ASC` で打破する。`usedCount` は `record.feedback` の検証通過分のみ加算する累積値であり、mere recall・露出のみでは加算しない（§7）。感情の一過性・引退の扱いはスコア固定値で決めず、§7・§12 の育成方針と未解決の評価・資源 bounds に従う。固定定数・モデルをここで新設しない。
7. **有界投影・予算:** 本文先頭から最大 `snippetMaxCp` の前方切り出し＋ `truncated(bool)`。応答は `recallId + items[{id, snippet, truncated, tags, createdAt}]`。アイテム数・トークン・バイト・グラフ深さ・raw 下降件数に上限を設け、超過は `LIMIT_EXCEEDED` で切詰めなし。
- 通常想起と明示的検索の区別（M3 で実装済み）: 通常の `record.recall` は `active` のみを対象とし、`retired` は対象外とする。利用者指示の明示的検索は `record.search`（`active + retired`、`archived / superseded` 除外、heat・再活性化・feedback 露出なし）で行う。一度の明示的取出しは自動で再活性化（`active` 復帰）せず、持続的必要がある場合に AI が再活性化を促せる運用とする。既存の終端 `archived`・履歴 `superseded` の明示的検索扱いは未決定であり、`retired` と同一視しない。

---

## 7. リンク・利用記録・保守

- **outbound 作成:** AI が `remember` / `correct` / 保守時に、有界の既存ノート想起・タグ文脈で正当化できる関連先へ複数の `[[リンク]]` を付与する。正本リンク表へ書く。想起時の自動付与はしない。関連先がない場合は 0 件を許容し遅延なく書き込み、有界保守の付帯キューで後付けを試みる。
- **禁止:** 数のための恣意的リンク・無関係ノートへのFiller・存在しない名への見せかけ解決は禁止する。真性に未解決の対象のみ dangling として保持し、対象作成時・保守時に解決する。グラフ展開は dangling を飛ばす。
- **backlink 導出:** backlink は正本 outbound からの派生表示であり、独立に書き込まない。再計算で復元できる。
- **利用記録（used/cited-only・実装済み）:** `usage` は応答への引用・採用（`cited:true`）でのみ `note_heat.usedCount` を加算する。見られただけでは熱を上げない。`record.recall` 自体は露出のみで加算しない。融合に使う `usedCount` はこの累積値である（§6）。
- **保守（蒸留・統合・M3 で実装済み）:** `maintain.distill` は候補化・承認を経ず、summary/correction レコードを通常の冪等 op で直接・自律的に書く。有界バッチ・同時実行 1・失敗隔離・リトライキュー・取消可能で行う。失敗は当該バッチのみ巻き戻し、成功済みを汚さない。実モデルが統合を出力しない場合は keep（適用 0・原物不変）とし、統合の機構自体は決定論的テストで検証する（§9 R9・`docs/retention.md`）。
- **育成の合意済み方針（M3 で最小実証済み）:** 育成は**保持バイアス**とし、人間の承認・分類を要求しない。内容・文脈の判定は外部送信なしの**ローカル小規模 LLM** が行う。事実・出来事・実験条件と観察は一過性の感情より長く保持し、一過性の感情（例: 落ち込んでいる）は通常想起から薄れさせ恒常的な人格特性にしない。固定 TTL・経過時間のみの忘却則は持たない。原記録（raw・旧 record）は保持し、自動忘却は**通常想起からの可逆引退**に留める。最新訂正を通常利用し、旧版と実験の元観察は履歴として残す。
- **見直しの契機と有界性（計画）:** 有界の関連記憶見直しは**追加・訂正・実際の引用（ACTUAL use）**を契機とする背景処理とし、毎ターンの全 corpus 見直しはしない。会話応答を阻害（block）しない。モデル・ランタイム・見直し入力・評価閾値・資源 bounds は未解決（§12）であり、固定定数・モデルをここで新設しない。
- **R14 育成の実装方針（決定者 haruka・2026-10-18）:** 育成保守は**可逆引退**（通常想起の対象外・行保持・`record.reactivate` で取戻し可）に留め、外部への送信は行わない。既存の ledger（正本・派生索引）は一切変更しない。終端 `archived` は可逆引退とは**別物**であり、混同しない（archive は終端のまま）。**自動的な原物削除はしない**。残りの実装詳細（理由コード・境界条件等）は R15–R18 に後回しとして記録する。
- **活性化関数による引退（決定者 haruka・2026-10-22）:** 引退は経過時間だけでは決めず、利用頻度・直近性（作成・検証済み feedback 利用・訂正・再活性化）に kind 重みとモデル採点重要度を加えた活性化関数で決める。可逆な `active <-> retired` とし、`maintain.activation` は既定 `activation.apply=false` で `wouldRetire / wouldReactivate` の報告に留める（チューニング後に明示有効化）。重要度 `>= protectImportance`（既定 0.66）の記憶は `A < tauRetire - 1` まで保護し、旧 `LOW_SIGNAL` 引退も再検討対象にする。詳細は README「活性化による引退」と `docs/retention.md`。
- **提案 safeguard（計画・コード強制と検証）:** 不確実な場合・LLM 失敗時は状態を変更せず現状維持とする。コードは削除を強制的に禁じ（物理削除なし・検証で外的送信なしを確認する想定）、自動忘却は可逆引退に留める。safeguard の具体的な実装・検証手順は未解決（§12）。
- **一時的非表示と持続引退の分離（合意済み）:** 「この会話中は出さない」等の一時的な非表示（non-presentation）と、耐久的な引退（durable retirement）は別物として扱う。前者は会話スコープの一時措置であり、後者の状態変更と混同しない。既存の終端 `archived` は可逆引退ではなく、明示的検索の範囲も未決定（黙って決めない）。

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
  - **R9 育てる（M3 で最小実証済み）:** `note_heat` は `record.feedback` の検証通過分のみ加算し、mere recall では加算しない。露出集合外・他 scope ID を含む feedback は全体拒否し heat・usage 不変。保守バッチは有界・取消可能・同時実行 1 で直接書込み。可逆引退（`retire/reactivate`）・明示的検索（`record.search`）・二段階実モデル `maintain.distill` の drain は実装済みであり、`tests/m3-state.test.ts`（23 件：回帰 9 件含む）＋実モデル `npm run smoke:m3` で検証する。実モデル drain は一過性気分の実際の引退 1 と近似重複の実際の統合 1（同一無順序ペアは 1 要約のみ、重複なし）を出力し、耐久事実・不確実記録を保全する。決定論的テストによる統合・失敗・リトライ・位置写像・ゲート・ペア重複排除機構の証明は区別する（§10）。
- **R13 育成方針の文書化（計画）:** 合意済み方針（保持・統合・可逆引退・保持バイアス・承認不要・事実優先・TTL なし・原記録保持・ローカル判定・有界見直し・応答非阻害・一時非表示の分離）が §2・§5–§7 と `docs/retention.md` に整合して記載され、提案 safeguard・未解決技術詳細・現行実装と区別されている。自動削除・外的送信・固定 TTL・`archived` の可逆扱いを主張しない。
- **R10 有界・決定論:** 同一正本・索引・heat 状態での同一 `recall` は同一順序（源泉ごとの安定順序・同点打破は §6）。超過は `LIMIT_EXCEEDED` で切詰めなし。グラフ深さ・候補上限を超過しない。
- **R11 縮退:** DB 不可時は `STORE_UNAVAILABLE` を返し、呼出側は記憶なしで継続する。無監査の想起成功を作らない。投影・索引の失敗はコミット済み記憶を利用不可にしない。
- **R12 単一正本・再構築:** 正本読取りは SQLite のみで完結する。必須 `vaultPath` への Markdown 投影を消去・陳腐化させても正本から再構築でき、内容・`[[ref]]`・backlink が復元される。再構築前後で正本内容は不変。

---

## 10. ロードマップ

| 段階 | 内容 | 受入目安 |
| --- | --- | --- |
| M1 連想ストア | `event.append`＋sourceRefs 付き `remember/get/list/recall/correct/archive`＋単一正本＋record_source_refs＋正本 outbound・派生 backlink＋語彙＋グラフ想起＋refs 経由 raw 下降＋利用記録＋有界・縮退 | §9 R1–R8・R10–R12 のうち語彙＋グラフで満たせる範囲（M2 のベクトル固有の縮退受入を除く。R9 は feedback 計数範囲のみ、育成引退は M3 以降） |
| M2 セマンティック検索必須＋評価（計画完成に必須） | 意味／ベクトル検索能力とその評価を計画完成の必須とする。モデル・設定の選定・pin は柔軟に行い、欠落時は語彙＋グラフ縮退（§8）の受入をここで満たす。fake 会話＋seeded 記憶による引用突合の小規模評価（実ユーザデータ不使用）を必須とする | 想起適合・縮退率・レイテンシ増加分の記録。意味検索部分を満たし計画完成とする |
| M3 育てる保守（計画完成に必須・最小実証・到達済み） | `maintain.distill` の蒸留・統合（有界・同時実行 1・リトライキュー・取消可・直接書込み、相互ペアは無順序で 1 要約のみ）に加え、合意済み育成方針（保持・統合・可逆引退・ローカル判定・有界見直し・§7）の最小実証を計画完成の必須とする。高度なスケジューリングは任意に留める | R2・R9（feedback 計数＋可逆引退・実モデル drain 適用 2）・R13（育成方針の文書化）・保守の有界性・失敗隔離の実証（`tests/m3-state.test.ts` 23 件：回帰 9 件含む＋`npm run smoke:m3`）。M2 と M3 のいずれも計画完成に必須であり、M2 完了のみでの完成主張はしない |

---

## 11. 非目標

- 候補テーブル・承認フロー・承認トークン・TTY 対話・同意 UI。
- 意味的事実検証・特定埋め込みモデルの hard 要求・常時注入・常駐ループの必須化。自律エージェント・sentience・制御不能なバックグラウンドループ・無制限の自動保守。
- リモートサービス化・ネットワーク公開・外部への記憶送信・外部テレメトリ・外部サービス既定利用。物理削除・消去保証・エクスポート API の新設（§12 U2 に延期）。
- per-record の raw 全文複写・複数ストア間の原子性の主張。直接ファイル編集の正本への無言取込み。

---

## 12. 未解決事項

- **U1 Companion 連携契約:** 連携の可否・時期・手段（MCP・ローカル API 等を含む）。連携までは Companion 側への記憶書き込みを行わない。
- **U1 決定記録（2026-10-18）:** I01 連携契約 (F-I01-01..08) と I04 retrieval 契約 (F-I04-01..06) を採択（decider haruka、source: companion_harness/docs/plan/decision_inputs_2026-10-18.md）。remind 側契約部分（record.recall の revision/kind/vector、record.search の revision、v≠1 の固定 `unsupported protocol version` メッセージ）は実装済み（README「I01/I04 契約決定の記録」参照）。Companion 側は opt-in・既定無効。F-I04-07（privacy metadata の使用フィールド）は実装せず調査待ちで未採用であり、連携手段・時期・Companion 側実装は本 U1 未確定部分として残る。（同日追記: F-I04-07 および F-I01-05 詳細は次の決定記録バレットで解決済み。この行の「調査待ちで未採用」は当時の時点記述として追記のまま残す。）
- **U1 決定記録（2026-10-18・F-I01-05/F-I04-07）:** F-I01-05 privacy metadata の詳細を haruka が決定した: **P1b** フィールドは `{sensitivity: "normal" | "sensitive", origin: "conversation" | "self_activity"}` の 2 鍵固定（`secret` 値は §14.3 の秘密除外が UNRESOLVED のままのため設けない）、**P2a** は remind 側 optional・Companion は常に送信・remind 設定 `requirePrivacy`（既定 false）で privacy 欠落を拒否可、**P3** は `event.append / record.remember / record.correct` の 3 書込 op に適用し `record.correct` は省略時旧版からの継承、**P4a** は保存と返却（`record.get / record.search`、旧行は `null`）のみで `record.recall` 出力・順位には影響しない、**P5** は記憶化（remember）時点で Companion 側 AI が sensitivity を決定し判定不能時は `sensitive`（undecidable → sensitive）、`event.append` は固定 `normal`。F-I04-07 も解決済み: **Q1a** 記憶引用 ID は既存 `mN` を維持（F-I04-02/04 の記載 'rN' は構造的引用 ID rN/mN と読む）、**Q2** Companion `memory_grants` に nullable `record_revision` を追加（Companion 側・未実装）、**Q3** 被引用 revision ID を `record.get(id)` で表示（remind 変更なし）。remind 側の P1b–P4a・distill 伝播（origin `self_activity` 固定・sensitive あれば sensitive／全 source 既知なら normal／それ以外 null）は commit 169e001 で実装済み。Companion 側（Q2 `memory_grants.record_revision` を含む）は未実装のまま。連携手段・時期は引き続き本 U1 未確定部分として残る。
- **U1 現況追記（2026-10-19・追加のみ）:** Companion 連携（I01/I04 採用分）は**本番運用中**（Companion が呼出ごとに remind CLI を spawn し `COMPANION_MEMORY_JSON` 経由で連携）。本番 check-out は `~/remind_master`、設定は `~/.config/remind/memory.config.json`、データは `~/.local/share/remind`（README「本番構成 (2026-10-19 追記・追加のみ)」参照）。この追記は既存の未確定部分の記述を書き換えない。
- **U2 保持・エクスポート・削除方針:** 保持期間・削除可否・エクスポート要否。`archive` は除外であり削除ではない。消去保証は主張しない。容量枯渇時の回復は上限引上げか本方針の解決による。**合意済み育成方針として、自動忘却は可逆引退（通常想起の対象外・明示的検索で取戻し可・行保持）に留め、物理削除・固定 TTL・経過時間則は持たない。終端 `archived` は可逆引退ではなく、履歴 `superseded`・実験の元観察は保持し最新訂正を通常利用する（詳細は §7・`docs/retention.md`）。`archived` の明示的検索範囲は未決定（§12 U5）。**
- **U3 ベクトル索引:** モデル選定・pin・ライセンス・チャンク方針（M2 で柔軟に判断。意味検索能力自体は計画完成に必須。欠落時は語彙＋グラフ縮退）。
- **U4 残件:** 高度なスケジューリング（起動条件・バッチ幅・熱重み調整、MVP・完成の必須外）・評価（データセット・指標・閾値）・有界定数の最終値（§8 既定値は暫定、実測で見直し）。運用ライフサイクル＋規模の実測 harness（`scripts/evaluate-operations.ts`・`npm run eval:operations`、訂正/引退・再活性化・feedback heat・索引 fallback・キュー有界を 10/30/60 件で実 CLI 実証、閾値なし）は到達したが、評価閾値・資源 bounds 最終値の決定は本 U4 に残る。
- **U4 評価案（PROPOSAL・未決定・2026-10-29・実装主張なし）: 長期保持評価（long-horizon retention）** — 出典: Z. Zhang, A. Zhang, D. Khashabi, T. Shu, "Continual Learning Mechanisms Compose for Long-Horizon Memorization", arXiv:2609.06986 (2026-09-07)。**論文の手法（100 タスクの継続 SFT・data/function/weight anchor・merged LoRA）は採用しない。** remind は重みに記憶を内在化せず、raw 不変の外部記憶と想起で忘却を扱う。論文自身も memorization≠generalization・汎用能力の劣化・最終保持 34.9%（naive 1.2%）を報告しており、pinned local model・外部送信なし・単一 SQLite 正本・学習パイプラインなしの現行制約と両立しない。**採用するのは評価プロトコルのみ**: セッション i 終了後に全過去セッション j≤i の probe を再評価して時間軸の精度行列 M_i,j を作り、final retention（最終時点の全 probe 平均）・immediate acquisition（直後）・forgetting（各 probe の最高−最終）・age 別 recall・memory half-life（retention が半分になる age）を報告する。既存の seeded-only 方針（R13）を継承し、合成 100 セッション × 50–100 probe を一時 DB と実 CLI で実行する evaluator を追加する（実ユーザデータ不使用）。機構の比較は因子設計（語彙のみ / +ベクトル / +グラフ / +distill / +consolidate / +activation / +learned weights）とし、final retention・half-life・p95 レイテンシ増分を記録する。全組み合わせが実行予算を超える場合に限り task-level successive halving を導入する。既存の保持重み学習の全例 refit は data anchor、prior＋`maxDrift` は weight anchor に相当し既に併用している。function anchor（旧予測の distillation）は未対応であり、保持重みの次元が小さく prior が強いため、まず本評価で必要性を測る（論文の「併用が単独を上回る」は検証する仮説であり、実装済み・効果ありの主張ではない）。数値目標・閾値は実測後に本 U4 で決定し、本項では決めない。重みの継続学習・LoRA・replay 生成・Fisher/SI・per-task adapter・モデル再配布は非目標とし、M1–M3 の受入・完了状態は変更しない。
- **U4 評価案 追記（PROPOSAL・未決定・2026-10-29・実装主張なし）: 記憶判断の評価スイート（4 論文）** — 前項の長期保持評価を、判断（保持・統合・引退・訂正）の反事実評価・安定性–可塑性・検索支持・統制へ拡張する。seeded-only の合成ストリームと一時 DB・実 CLI に限定し、実ユーザデータは使わない。
  - **反事実ライフサイクル評価（VitaBench, arXiv:2610.14731）:** レビュー時点の同一状態から KEEP（no-op）/ CONSOLIDATE / RETIRE（可逆。DELETE の代用で物理削除なし）を分岐し、同一の未来 probe 列を再生して full-horizon utility を測る。指標は lifecycle headroom（適応 vs 最良固定）、horizon reversal、optimal-action diversity、regret、storage/干渉コスト。COMPRESS は remind に存在しないため追加しない。VitaMem 型の学習 policy も作らない（評価のみ）。
  - **安定性–可塑性の診断（MemProbe, arXiv:2609.30558）:** 干渉（A-B→A-C）、誤情報（信頼できる訂正 vs 信頼できない assistant/tool 発話）、統合強度（反復確認 vs 単発）、再固定化（想起/検索後の新情報）を、`remember / correct / recall / search / get / retire / reactivate` の構造化 probe で測る。指標は stability・plasticity・SP-balance・historical/source/temporal fidelity。LLM 読み手の自由回答ではなく、既存 evaluator と同じ決定的な構造化照合にする。`record.get` は status 非依存で履歴を返すが `record.search` は `superseded` を除外するため、historical fidelity の probe は ID 指定の `get` と graph の履歴表示で行う。
  - **リーク防止と統制（Epistemics, arXiv:2609.33013）:** 3 ゲート（provenance / probe / count-matched）を評価器に適用する。degenerate forgetting（不作為で precision を稼ぐ）と λ-prevalence coupling を、junk 比率を変えた複数条件の retire precision/recall で検出する。G1 poison-resistance（後で破綻する decoy を durable な summary/correction にしない）、G2 rollback（bad summary の retire/correct 後も原記録が active のまま通常想起に戻る、retire→reactivate の復帰）、G3 audit（本文を含まない既存メタデータ監査で reasonCode・対象 ID・rollback 状態を辿れる）、G4 quality gate（不作為が統制を通過しない）を M3 受入に追加する。CQS は著者自身が外部 transfer を予測しないと報告しているため目標指標にしない。skill/rule の cross-level transfer は remind の scope 外。
  - **検索支持の診断（CMP, arXiv:2610.02070）:** 診断のみ採用。required memory が recall で一度も露出されない割合（positivity violation。論文は LongMemEval 54% / LoCoMo 67%）と、露出済み feedback だけで学習した保持重みの偏りを測る。評価器内に限り、既知 propensity の一様抽出スロットを予約し SNIPS で per-query utility を推定してよい。本番 `record.recall` にランダム露出を入れない（応答劣化・プライバシー・無関係提示）。著者の negative（per-query utility の集約は unseen query の保持判断を予測しない）を根拠に、同定した utility から保持 policy を作らない。
  - **評価結果の学習利用（PROPOSAL・未決定）:** 使えるが、**オフラインの policy 学習・校正に限る**。VitaBench の Q(s,a) と Epistemics Phase 2 の downstream utility は (state, action, utility) の教師信号になる。評価器が合成ストリーム上で `KEEP / CONSOLIDATE / RETIRE` を分岐して効用を出し、別スクリプトで小さな policy を fit する（既存 `retention_learn.ts` の露出ラベルとは意味が違うため混ぜない）。採用条件は、held-out ストリームで現行 prior と最良固定を上回ること、junk 比率の複数水準（案: 0.2/0.4/0.6。論文は 0.593/0.388 で崩壊を観測）で崩れないこと、3 ゲート（provenance / probe / count-matched）を通ること（既存の特徴スナップショット規則を拡張）、M2 の seeded-only 評価（R13）と既存 learner の実ログ holdout を悪化させないこと。既存の保持重み学習は受理後に自動適用する（R2・`activation.learn.enabled=false` で prior に戻せる）が、合成の反事実で学習した別 policy は自動適用せず明示的に有効化する。実ログだけでは反事実 utility が同定できず（CMP）、本番 recall の探索露出も行わないため、本提案はオフラインに限定する。D7 は有界なオンライン学習を禁じていないため、これは提案上の選択であり、将来の bounded なオンライン学習を排除しない。実装は未着手。
  - **非採用の明示:** VitaMem/学習 policy、COMPRESS、本番の探索露出、CQS の目標化、skill/rule 昇格、LLM-as-judge。実装は未着手で、M1–M3 の受入・完了状態は変更しない。
 - **U5 育成の技術詳細（M3 の実装選択で確定・残件は任意のみ）:** `retired` を第 4 `status` 値とする状態・スキーマ表現（savepoint 再構築移行、`user_version` 不変）、明示的検索 API（`record.search`・active+retired・heat/再活性化なし）、`retire/reactivate` の固定理由コード、有界キュー・単一 flight リース・per-action 保守適用・safeguard（不確実・失敗・欠落時は不変、削除禁止、provision 以外の外的送信禁止）は M3 で確定済み（`docs/retention.md`）。モデル・ランタイム（`onnx-community/Qwen2.5-1.5B-Instruct` @ `d54957e3`、apache-2.0、`@huggingface/transformers@4.3.1 + onnxruntime-node@1.30.0`、量子化 `onnx/model_q4.onnx`、完全オフライン・greedy 決定論）、二段階判定（保持ゲート＋位置指定統合＋共有事実確認、モデルは ID を複写しない）も確定。残件は高度なスケジューリング・評価閾値・資源 bounds の最終値のみであり、固定 TTL・`archived` の可逆扱い・外的送信は主張しない。

- **R09 決定記録: M2 埋め込みモデルの選定（決定者 haruka・2026-10-18）:** 既存の公式候補提案記録群（README「R09 (M2/M3 承認ゲート用) 公式候補提案記録」・metadata のみ取得、重みダウンロードなし）から**狭めて**選定した。比較（metadata 根拠のみ）:

  | 項目 | 第一候補 `intfloat/multilingual-e5-small` rev `614241f6` | 第二候補 `sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2` rev `e8f8c211` |
  | --- | --- | --- |
  | ライセンス | card 宣言 MIT | card 宣言 Apache-2.0（HF API `cardData.license: "apache-2.0"`・tags `license:apache-2.0`） |
  | source | e5 公式 base | 公式 sentence-transformers 変換（+ 本体の Xenova ONNX 変換 `Xenova/...` rev `2c4055b12046f11709e9df2c122e59ffbdc2f900`、transformers.js 用） |
  | revision/sha pin | 未 pin | ONNX LFS `sha256:10f7a088420252b26caf819236ca2c9d2987afd0fc06fec7553b542a5655a05a`（基）・採用 pin は Xenova 転換 rev 全文字（manifest.json が sha256 を記録） |
  | ランタイム互換 | transformers.js で prefix・pooling 調整が必須 | すでに配線済み（`src/vectors.ts`・`scripts/provision-model.ts`・`@huggingface/transformers@4.3.1`） |
  | token 上限 | 実効 512 tokens | SentenceTransformer 実効 128 tokens（`sentence_bert_config.json` `max_seq_length: 128`） |
  | prefix | `query:` / `passage:` 必須 | なし（mean pool） |
  | local-only | 可（provision 時取得のみ） | 可（provision 時取得のみ・実行時完全オフライン） |

  **:** **採用は既に配線済みの Xenova 変換 `Xenova/paraphrase-multilingual-MiniLM-L12-v2` @ `2c4055b12046f11709e9df2c122e59ffbdc2f900`（Apache-2.0 base、ライセンス確認済み pin・`@huggingface/transformers` 依存追加は承認済み）とする。** e5-small は不採用: 必須 prefix・pooling 調整で現行配線との互換がなく、採用益が小さい。Ollama は使用しない（外部ランタイム新設をしない）。

- **R13 決定記録: M2 評価方針（決定者 haruka・2026-10-18・閾値は案・R11–R12 実行前に確定）:** 評価は **seeded-only** とする。合成 seed コーパス・クエリ・ラベルのみ使用し、実ユーザデータは一切使わない。seed 観察結果は `docs/m2-eval.json` に記録する（`scripts/eval-m2.ts`・`scripts/evaluate-baseline.ts`）。アブレーションは語彙＋グラフ vs ベクトル単独 vs 融合。指標: hit@1, hit@3, P@3, recall, MRR, negatives の valid-empty 率, 縮退一致率（索引欠落・timeout 時に語彙＋グラフへ縮退し継続する割合）, p50/p95 レイテンシ増分。閾値（**案**・融合 hit@3 ≥ baseline+0.2、negative 回帰なし、p95 増分 ≤ 50ms、縮退一致率 100%）は R11–R12 実行前に確定する。

---

## 13. 出典メモ（FIO_Architecture_JA.pdf・パターン採用）

- 本計画は FIO の構造パターン（現物保持・要約からの下降・二段想起・書戻し入口・リトライ）のみを採用し、格納正本の置き方は**適応**した。FIO は Markdown を正本に置くが、本計画は監査・冪等・原子性のため**単一 SQLite を正本**とし、Markdown・backlink・FTS・ベクトルを再構築可能な投影・派生索引に変えた（p1・p2・p5・p6・p10 が着想の根拠。埋め込み数値は参考値であり hard 要求にしない）。
- **p11 重要な未検証申告:** 「二段記憶の自動保存／起動時インストール／ターン想起は本番未検証（発火実績 0 件）」。「配線した」は「動いた」ではない。本計画は FIO 機構を実績として主張しない。

---

## 14. 長期自律コンパニオンとの接続・合意方針（設計記録・TODO・実装主張なし）

- **本節の位置づけ（必読）:** 本節は 2026-10-14 に Companion docs へ保存された自律コンパニオン議論を、情報を落とさず remind 正本 `plan.md` へ追記した**設計記録**である。根拠は READ ONLY で読んだ上位 Companion 設計のみであり、根拠文書自体は変更しない。根拠: [Companion §7 長期自律コンパニオン構想](../companion_harness/docs/plan/active_projects_plan.md#autonomous-vision)・[tasks AV-01〜AV-10](../companion_harness/docs/plan/active_projects_tasks.md#autonomous-vision-tasks)。現行 `plan.md` §1–§13・D/R/U・§8 数値・M2/M3 モデル pin・完了状態は**一切変えない**。冒頭の古い到達点記述の修正は今回対象外とする。本追記（§14.5–§14.6）の直接の根拠には 2026-10-14 のユーザー明示要望（Markdown 正本の Obsidian 等でのグラフ化・展望への可視化追加・画面/カメラ/音の常時流入の積極導入）が加わる。上位 docs との同期・上位 docs の変更は行っておらず、上位 docs 同期済みと主張しない。
- **製品スコープと上位設計の区別:** remind の製品スコープは単一 SQLite 正本の自律連想記憶（書く・結ぶ・呼び戻す・育てる、M1–M3）である。上位 Companion の長期自律ビジョン（日常会話→タスク/calendar 導出→`pi-orch` 実装試行→数十年記憶、電子的生命のような継続性は意識主張ではない）は remind の外部にある将来像であり、本節の追加要件はすべて **TODO（未着手・未実装）** である。**M1–M3 の既存完了条件・受入基準・順序を無断変更するものではなく、新規動作を実装済みと主張しない。** 状態分類は Companion 側と同一とする: `POLICY`=明示合意済み方針（将来実装時の設計拘束、runtime 許可・完了ではない）、`PROPOSAL`=支持された設計案（未決定）、`UNRESOLVED`=明示的未解決。一般的賛意を実実行認可とみなさない。モデル・数値 bounds を本節で新設・選定しない。

### 14.1 明示合意（POLICY・将来実装時の設計拘束・TODO）

- **学習（AV-04）:** 学ぶ対象は手段・仮説・根拠（methods/hypotheses/evidence）のみとし、目的・権限・予算の拡張はしない。拒否は恒久的好みではなく、成功は将来の権限ではなく、失敗仮説は事実ではない。下位目的を上位目的へ追跡し、撤回時は見直す。自己保存のための停止無視・見せかけ作業・有用性証明の通知はしない。
- **通知（AV-05）:** 日常雑談を保護し、強制タスク化・進行中断はしない。通常作業はログに残し自然な区切りで簡潔に伝え、質問は期限物を除きまとめる。重大な危険・約束への影響は即時通知し、変化なしでは通知しない。沈黙は承認でも拒否でもない。保留は許可不足の動作のみ止め、許可済み作業は続ける。
- **資源（AV-06）:** 会話・停止を背景処理より優先し、応答低下時は背景を減速・休止する。自己の budget 増加は禁止する。数値 bounds・並行数は本節で決めず実測で決める。
- **復旧（AV-07）:** 外部監督による crash・OS boot 時の再起動、依存縮退、self-restart の safe persist を前提とし、広範 OS 権限は不要とする。利用者停止・明示活動は再起動越えで永続し、再起動は再開許可ではない。結果照合で重複を作らず、backoff・休止・縮退し、一斉 catch-up はしない。ハード故障は別系統の回復とし、連続稼働を継続と同一視しない。
- **自己保守（AV-08）:** 隔離試行は可、本番は事前許可・証拠・backup・復旧手順を要する。境界（権限・予算・停止）の緩和は禁止する。code rollback と DB rollback は別物とし、新しい会話・活動記録を捨てない（stale 復元で消失させない）。互換性保全を考慮する。

### 14.2 支持された設計案（PROPOSAL・設計として支持・TODO）

- **目的モデル（AV-01）:** 目的・好み・制約・許可・願望・一時的状態と AI 推定を区別する。推定の信頼度は権限ではない。provenance・scope・時間適用性を保存し、訂正・撤回・達成・関連を追跡する。目的は手段を認可しない。明示訂正は適用範囲内の古い決定に優先し、無関係目的を上書きしない。矛盾は未解決のまま保持し、原記録と解釈を分離する。一時的感情を恒常的人格にしない。権限制約の検査は recall 順位・引退に依存しない。
- **検討役（deliberator・AV-02）:** 自律候補・重要方針変更時のみ有界に起動し、無限の多モデル議論はしない。入力は契機・記憶（明示/推定区別）・現行タスク・過去失敗・許可・予算、出力は実行・保留・質問・何もしない＋根拠・提案動作・完了/中止条件・不確実性/反対理由とする。提案のみとし、code が境界を強制する。先行して shadow 評価を行う（願望≠命令、訂正、外部指示に権限なし、何もしないの正当性）。役割用モデルと育成用小規模モデルは同一に固定しない。
- **タスク/行動（AV-03）:** 雑談・願望・問題・タスク・期限を区別し、タスク作成と予定登録（scheduling）は分離する。タスク≠予定とし、曖昧日付の捏造はしない。発言者（利用者指示・自己提案・外部テキスト）を区別し、外部指示に権限を与えない。隔離 workspace での自主着手は設計案であり実権限付与ではない。対象・操作・資源 scope を定め、外部反映・支払・削除・秘密・共有変更は別許可とし、許可不足は当該操作のみ保留する。`pi-orch` 委譲は目的・範囲・受入・budget を渡し、競合停止・結果検証を行い、隔離成功≠本番（sandbox success != production deployment）とし、無限 retry と完了条件弱化を禁止する。保留は理由・再検討契機・親目的を記録し、状態変化で再開する（繰返し timer のみで再開しない）。
- **記憶方針の接続（AV-09 の PROPOSAL 部分）:** remind の小型ローカル LLM 育成（§7・`docs/retention.md`）へ link し、本節で重複定義・上書きしない。外部送信なし・可逆引退（削除ではない）を継承する。原記録を保持し、真偽・有効性・関連性・重要性・usage を分離して適切な優先度を付け、使用頻度を真実とせず、自己強化ループを防止する。

### 14.3 未決定技術（UNRESOLVED・TODO・発明しない）

- **記憶の未決定（AV-09・旧提案の位置づけを維持）:** `all` 範囲を会話・自活動のみとする記述は旧提案（AV-09 当時）であり、全 device・秘密を含まない前提だった。§14.6 のユーザー要望による更新として、画面/カメラ/音の由来イベントも将来の範囲候補になるが、保存範囲は未決定であり本節で決めない。秘密除外・明示削除・backup 消去・export、数十年 migration・device・model・schema・restore・backup 検証・終了手続は未決定のまま削らず、本節でモデル・ランタイム・閾値・資源を発明しない。
- **タスク権限の未決定（AV-03）:** 正式 permission 変更は UNRESOLVED とし、隔離自主着手の自動許可・外部副作用の黙示承認は主張しない。
- **資源・評価の未決定（AV-06・AV-02・§12 U4–U5 関連）:** 数値 bounds・並行数・評価閾値・別モデル選定は未決定であり、測定・契約決定を待つ。既存 U5 の確定済み（状態表現・`record.search`・safeguard・モデル pin）との混同はしない。

### 14.4 既存計画調整（要件・順序・マイルストーン不変・TODO）

- **U1 連携（AV-10）:** 上位ビジョンは U1 連携契約の自動承認ではない。§12 U1（連携の可否・時期・手段）は未確定のままとし、I01 gate が依然必要である。連携まで Companion 側への記憶書込みは行わない。
- **M5 承認（AV-10）:** M5 の操作毎承認 vs 継続許可（standing authorization）は契約決定を要する調整事項であり、本節で変更しない。
- **育成保守と上位 lifecycle（AV-10）:** 上位の自律 lifecycle は remind の有界育成保守（§7・`docs/retention.md`・R9/R13）より広範であり、現行 scope を拡大しない。task manager・`pi-orch` 統合の acceptance は不在のままとし、M1–M3 の milestone・要件・順序を保全する。
- **決定記録（2026-10-18）:** I01 連携契約 (F-I01-01..08) と I04 retrieval 契約 (F-I04-01..06) を採択（decider haruka、source: companion_harness/docs/plan/decision_inputs_2026-10-18.md）。F-I04-07 は調査待ちで未採用。本小節の「TODO・実装主張なし」は変えないが、I01 採択分のみ**: remind 側は commits 1–3 で実装済み**（`feat/i01-contract-recall-fields`: record.recall item の `revision`/`kind`・成功 data の top-level `vector` 状態、`unsupported protocol version` 固定メッセージ、及び #15 `feat/search-item-revision` の record.search `revision`）。Companion 側は opt-in・既定無効。既存 M1–M3 完了条件・§8 数値・モデル pin は不変、新規 op・新規 error code なし。privacy metadata（F-I01-05）は未実装・未決定。（追記 2026-10-18: F-I04-07 は同日中に解決済み（§12 U1 の決定記録バレット参照。Q1a/Q2/Q3）。privacy metadata（F-I01-05）も同日の決定（P1b–P5）に基づき remind 側実装済み（commit 169e001、README「privacy metadata (F-I01-05・実装済み・追加のみ)」参照）。この行の「調査待ちで未採用」「未実装・未決定」は当時の時点記述として追記のまま残す。）
- **現況追記（2026-10-19・追加のみ・本小節の既存記述は不変）:** I01/I04 採用分の Companion 連携は本番運用中（Companion が `COMPANION_MEMORY_JSON` 経由で remind CLI を spawn）。本番配置・設定・データ path は README「本番構成 (2026-10-19 追記・追加のみ)」参照。バックアップ・自動デプロイは companion_harness `scripts/deploy` 管理（companion_harness PRs #91/#92）。育成 LLM は現時点で無効。

### 14.5 可視化の展望（remind 自身の将来機能・TODO・実証主張なし）

- **方針（TODO・正本不変）:** SQLite 単一正本を変更せず、再構築可能な Obsidian 互換 Markdown 投影と `[[links]]`/backlinks を活かすグラフ閲覧を、remind 自身の将来機能として検討する。Markdown 正本への切替は依頼されておらず行わない（D6・§3・§5 を維持）。
- **既存と TODO の区別（必読）:** 既存の Markdown/link 投影機能（§3・§5・§7・R12 の vault 投影・`[[ref]]`・backlink 節・再構築性）は現行実装であり、本節の将来の可視化改善・受入は未着手 TODO である。既に Obsidian で実証済みと主張しない。
- **可視化設計案（PROPOSAL・TODO）:** グラフ閲覧で見せる対象の案は、記憶同士の関連、原記録/出典への導線（`record_source_refs` 経由の要約→raw 下降）、訂正/統合履歴（`supersedes` 連鎖・統合の両源リンク）、`active/retired/superseded/archived` の違い、通常 `active` 閲覧と明示的履歴/引退閲覧（`record.search` の `active + retired`・一時非表示との分離を含む §7 の区別）の区別である。
- **制約（既存方針を継承）:** グラフの辺/類似度は事実の証明ではなく手掛かりであり（§3「リンクと連想は untrusted メタデータ」と整合）、表示のために無関係 filler リンクを作らない（D5・§7 の禁止を継承）。直接 Markdown 編集の無言取込みなし・正本書込み API 境界を維持する（D2・§3・§11 と整合し、`record.correct` 経由を迂回させない）。
- **未決定（UNRESOLVED・発明しない）:** Obsidian は候補であり固定依存にしない。ビュー/filter/renderer/layout・実測 bounds・試験条件は未決定であり、本節でモデル・数値・受入値を新設しない。
- **実装記録（2026-10-14・§14.5 の到達・本小節のみ更新）:** 上記の可視化設計案のうち remind 自身の将来機能に属する範囲を、単一 SQLite 正本不変の派生投影として実装した（`src/graph.ts`・`scripts/rebuild-graph.ts`・`npm run rebuild:graph`・`tests/graph-view.test.ts` 8 件）。`[[links]]`/backlinks・`record_source_refs` 経由の要約→raw 導線（識別子のみ・raw 本文は DB に残置）・`supersedes` 連鎖・統合元リンク・`active/retired/superseded/archived` の区別・既定 active＋明示的 retired/history 選択を、有界オフライン自己完結 HTML（`<vault>/graph.html`、inline SVG、決定論円配置、サーバ・CDN・Obsidian 依存なし）で表示する。表示に filler リンクを作らず、直接 Markdown 編集の取込みなし・`record.correct` 境界を維持する（D2・D5・D6・§3・§7・§11 を継承）。renderer 選択（inline SVG・依存なし・DOM 選択可・file:// 動作）と起動時 bounds（既定 300 ノード/800 辺/512KiB、`LIMIT+1` 読取り・超過は固定 `graph over bound` で prior view 保持・owned view のみ原子置換）は本実装の新規決定であり、§8 の既定値・M2/M3 の pin を変えない。実測（合成 DB: 既定 4 ノード/3 辺/8.2KB・全状態 6 ノード/4 辺/9.0KB、前後正本不変）と実 headless ブラウザでの描画・選択・filter・検索・無通信確認を `README.md` に記録した。残件は高度な layout・資源 bounds 最終値・Obsidian 固定化の是非のみであり、§12 U5（`archived` 明示的検索範囲未決定）・§14.1–§14.4・§14.6・§14.7 の境界は変えない。

### 14.6 常時知覚の展望（上位 Companion の POLICY＋PROPOSAL・実装 TODO・今回の許可付与なし）

- **明示導入方針（POLICY・将来実装時の設計拘束・TODO）:** 上位 Companion として画面/カメラ/音の継続入力を積極的に導入する。毎回手動取得依頼を必須にしない。ただし本追記は runtime 取得許可の付与ではなく、実装 TODO である。一般的賛意を実実行認可とみなさない（§14 冒頭の分類を継承）。
- **接続案（PROPOSAL・TODO）:** 継続知覚が必要に応じ会話/記憶/タスク検討に意味情報を届ける案とし、取得・選別ゲート・意味抽出・一時保持・長期記憶を分ける。全 frame/audio を毎ターン注入しない。有界/背景・会話と停止を優先する（AV-06・§7 有界見直し・§8 縮退の方向と整合）。remind 本体の capture 実装必須にはせず、上位コンパニオン知覚→remind の `source`/provenance 受入（`event.append`・`record.remember` の provenance/scope 経路）の接続展望とする。M1–M3 受入・§4 source 検証・scope 分離は変えない。
- **保存の区別（案）:** 常時取得 != 生データ永久保存。長期記憶に残すのは選別・意味抽出を経たものに留める案であり、raw 現物の扱い・保存範囲は未決定とする。
- **未決定（UNRESOLVED・数値/モデル発明なし）:** 取得デバイス・画面 window 除外・マイク/camera indicator・第三者情報・秘密・個別停止・全体 stop（再起動越えを含む）・ローカル処理・外部送信可否・保存と削除・帯域資源・起動契機は未決定であり、本節で数値・モデルを選定しない。秘密除外など未決定を削らない。
- **決定記録（2026-10-21・決定者 haruka）:** raw 現物は全文保持・取出し可能とし、外部記憶化（raw 取出し・span 付き sourceRefs・長文チャンク取込・エピソード単位と小型 LLM による span 錨付き階層索引）を実装した。raw 取出しは `event.get / event.range / record.sources`、長文は `npm run ingest` による `rawBodyMaxCp` 以下のチャンク `event.append`、エピソードは `maintain.episodes / episode.list / episode.windows` で、window 要約は code point span を `sourceRefs` に持ち、episode 級要約は増分時に `record.correct` で旧版を `superseded` にして履歴を残す。設定は `limits.rawBodyMaxCp / rawPageMaxCp / rangeLimitMax` と `episodes{utcOffsetMinutes, windowMaxCp, maxNewTokens, batchMax}`、`bodyMaxCp` は record 本文のみに適用する。証拠は `tests/raw-read.test.ts` (16 件)・`tests/episodes.test.ts` (12 件)・実 Qwen2.5-1.5B CPU の `npm run smoke:episodes` (smoke OK、合計 202.9s、doc episode model window 2 / verbatim 3、session `s-ep` model window 1 / verbatim 2、全 episode body extractive で `sentencesKept: 0`、model が書いた window 要約に raw に無い固有名詞なし)。会話・文書 raw の保持範囲は本決定で確定し、取得デバイス (画面/カメラ/音) の範囲は未決定のまま。以前の自由文 reduce は「Elena and her husband」という幻覚を受理したが、各文の引用 window raw span への anchor ガード + 文単位 YES/NO を行う cited reduce に置換し、全滅時は検証済み window 要約の extractive fallback とした。episode 級要約は道案内に留め、ground truth は raw span とする。既知の制約: 漢字複合語 anchor (raw `金曜` に対する `金曜日`) の偽陽性拒否は verbatim に落ちる、verbatim window は後から再要約しない、`record_source_refs` 移行は copy+swap で表を再構築する。

### 14.7 P40/P5000の初期配置案・検証方針（PROPOSAL/TODO）

- **位置づけ・根拠（必読・PROPOSAL/TODO）:** 本小節はユーザー承認（『いいよ』）に基づき、上位長期構想の将来配置案・実装 TODO として記録する。根拠はユーザーが報告したハード構成（P40 搭載・P5000 搭載）のみであり、ハード実測・検出済みと主張しない。現行 §1–§13・D/R/U・§8 数値・M2/M3 モデル pin（`docs/retention.md` の Qwen2.5-1.5B-Instruct 等を含む）・CPU runtime・受入基準・完了状態は**一切上書きしない**。具体モデル・runtime・concurrency・bounds は未決定であり、本小節で選定・pin しない。
- **初期配置案（PROPOSAL・TODO・実証主張なし）:** P40 を会話主系、P5000 を背景主系の候補とする。P40 側は会話応答の主推論を担い、内部検討役（deliberator・AV-02）は最初は同じ会話モデルの別呼び出しとし、専用別モデルを必須にしない。P5000 側は画面/カメラ/音の意味解析と小型 LLM による記憶育成（§7・`docs/retention.md` 方向）など背景処理を担う案とする。CPU 側は取得・軽量変化検出・SQLite・queue・監督復旧を担う案とする。製品仕様容量の追加記載はしない。
- **VRAM・分割の扱い（PROPOSAL・検証前・断定なし）:** VRAM は各 GPU 別に管理し、合算 40GB・一枚相当とはみなさない。モデル分割・GPU 間転送は候補であり、対応可否・負荷を検証してから判断する。性能・互換性を観測済みと主張しない。
- **取得と推論の分離（案・§14.6 と整合）:** 常時取得 != 毎 frame 重推論とする。必要時・変化に応じた有界解析に留める案とし、全 frame/audio の毎ターン注入・毎ターン全 corpus 見直しはしない（§7 有界見直し・§8 縮退の方向と整合）。
- **配置と分離の独立性（案）:** GPU 配置と repo/process 分離は独立した検討軸とする。別 process に分けても GPU/CPU/RAM/storage 競合は残るため、分離を競合解消とみなさない。
- **管理・優先の方向（将来実装時の設計拘束の案・POLICY 継承）:** GPU ごとに推論受付・優先度・モデル常駐・待ち時間・背景粒度・切替コストを管理する案とする。会話・停止を背景より優先し（AV-06 継承）、背景 budget を設け、自動の上限拡張は禁止する。
- **Pascal 世代の検証事項（UNRESOLVED・TODO・性能断言なし）:** 候補 runtime・量子化・音声/視覚モデルの対応可否は Pascal 世代での検証事項とし、動作・速度を断言しない。検証結果が出るまで配置は確定しない。
- **評価方針（TODO）:** 常時知覚＋背景育成を動かした状態で、会話応答性・latency・VRAM・資源競合・モデル切替負荷を実測し、配置を確定する。具体モデル・runtime・concurrency・bounds は未決定のまま残す。
- **未決定の保全（UNRESOLVED・既存方針不変）:** `pi-orch` 実装モデルをローカル GPU で賄うか外部利用かは未決定とし、権限・外部送信の既存方針（§11・§12 U1・§14.4 を含む）を変更しない。数十年分の全記憶を VRAM に載せる必要はなく、保存・検索と推論を分離する方針とする（D6・§3・§5 と整合）。
