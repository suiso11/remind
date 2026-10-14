# M1 受け入れマニフェスト (7 件) + M2/M3 到達記録

対象: `tests/acceptance.test.ts` (`npm run acceptance`)。自動のみで手動 TTY 工程はない。旧 A1-A13 体系は廃止し、以下 A1-A7 を正とする。M2 セマンティック検索と M3 育成保守は到達済みであり、A7 の旧文言（不存在主張）は更新した。`plan.md` §9（R1–R13）が正本である。

| ID | 内容 | 対応する計画受入 (plan.md §9) |
| --- | --- | --- |
| A1 | 新規 v2 ストアが残滓なく起動する (`user_version=2`、旧承認痕跡なし) | R12 (単一正本・再構築の前提) |
| A2 | 旧承認スキーマ DB は起動失敗し、変更・削除・移行しない (退避して新 DB を指定) | R11 (縮退・安全な失敗)、R12 |
| A3 | `event.append` -> 有効 `sourceRefs` 付き `record.remember` -> 直後の `record.recall/get/list` で内容が現れる。承認待ちなし | R1 (自律即時性)、R4 (raw 下降・snippet のみ)、R10 (有界・決定論)、R8 (source 検証・分離の一部) |
| A4 | `record.feedback` で露出分のみ計数し、`record.correct` で旧版が `superseded` となり、`record.archive` 後に想起から除外される。行は保持 | R5 (訂正・並行時勝者 1 件)、R6 (アーカイブ除外・非削除)、R8 (露出検証・分離) |
| A5 | CLI が M1 操作を提供し、旧世代操作 (`candidate.create`、`candidate.get`、`approve`、`review`、`record.correct-request` 等) を `BAD_REQUEST` で拒否する | R2 (承認残滓なし)、R7 (書込系の鍵検証の一部) |
| A6 | 監査・露出台帳に本文を含まず、超過入力に `LIMIT_EXCEEDED` を返す | R8 (本文非保持の監査)、R10 (予算超過は切詰めなし) |
| A7 | M2 は想起内融合として出荷（新規 op なし、欠落時は語彙+グラフ縮退）。M3 `maintain.distill` は書込 op として存在する（単独ベクトル op は `BAD_REQUEST` のまま） | R4 の縮退範囲、R9・R13・保守育成（M3 到達、下記） |

計画と実装の分離:

 - R9 は `record.feedback` の引用・採用の計数と露出検証に加え、M3 の可逆引退・LLM 判定・関連記憶見直し・明示的検索・再活性化の最小実証を含む（`tests/m3-state.test.ts` 23 件：回帰 9 件含む + 実モデル `npm run smoke:m3`、相互ペアは 1 要約のみ）。
- R13（育成方針の文書化）は `plan.md` §2・§5–§7・§9–§10・§12 と `docs/retention.md` の整合の確認に留め、動作試験の合否にはしない。
- `superseded`（旧版履歴）・終端 `archived` と可逆 `retired` を区別する。`archived` を可逆扱いにしない。`archived` の明示的検索範囲は未決定であり黙って決めない。

補足:

- R3 (複数リンク・backlink) と R7 (冪等: 同一キー再送は `deduplicated:true`、改変は `CONFLICT`、欠落は `BAD_REQUEST`) は `tests/m1-core.test.ts`・`tests/m1-recall.test.ts`・`tests/m1-hardening.test.ts` と A3-A5 で確認する。
- R5 の shared-file DB 並行訂正は `tests/m1-recall.test.ts` と `tests/fixtures/correction-race-worker.ts` で追加確認する。両 worker が独立 connection で同じ temp M1 DB の active 旧版を確認した後、実 SQLite `BEGIN` の barrier で同時開始し、成功 1 件・`CONFLICT` 1 件、旧版 `superseded`・active 新 revision 1 件、敗者の `ROLLBACK` と revision/sourceRefs/links/operations/成功 audit の残留なしを検証する。
- R9 (育成・`maintain.distill`・可逆引退) は M3 で到達。M1 の `record.feedback` は引用・採用の計数と露出検証の範囲のみ。
  - M3 到達の証拠: `tests/m3-state.test.ts`（遷移・冪等・分離・巻戻し・キュー・単一 flight・cancel・再利用・適用・移行・二段階ゲート safeguard・相互ペア重複排除・回帰 9 件の 23 件）、実モデル CLI スモーク `npm run smoke:m3`（retire/reactivate 往復、recall 除外・search 取戻し・heat 不変、実モデル drain による一過性気分の実際の引退 1＋近似重複の実際の統合 1（重複サマリなし）＋耐久事実・不確実記録の保全、同一キー再送の `deduplicated`、欠落モデルの縮退、他者 lease 下の `CONFLICT`、cancel）。CLI 並行の同一キー drain は drain 中 `CONFLICT`・完了後 `deduplicated`（実モデル確認）、degraded 並行は先勝 drain＋後発 `deduplicated` に直列化する。回帰全体は `npm test` 91 件。
- M2 到達の証拠: `docs/m2-eval.json`（合成 8 記憶・4 probe、融合 hit@1 1.0、縮退 4/4 一致）、`npm run smoke:semantic`、`npm run eval:m2`。
- R10 の決定論は同一の正本・索引・heat 状態に対する同一順序を指す。書込み・再構築後は変わり得る。
- R11 の呼出側縮退 (記憶なしの通常応答) と R12 の投影再構築は実装方針として保持し、自動試験の A1-A2・A6 と単体試験で確認する。
- M2 ベクトル意味検索と M3 `maintain.distill`・育成引退一式は到達済みであり、上記の通り受入として主張する。
- 書込み永続化失敗時の巻戻しは `tests/m1-rollback.test.ts` で確認する。audit/operations の INSERT 拒否で 5 操作 (`event.append`・`remember`・`feedback`・`correct`・`archive`) とも `STORE_UNAVAILABLE`・正本/heat/usage/links/sourceRefs/status 不変・operations/成功 audit 残留なし、解除後の再送で 1 件のみ確定する。DB・vault は temp 配下のみで終了時に除去する。A4 の逐次 lifecycle coverage と区別し、R05 全項目や M2/M3 の完了を主張しない。
- グラフ表示 (§14.5 の実装・R12 派生投影の範囲): `npm run rebuild:graph` が単一 scope の有界オフライン HTML (`<vault>/graph.html`) を再構築する。受入 gate ではなく記録に留める。証拠は `tests/graph-view.test.ts` 8 件 (scope 分離・active 既定/明示 retired/history・辺種別・dangling 標識・XSS・LIMIT+1 超過・byte 上限・決定論・正本不変)＋合成 CLI スモーク (既定 4 ノード/3 辺・全状態 6 ノード/4 辺、前後正本一致、超過時 prior view 保持)＋実 headless ブラウザでの描画・選択・filter・検索・無通信確認。raw 本文の埋め込み・`record.search` 拡張・`archived` 復活はしない。
