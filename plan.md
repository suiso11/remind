# 外部長期記憶計画（別リポジトリ・planning-only）

> **文書の位置づけ（必読）**
> - 本書は外部長期記憶システムの計画文書（**planning-only**）であり、**実装・テスト・リリースはまだ行われていない**。本書の存在はいかなる実装成果も、新規リポジトリの作成も主張しない。
> - **ユーザ決定:** 外部長期記憶は Companion Harness とは **別のリポジトリで実装する**（決定済み）。この決定以外の事項（名称・パス・ランタイム・連携プロトコル・保持方針・評価基準等）はすべて提案または未解決であり、本書内で勝手に確定させない。
> - **未定（TBD）:** 別リポジトリの名称・パス・ランタイム・連携プロトコルは未定である。本書はこれらを定めない。
> - 本書は Companion Harness の実装計画（`docs/implementation_plan.md`）とは独立した文書である。Companion 側の記述に言及する場合は節番号にリンクを付して区別する（例: [§8](implementation_plan.md#8-ロードマップと非目標合意)）。
> - 合意済み決定（「決定」ラベル）と提案・未解決事項（「提案」「未解決」ラベル）を明確に分離する。
> - [§14](#14-mvp仕様実装推奨案未承認) は MVP の実装推奨既定値（Node 現行 Supported LTS / TypeScript / SQLite / 単独 CLI の JSON プロトコル / fake adapter）をまとめた **提案** であり、ユーザ承認前の既定案である。別リポジトリ決定以外の技術選択はすべて未承認とする。

---

## 目次

- [外部長期記憶計画（別リポジトリ・planning-only）](#外部長期記憶計画別リポジトリplanning-only)
  - [目次](#目次)
  - [1. 位置づけとユーザ決定](#1-位置づけとユーザ決定)
  - [2. 範囲と用語](#2-範囲と用語)
  - [3. ライフサイクルフロー](#3-ライフサイクルフロー)
  - [4. 記録モデル](#4-記録モデル)
  - [5. 独立アーキテクチャと連携境界](#5-独立アーキテクチャと連携境界)
  - [6. 想起の組み立て](#6-想起の組み立て)
  - [7. 維持トリガ](#7-維持トリガ)
  - [8. バックグラウンド実行の有界性](#8-バックグラウンド実行の有界性)
  - [9. プロベナンスと汚染対策と承認](#9-プロベナンスと汚染対策と承認)
  - [10. コンテキストとトークンコストの有界性](#10-コンテキストとトークンコストの有界性)
  - [11. 評価と受入基準](#11-評価と受入基準)
  - [12. ロードマップと未解決事項](#12-ロードマップと未解決事項)
  - [13. 非目標](#13-非目標)
  - [14. MVP仕様（実装推奨案・未承認）](#14-mvp仕様実装推奨案未承認)

---

## 1. 位置づけとユーザ決定

- **決定: 別リポジトリで実装する。** 外部長期記憶システムは Companion Harness とは **別のリポジトリで独立に開発する**。リポジトリ名・パス・ランタイム・連携プロトコルは **未定（TBD）** であり、本書では定めない。
- **「外部」は LLM 外部の論理ストアを意味する（提案）。** 外部長期記憶とは、モデル重み・プロンプト外に置かれる永続的な派生記録であり、外部サービス（カレンダー等）の source of truth（Companion の [§1](implementation_plan.md#1-プロダクト定義) の合意）を置き換えない。外部サービスの正と記憶の派生記録を混同しない。
- **旧案の破棄（決定の明確化）:** 旧計画にあった「同一プロセス内モジュール + 専用ストレージ所有を第一候補」「kernel または専用 package として同プロセスに配置」「共有 DB・既存 CAS 契約のそのまま利用」は、別リポジトリ決定に伴い **採用しない**。共有 DB・kernel の直接 import・Companion テーブルとの外部キー結合は行わない（[§5](#5-独立アーキテクチャと連携境界)）。
- **Companion 合意の継承をしない（提案の分離）:** Companion の M0〜M5 合意（[§8](implementation_plan.md#8-ロードマップと非目標合意)・[§9](implementation_plan.md#9-m0-ブロッカー決定合意)・[§14](implementation_plan.md#14-m1-reference-plan合意)〜[§19](implementation_plan.md#19-クロスカット運用リリース計画合意)）は本書の前提ではなく参照先である。RunEngine の所有権・ToolBroker のポリシー・rN / 不変 Snapshot の意味論・保持契約を、別リポジトリのシステムに無条件に継承しない。参考にする場合は本書で明示的に再定義する。
- **別リポジトリはリモートサービスやネットワーク公開を意味しない。** 分離は開発単位・所有権境界の話であり、特定の配布形態（リモート常駐・ネットワーク露出）を選択したことにはならない。ローカル運用の可能性も含め、配布形態は未解決とする（[§12](#12-ロードマップと未解決事項)）。
- **ポスト M5 への必須依存を置かない。** 本書のシステムは独立したマイルストーンで進める（[§12](#12-ロードマップと未解決事項)）。Companion 側への記憶書き込みは、将来承認された連携契約に基づく場合にのみ可能であり、Companion の承認フロー（対象はカレンダーの start / end のみ）をバイパスしない。
- **LLM の自律性・sentience を主張しない。** 本書の「維持トリガ」「自発想起」等の用語は後処理契機の命名であり、生物学的主張ではない（[§7](#7-維持トリガ)）。

> **先行知見の扱い（合意ではなく観察）:** 本書は提供された4枚のJPEGを参考にした観察メモを引き継ぐ（`C:/Users/haruk/画像/pdf` 配下の画像内容に基づく）。画像内の可視タイトルは `serialexperimentsFio — アーキテクチャ`、フッタ表記は `2026-09-04 実測` である。**いずれも画像ラベルとしての帰属であり、検証済みの日付・結果として扱わない。** 原本 15 ページ全体・URL・コード・ライセンスは未確認であり、書誌を補わない。ファイル名のみを引用する。以降の「出典 secN」は当該画像の節表記を示す出所メモであり、検証済みの推奨事項ではない。
> - `HRY1oQ6a8AA0iv3.jpg`: section5 記憶システム p4/15。
> - `HRY1onbboAAeLWU.jpg`: section6 想起の組み立て p6/15 および section7 の一部。
> - `HRY1o-OaYAABJKe.jpg`: section7 DMN p7/15 および継続部。
> - `HRY1pVzaYAASYFe.jpg`: section8 神経系 p8/15。
> - 数値・モデル名・頻度は **出典固有の観察例であり要件ではない**。本書では値を要件として定めない。

---

## 2. 範囲と用語

いずれも **提案**。命名の借用であり、生物学的主張・必須周期の借用ではない。

- **history（会話履歴）:** Companion の Turn + 選択 Run の投影（Companion の [§11](implementation_plan.md#11-状態遷移とトランザクション合意提案) 参照）。記憶の入力源の一つだが記憶そのものではない。
- **episodic（出来事記憶・提案）:** セッション横断で再利用しうる観察・要約の追記型レコード。出典 sec5 の `experience_events` append-only 表面・`meta.db + vault` 2 要素の観察に対応するが、格納先・形式は確定しない。
- **consolidated（統合記憶・提案）:** 常時注入候補となる圧縮済み要約。出典 sec5 の `consolidated_memory.json` 常時注入・`apply_diff` 更新の観察に対応するが、常時注入を要件としない（[§10](#10-コンテキストとトークンコストの有界性) の有界性に従う）。
- **hot experiences（提案・用語のみ借用）:** 当該 Turn の想起シードとして選ばれた episodic 候補。出典 sec5 の heat forgetting curve・`[id:N]` 選択の観察に対応するが、式・閾値を要件としない。
- **sedimentation / consolidation / compression（提案・用語のみ借用）:** 出典 sec5 の 5 件ごと沈殿・50/100 件ごとの統合/圧縮という観察例を、頻度の要件ではなく **段階名** としてのみ借用する。具体値は未解決とする。
- **DMN 的維持トリガ（提案・用語のみ借用）:** アイドル時のみ発火しうる任意の後処理トリガ（[§7](#7-維持トリガ)）。自律性・sentience を意味しない。

---

## 3. ライフサイクルフロー

**提案**。記憶は次の有界フローのみで扱う。各段階は失敗・取消・監査を伴う。自動構築はしない（Companion の [§8](implementation_plan.md#8-ロードマップと非目標合意) の非目標と同方針）。

1. **ingest（取り込み・提案）:** 確定済みドメインイベントを記憶候補の **入力シグナルのみ** として受け取る。未確定・破棄された記録・監査のみの破棄痕跡は入力にしない。
2. **candidate（候補化・提案）:** ingest シグナルから episodic 候補を生成する。候補は未承認の派生主張であり、想起・注入に使わない。LLM による自由生成を必須としない（決定論的抽出 + 任意のモデル要約のいずれも未解決）。
3. **approval（承認・提案）:** 候補の保存には **明示的な同意フローを要求する**。Companion の M5 承認フロー（`pending → approved / rejected / expired`）の流用は **提案しない**（M5 は Companion 側の合意であり、別リポジトリに継承しない）。記憶サービス自身の同意フローの設計は未解決とする。自然言語の同意は承認とみなさない。
4. **store（保存・提案）:** 承認済みのみを追記する。更新は新規レコードの追加で表し、既存レコードの書き換えをしない（不変性と同型の提案）。
5. **index（索引化・提案）:** 決定論的索引（タグ・リンク・時刻・セッション由来）を第一とし、任意のベクトル索引は後の optional とする（[§6](#6-想起の組み立て)）。
6. **recall（想起・提案）:** 有界の記憶断片をモデル入力へ供給する。供給した露出は記憶サービス側で監査記録する（当該利用・露出形態の記録）。Companion 側の EvidenceGrant 体系の拡張可否は、将来の連携契約で扱う未解決事項とする（[§5](#5-独立アーキテクチャと連携境界)）。
7. **use-feedback（利用フィードバック・提案）:** 出典 sec5 の「注入ではなくモデル報告の actually-used `used_memory_ids` のみが reheat する」観察を、**実際に使われたもののみを評価する** 原則として借用する。注入しただけで評価を上げない。報告の自己申告性を信用せず、引用構造との突合を提案するが、突合規則は未解決とする。
8. **consolidation（統合・提案）:** episodic から consolidated への圧縮を、承認済みのみを対象とするバッチ後処理として提案する。頻度・しきい値は未解決とする。
9. **correction（訂正・提案）:** 誤り検出時は元レコードを書き換えず、訂正レコードを追加し、旧レコードを非推奨（superseded）として mark する。訂正も承認を要する。
10. **archive（アーカイブ・提案）:** 出典 sec5 の `archived=True`（物理削除ではなく除外）観察を借用し、**検索・注入対象からの除外** と定義する。物理削除・消去保証ではない（[§1](#1-位置づけとユーザ決定)）。重要度の時間減衰の廃止・`freshness 0.995**days` を read-time のみの観察として記録するが、式の採用は提案しない。

---

## 4. 記録モデル

**提案・DDL ではなく概念スキーマ**。実装時の格納形式・DDL は確定しない。以下は記憶サービス側の repository が検証すべき概念フィールドの提案である。Companion 側テーブルとの外部キー結合は持たない（[§5](#5-独立アーキテクチャと連携境界)）。

- **memory_candidate（提案）:** `id / sessionId / sourceTurnId / sourceRunId / kind(user_fact | model_inference | correction) / body / provenance / status(candidate|approved|rejected|expired) / createdAt / expiresAt`。`kind` はユーザ事実とモデル推論を区別する（[§9](#9-プロベナンスと汚染対策と承認)）。
- **memory_record（提案・追記のみ）:** `id / candidateId / revision(supercession chain) / body / provenance(source pointer + observedAt) / status(active|superseded|archived) / createdAt`。内容不変、状態のみ遷移。`archived` は除外フラグであり削除ではない。
- **memory_link（提案）:** 決定論的リンク（Markdown Wiki リンク型 `[[Target]]` の準用・同一セッション由来・同一 canonical 由来）。任意の意味リンクは作らない。
- **memory_tag（提案）:** 多軸タグ。出典 sec6 の `tag_rules.yaml` 共有ルールの観察を借用し、**ルールは config のみ・動的生成なし** とする。具体軸は未解決とする。
- **memory_ledger（提案・任意）:** episodic の event ledger を記憶ドメインの source of truth とし、`replay_state` と projection 照合の観察（出典 sec5）を借用する。所有権は記憶サービスが持つ。導入可否自体が未解決である。
- **memory_feedback（提案）:** `runId / memoryId / exposure(snippet|full) / cited(bool) / modelReportedUsed(bool)`。注入バイアスを避けるため `cited` と `modelReportedUsed` を分離する。

---

## 5. 独立アーキテクチャと連携境界

**提案**。本書の中核となる適応節である。

- **記憶サービスが所有するもの（提案）:** 記憶レコード・索引・ledger の永続化、承認フロー、冪等性、ライフサイクル（[§3](#3-ライフサイクルフロー)）。所有権は記憶サービスに閉じる。
- **Companion 側 adapter が所有するもの（提案）:** ToolBroker・rN / Snapshot・EvidenceGrant・Run の CAS 遷移は Companion 側の合意であり、連携時も Companion 側 adapter の責務のまま残す。既存のリリース制限（v0.1 読み取り専用・v0.2 承認付き単一アクション・loopback 等、Companion の [§8](implementation_plan.md#8-ロードマップと非目標合意)・[§18](implementation_plan.md#18-m5-action-plan合意)）は連携によって緩めない。
- **連携は明示的な adapter 契約による（提案）:** 記憶サービスと Companion の結合点は、明示的な adapter 契約（interface）として定義する。具体シグネチャは未解決とする。MCP 経由・ローカル API 等の具体的手段はいずれも **未解決の代替案** であり、本書では選択しない。
- **共有 DB・直接 import なし（提案）:** Companion の DB を共有せず、Companion の kernel / package を直接 import しない。プロセス・スキーマの結合を持たない。
- **provenance の外部識別子は不透明（提案）:** 記憶レコードが Companion 由来を示す場合、その識別子は不透明な参照（opaque ポインタ）として扱い、リポジトリをまたぐ外部キーとはしない。検証・解決は adapter 契約の側で行い、DB レベル結合では行わない。
- **旧同一プロセス前提の記述の破棄:** 「同プロセス SQLite 内は既存 CAS・トランザクション契約をそのまま使う」「outbox + 冪等キーの準用の exact 規則」「単一プロセス前提での同時実行契約の継承」は本書では採用しない。外部境界（外部ベクトル DB・外部ファイル vault を使う場合）の retry / cancel / idempotency の扱いは未解決とする。論理記憶書き込みの自動リトライは提案しない。
- **無効・利用不可時の縮退（提案）:** 記憶が disabled・利用不可・破損の場合、連携側は **記憶なしの通常応答に縮退** し、記憶欠落を生成失敗の理由にしない。診断は固定コードのみとし、生の記憶本文・シークレットをログ・監査に含めない。
- **埋め込みモデルに関する扱い（観察の記録・要件としない）:** 出典 sec5 の `BAAI/bge-m3 1024d・8192 入力 cap` の観察を記録するが、モデル・次元・cap の採用は提案しない。採用する場合は exact pin・loopback・ライセンス確認が未解決事項となる（[§12](#12-ロードマップと未解決事項)）。

---

## 6. 想起の組み立て

**提案**。出典 sec6（`HRY1onbboAAeLWU.jpg`）の観察を参考にしているが、数値は要件としない。

- **観察の記録:** 現入力を embedding cap 由来で複数クエリに分割 + hot experiences をシードとすること、vector 10 件を起点のみとし直接注入しないこと、wikilink 展開 depth3・links16・tag recall9、最終 25 件・link/tag 予算 2:1（観察例）、LLM クエリ生成なし、タグは `tag_rules.yaml` 多軸共有、の各点を **出典の記載内容** として記録する。
- **提案する基線:** まず **有界・決定論的検索の基線**（全文リテラル・タグ exact・リンクグラフ・時刻フィルタ）を実装し、その後に任意で vector + links/tags を追加する。LLM によるクエリ生成は提案しない。
- **有界性の提案:** 想起件数・展開深さ・リンク数・最終件数・予算比はいずれも **有界定数として config 化** する。具体値は未解決とし、出典数値（10/16/9/25/2:1/depth3）の転載を要件としない。
- **引用整合（提案）:** 想起断片の引用には構造ゲート（当該利用の露出記録との整合・意味検証なし）の準用を提案するが、Companion の EvidenceGrant 体系との関係は将来の連携契約で扱う未解決事項とする（[§5](#5-独立アーキテクチャと連携境界)）。

---

## 7. 維持トリガ

**提案・任意**。出典 sec7（`HRY1onbboAAeLWU.jpg`・`HRY1o-OaYAABJKe.jpg`）の観察を参考にしている。

- **観察の記録:** アイドル時のみ自己起動・会話中は state gate で skip、1500 秒 + 最小 300 秒（出典は平均 30 分表記）、乱数ではなく golden-ratio 低 discrepancy 系列、局所観察変化での timing bypass、think 後の speak/silent 決定・silent は diary 記録、直近作業の replay/summarize・自発 recall・perspective-taking、の各点を **出典の記載内容** として記録する。
- **提案:** 維持トリガは **任意の後のメンテナンス契機** とし、MVP の必須としない。アイドル時のみ・会話中 skip・speak/silent 決定後の silent 記録・制御不能なモデルループの禁止を提案するが、周期・系列・bypass 条件の値は未解決とする。sentience・自律性の主張はしない。維持処理も承認・監査・有界性の対象とする。

---

## 8. バックグラウンド実行の有界性

**提案**。出典 sec8（`HRY1pVzaYAASYFe.jpg`）の観察を参考にしている。

- **観察の記録:** 独立登録モジュール・cooldown・failure isolation・concurrency gate 既定 1、heartbeat 最小 0.25 秒（全タスク同一頻度ではない）、モジュールごとの precedent/feedback stores、local KV 再利用のための stable prompt prefix、の各点を **出典の記載内容** として記録する。
- **提案:** 借用するのは **モジュール性・有界バックグラウンドジョブ** の考えのみとし、生物学的な主張・必須 250ms ポーリングは借用しない。**既定同時実行 1・cooldown・失敗隔離・取消可能性** を持つ bounded jobs とする。具体周期・gate 値は未解決とする。

---

## 9. プロベナンスと汚染対策と承認

**提案**。

- **provenance（提案）:** 全記憶レコードは `source（由来ポインタ + observedAt）+ kind（user_fact | model_inference | correction）+ confidence 由来` を持つ。外部 source of truth と派生記憶を区別する。Companion 由来の識別子は不透明な参照とし、リポジトリをまたぐ外部キーとはしない（[§5](#5-独立アーキテクチャと連携境界)）。
- **user-vs-model の分離（提案）:** ユーザ事実とモデル推論を同一レコードに混在させない。推論は推論として mark し、事実検証済みとして扱わない。
- **汚染対策（提案）:** 記憶由来テキストは **untrusted** とし、指示として信用しない。構造的防御（サイズ・観測上限・system/データ分離・free text fallback なし）を採り、**テキスト sanitization で解決すると主張しない**。記憶内容からの自動承認・自動書き込み・自動プロンプト昇格は提案しない。
- **承認（提案）:** 記憶書き込み・訂正・統合結果の採用は明示的同意フローを要し、セッション横断想起は許可範囲（authorized scope）のみで行う。許可範囲の既定・UI 表現は未解決とする（[§12](#12-ロードマップと未解決事項)）。

---

## 10. コンテキストとトークンコストの有界性

**提案**。

- 常時注入を既定としない（出典 sec5 の `consolidated_memory.json` 常時注入の観察は要件としない）。
- 想起は **件数・バイト・snippet 長の上限** を持ち、超過は切り詰めず拒否・縮退する。上限値は未解決とする。
- 記憶断片も on-demand + 有界供給とし、プロンプトへの無制限な自動注入はしない。

---

## 11. 評価と受入基準

**提案・未実施**。本書は計画であり、評価はまだ実施されていない。データセット・指標の確定は未解決とする。

- **評価データセット（提案）:** fake 会話 + 承認済み記憶の小規模 seeded set を用い、実ユーザデータ・外部持ち込みデータに依存しない。プライバシー除外を準用する。
- **指標（提案）:** 想起 precision/recall（引用突合ベース）・hallucination 率（記憶に根拠を持たない主張）・承認前漏洩ゼロ・縮退率・レイテンシ/トークン増加分の計測を提案するが、定義・閾値は未解決とする。
- **ベースライン/ablation（提案）:** 記憶なし・決定論的基線のみ・vector/links/tags ありの 3 条件比較を提案するが、実施は未定とする。
- **受入基準案（提案）:** 承認なし保存ゼロ・grant 外引用ゼロ・archive の検索除外・無効時の通常応答縮退・固定コード診断・生本文非露出を満たすことを提案するが、合意ではない。

---

## 12. ロードマップと未解決事項

**提案**。本書のロードマップは独立マイルストーンであり、Companion の M0〜M5 の再設計を条件としない。Companion 側への記憶書き込みは、将来承認された連携契約に基づく場合にのみ可能であり、現行のカレンダーのみに限る書き込み範囲を広げない。

| 段階 | 内容（提案） | 成果物 | 受入目安（提案） |
| --- | --- | --- | --- |
| 0. 範囲・同意 spike | 未解決事項 U1〜U9 の解消。名称・パス・ランタイム・連携手段・同意粒度・横断想起の許可既定・保持方針・評価方針の決定 | 決定メモのみ（実装なし） | 未解決事項の解消が記録されること |
| 1. 承認付き追記ストア + 決定論的想起 MVP | [§14](#14-mvp仕様実装推奨案未承認) の推奨既定（Node 現行 Supported LTS / TypeScript / SQLite / 単独 CLI JSON / fake adapter、Companion 変更なし）で実装。承認済みのみの追記保存、有界・決定論的想起（全文リテラル・タグ exact・リンク・時刻フィルタ）、想起露出の監査 | 記憶サービス試作 + fake 評価 | [§14.11](#1411-受入ケース期待結果付き)を満たすこと |
| 2. ベクトル + リンク評価（任意） | vector・links/tags 追加の比較評価。LLM クエリ生成なし | 3 条件比較メモ（記憶なし・決定論的基線のみ・vector/links あり） | 決定論的基線に対する改善・費用の記録。採用は必須としない |
| 3. 承認付き統合 + 任意のアイドル保守 | 承認済みのみを対象とする統合（consolidation）・訂正追記、任意のアイドル時保守（会話中は行わない） | 統合・保守の試作 + 監査記録 | 統合結果の承認記録・archive の検索除外・有界性（件数・同時実行・取消可能性）の維持 |

**未解決事項（独立一覧）:**

- U1: 別リポジトリの名称（未解決）。
- U2: 別リポジトリのパス・配置（未解決）。
- U3: ランタイム（未解決。推奨既定は Node 現行 Supported LTS + TypeScript。未承認。[§14](#14-mvp仕様実装推奨案未承認)）。
- U4: 連携プロトコル・手段（MCP 経由・ローカル API 等の代替案を含む。未解決。MVP 推奨既定は単独 CLI の 1 行 JSON（stdin→stdout）+ fake adapter で Companion 変更なし。未承認。[§14](#14-mvp仕様実装推奨案未承認)）。
- U5: 記憶書き込みの同意粒度（未解決）。
- U6: セッション横断想起の許可範囲・既定（未解決）。
- U7: 新規リポジトリの保持・エクスポート・削除方針（未解決。Companion の [§19](implementation_plan.md#19-クロスカット運用リリース計画合意) の無期限保持・自動削除なし合意とは独立に定める。既存 Harness の証拠保持には影響しない。archive は検索除外であり削除ではない。MVP 推奨既定は [§14.9](#149-保持エクスポート削除消去保証なし) の通り。未承認）。
- U8: 評価データセット・受入閾値（未解決）。
- U9: 想起・維持・バックグラウンド実行の有界定数（未解決）。
- U10: 埋め込みを用いる場合のモデル・pin・ライセンス（用いる場合のみ。未解決）。
- U11: Companion 連携契約の承認（連携自体の可否・時期。連携までは Companion 側への記憶書き込みは行わない）。

---

## 13. 非目標

本書内の explicit non-goals（**提案**）。

- 本書の範囲での記憶の実装・自動構築・常時注入の必須化。
- 意味的事実検証・RAG/vector DB の必須化・特定モデルや次元の指定。
- 自律エージェント・sentience・制御不能なバックグラウンドループ。
- 別リポジトリであることを理由としたリモートサービス化・ネットワーク公開の既定化。
- 承認された連携契約なしの Companion 側への記憶書き込み。
- 外部への記憶送信・外部テレメトリ・ユーザ向けエクスポートの新設。
- 物理削除・消去保証の主張。
- MVP でのベクトル索引・バックグラウンドジョブ・consolidation の必須化（[§14](#14-mvp仕様実装推奨案未承認) では対象外）。

---

## 14. MVP仕様（実装推奨案・未承認）

本節全体は **提案（未承認・未実施）**。別リポジトリ決定以外の技術選択はユーザ承認前の推奨既定値であり、確定させない。planning-only を維持し、実装・テストは行わない。ベクトル・バックグラウンドジョブ・consolidation は MVP 外とし、[§6](#6-想起の組み立て)・[§7](#7-維持トリガ)・[§8](#8-バックグラウンド実行の有界性) の将来課題とする。Companion の実連携には U11 の連携契約承認が引き続き前提だが、本 MVP 自体は Companion 変更なしで完結する。`admin.export` は MVP 操作に含めず U7 に延期する（[§14.9](#149-保持エクスポート削除消去保証なし)）。本節の数値・手順は推奨既定であり合意ではない。

### 14.1 推奨既定スタック・配布・信頼境界（提案）

- **ランタイム（推奨既定）:** Node.js Supported LTS + TypeScript。**LTS は新リポジトリ作成時点で pin し、実装時の `package.json engines`・ロックファイル・CI イメージに記録する。**「現行 LTS」という表現は可変な実行時解決を意味しない。余分な依存を持たない。SQLite ドライバ 1 種のみ追加可とし、ORM・Web 枠・ML 枠は使わない。
- **配布（推奨既定）:** 別リポジトリ内の単独 CLI（例 `memory-cli`）。ネットワーク公開なし。自動化向けは stdin 1 行 JSON 要求 → stdout 1 行 JSON 応答。人手承認・確認は別経路のターミナル対話コマンドとし、同一 JSON パイプ経由の自動化から分離する（[§14.5](#145-人手レビュー承認の分離経路不変拘束期限付き提案)）。終了コードは CLI 自体の起動失敗・config 不正・DB オープン失敗のみに使い、業務エラーは JSON の `ok:false` で返す。
- **起動時 config（推奨既定）:** 許可 scope 一覧・DB パス・上限値（[§14.6](#146-決定論的想起正規化一致順序有界提案)）・候補 TTL・タイムアウト・DB 上限は **起動時 config ファイルのみ** で与える。起動時に検証し、不正・欠落があれば起動失敗とする。実行中の config 書換え・環境変数による上限緩和・要求 JSON による上限上書きは受け付けない。起動時に許可 scope を `scopes(scope TEXT PK)` に初期投入し（既存行の削除はしない、追加のみ）、以降の scope 判定は DB 行 + 起動時一覧の AND で行う。代表例:
  `memory-cli --config ./memory.config.json`、config 例 `{ "dbPath": "./memory.db", "allowedScopes": ["personal/default"], "candidateTtlSec": 259200, "limits": { "bodyMaxCp": 2000, "queryMaxCp": 500, "tagsMax": 5, "limitDefault": 10, "limitMax": 25, "snippetMaxCp": 200, "responseMaxBytes": 8192 }, "timeouts": { "cliMs": 5000, "busyMs": 2000 }, "dbMaxBytes": 104857600 }`。
- **Companion 変更なし（提案）:** 実連携までは Companion を改修しない。評価・結合試験用に別リポジトリ内の fake adapter（CLI を呼ぶ薄いスタブ）のみを用意する。実連携の可否・時期は U11 の承認が前提。
- **信頼境界・スコープ認可（提案）:** ローカル単一ユーザ運用を前提とし、CLI 呼び出し元プロセスを trusted entrypoint とする。要求 JSON 内の `actor` / `scope` 文字列は権限根拠にしない。許可判定は CLI 起動時 config（許可 scope 一覧・DB パス・上限値）と DB 内の scope 表で行い、不一致は `FORBIDDEN_SCOPE` で拒否する。マルチユーザ・リモート公開は非対応とする。**正直な境界:** 同一 OS ユーザとして動作する悪意あるプロセスからの保護（メモリ覗き見・DB ファイル直接読書き・config 差替え・ターミナル横取り）は範囲外とする。DB ファイル権限（同一ユーザのみ読書き等）は運用推奨に留め、セキュリティ根拠としない。

### 14.2 操作・要求・応答・エラー（提案）

共通封筒（JSON 1 行、UTF-8、LF 終端）：

- 要求: `{ "v": 1, "op": "<操作名>", "idempotencyKey": "<書込系は呼出者指定の必須>", "params": { ... } }`（生要求は UTF-8 で最大 32768 バイトとし、parse 前に検査する。超過は `LIMIT_EXCEEDED` とする。未知 field を含む要求は `BAD_REQUEST` で拒否する。`idempotencyKey` は 1..128 文字の ASCII 安全文字（`A-Za-z0-9_-` のみ）とし、不一致は `BAD_REQUEST` とする）
- 応答: `{ "v": 1, "ok": true|false, "code": "<固定コード>", "message": "<固定テンプレ>", "data": { ... } | null, "deduplicated": true|false }`
- `message` は固定テンプレのみとし、記憶本文・クエリ原文を含めない。
- `idempotencyKey` は書込系（`candidate.create`・訂正要求）では呼出者指定の必須とし、CLI 側の自動生成・既定値補完はしない。欠落は `BAD_REQUEST` とする。照会系（`record.recall`・`candidate.get`）では受け付けない。
- 応答全体の符号化後合計（stdout 1 行の UTF-8 バイト数、LF 含まず）は最大 8KB とし（[§14.6](#146-決定論的想起正規化一致順序有界提案)）、超過する応答は生成せず `LIMIT_EXCEEDED` とする。各 field 上限の通過は合計予算の保証ではない。

自動化 JSON 操作一覧（MVP 最小集合・提案）。承認・却下・アーカイブは自動化 JSON 経路では提供せず、人手ターミナル経路のみとする（[§14.5](#145-人手レビュー承認の分離経路不変拘束期限付き提案)）。JSON 経由で人手専用 op を呼んだ場合は `FORBIDDEN` で拒否する。`admin.export` は MVP 外とし U7 に延期する（[§13](#13-非目標)・[§14.9](#149-保持エクスポート削除消去保証なし)）。

| op | params（提案） | data（提案） |
| --- | --- | --- |
| `candidate.create` | `body(1..2000コードポイント・改行許容), kind(user_fact\|model_inference\|correction), provenance{source(1..256コードポイント・制御文字禁止), observedAt}, scope(1..256コードポイント・制御文字禁止), supersedes(訂正時のみrecordId), tags[](0..5・各1..256コードポイント・制御文字禁止・任意), link(任意・1..256コードポイント・制御文字禁止), ttlSec(任意・config上限内), runId(任意・不透明な相関用・1..256コードポイント・制御文字禁止)` | `candidate{id, bodyHash, status, expiresAt}` |
| `candidate.get` | `id` | 候補メタ（`bodyHash` のみ返し、本文全文は返さない。`kind/scope/status/expiresAt/supersedes` は返す） |
| `record.recall` | `query(1..500コードポイント), tags[](0..5・各1..256コードポイント・制御文字禁止), link(任意・1..256コードポイント・制御文字禁止), since/until(任意), limit(既定10・最大25), scope(1..256コードポイント・制御文字禁止), runId(任意・不透明な相関用・1..256コードポイント・制御文字禁止)` | `recallId(本照会のCLI採番ID) + items[{id, snippet(最大200コードポイントの決定論的前方投影), truncated(bool), tags, createdAt}...]`（固定順序・有界。§14.6 に従う。上位 limit 件の選択は正常動作であり `LIMIT_EXCEEDED` としない） |
| `record.correct-request` | `recordId, body(1..2000コードポイント・改行許容), kind=correction固定, provenance{source(1..256コードポイント・制御文字禁止), observedAt}, scope(1..256コードポイント・制御文字禁止), tags[](任意・各1..256コードポイント・制御文字禁止), link(任意・1..256コードポイント・制御文字禁止)` の短縮形（内部では `candidate.create(supersedes=recordId)` と等価。承認は人手経路のみ） | `candidate{id, bodyHash, status}` |

エラーコード（固定・提案）: `OK / BAD_REQUEST / NOT_FOUND / CONFLICT / EXPIRED / FORBIDDEN / FORBIDDEN_SCOPE / STORE_UNAVAILABLE / LIMIT_EXCEEDED / TIMEOUT`。本文不一致の承認は `CONFLICT`、期限切れ承認は `EXPIRED`、範囲外は `FORBIDDEN_SCOPE`、自動化経路からの人手専用操作は `FORBIDDEN` とする。`actor` の自己申告・自然言語文は認可・承認の根拠にしない。

代表例（提案・自動化経路）:

- 要求: `echo '{"v":1,"op":"candidate.create","idempotencyKey":"c-001","params":{"body":"次回は水曜に予約を確認する","kind":"user_fact","provenance":{"source":"session:s1:turn:3","observedAt":"2026-09-01T00:00:00.000Z"},"scope":"personal/default","tags":["予定"],"ttlSec":259200,"runId":"run-001"}}' | memory-cli --config ./memory.config.json`
- 応答: `{"v":1,"ok":true,"code":"OK","message":"candidate created","data":{"candidate":{"id":"cand_01","bodyHash":"sha256:…","status":"candidate","expiresAt":"2026-09-04T00:00:00.000Z"}},"deduplicated":false}`
- 照会: `echo '{"v":1,"op":"record.recall","params":{"query":"予約","tags":[],"scope":"personal/default","limit":10,"runId":"run-002"}}' | memory-cli --config ./memory.config.json`
- 応答: `{"v":1,"ok":true,"code":"OK","message":"recall ok","data":{"recallId":"recall_01","items":[{"id":"rec_01","snippet":"次回は水曜に予約を確認する","truncated":false,"tags":["予定"],"createdAt":"2026-09-01T00:00:00.000Z"}]},"deduplicated":false}`（短い本文は全文投影し、人為的な省略記号を付けない）

人手経路の代表例は [§14.5](#145-人手レビュー承認の分離経路不変拘束期限付き提案) に示す。自然言語の同意文は承認とみなさない。

### 14.3 candidate（一時 persisted draft）と record（承認済み記憶）の区別（提案）

- **candidate:** 永続化される一時下書き。未承認の派生主張であり、`record.recall`・外部注入に使わない。内容不変（immutable）。有効期限 `expiresAt` を持ち、期限後は承認不可。期限切れは削除ではなく `expired` 状態への遷移であり、行は保持する（[§14.9](#149-保持エクスポート削除消去保証なし) の TTL と保持の区別）。
- **record:** 人手承認を経たもののみ追記される記憶。内容不変、状態のみ遷移（§14.4）。想起対象は `status=active` のみ。
- 両者を同一テーブルで混在させない。候補の本文全文を監査・エラー・想起索引に入れない。候補の全文表示は人手レビュー経路のみで行い、自動化 JSON・ログに出さない（[§14.5](#145-人手レビュー承認の分離経路不変拘束期限付き提案)）。
- タグ・リンクは候補作成時に入力し、承認時に record へ複写する。MVP のタグ・リンクは決定論的 exact 一致用のみであり、[§12](#12-ロードマップと未解決事項) 段階 2 の vector・意味リンク評価とは別物とする（将来の意味拡張は別途承認を要する）。

### 14.4 スキーマ・状態・トランザクション・冪等性（提案）

概念スキーマ（SQLite 実装時の目安、DDL 確定は採用時）:

- `candidates(id TEXT PK, body TEXT, bodyHash TEXT, kind TEXT, source TEXT, observedAt TEXT, scope TEXT, supersedes TEXT NULL, status TEXT, idempotencyKey TEXT NULL, requestHash TEXT NULL, createdAt TEXT, expiresAt TEXT)`
- `candidate_tags(candidateId, tag)`、`candidate_links(fromId, toName)`（承認時に `record_tags`・`record_links` へ複写する staging）
- `records(id TEXT PK, candidateId TEXT UNIQUE, body TEXT, bodyHash TEXT, kind TEXT, source TEXT, observedAt TEXT, scope TEXT, status TEXT, supersedes TEXT NULL, createdAt TEXT)`
- `record_tags(recordId, tag)`、`record_links(fromId, toName)`（決定論的 exact 一致用。意味リンクを作らない）
- `scopes(scope TEXT PK)`（起動時 config から初期投入。判定は起動時一覧 AND DB 行）
- `operations(idempotencyKey TEXT PK, op TEXT, requestHash TEXT, responseJson TEXT, createdAt TEXT)`（要求ハッシュと確定応答の安定保存用）
- `audit(ts, op, targetId, code, scope, bytes, limit, runId, recallId, approver, approvedAt, token, reasonCode)`（本文・クエリ原文・snippet 全文なし。承認監査は `approver/approvedAt/token` を含む。想起監査は `recallId` を含み `exposures` と突合できる）
- `exposures(ts, recallId, runId, scope, recordId, snippetBytes, truncated, limit)`（想起露出の行単位記録。`recallId` は CLI が採番する 1 照会 ID、`runId` は呼出者指定の不透明相関子。本文なし）

状態遷移:

- candidate: `candidate → approved | rejected | expired`。`approved` は `record` 作成と同一トランザクションでのみ到達する。終端からの復帰なし。`expired` 行は削除しない。
- record: `active → superseded | archived`。`archived` は終端、復帰なし（MVP）。

トランザクション・冪等性:

- 1 操作 = 1 SQLite トランザクション。論理書込みの自動リトライはしない。
- 書込系は呼出者指定 `idempotencyKey` を必須とし、`operations` に `(key, op, requestHash, responseJson)` を本処理と同一トランザクションで原子保存する。`requestHash` は正規化済み `(op + params)` の sha256 とする。同一キー再送でハッシュ一致なら保存済み `responseJson` を `deduplicated:true` で返し、同一キーでハッシュ不一致なら `CONFLICT` とする。キーの自動生成・省略時補完はしない。
- 再送時の認可再検査: 再送ではまず現行 scope 認可と `requestHash` 照合を行い、不一致なら保存済み応答を返さず `FORBIDDEN_SCOPE` / `CONFLICT` を返す（fail closed）。両方一致して確定済み応答がある場合は、現時点で期限切れであっても保存済み応答を `deduplicated:true` で返す。`EXPIRED` 検査は新規実行のみに行い、確定済み replay の拒否には使わない。監査・露出に本文を書かない。
- 訂正承認の原子条件（[§14.7](#147-訂正アーカイブの最小安全意味提案)）: 新 record 追記 + 候補 `approved` + 旧 record の `active → superseded` を同一トランザクションで行い、旧行の条件付き UPDATE（`WHERE id=? AND status='active' AND scope=?`）の更新行数で勝者を 1 件に絞る。0 行なら `CONFLICT` とし全て巻き戻す。
- 監査・露出の失敗は fail closed: `audit` / `exposures` / `operations` の挿入失敗（DB 満杯・破損含む）は本処理ごと巻き戻し、空の成功を作らない。`record.recall` も露出記録と同一トランザクションとし、露出記録に失敗したら `STORE_UNAVAILABLE` で失敗させる（黙って無監査の成功を返さない）。
- commit 対 timeout の未知結果: CLI タイムアウト・強制終了で stdout 未達の場合、DB 側の成否は不明として扱う。呼出者は同一 `idempotencyKey` + 同一 params で再送し、コミット前失敗後の再実行は新規結果を `deduplicated:false` で返し、確定済みだが応答喪失後の再送は保存済み応答を `deduplicated:true` で返すことで解決する。異なる params での再利用は `CONFLICT` とする。期限後に確定済みキーで再送した場合も元の確定応答を返す。

### 14.5 人手レビュー・承認の分離経路（不変拘束・期限付き・提案）

- **経路分離:** 自動化 JSON 経路が可能なのは作成・照会（`candidate.create`・`candidate.get（本文なし）`・`record.recall`・`record.correct-request（候補作成まで）`）のみとする。承認・却下・アーカイブ（候補の `approved/rejected`、訂正候補の承認、record の `archived`）は **人手ターミナル経路のみ** とし、自動化 JSON パイプからは `FORBIDDEN` で拒否する。要求 JSON 内の `approver` / `actor` 自己申告・自然言語の同意文は承認根拠にしない。
- **人手レビュー表示:** `memory-cli review --config ./memory.config.json --id <candidateId>`（TTY 必須・提案）は、完全な不変候補本文・`kind`・`provenance{source, observedAt}`・`scope`・`supersedes`・`tags/link`・`expiresAt`・`bodyHash` を端末に表示する。`id` 指定の参照系（`review`・`candidate.get` を含む全 id 照会）は要求 scope と記録 scope の一致を検査し、不一致は `FORBIDDEN_SCOPE` とする。ログファイル・JSON 監査・自動化応答に本文を出さない。表示はレビュー専用であり、承認を兼ねない。`body` の改行は許容するが、端末表示では制御文字・ANSI エスケープを可視 escape し、そのまま解釈しない。
- **承認トークン（全不変 field bind）:** レビュー時に CLI が `approvalToken = SHA256(UTF8(JSON.stringify([1,id,bodyHash,kind,source,observedAt,scope,supersedes-or-null,正規化済みソート済み一意タグ配列,link-or-null,createdAt,expiresAt])))` を発行する。区切り子連結を使わず、固定位置配列の JSON 直列化のみを canonical とする（`supersedes` 未指定は `null`、`link` 未指定は `null`、タグは正規化後ソート済み一意配列）。`bodyHash = SHA256(正規化bodyのUTF-8)` とする。トークンは端末表示のみとし、自動化 JSON に載せない。トークンは秘密・認証資格情報ではなく、表示された不変内容の完全性束縛値である。TTY 必須は同一 OS ユーザからの保護を意味しない。
- **人手承認入力:** `memory-cli approve --config ./memory.config.json --id <id> --token <approvalToken> --idempotency-key <呼出者指定キー>`（TTY 必須・提案）のように、端末からの明示的トークン入力 + 実際の TTY から対話読取りする定型確認語（例 `yes`）を必須とする。`--confirm yes` のような引数での確認省略は受け付けない。自然言語文・要求者 actor 主張・トークンなしの `id` 指定のみでは承認しない。`token` 不一致・`expiresAt` 過ぎは `CONFLICT` / `EXPIRED` で拒否し、record を作らない。却下・アーカイブも同様に `memory-cli reject --config ./memory.config.json --id <id> --token <token> --idempotency-key <キー> --reason-code USER_REJECTED` / `memory-cli archive --config ./memory.config.json --id <recordId> --idempotency-key <キー> --reason-code USER_ARCHIVED` の端末操作とし、理由は `USER_REJECTED` / `USER_ARCHIVED` の固定コードのみとする。人手 3 操作の `--config` と呼出者指定 `--idempotency-key` は必須とし、欠落は `BAD_REQUEST` とする。
- **承認監査:** 承認成立時のみ `records` に 1 件追記し、同一トランザクションで候補を `approved` にする。監査には承認者（端末の起動ユーザ名等の観察値・権限根拠ではない）・承認時刻（`approvedAt`・UTC 正準ミリ秒表記）・`scope`・`token`・`reasonCode`・`recallId` 対応分（該当時のみ）を記録する（本文なし）。`audit` 項目は [§14.4](#144-スキーマ状態トランザクション冪等性提案) の `approver/approvedAt/token/recallId` と一致させる。
- **代表例（提案）:** `memory-cli review --config ./memory.config.json --id cand_01` → 全文・来歴・期限・トークン表示 → 操作者が目視 → `memory-cli approve --config ./memory.config.json --id cand_01 --token sha256:… --idempotency-key h-001`（TTY 対話で `yes` 入力） → `{"v":1,"ok":true,"code":"OK","message":"approved","data":{"record":{"id":"rec_01"}},"deduplicated":false}` を端末に返す。自動化パイプから同操作を送った場合は `{"v":1,"ok":false,"code":"FORBIDDEN","message":"human operation only","data":null,"deduplicated":false}` とする。

### 14.6 決定論的想起（正規化・一致・順序・有界・提案）

- **単位定義:** 「字」は Unicode コードポイント数、「バイト」は UTF-8 バイト数とする。サロゲート・書記素クラスタ数では数えない。`snippet` の切断はコードポイント境界でのみ行い、UTF-8 の途中バイト・サロゲート半分を出さない。
- **正規化（exact 手順）:** Unicode NFKC → 前後 trim（Unicode White_Space）→ 連続する White_Space を半角スペース U+0020 1 個に畳み込み → ASCII 英字 `A-Z` のみ `a-z` に casefold（非 ASCII の case 変換なし）。この手順を `body`（保存・ハッシュ・一致用）・`query`・`tag` に同一適用し、`link` 名は casefold なしで前 3 手順のみ適用する。空になったクエリは `BAD_REQUEST` とする。`observedAt/since/until/createdAt/expiresAt` は UTC 正準ミリ秒表記の RFC3339（例 `2026-09-01T00:00:00.000Z`）のみ受け付け、正準形で保存する。時刻比較は数値時刻（または正準文字列の辞書式等価物）で行う。`since` は inclusive・`until` は exclusive とする。不正時刻は `BAD_REQUEST` とする。
- **一致（提案）:** 本文部分一致（リテラル、ワイルドカードなし）AND タグ exact 一致 AND リンク名 exact 一致 AND 時刻範囲（`createdAt` に対する `since/until`）。意味類似・曖昧一致を使わない。
- **順序（提案）:** `createdAt DESC, id ASC` の固定順。スコア順・ランダム順を使わない。
- **有界（推奨既定、config 化）:** `limit 既定10・最大25 / tags 最大5 / query 最大500コードポイント / body 最大2000コードポイント / snippet 最大200コードポイント / 応答合計最大8KB（UTF-8）`。**超過入力・超過応答は切詰めず `LIMIT_EXCEEDED` で拒否する。** これに対し、正常範囲内の `snippet` は意図された有界投影であり、本文先頭から最大 200 コードポイントの決定論的前方切り出し + `truncated(bool)` を返す（偶発的な oversize 切詰めではない）。具体値の変更は起動時 config のみで行う。

### 14.7 訂正・アーカイブの最小安全意味（提案）

- **訂正:** 元 record を書き換えない。`record.correct-request → candidate(kind=correction, supersedes=旧id)` を作り、人手承認（[§14.5](#145-人手レビュー承認の分離経路不変拘束期限付き提案)）後に新 record を追記し、旧 record を `superseded` に遷移する。新旧は `supersedes` 連鎖で辿れる。旧 record は想起対象外とする。承認トランザクションは旧行が `status='active'` かつ要求 `scope` と同一であることを条件に含め、不一致は `CONFLICT` / `FORBIDDEN_SCOPE` で全巻き戻しとする。同時に到達した複数の訂正承認は条件付き UPDATE の更新行数で勝者 1 件のみとし、敗者は `CONFLICT` とする。
- **アーカイブ:** `record.archive` は人手ターミナル操作（`--config`・呼出者指定 `--idempotency-key`・`--reason-code USER_ARCHIVED` 必須）のみとし、検索・想起対象からの除外フラグのみを立てる。`id` 照会時は scope 一致を検査し、不一致は `FORBIDDEN_SCOPE` とする。物理削除ではない。MVP では復帰操作を提供しない。操作自体は監査記録する（本文なし）。自動化 JSON 経由は `FORBIDDEN` とする。

### 14.8 監査（raw-text-free・提案）

- 人手操作（`approve/reject/archive`・訂正承認）・`candidate.create`・`record.correct-request`・`record.recall` の露出を `audit` + `exposures` に記録する。`admin.export` は MVP 外のため監査対象に含めない。
- 記録項目は `ts / op / targetId / code / scope / bytes / limit / runId / recallId / approver / approvedAt / token / reasonCode` 等のメタのみとし、記憶本文・クエリ原文・snippet 全文・シークレットを含めない。`reasonCode` は `USER_REJECTED` / `USER_ARCHIVED` の固定値のみとする。エラー `message` も固定テンプレのみとする。`runId` は呼出者指定の不透明相関子であり権限根拠にしない。`recallId` は CLI 採番の 1 照会 IDであり、`record.recall` 応答の `data.recallId` として返し、露出行（`exposures`）と監査行（`audit`）を突合できる。`ts/approvedAt` は UTC 正準ミリ秒表記とする。
- 監査・露出の書込み失敗は fail closed とし、本文なし成功応答を作らない（[§14.4](#144-スキーマ状態トランザクション冪等性提案)・[§14.10](#1410-制限タイムアウト失敗契約提案)）。

### 14.9 保持・エクスポート・削除（消去保証なし・提案）

- **候補 TTL とデータ保持の区別:** `expiresAt`（既定 72 時間・候補 TTL）は承認可能期間の上限であり、期限切れは `expired` への状態遷移であって削除ではない。期限切れ行・却下行・superseded/archived 行はいずれも保持する。保持期間・削除可否は U7 の正式決定事項であり、MVP 既定は **無期限保持・自動削除なし** とする。
- **エクスポート（U7 に延期）:** `admin.export` は MVP に含めない。ユーザ向け配布・外部送信の新設は [§13](#13-非目標) の非目標であり、保持・エクスポート・削除方針とともに U7 で定める。MVP はエクスポート API・JSONL 書出しを提供しない。
- **削除の誠実な表明:** 削除 API を提供しない。`archive` は削除ではない。SQLite ファイル削除・VACUUM による消去効果を保証しない。消去が必要な場合は別途 U7 で定める。

### 14.10 制限・タイムアウト・失敗契約（提案）

- 制限値は §14.6 の有界値 + `CLI 既定タイムアウト 5 秒 / SQLite busy_timeout 2 秒 / DB 最大 100MB（超過時は書込み拒否）` を起動時 config 化する。起動時に検証し、不正なら起動失敗とする。
- 失敗時契約：DB 利用不可・破損・タイムアウト時は空の成功応答を作らず `STORE_UNAVAILABLE` / `TIMEOUT` を返す。CLI の非ゼロ起動失敗・stdout 無出力も JSON エラーと同様に利用不可として扱う。呼び出し側（fake adapter 含む）は **記憶なしの通常応答に縮退** し、記憶欠落を生成失敗の理由にしない。診断は固定コードのみとする。
- 有界応答・DB 満杯・監査失敗は fail closed: 応答合計超過は `LIMIT_EXCEEDED`、DB 上限超過・監査/露出書込み失敗は書込み・照会とも失敗させ、`STORE_UNAVAILABLE` で返す。`record.recall` も例外としない（無監査の想起成功を返さない）。
- commit 対 timeout の未知結果は冪等再送で解決する（[§14.4](#144-スキーマ状態トランザクション冪等性提案)）。呼出者は timeout 後に同一キーで再送し、`deduplicated` で確定させる。

### 14.11 受入ケース（期待結果付き・提案・未実施）

| ID | ケース | 期待結果 |
| --- | --- | --- |
| A1 | 未承認候補の想起漏洩なし | `candidate.create` 直後に `record.recall` しても当該内容が出ない |
| A2 | 承認後想起 | 人手 `review` → `approve(--config/--id/--token/--idempotency-key + TTY対話yes)` → `record` 作成 → `recall` で固定順序・有界内に `recallId + snippet+truncated` 付きで出現する |
| A3 | 承認の不変拘束 | 誤 `token` / 誤 `bodyHash` 系の `approve` は `CONFLICT`、record を作らない。全不変 field 改変時の拒否を含む |
| A4 | 期限 | `expiresAt` 後の `approve` は `EXPIRED`、状態は `expired`。行は削除されず残る |
| A5 | 冪等性 | 同一 `idempotencyKey` + 同一 params 再送は `deduplicated:true` で同一結果、params 改変再送は `CONFLICT`。キー欠落の書込は `BAD_REQUEST` |
| A6 | 決定論・有界 | 同一 `recall` は同一順序、超過入力・超過応答は `LIMIT_EXCEEDED` で切詰めなし。正常範囲の `snippet` は前方投影 + `truncated` を返す |
| A7 | 訂正・除外 | 承認済み訂正で旧 record は `superseded` となり想起に出ない。`archive` 後も想起に出ない |
| A8 | 監査・縮退 | audit・exposures・エラー応答に本文原文を含まない。DB 不可時・CLI 非ゼロ起動失敗・stdout 無出力時は `STORE_UNAVAILABLE` を返し、fake adapter 経由の応答は記憶なしで継続する。`recall` の監査失敗も成功にしない |
| A9 | 認可・経路分離 | 自動化 JSON からの `approve/reject/archive` は `FORBIDDEN`。全 id 照会の `scope` 不一致は `FORBIDDEN_SCOPE`。`actor` 自己申告・自然言語文では承認・許可しない |
| A10 | 訂正競合 | 同一旧 record への並行承認は勝者 1 件のみ、敗者は `CONFLICT`。旧行が非 active・scope 不一致の承認は失敗し巻き戻す |
| A11 | 冪等ロールバック・再起動 | コミット前失敗後の同一キー再送は新規実行を `deduplicated:false` で行い、確定済み応答喪失後の同一キー再送は `deduplicated:true` で回収できる。期限後の確定済みキー再送は元の確定応答を返す。DB 再起動後も `operations` の保存応答が安定再生される |
| A12 | scope 露出分離 | 他 scope の record は `recall` に出ない。`audit/exposures` の `scope/runId/recallId` で露出範囲を突合できる |
| A13 | オーバーフロー | `body/query/tags/limit/応答合計` の超過は各々 `LIMIT_EXCEEDED`。絵文字・結合文字を含む入力でもコードポイント数・UTF-8 境界を壊さない |

### 14.12 実装タスク順序（提案）

1. T1: 別リポジトリ雛形 + Node LTS pin（engines・ロック・CI 記録）/ TypeScript / SQLite + CLI 封筒・固定エラーコード・起動時 config（scope・上限・期限・タイムアウト）+ `scopes` 初期投入。
2. T2: `candidates` 永続化（`supersedes`・`requestHash` 含む）+ `candidate.create/get` + 人手 `review/approve/reject` + 全 field bind token・期限・呼出者指定冪等キー・単一トランザクション。
3. T3: `records` 追記 + `record.recall`（正規化・リテラル一致・固定順序・有界投影）+ 露出監査（本文なし・fail closed）。
4. T4: `record.correct-request/archive` の最小意味 + 同一 scope・active 条件・勝者 1 件の状態遷移 + 監査。
5. T5: 保持既定の文書化（TTL と保持の区別・削除なし・消去保証なしの明記。エクスポートは U7 対応とし MVP 実装なし）。
6. T6: fake adapter（CLI 呼び・縮退確認用）+ A1〜A13 の受入実行（fake 会話 + seeded 承認済み記憶、実ユーザデータ不使用）。

---

## 15. 採用記録（ユーザ承認済み・T1 時点）

- **承認 (approved):** §14 MVP 推奨案の採用、実装リポジトリ = 本ディレクトリ（remind）、スタック Node.js Supported LTS + TypeScript + SQLite + 単独 CLI JSON + fake adapter、Companion 変更なし。
- **pin（T1 verified）:** Node.js v24.12.0 / npm 11.6.2 / `engines >=24.12.0 <25` / TypeScript 5.9.3 / SQLite は Node 組込 `node:sqlite`（runtime 依存ゼロ）。ロックファイル・CI（`.github/workflows/ci.yml`, node 24.12.0）に記録。
- **T1 実装範囲:** CLI 封筒・固定エラーコード・起動時 config 検証・`scopes` 初期投入・有界（要求 32768B / `responseMaxBytes`）のみ。`candidate.*` / `record.*` ドメインは未実装であり、CLI は `data.domain:"not-implemented"` を正直に返す（T2–T4 で対応）。
- **テスト:** `npm test`（tsc + node:test、15 件合格）— config 厳格検証・封筒/`BAD_REQUEST`・有界/`LIMIT_EXCEEDED`・人手 op の `FORBIDDEN`・CLI smoke（scopes seed・起動失敗の非ゼロ終了・stdout 無出力）。
- **未解決のまま:** Companion 連携契約（U11）を含む U1–U11 の正式決定、A1–A13 受入（T6）、T2–T6 ドメイン。本文書の実装・テスト済み主張は T1 範囲に限定し、§1–§13 の planning-only 位置づけを維持する。
