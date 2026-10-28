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
- 内容・文脈の判定は外部送信なしの**ローカル小規模 LLM** が行う。プロセス内 ONNX のほか、ループバック限定の OpenAI 互換サーバー (llama.cpp `llama-server` / LiteLLM 等) を保守モデルにできる。
- 有界の関連記憶見直しは**追加・訂正・実際の引用**を契機とする背景処理とし、毎ターンの全 corpus 見直しはしない。会話応答を阻害しない。
- 「この会話中は出さない」等の一時的な非表示と、耐久的な引退は別物として扱う。
- 既存の終端 `archived` は可逆引退ではない。`superseded`（旧版履歴）・`archived` と可逆 `retired` を区別する。`archived` の明示的検索範囲は未決定であり黙って決めない。

## 活性化関数による引退（2026-10-22 決定・決定者 haruka）

- 引退は**経過時間だけでは決めない**。利用頻度・直近性（作成・検証済み feedback 利用・訂正・再活性化の時刻）に kind 重みとモデル採点の重要度を加えた ACT-R 風の多要素保持スコア `R` で決める。式・既定値は README「活性化による引退」を参照。
- 重要度はローカル LLM が 0..3 で採点し、`record_importance` に `importance = n/3`、`source='llm:v2:<model>'`、現在の `bodyHash` とともに保存する。本文が訂正され bodyHash が変わった採点は陳腐化として無視する。モデル無効・欠落時は採点をスキップし、中立 0.5 として扱う（嘘の 0 を入れない）。
- 引退は可逆である。`active <-> retired` の既存遷移経路（監査付き）を使う。判定は単一の多要素保持スコア `R`（基底活性 + kind + importance + nature + リンク + 期限切れ + 統合済み）で行い、`R < tauRetire` かつ nature 別の最小経過時間を満たすときに引退、`R >= tauReactivate` で再活性化する。式・既定値は README「活性化による引退」の表を参照。
- 引退理由は支配要因で `OUTDATED`（期限切れ日付）/ `CONSOLIDATED`（統合済み点のみが閾値を跨がせた）/ `LOW_ACTIVATION`（その他）を記録する。自動引退の全理由（旧 `LOW_SIGNAL` を含む）を再検討対象とし、`reconsiderLegacy` は廃止した。
- 利用者主導の引退 `NO_LONGER_USEFUL` は自動再活性化しない。直近の再活性化理由が `USER_REQUESTED` の行は自動引退しない。
- 重要度が `activation.protectImportance`（既定 0.66 ≒ 2/3）以上の記憶は、通常の `tauRetire` では引退せず `R < tauRetire - 1` の保護マージンを要求する。
- maintenance は 1 パス 2,000 件の有界スキャンを維持しつつ、scope 別の `(createdAt,id)` continuation cursor を永続化して次のパスで続きから評価し、末尾で先頭へ wrap する。これにより古い retired 行がスキャン窓を占め続けても、新しい active 行が永久に未評価にならない。`activation.preview` の `nextCursor` は採点時刻を固定して頁間の `R` を一致させる。importance/operations/audit の各 commit は `dbMaxBytes` 超過時に rollback して `STORE_UNAVAILABLE` を返す。
- `activation.apply` は**既定 false**。false の間は状態を変えず `wouldRetire / wouldReactivate` を報告するだけに留め、モデルと閾値の調整が済むまで自動適用しない。有効化は起動時 config の明示指定のみで行う。

## Learned retention weights（保持重みの学習）

- **学習データ**: `retention_examples`。露出は horizon (`labelHorizonMs`, 既定 6h) 経過後に、同一 `(recallId,recordId)` の usage 有無で正/負例 (weight 1)。明示遷移は `USER_REQUESTED` 再活性化を正例、`NO_LONGER_USEFUL` 引退を負例 (weight 5)。`audit:<rowid>` を露出 ID と同様の安定キーにし、再実行で再ラベルしない。
- **リーク規則**: 特徴量は例の `ts` 時点でスナップショットする。`base` は `ts` より前の事象のみを使い、ラベル対象の usage を混入させない。kind/nature/importance/links/expired/consolidated は現在状態の近似である。
- **モデルと事前分布**: `R_w(x)=base+Σ w_k·φ_k(x)` は既存因子構造と同一。`P(useful)=sigmoid(a·R_w+b)`。θ = {平坦化 w, a, b}。事前重みは現在の config/default で、目的関数は重み付き log-loss + `lambda·Σ(w−prior)²`。`a,b` は正則化せず `a≥0.05` に clamp。決定的 full-batch Adam (lr 0.05, 600 反復、初期値 prior/1/0)。
- **ガードレール**: 各 step 後に `wImportance,wLinks,wExpired,wConsolidated≥0`、`GREETING/CHATOPS/TRANSIENT/EMOTION≤0`、`|w−prior|≤maxDrift` へ射影する。
- **受理ゲート**: enabled、`learnIntervalMs` 経過、前回以降の新規例 ≥50、`n≥minExamples`、正例 ≥`minPositives` を満たすときだけ試行。skip 理由 (`disabled/interval/no-new-examples/min-examples/min-positives/deadline/error`) は応答に載せ、行は残さない。試行は時刻順 holdout 20% で比較し、baseline の `a,b` も train のみで fit する。holdout log-loss が `1e-4` 超改善した場合のみ採用し、全例で再 fit して `accepted=1` を保存。試行行は棄却でも損失付きで常に残す。
- **スコアリングとロールバック**: preview/maintain は最新 accepted 重みを使用 (無ければ config)。preview は `weightsVersion` (null=prior) と `weights`、maintain の `learn` は試行結果と損失を返す (`version` は試行行の版、skip 時は null)。`activation.learn.enabled=false` で採点は config 重みへ戻り、最新 accepted は無視される (行は保持)。
- **データ量の注意**: 既定 300 例 / 正例 30 / 新規 50 件ゲートのため、履歴が少ない間は試行されず prior のまま。holdout 改善のみを受理条件とする保守的設計であり、データ不足時の過学習を避ける。 合成 20,000 例で `fitRetentionWeights` を実測すると約 925 ms（Node 24、full-batch 600 反復、`dist` 実行）であり、1 回の保守パスの許容範囲に収まる。

## 保持するもの・保持しないもの（実装済み範囲）

- `raw_events` は不変の追記のみ。更新・削除はない。
- `records` は `active / superseded / archived / retired` の行をすべて保持する。`record.correct` は新 revision 追記 + 旧版 `superseded`、`record.archive` は検索除外フラグ、`record.retire / reactivate` は可逆の通常想起除外・復帰であり、いずれも物理削除ではない。
- 削除 (消去) API とエクスポート API はない。SQLite ファイルの削除や `VACUUM` を消去保証として主張しない。保持期間・削除可否の方針決定は将来課題とする。
- 台帳 (`operations / audit / exposures / usage / note_heat`) は運用に必要な範囲で保持する。`exposures` は上限 1000 件で古い行から刈り込む。刈り込み失敗は `record.recall` 全体を `STORE_UNAVAILABLE` で巻き戻し、上限超過の成功を作らない (新規露出+監査の原子性)。監査の失敗は操作全体を巻き戻す (監査なしの成功を作らない)。
- `note_heat.usedCount` は `record.feedback` の検証通過分のみ加算する累積値であり、mere recall・露出のみでは加算しない。

## 外部記憶化（2026-10-21 決定・実装済み）

- 決定 (2026-10-21・決定者 haruka): raw 現物は全文保持し、明示的に取り出せる。raw の取出しは `event.get` / `event.range` / `record.sources` による。
- record は raw へのポインタである。`sourceRefs` は同一 scope の raw event を指し、任意で code point の `{eventId, start, end}` span を持つ。record 本文は raw の複製ではない。
- 忘却は索引からの除去 (`retire` 等) であり、raw は削除しない。通常想起から外れた後も raw は保持され、明示的な raw 取出しで読める。物理削除・消去 API は依然ない。
- 長文は `npm run ingest` で `rawBodyMaxCp` 以下のチャンクとして raw に全文入る。チャンク境界は raw 長と NFKC 正規化後長の両方で上限以下になるよう選び、書込み前に全チャンクを検証する (上限超過は `LIMIT_EXCEEDED`、正規化後空は `BAD_REQUEST` で、DB を開かず 1 件も追記しない)。`event.get` は raw を頁で返し、`event.range` は範囲・session・doc で列挙する。
- エピソード要約は派生索引である。window 要約は raw span を `sourceRefs` に持ち、CJK 文書では日本語プロンプト + assistant prefill `要約：` で生成する。生成文は `要約：` 除去・整形の後、固有名詞や数字などの anchor token が window raw に存在するかの決定的ガードと、window raw に対する厳密 YES/NO 検証を通す。検証プロンプトは候補要約を常に全文含み、短縮するのは source 側だけである。候補全文と最小 source が予算に収まらない検証不能な候補は YES を問わず、window は verbatim に落とす (reduce の文は drop し、全滅時は extractive fallback)。内容拒否 (parse 失敗・anchor 不在・NO) の window は、その raw window 文を span 付き `summary` record として保存し `episode-window-verbatim` tag を付ける (record を書かないのではなく、episode を前進させる)。timeout・モデル失敗時は何も書かず再試行可能に止める。
- episode 級要約は cited reduce で作る。最大 5 window ずつ、各文に引用番号 `[1][3]` を要求し、各文を引用した window の raw span に対する anchor ガードと文単位の厳密 YES/NO に通す。全文が落ちた場合は検証済み window 要約を連結する extractive fallback とし、episode record は前進する (`sentencesKept: 0`)。以前の自由文 reduce は「Elena and her husband」という幻覚を受理したが、引用付き・raw 検証付き reduce に置換した。episode 級要約は道案内であり ground truth ではないため、事実確認は `episode.windows` → `record.sources` → `event.get` の raw span で行う。
- 完了は raw event 単位で `episode_event_done` に記録する (最後の window canonical record + ledger と同一 transaction、window の無い再実行・修復時は fenced な done 行のみ)。`episode.list` の `stale` は timestamp 比較ではなく、done 行の無い pending raw event または `foldedRecordIds` に含まれない active window の有無で決まり、観測順・createdAt の同値で失敗 event を取りこぼさない。`coveredThrough` は done event の `MAX(observedAt)` を返す互換 report で、選択・staleness には使わない。
- すべての canonical / ledger 書込みは run owner の lease fence を同じ transaction 内で再確認する。推論中に lease を失った場合は `CONFLICT` で全体を rollback し、部分書込みを残さない。
- privacy は `maintain.distill` と同じ規則で伝播する。window は raw event の sensitivity を `origin: self_activity` で継承し、episode は引用 window から `sensitive` 優先・全 known なら `normal`・unknown を含めば `null` とする。`requirePrivacy` 時に raw event の privacy が unknown なら、その event は書かず pending のまま残す。
- 増分更新では新規 window だけを書き、episode 級要約は `record.correct` で旧版を `superseded` にして履歴を保持する (競合時は新 summary + 旧版 `archived (OBSOLETE)`、削除なし)。
- 実測 (実 Qwen2.5-1.5B CPU、`npm run smoke:episodes`): smoke OK、合計 161.5s。doc episode は model window 2 / verbatim 3、session `s-ep` は model window 1 / verbatim 2。両 episode body は extractive fallback (`sentencesKept: 0`) で、model が書いた window 要約に raw に無い固有名詞は無かった。
- 既知の制約: 漢字複合語の anchor (raw `金曜` に対する `金曜日` など) は偽陽性拒否となり verbatim に落ちる。verbatim window は後から再要約しない。`record_source_refs` の移行は copy+swap で表を再構築する (初回 open 時に本番 DB のバックアップを取る)。raw 取出し・chunk・span の追加は `raw_events` の ALTER のみで行う。

## 可逆引退・蒸留・統合（M3 で実装済み）

- 状態・スキーマ表現は `records.status` の第 4 値 `retired` に確定した（既存行を保持する savepoint 再構築で移行し、`user_version` は単一の直列化された `BEGIN IMMEDIATE` 移行の完了時に `SCHEMA_VERSION` の `12` へ更新される。既に `12` のファイルは書込みロックを取らない fast path で起動する）。
- `record.retire / record.reactivate` は `active <-> retired` の可逆遷移（冪等・固定理由コード・メタデータのみ監査）。`superseded / archived` は動かさない。通常想起・一覧（既定）・raw 下降・グラフ・ベクトルは active のみ。
- 利用者指示の明示的検索は `record.search`（active + retired、`archived / superseded` 除外、各 item は `revision` を含む、heat・再活性化・feedback 露出なし）。一度の取出しは再活性化しない。
 - 内容・文脈の判定は外部送信なしのローカル小規模 LLM が行う。既定 (`llm.backend: "onnx"`) は `onnx-community/Qwen2.5-1.5B-Instruct` @ `d54957e3`（基盤 `Qwen/Qwen2.5-1.5B-Instruct`、license `apache-2.0`、`@huggingface/transformers@4.3.1 + onnxruntime-node@1.30.0`、量子化 ONNX `onnx/model_q4.onnx` をオフライン生成、greedy 決定論）で、取得は `npm run provision:llm` のみ。`llm.backend: "openai"` では同じ ChatML プロンプトをループバック (`127.0.0.1` / `::1` / `localhost`) の OpenAI 互換 `/v1/chat/completions` に送る。`llm.baseUrl` は loopback 以外を起動時に拒否し、外部送信は行わない。`llm.model` は必須、`llm.apiKeyEnv` は鍵を持つ環境変数名のみ、`llm.disableThinking` (既定 true) は `enable_thinking: false` と `<think>…</think>` 除去を行う。
- 保持分類器だけをメインモデルで動かす場合は `activation.llm` (`{backend:"openai", baseUrl, model, timeoutMs?, apiKeyEnv?}`) を指定する。分類器はこの endpoint/model を使い、`distill / consolidate / associate` はグローバル `llm` (9B) を使い続ける。分類器リクエストは常に `enable_thinking:false`。`record_importance.source` は `llm:v2:<model>` 形式になり、モデル変更時は既存行 (旧 `llm:v2` を含む) が陳腐化して再採点される。
  - `maintain.distill` は有界バッチ・単一 flight（SQLite リース、crash/retry/cancel 対応）・失敗隔離・リトライキュー・取消可能で、summary/correction を通常の冪等 op で直接・自律的に書く。判定は二段階（(1) 保持ゲート：`llm.backend: "openai"` のみ実行する単一ラベル分類。KEEP-type = `FACT / PREFERENCE / OPINION / PLAN / EVENT / RELATIONSHIP / PROJECT`、DROP-type = `GREETING / TRANSIENT / CHATOPS`。ラベル完全一致のみ採用し、前後空白と末尾句読点を除去して大文字小文字を無視する。不一致・`NONE`・空は uncertain で keep。ONNX backend は gate を実行しない（実 DB 監査で Qwen2.5-1.5B が 108/158 件を誤って `LOW_SIGNAL` 引退し、中央値 作成後約 5 分だったため。Ornith では同じ 108 件中 87 件が耐久 FACT/PREFERENCE/PLAN だった）。DROP 候補でも (a) `record_links` が inbound/outbound に存在する、または (b) `note_heat.usedCount > 0` なら keep。理由コードは `LOW_SIGNAL` のまま。(2) 位置指定の統合選択：関連記憶を番号 `1..N` で提示し `MERGE <n> / KEEP` で回答、コードが実際の同一 scope 有界入力に写像しモデルは ID を複写しない。(3) 共有事実の確認：統合提案は両記憶の共有事実の抽出か `NONE` で検証し、`NONE`・不確実は keep、共有事実のみ要約草案へ。同一バッチで両者が互いに指名し合う場合のみ統合し、片思いの指名は keep とする。相互指名の同一無順序ペアは同一バッチで 1 回のみ統合する（最小 recordId 代表が単一の実生成要約を書き、対は監査付き keep、重複サマリなし、全キューは done 解決、原物・union refs/links 保持）。抽出文自体は保存・再利用しない）。推論は正準トランザクション外、モデル文脈は同一 scope 最大 6 件の断片に有界。統合は最低 2 件の関連表示を要求し、確認なしの統合・ID 複写・単一トークン判定はしない。会話書き込み側にインライン推論はなく、常駐スケジューラ・全 corpus 見直し・TTL 削除はない。
- `maintain.consolidate` の統合は話題クラスタ単位・文ごとに出典検証・作り話は書かない（`record_topics` の話題ごとに `consolidate.minMembers` 件以上の active メンバーを cited reduce し、各文を引用メンバー本文への anchor ガードと厳密 YES/NO に通す。1 文も残らなければ extractive fallback を書かず、モデルの一時失敗は defer する）。fingerprint が変わらないクラスタはモデルを呼ばず、同一 topic の旧 summary は `record.correct` で `superseded` にする。訂正済みの summary は supersedes 連鎖を辿って現行 revision を訂正する。書込みトランザクション内でメンバーの active 状態と revision/bodyHash を再検証し、変化していれば defer する。`no_grounded_sentences` / `deferred` の話題は scope ごとの回転 cursor で後回しにし、小さい limit でも後続話題が飢餓しない。

- キュー投入の契機は `remember / correct / 検証済み feedback` の確定後のみ（露出検証前の mere recall は投入しない）。起動時 bounds は `cultivation{queueMax=500, batchMax=20, leaseTtlMs=120000, reviewMaxAttempts=5}`、`llm{backend="onnx", timeoutMs=60000, maxNewTokens=48, maxPromptChars=2000, baseUrl?, model?, apiKeyEnv?, disableThinking=true}`、`maintenance{timeoutMs=120000}`（いずれも任意・既定あり）。

- 自動忘却は行削除ではなく、通常の `record.recall` の対象外とする状態変更（`retired` 想定）に留める。行・原記録は保持する。
- 利用者指示の明示的検索は `record.search`（active + retired、`archived / superseded` 除外、heat・再活性化・feedback 露出なし）に確定した（M3 state の U5 実装選択：`retired` を第 4 `status` 値とし savepoint 再構築で移行、キューは 1 record 1 open review・満杯時 drop、単一 global リース・TTL steal/heartbeat、適用は per-action 保守 no-change、統合の links は同一 scope 解決必須）。一度の取出しは再活性化しない。レビュー指摘の回帰 9 件も確定済み：steal 時の孤立 `leased`→`pending` 回収、縮退 drain の dequeue 前判定（`leased` 残留なし）、実行ごと一意の lease 所有者（同一キー並行 drain の単一 flight 保持）、`(nextAt, queueId)` 複合 cursor（旧 bare 形式は同 keyset に解決）、推論合間の heartbeat 更新＋`maintenance.timeoutMs` 打切り（fence 付き abort）、適用 txn 内の lease 存続＋行 `leased` 存続の二重 fence（取消後・奪取後は `CONFLICT` 無変更）、open-per-record 重複投入の `duplicate` 報告、索引喪失時の正準 `bodyNorm` fallback（`record.search`）、プロンプトの構造尾部保持（`maxPromptChars` 500..8000）。drain 内の lease/dequeue/fence は単一時刻（`nowOverride` 指定時は固定時刻、通常は壁時計）を共有する。
- `superseded` 旧版と実験の元観察は履歴として保持し、通常は最新訂正を利用する。
- 状態・スキーマ表現は `records.status` の第 4 値 `retired` に確定済みであり、現行の `active / superseded / archived` を可逆引退とみなさない。

## safeguard（実装済み・検証付き）

- 不確実・無効・失敗・欠落・タイムアウトのモデル出力は状態・本文を変更しない（不確実な判定は監査付き keep、推論失敗は有界リトライへ、陳腐化した適用は per-action no-change）。
- コードは削除を強制的に禁じる（物理削除なし。`applyCultivationBatch` の統合は summary 行の INSERT のみで元記録を自動引退させない）。外的送信は provision 以外の全経路で禁止し、想起・再構築・蒸留の実行時は `allowRemoteModels=false` の完全オフライン。
  - モデル欠落・無効時は縮退 OK（適用 0・キュー不変・偽の判定なし）。検証は `tests/m3-state.test.ts` (23 件：回帰 9 件含む) と実モデル `npm run smoke:m3` (適用 2：引退 1＋統合 1、サマリ 1) で行う。実モデル drain は保持ゲートの DROP ラベル（`TRANSIENT` 等）による一過性気分の実際の引退（OpenAI backend）と、位置指定＋共有事実確認を経た近似重複の実際の統合（要約行 1 件のみの適用、重複サマリなし）を出力し、耐久事実・不確実記録は保全する。統合・失敗隔離・リトライ・ペア重複排除の機構証明は決定論的テストの範囲と区別する。

## 未解決技術詳細（残件のみ）

- 高度なスケジューリング（起動条件・バッチ幅・熱重みの調整）は任意・将来課題。評価閾値・資源 bounds の最終値（§8 既定値は暫定、実測で見直し）も残件。モデル・ランタイム・見直し入力・明示的検索 API・状態表現・safeguard 実装は M3 で確定済み（上記）。

## 容量上限

- `dbMaxBytes` 超過見込みの書き込みは `STORE_UNAVAILABLE` で巻き戻す。無言の削除・上書き・切詰めはしない。
- 超過中も読み取り (`record.get / list / recall`) は継続する。書込みの成否判定後に監査・露出の書込みを行う。
- 回復は書き手停止・退避後に上限引上げまたは保持方針の解決で行う。自動削除はない。

## 投影・索引の再構築性

- 正本は単一 SQLite のみ。`vaultPath` への Markdown 投影 (`<id>.md`、`[[ref]]`、backlink 節) は派生であり、消失・陳腐化時は正本から再構築できる。再構築で正本内容は変わらない。
- FTS5・char-bigram 転置索引・backlink ビューも派生物であり、欠落・再構築は正本に影響しない。投影キューは失敗行を保持し、有界リトライで再試行する。成功時のみ取り除く。
- 連想の派生層 (`record_topics` / `similar_edges` / `associate_state` / `vec_notes`) も再構築可能な派生物である。`maintain.associate` または `topic.set` で作り直せ、欠落・陳腐化しても正本の記録・`record_links` は変わらない。canonical link は呼出者が書く `record_links` のままであり、派生層は追加・削除しない。

## 監査はメタデータのみ

- `audit / exposures / usage` とエラー応答に記憶本文・クエリ原文・断片を含まない。時刻・操作・対象 ID・固定コード・scope・バイト数・件数・`runId`・`recallId`・`reasonCode` のみ。
- `message` は固定文言のみ。入力の反響はない。
