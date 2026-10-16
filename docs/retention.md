# 保持・育成方針 (cultivation)

本書は合意済み育成方針の保持面の正本補足である。正本計画は `plan.md`（§2・§5–§7・§9–§10・§12）とする。本書の将来計画部は実装の主張ではない。

## 合意済み方針（決定）

- 育成とは強化だけではなく、**有用な記憶の保持・統合（consolidation）と不要な記憶の可逆的な引退（retirement）**である。
- **保持バイアスの自律 AI**が判断する。通常の書き込み・想起・保守に人間の承認・分類を要求しない。
- 事実・出来事・実験条件と観察は一過性の感情より長く保持する。「落ち込んでいる」等の感情は通常想起から薄れさせ、恒常的な人格特性にしない。
- **固定 TTL・経過時間のみの忘却則は持たない。**
- 原記録（`raw_events`・旧 record）は保持する。自動忘却は**通常想起からの可逆引退**に留める。利用者指示の明示的検索では引退済みを取り戻せる。
- 一度の明示的取出しは自動で再活性化しない。持続的必要がある場合に AI が再活性化を促せる。
- 最新訂正を通常利用し、旧版と実験の元観察は履歴として残す。
- 内容・文脈の判定は外部送信なしの**ローカル小規模 LLM** が行う。
- 有界の関連記憶見直しは**追加・訂正・実際の引用**を契機とする背景処理とし、毎ターンの全 corpus 見直しはしない。会話応答を阻害しない。
- 「この会話中は出さない」等の一時的な非表示と、耐久的な引退は別物として扱う。
- 既存の終端 `archived` は可逆引退ではない。`superseded`（旧版履歴）・`archived` と可逆 `retired` を区別する。`archived` の明示的検索範囲は未決定であり黙って決めない。

## 保持するもの・保持しないもの（実装済み範囲）

- `raw_events` は不変の追記のみ。更新・削除はない。
- `records` は `active / superseded / archived / retired` の行をすべて保持する。`record.correct` は新 revision 追記 + 旧版 `superseded`、`record.archive` は検索除外フラグ、`record.retire / reactivate` は可逆の通常想起除外・復帰であり、いずれも物理削除ではない。
- 削除 (消去) API とエクスポート API はない。SQLite ファイルの削除や `VACUUM` を消去保証として主張しない。保持期間・削除可否の方針決定は将来課題とする。
- 台帳 (`operations / audit / exposures / usage / note_heat`) は運用に必要な範囲で保持する。`exposures` は上限 1000 件で古い行から刈り込む。刈り込み失敗は `record.recall` 全体を `STORE_UNAVAILABLE` で巻き戻し、上限超過の成功を作らない (新規露出+監査の原子性)。監査の失敗は操作全体を巻き戻す (監査なしの成功を作らない)。
- `note_heat.usedCount` は `record.feedback` の検証通過分のみ加算する累積値であり、mere recall・露出のみでは加算しない。

## 可逆引退・蒸留・統合（M3 で実装済み）

- 状態・スキーマ表現は `records.status` の第 4 値 `retired` に確定した（既存行を保持する savepoint 再構築で移行し、`user_version` は不変のまま `2`）。
- `record.retire / record.reactivate` は `active <-> retired` の可逆遷移（冪等・固定理由コード・メタデータのみ監査）。`superseded / archived` は動かさない。通常想起・一覧（既定）・raw 下降・グラフ・ベクトルは active のみ。
- 利用者指示の明示的検索は `record.search`（active + retired、`archived / superseded` 除外、heat・再活性化・feedback 露出なし）。一度の取出しは再活性化しない。
 - 内容・文脈の判定は外部送信なしのローカル小規模 LLM（`onnx-community/Qwen2.5-1.5B-Instruct` @ `d54957e3`、基盤 `Qwen/Qwen2.5-1.5B-Instruct`、license `apache-2.0`、`@huggingface/transformers@4.3.1 + onnxruntime-node@1.30.0`、量子化 ONNX `onnx/model_q4.onnx` をオフライン生成、greedy 決定論）が行う。取得は `npm run provision:llm` のみ、実行時は完全オフライン。
  - `maintain.distill` は有界バッチ・単一 flight（SQLite リース、crash/retry/cancel 対応）・失敗隔離・リトライキュー・取消可能で、summary/correction を通常の冪等 op で直接・自律的に書く。判定は二段階（(1) 保持ゲート：永続内容の抽出か `NONE`、厳密 `NONE` のみ引退候補・その他は継続・不確実は keep。(2) 位置指定の統合選択：関連記憶を番号 `1..N` で提示し `MERGE <n> / KEEP` で回答、コードが実際の同一 scope 有界入力に写像しモデルは ID を複写しない。(3) 共有事実の確認：統合提案は両記憶の共有事実の抽出か `NONE` で検証し、`NONE`・不確実は keep、共有事実のみ要約草案へ。同一バッチで両者が互いに指名し合う場合のみ統合し、片思いの指名は keep とする。相互指名の同一無順序ペアは同一バッチで 1 回のみ統合する（最小 recordId 代表が単一の実生成要約を書き、対は監査付き keep、重複サマリなし、全キューは done 解決、原物・union refs/links 保持）。抽出文自体は保存・再利用しない）。推論は正準トランザクション外、モデル文脈は同一 scope 最大 6 件の断片に有界。統合は最低 2 件の関連表示を要求し、確認なしの統合・ID 複写・単一トークン判定はしない。会話書き込み側にインライン推論はなく、常駐スケジューラ・全 corpus 見直し・TTL 削除はない。
- キュー投入の契機は `remember / correct / 検証済み feedback` の確定後のみ（露出検証前の mere recall は投入しない）。起動時 bounds は `cultivation{queueMax=500, batchMax=20, leaseTtlMs=120000, reviewMaxAttempts=5}`、`llm{timeoutMs=60000, maxNewTokens=48, maxPromptChars=2000}`、`maintenance{timeoutMs=120000}`（いずれも任意・既定あり）。

- 自動忘却は行削除ではなく、通常の `record.recall` の対象外とする状態変更（`retired` 想定）に留める。行・原記録は保持する。
- 利用者指示の明示的検索は `record.search`（active + retired、`archived / superseded` 除外、heat・再活性化・feedback 露出なし）に確定した（M3 state の U5 実装選択：`retired` を第 4 `status` 値とし savepoint 再構築で移行、キューは 1 record 1 open review・満杯時 drop、単一 global リース・TTL steal/heartbeat、適用は per-action 保守 no-change、統合の links は同一 scope 解決必須）。一度の取出しは再活性化しない。レビュー指摘の回帰 9 件も確定済み：steal 時の孤立 `leased`→`pending` 回収、縮退 drain の dequeue 前判定（`leased` 残留なし）、実行ごと一意の lease 所有者（同一キー並行 drain の単一 flight 保持）、`(nextAt, queueId)` 複合 cursor（旧 bare 形式は同 keyset に解決）、推論合間の heartbeat 更新＋`maintenance.timeoutMs` 打切り（fence 付き abort）、適用 txn 内の lease 存続＋行 `leased` 存続の二重 fence（取消後・奪取後は `CONFLICT` 無変更）、open-per-record 重複投入の `duplicate` 報告、索引喪失時の正準 `bodyNorm` fallback（`record.search`）、プロンプトの構造尾部保持（`maxPromptChars` 500..8000）。drain 内の lease/dequeue/fence は単一時刻（`nowOverride` 指定時は固定時刻、通常は壁時計）を共有する。
- `superseded` 旧版と実験の元観察は履歴として保持し、通常は最新訂正を利用する。
- 状態・スキーマ表現は `records.status` の第 4 値 `retired` に確定済みであり、現行の `active / superseded / archived` を可逆引退とみなさない。

## safeguard（実装済み・検証付き）

- 不確実・無効・失敗・欠落・タイムアウトのモデル出力は状態・本文を変更しない（不確実な判定は監査付き keep、推論失敗は有界リトライへ、陳腐化した適用は per-action no-change）。
- コードは削除を強制的に禁じる（物理削除なし。`applyCultivationBatch` の統合は summary 行の INSERT のみで元記録を自動引退させない）。外的送信は provision 以外の全経路で禁止し、想起・再構築・蒸留の実行時は `allowRemoteModels=false` の完全オフライン。
  - モデル欠落・無効時は縮退 OK（適用 0・キュー不変・偽の判定なし）。検証は `tests/m3-state.test.ts` (23 件：回帰 9 件含む) と実モデル `npm run smoke:m3` (適用 2：引退 1＋統合 1、サマリ 1) で行う。実モデル drain は保持ゲートの `NONE` による一過性気分の実際の引退と、位置指定＋共有事実確認を経た近似重複の実際の統合（要約行 1 件のみの適用、重複サマリなし）を出力し、耐久事実・不確実記録は保全する。統合・失敗隔離・リトライ・ペア重複排除の機構証明は決定論的テストの範囲と区別する。

## 未解決技術詳細（残件のみ）

- 高度なスケジューリング（起動条件・バッチ幅・熱重みの調整）は任意・将来課題。評価閾値・資源 bounds の最終値（§8 既定値は暫定、実測で見直し）も残件。モデル・ランタイム・見直し入力・明示的検索 API・状態表現・safeguard 実装は M3 で確定済み（上記）。

## 容量上限

- `dbMaxBytes` 超過見込みの書き込みは `STORE_UNAVAILABLE` で巻き戻す。無言の削除・上書き・切詰めはしない。
- 超過中も読み取り (`record.get / list / recall`) は継続する。書込みの成否判定後に監査・露出の書込みを行う。
- 回復は書き手停止・退避後に上限引上げまたは保持方針の解決で行う。自動削除はない。

## 投影・索引の再構築性

- 正本は単一 SQLite のみ。`vaultPath` への Markdown 投影 (`<id>.md`、`[[ref]]`、backlink 節) は派生であり、消失・陳腐化時は正本から再構築できる。再構築で正本内容は変わらない。
- FTS5・char-bigram 転置索引・backlink ビューも派生物であり、欠落・再構築は正本に影響しない。投影キューは失敗行を保持し、有界リトライで再試行する。成功時のみ取り除く。

## 監査はメタデータのみ

- `audit / exposures / usage` とエラー応答に記憶本文・クエリ原文・断片を含まない。時刻・操作・対象 ID・固定コード・scope・バイト数・件数・`runId`・`recallId`・`reasonCode` のみ。
- `message` は固定文言のみ。入力の反響はない。
