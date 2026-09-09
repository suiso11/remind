# 保持方針 (M1)

## 保持するもの・保持しないもの

- `raw_events` は不変の追記のみ。更新・削除はない。
- `records` は `active / superseded / archived` の行をすべて保持する。`record.correct` は新 revision 追記 + 旧版 `superseded`、`record.archive` は検索除外フラグであり、いずれも物理削除ではない。
- 削除 (消去) API とエクスポート API はない。SQLite ファイルの削除や `VACUUM` を消去保証として主張しない。保持期間・削除可否の方針決定は将来課題とする。
- 台帳 (`operations / audit / exposures / usage / note_heat`) は運用に必要な範囲で保持する。`exposures` は上限 1000 件で古い行から刈り込む。監査の失敗は操作全体を巻き戻す (監査なしの成功を作らない)。

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
