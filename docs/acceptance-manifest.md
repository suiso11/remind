# M1 受け入れマニフェスト (7 件)

対象: `tests/acceptance.test.ts` (`npm run acceptance`)。自動のみで手動 TTY 工程はない。旧 A1-A13 体系は廃止し、以下 A1-A7 を正とする。

| ID | 内容 | 対応する計画受入 (plan.md §9) |
| --- | --- | --- |
| A1 | 新規 v2 ストアが残滓なく起動する (`user_version=2`、旧承認痕跡なし) | R12 (単一正本・再構築の前提) |
| A2 | 旧承認スキーマ DB は起動失敗し、変更・削除・移行しない (退避して新 DB を指定) | R11 (縮退・安全な失敗)、R12 |
| A3 | `event.append` -> 有効 `sourceRefs` 付き `record.remember` -> 直後の `record.recall/get/list` で内容が現れる。承認待ちなし | R1 (自律即時性)、R4 (raw 下降・snippet のみ)、R10 (有界・決定論)、R8 (source 検証・分離の一部) |
| A4 | `record.feedback` で露出分のみ計数し、`record.correct` で旧版が `superseded` となり、`record.archive` 後に想起から除外される。行は保持 | R5 (訂正・並行時勝者 1 件)、R6 (アーカイブ除外・非削除)、R8 (露出検証・分離) |
| A5 | CLI が M1 操作を提供し、旧世代操作 (`candidate.create`、`candidate.get`、`approve`、`review`、`record.correct-request` 等) を `BAD_REQUEST` で拒否する | R2 (承認残滓なし)、R7 (書込系の鍵検証の一部) |
| A6 | 監査・露出台帳に本文を含まず、超過入力に `LIMIT_EXCEEDED` を返す | R8 (本文非保持の監査)、R10 (予算超過は切詰めなし) |
| A7 | M2 ベクトル検索と M3 蒸留が存在しないこと (`record.vector-search`、`maintain.distill` 等は `BAD_REQUEST`) | R4 の縮退範囲 (語彙+グラフで動作)、R9・保守は M3 に延期 |

補足:

- R3 (複数リンク・backlink) と R7 (冪等: 同一キー再送は `deduplicated:true`、改変は `CONFLICT`、欠落は `BAD_REQUEST`) は `tests/m1-core.test.ts`・`tests/m1-recall.test.ts`・`tests/m1-hardening.test.ts` と A3-A5 で確認する。
- R9 (育成・`maintain.distill`) は M3 に延期。M1 の `record.feedback` は引用・採用の計数と露出検証の範囲のみ。
- R10 の決定論は同一の正本・索引・heat 状態に対する同一順序を指す。書込み・再構築後は変わり得る。
- R11 の呼出側縮退 (記憶なしの通常応答) と R12 の投影再構築は実装方針として保持し、自動試験の A1-A2・A6 と単体試験で確認する。
- M2 ベクトル意味検索と M3 `maintain.distill` は未実装であり、受入として主張しない。
