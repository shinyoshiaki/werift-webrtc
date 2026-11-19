## 背景・下流事例

[wolkesson/dronelink PR #63](https://github.com/wolkesson/dronelink/pull/63) は、Windowsで `MediaRecorder` によるWebM記録時にファイルの `append` / `open` / `write` などが、一時的なアンチウイルス・OSのファイルロック競合で `EBUSY` / `EPERM` を返し、録画が失敗する問題に対して限定リトライを追加しています。

- [下流のパッチ](https://github.com/wolkesson/dronelink/blob/main/patches/werift%2B0.24.4.patch)
- [該当PR](https://github.com/wolkesson/dronelink/pull/63)

## 現行コード

2026-11-19時点のv0.28.0 / `develop`：[ `packages/rtp/src/extra/processor/webmCallback.ts` ](https://github.com/shinyoshiaki/werift-webrtc/blob/v0.28.0/packages/rtp/src/extra/processor/webmCallback.ts) の `saveToFileSystem()` は、`value.saveToFile` の場合 `appendFile(path, ...)` を直接実行し、`value.eol` の場合 `open(path, "r+")` → duration/Cluster/Segmentサイズを書き換えてから `close()` しています。

- `EBUSY` / `EPERM` に対する限定リトライはない。
- eol中の途中 `write` / `stat` が失敗すると、`handler.close()` まで到達しない。ファイルハンドルは `finally` で解放する必要がある。
- WebM Cluster実サイズの書き換え自体は既存PR #791で実装済みであり、本件はファイルアクセス障害時の堅牢性に絞る。

## 修正設計

1. 再試行対象は**一時的なファイルアクセス衝突と判定可能なエラーのみ**（Windowsの `EBUSY` / `EPERM` など）とし、試行回数と総待ち時間に上限を設け、短いbackoffを使う。恒久的なアクセス拒否やディスクフルを無限再試行しない。
2. `open()` 後の処理は `try/finally` で `FileHandle.close()` を保証。closeエラーの扱いも規定する。
3. **`appendFile` 成功途中で障害が起きた場合、操作全体を無条件に再実行すると重複追記・WebM破損を生む可能性がある。** リトライを安全な境界（open前、実ファイルサイズ検査後の明示オフセット書き込みなど）に分けるか、再試行前後の整合性検査・ロールバックを設計する。
4. eolのduration / Cluster / Segmentサイズは固定オフセットへの冪等書き換えとし、失敗・再試行時もメタデータ整合性を保つ。
5. WebM以外の出力や既存の成功ケースの性能・動作を変えない。必要なら共通の安全なファイル操作ヘルパーへ切り出すが、抽象化を広げすぎない。

## テスト

- fs操作へ `EBUSY`/`EPERM` を一時的に注入して成功へ回復するユニットテスト。
- リトライ上限超過、恒久エラー(`EACCES`, `ENOSPC` など)、終了処理失敗のエラー伝播とリソース解放。
- 追記中の部分成功を想定し、ファイルサイズ・フレームの重複・Cluster/Segmentサイズの整合性を確認。
- Windows CIでファイル競合を模した統合テスト。生成WebMをパーサ・ffprobe等で検証（実行可能な環境で）。
- 通常経路に余計な待機が発生せず、録画終了・再開始の既存仕様に回帰がないこと。

## 完了条件

- 一時的なWindowsファイルアクセス競合で録画を不必要に失敗させない。
- 失敗時も未クローズのハンドルや無限リトライが残らず、ファイルの重複追記・破損を引き起こさない。
- 障害注入テストとWindowsでの回帰テストを追加し、下流独自パッチが不要になることを確認する。

関連：PR #791（WebM Clusterサイズ修正済み）、[#789](https://github.com/shinyoshiaki/werift-webrtc/issues/789)（別原因の録画先頭欠落）。