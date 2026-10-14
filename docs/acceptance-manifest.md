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
- R06 露出上限の原子性は `tests/r06-exposure-cap.test.ts` (2 件) で確認する。実 recallId でちょうど 1000 行 (複数件露出・複数 scope・同一時刻の rowid タイ) を満たし、超過分は最古から逐語タプルで刈り込む。完全/部分消去・混合の新規 feedback は `NOT_FOUND` で台帳不変、保持分は一度だけ heat し別キーは二重 heat しない。消去前の保存済み feedback は同一キー+同 params で `deduplicated` 再送成功 (heat/usage/audit/operations 追加なし)、新規キーは `NOT_FOUND`。満杯時の exposures DELETE 拒否は `STORE_UNAVAILABLE` で全行スナップショット不変・トランザクション終了、解除後の再送で上限 1000 のまま heat なしで成功する。DB・vault は temp 配下のみで終了時に除去する。
- R07 耐久回復は `tests/r07-projection-recovery.test.ts` (3 件) で確認する。失敗キューは close+reopen を跨いで永続し、独立 future 行の metadata/no-Markdown 不変を保ったまま due 行のみ drain して links/backlinks を復元し、後に future 行も due 化して完全回復する。実 rename 段階失敗は同一宛先の既存 regular 最終 Markdown に対する scoped `fs.renameSync` primitive fault (tmp 書込み後の exact-dest 失敗、platform 非依存) で確認し、旧 bytes 不変・queue 保持・再 drain で新正準 render に復元する。削除/破損後の rebuild は recall+feedback で事前 populated な 8 列 exposures/usage/heat を含む正本全行内容 (counts ではなく全行、派生 queue/index を除く) が不変で、各 vault が正準 render と完全一致し、既存 exposure は有効のまま二重 heat しない。rebuild CLI/daemon は新設しない。
- R08 実子プロセス CLI 境界・リプレイは `tests/r08-cli-boundary-replay.test.ts` (9 件) で確認する。先行 LF は stdin close 前に単一有界 JSON、EOF 無改行・既缓冲の非空白追加入力・保持無改行 TIMEOUT/exit (cliMs に対する有界 assert、orphan なし)・fatal UTF-8・32768 境界/超過・保持 multibyte (20000 文字/40000 バイト、LF/EOF なし) の streaming byte cap による `LIMIT_EXCEEDED`・spawn 前ロックの起動 busy 失敗後に同キー+同 params 再送で正準効果ちょうど 1 件→deduplicated replay・起動 ready 後の post-startup ロック下での実 worker (positive threadId の BEGIN 到達) 親 TIMEOUT+exit 後に同キー再送で正準効果ちょうど 1 件→deduplicated replay を確認する。TIMEOUT の未知結果は rollback 主張しない。DB・vault は temp 配下のみで終了時に除去する。
- R08 包装 bin 契約は `tests/r08-bin-entry.test.ts` (1 件) で確認する。manifest bin 解決の platform 対応 launcher (POSIX symlink/.cmd) 経由で event.append 永続・remember/get 往復・同キー replay が正準効果ちょうど 1 件→deduplicated となる。build は外部 chmod なし (Node fs.chmodSync、win32 guard)。DB・vault は temp 配下のみで終了時に除去する。
- 書込み永続化失敗時の巻戻しは `tests/m1-rollback.test.ts` で確認する。audit/operations の INSERT 拒否で 5 操作 (`event.append`・`remember`・`feedback`・`correct`・`archive`) とも `STORE_UNAVAILABLE`・正本/heat/usage/links/sourceRefs/status 不変・operations/成功 audit 残留なし、解除後の再送で 1 件のみ確定する。DB・vault は temp 配下のみで終了時に除去する。A4 の逐次 lifecycle coverage と区別し、R05 全項目や M2/M3 の完了を主張しない。
- R05 同一正本への同時訂正競合は `tests/m1-recall.test.ts` の共有ファイル競合試験 (2 件) で確認する。2 本の実 worker スレッドが各々の実 DatabaseSync で native BEGIN rendezvous (常時 OK authorizer) し、ちょうど 1 件 OK/1 件 CONFLICT、勝者の正準/ref/link/heat/operation/成功 audit のみ残留し、敗者の body/ref/link/operation/成功 audit はゼロである。ready/done の settled outcome は起動直後に束縛し (noop catch ではなく実 error 伝搬)、失敗 cleanup で全 settlement を消費し、同期 spawn 失敗時は先行 worker の promise を残さない。failure-edge は無効 temp DB path での実 SQLite open 失敗 (ready 前) を同一 lifecycle で確認し、primary error は settled await (bare throw なし)・両 completion 消費・両 worker 実 exit・fixture 除去となる。両 worker は exit 後に temp を除去する。逐次 replay 試験と重複させない。
