# 記憶判断の評価スイート — 論文の適用レポート

対象: remind の U4 評価スイート（`feat/memory-decision-eval`、未デプロイ）
関連: `plan.md` §12 U4、`README.md`「記憶判断の合成評価」、`docs/retention.md`

## 0. 結論

- 4 本の記憶論文と 1 本の継続学習論文を読み、**production の学習アルゴリズムとして採用したものはない**。
- 採用したのは **評価プロトコル・統制ゲート・オフライン fit の受理条件**。remind は重みに記憶を内在化せず、raw 不変の外部記憶で忘却を扱うため、weight-level の継続 SFT / LoRA / replay は设计と衝突する。
- 実装したのは以下。既定はモデルを呼ばない。
  - MemProbe 型の安定性–可塑性診断
  - CMP 型の検索支持診断
  - VitaBench 型の反事実ライフサイクル（KEEP / RETIRE / CORRECT）
  - Epistemics 型の governance（G1–G4、leak 検査）
  - 評価ラベルからのオフライン fit（自動適用なし）
- 検証: `npm test` **464 件成功**（master の #41/#42 を含む）。実モデル smoke は exit 0（`maintain.consolidate` は opt-in）。
- 本レポートの実装は**本番未デプロイ**。production の保持重み学習はまだ 1 度も受理されていない（後述）。

## 1. 論文と採否

| 論文 | 中身 | 採用した部分 | 採用しなかった部分 |
|---|---|---|---|
| **2609.06986** Zhang et al., *Continual Learning Mechanisms Compose for Long-Horizon Memorization* | 100 タスクの継続 SFT。data/function/weight anchor + merged LoRA。最終保持 34.9%（naive 1.2%）。汎化・汎用能力は未解決 | 長期保持の**評価軸**（時間軸の精度行列、final retention、forgetting、half-life）を U4 の提案として記録 | 継続 SFT / LoRA / replay 生成 / Fisher・SI / per-task adapter / モデル再配布 |
| **2610.14731** Yu & Hu, *VitaBench* | KEEP / COMPRESS / CONSOLIDATE / DELETE を同一状態から分岐し、未来列を再生して遅延効用を測る。headroom、horizon reversal、action diversity | **KEEP / RETIRE / CORRECT の反事実分岐**、headroom、horizon reversal、oracle diversity、storage penalty | COMPRESS（remind に存在しない）、VitaMem 型の学習 policy、lifecycle 内の CONSOLIDATE 分岐 |
| **2609.30558** Ding & Wu, *MemProbe* | 干渉・誤情報・統合強度・再固定化の 4 パラダイム。stability/plasticity/SP-balance、履歴・出典・時系列 fidelity | **4 パラダイムの決定的 probe**、stability/plasticity/SP-balance、historical/source/temporal fidelity | LLM 読み手の自由回答採点、56 エピソードの固定スイート |
| **2610.02070** Behnam & Wang, *Causal Memory Policy* | 検索されない記憶は効果が同定できない（retrieval-level positivity violation）。探索スロット＋SNIPS。per-query utility は unseen query の保持判断に集約できない | **支持失敗率と zero-exposure rate の診断**。評価器内だけの探索スロットは将来候補 | 本番 `record.recall` へのランダム露出、per-query utility からの保持 policy 作成 |
| **2609.33013** Annapureddy & Thamatani, *Epistemics of Agent Memory* | 統合判断の品質・統制。3 つの leak ゲート、G1–G4、prevalence、CQS は外部 transfer を予測しない | **provenance/probe の leak 検査、G2–G4、prevalence/fit ゲート、no-op adversary** | CQS の目標化、skill/rule の cross-level transfer、governance-by-inaction を許す設計 |

## 2. 論文ごとの適用

### 2.1 2609.06986 — 手法は不採用、評価軸だけ提案

- **判断**: 継続 SFT は remind の「raw 不変・外部記憶・pinned local model・学習パイプラインなし」と両立しない。論文自身も memorization≠generalization、汎用能力の劣化、最終保持 34.9% を報告している。
- **適用**: 時間軸の精度行列 `M_i,j`、final retention、forgetting、age 別 recall、memory half-life を **U4 の PROPOSAL** として `plan.md` に記録。
- **未実装**: この長期保持 evaluator 自体はまだ実装していない。今回の実装は 4 本の記憶論文に基づく。混同しないよう、`plan.md` の実装記録にも「未実装」と明記した。

### 2.2 VitaBench — lifecycle の反事実評価

- **実装**: `scripts/evaluate-memory-decisions.ts` の `lifecycleSuite`。
  - 同一チェックポイントから `KEEP` / `RETIRE`（可逆）/ `CORRECT` に分岐。
  - DB を分岐ごとにコピーし、同じ未来列（future writes + probes）を再生。
  - 指標: headroom（適応 vs 最良固定）、horizon reversal、oracle action 多様性、storage penalty。
- **実測**（実モデル smoke）: headroom 0.088（H=2）/ 0.0625（H=4）、horizon reversal 0.25、full-horizon の oracle は keep 3 / correct 1。
- **不採用**: COMPRESS（remind に op がない）、VitaMem の学習 policy、CONSOLIDATE を lifecycle の action にすること。CONSOLIDATE は別の構造検査（opt-in）に分離。
- **制約**: per-thread 分岐で他スレッドを KEEP に固定。スレッド間干渉の同時決定は測っていない。

### 2.3 MemProbe — 安定性–可塑性の診断

- **実装**: `interferenceScenario` / `misinformationScenario` / `consolidationStrengthScenario` / `reconsolidationScenario`。
  - 干渉: A-B → A-C。`superseded` を通常想起から除外し、旧版は `record.get` で読める。
  - 誤情報: `user_fact` と `model_inference` の共存。モデル推論が事実を自動上書きしない。
  - 統合強度: 反復 feedback の heat と、単発記録の差。
  - 再固定化: recall / search が自動更新感度を変えない。明示 `correct` だけが更新する。
  - 指標: stability、plasticity、SP-balance、historical/source/temporal fidelity。
- **実測**: stability 1.0、plasticity 1.0、current 1.0。**source fidelity 0.833**。
  - 残る失敗は harness ではなく実挙動: 同一クエリで新しい `model_inference` が古い `user_fact` を上回る（recall に kind/source 重みがなく、同点は `createdAt DESC`）。これは評価器が表面化した finding で、テストの invariant にはしていない。
- **不採用**: LLM 読み手の自由回答採点。既存 evaluator と同じ決定的な構造化照合にした。

### 2.4 CMP — 検索支持の診断

- **実装**: `supportSuite`。
  - 30 記録・10 必須クエリ。必須記憶が recall で返らない割合（支持失敗）と、active 記録のうち一度も露出されない割合（zero-exposure rate）を測る。
- **実測**: 支持失敗 **0**、zero-exposure **0.6**（30 件中 12 件だけ露出）。
- **不採用**:
  - 本番 `record.recall` へのランダム露出。応答劣化・プライバシー・無関係提示のコスト。
  - per-query utility から保持 policy を作ること。論文自身が「集約は unseen query の保持判断を予測しない」と報告している。
- **適用の意味**: 保持重み学習のラベルが「露出済み」に偏る問題を、数値で監視できるようにした。

### 2.5 Epistemics — governance と fit の受理条件

- **実装**: `scripts/decision-governance.ts` の `runGovernanceSuite`。
  - G1 poison-resistance: model-free では **`skipped:true`**。自動 durable write 経路がないことの構造確認だけ。
  - G2 reversibility: retire→recall 除外→search 取得→reactivate 復帰。summary の retire/correct 後も原記録が active。
  - G3 auditability: reasonCode・対象 ID をメタデータ監査で辿れる。本文列がないことも検査。
  - G4 quality gate: no-op adversary が retire/reactivate/correct をしても state が変わらなければ拒否。
  - leak: provenance（query に ID/label が入らない）、probe（単一特徴の accuracy − majority < 0.2）、count-matched は **`n/a`**（決定的スイートでサンプリング制御がない）。
- **fit への適用**: `scripts/decision-policy-fit.ts`。
  - MAP fit、whole-stream holdout（2 ストリーム以上）、n>=30、prevalence 2 水準以上、holdout で best fixed action を上回ること、`autoApply:false`。
  - 現行 evaluator のラベルは 4 状態・1 ストリームなので **`skipped: n=4 < 30`**。診断用であり、このデータからは学習しない。
- **不採用**: CQS を目標指標にすること（著者自身が外部 transfer を予測しないと報告）。skill/rule の cross-level transfer は remind の scope 外。

## 3. 実装マップ

| ファイル | 役割 |
|---|---|
| `scripts/evaluate-memory-decisions.ts` | MemProbe / support / lifecycle / governance の 4 スイート。`--labels`、`--llm-config`、`--out` |
| `scripts/decision-governance.ts` | G1–G4、provenance/probe leak、no-op adversary |
| `scripts/decision-policy-fit.ts` | オフライン MAP fit と受理ゲート |
| `tests/memory-decision-eval.test.ts` | evaluator の exit 0、4 パラダイム、支持率、headroom/reversal、governance、labels、fit 拒否 |
| `tests/decision-governance.test.ts` | gate の pass/fail と no-op adversary |
| `tests/decision-policy-fit.test.ts` | 分離可能データの受理、ノイズ拒否、n<30、単一ストリーム、prevalence 未検証、不正入力 |
| `docs/retention.md` / `plan.md` | 論文の採否、既存制約との境界、実装記録 |

## 4. 実測と検証

- `npm test`: **464 件成功**（129 suites。master の #41/#42 を含む）。
- 実モデル smoke（`--llm-config ~/.config/remind/memory.config.json`）: exit 0。
  - `maintain.consolidate`: applied 1、sentencesKept 1、sources 3、linkCoverage 1.0、2 回目 unchanged。
  - governance: 全 gate pass（G1 skipped、count-matched n/a）。
  - support: 支持失敗 0、zero-exposure 0.6。
  - lifecycle: headroom 0.088 / 0.0625、reversal 0.25、oracle keep 3 / correct 1。
  - latency: 391 CLI calls、p50 85.8ms、total 35.2s。
- fit: 90 行の合成 fixture は受理、ノイズは拒否、evaluator の 4 行は `skipped: n=4 < 30`。

## 5. 既存ドキュメントとの整合（重要な修正）

- **R13 は M2 評価方針**。seeded-only は M2 ベンチマークの制約であり、保持重み learner の実ログ holdout には適用しない。
- **D7 は常駐ループを要求しない＋無制限ループ禁止**。有界なオンライン学習は禁止していない。今回のオフライン限定は CMP の同定不能と本番露出コストによる**提案上の選択**であり、D7 由来ではない。
- **R2**: 既存の保持重み learner は受理後に自動適用する。合成の反事実で学習する別 policy は自動適用しない（`autoApply:false`）。
- **本番 recall の探索露出は行わない**。CMP の測定は評価器内に限定。
- **cross-batch 重複 summary の防止**は論文由来ではなく、production 観察から追加した修正（`src/distill.ts`）。統合草案が既存 active と同じ bodyHash なら keep。same-batch の重複も `plannedSummaryHashes` で防ぐ。

## 6. 残件・限界

- 2609.06986 の長期保持 evaluator（`M_i,j`、final retention、forgetting、half-life）は **未実装**。U4 の PROPOSAL に残る。
- lifecycle は per-thread 分岐で他スレッドを KEEP に固定。CONSOLIDATE は opt-in の別構造検査で、lifecycle の効用には含めない。
- G1 は governance では常に skipped。モデル leg は G1 の代替ではない。
- 評価ラベルは現行 generator では `hasConflict=false` 固定、heat/exposures=0、4 状態・1 ストリーム。fit は診断用で、このデータから学習しない。
- 実装は **本番未デプロイ**。production の保持重み learner は examples 701 / positives 29 で `minPositives:30` に届かず、`retention_weights` は空。最初の fit はまだ走っていない。
- companion の learning proposals は 18 件すべて pending、applications 0。提案は作られるが適用されていない。

## 7. 再現

```bash
npm test
node dist/scripts/evaluate-memory-decisions.js --out /tmp/decisions.json --labels /tmp/labels.jsonl
node dist/scripts/evaluate-memory-decisions.js --llm-config ~/.config/remind/memory.config.json --out /tmp/decisions-llm.json
node dist/scripts/decision-policy-fit.js --input /tmp/labels.jsonl
```

---

このレポートは「論文をどう使ったか」の記録であり、production の学習が成功したという主張ではない。production の観測（重複 summary、保持重み未受理、pending proposals）は別途、時点付きで扱う。
