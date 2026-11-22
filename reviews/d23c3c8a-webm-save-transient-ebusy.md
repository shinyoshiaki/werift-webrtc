---
ide:
  viewer: review-document
  version: 1
  title: "WebM 保存の一時的な EBUSY 耐性と書き込み失敗の通知"
  dock: right
  baseCommit: f5bdd48e7756b3b11b9afe7457a748c836ed73a7
---
# WebM 保存の一時的な EBUSY 耐性と書き込み失敗の通知

## 1. 概要

`saveToFileSystem` を、追記（`appendFile`）から「各 chunk を自分のバイトオフセットに書く位置指定書き込み」へ変えました。`EBUSY` だけを上限付きで再試行します。再試行しても chunk が二重に書かれず、ファイルハンドルも漏れません。あわせて、WebM の書き込み失敗が unhandledRejection でプロセスを落とす問題を直し、Ogg と同じ `onError` 経路に揃えました。

native Windows はサポート対象外です。そのため Windows 固有の `EPERM` 再試行は入れていません。目的は、Linux（CIFS/SMB、FUSE、WSL2 の `/mnt`）で同種の一時エラーが起きたときに耐えることです。

対象コミットは `f5bdd48e7` です。

## 2. 修正前と修正後の流れ

<div style="display:flex;gap:12px;flex-wrap:wrap">
<div style="flex:1;min-width:300px;border:1px solid #c0392b;border-radius:8px;padding:10px">
<b style="color:#c0392b">Before</b>
<ol style="margin:6px 0;padding-left:18px;font-size:13px">
<li><code>saveToFile</code> → <code>appendFile(path, chunk)</code></li>
<li style="color:#c0392b">write 成功後に close が EBUSY → 呼び出し側が全体を再実行すると chunk が二重追記される</li>
<li><code>eol</code> → <code>open("r+")</code> → write/<code>stat</code> → <code>close</code></li>
<li style="color:#c0392b">途中の write/stat が throw → close に届かずハンドルがリークする</li>
<li style="color:#c0392b">saver の reject を誰も catch しない → unhandledRejection でプロセスが落ちる</li>
<li style="color:#c0392b"><code>unlink</code> 失敗は握りつぶし → 古い内容の後ろに追記され、絶対オフセットが狂う</li>
</ol>
</div>
<div style="flex:1;min-width:300px;border:1px solid #1e8449;border-radius:8px;padding:10px">
<b style="color:#1e8449">After</b>
<ol style="margin:6px 0;padding-left:18px;font-size:13px">
<li><code>WebmBase</code> が各 output に <code>position</code> を付与</li>
<li style="color:#1e8449"><code>retryTransientFsError(withFileHandle(open → writeAll(position) → close))</code>。位置指定なので再実行しても同じバイトが同じ場所に入る</li>
<li style="color:#1e8449">先頭 chunk は <code>"w"</code>（truncate）で開く。unlink 失敗でも既存ファイルを置き換える</li>
<li style="color:#1e8449"><code>eol</code> は <code>truncate(total)</code> → 固定オフセット上書き。<code>stat</code> に頼らず、全体を 1 単位として再試行</li>
<li style="color:#1e8449">失敗は <code>WebmCallback.onError</code> → <code>WebmFactory.onError</code> → <code>MediaRecorder.onError</code>。録画を停止し、プロセスは落ちない</li>
</ol>
</div>
</div>

図の要点: 赤が修正前の欠陥、緑が修正後の対処です。再試行の単位を「冪等な 1 回の open〜close」に取り、chunk の書き込み先を呼び出し回数ではなくオフセットで決めるのが核です。

## 3. 主要変更

### 3.1 一時エラーの限定リトライ

[packages/rtp/src/extra/processor/fsRetry.ts:1](review-file:packages/rtp/src/extra/processor/fsRetry.ts:1) は新規ファイルで、変更の核は [fsRetry.ts](review-diff:packages/rtp/src/extra/processor/fsRetry.ts) です。

- `EBUSY` だけを一時エラーとします。`EPERM` は POSIX では恒久エラーなので再試行しません。再試行対象は定数配列 `TransientFsErrorCodes` にまとめ、`process.platform` の分岐はありません。
- 最大 8 回、合計待ち時間 1 s 以内で打ち切ります。待ち時間は 20ms × n（合計 560ms）です。上限に達したら最後のエラーを `code` ごとそのまま throw します。初回成功時は待ちません。
- `withFileHandle` は handle を必ず 1 回だけ close します。本体が失敗したときは本体のエラーを優先し、close だけが失敗したときは close のエラーを throw します（一時エラーなら単位ごと再試行されます）。

### 3.2 WebM ファイルライター

[packages/rtp/src/extra/processor/webmFileWriter.ts:50](review-file:packages/rtp/src/extra/processor/webmFileWriter.ts:50) の `createWebmFileWriter` は新規ファイルです。差分は [webmFileWriter.ts](review-diff:packages/rtp/src/extra/processor/webmFileWriter.ts) です。

- chunk の書き込み先は `WebmOutput.position` です。無い場合は書き込み済みバイト数 `written` を使います。`written` は単位全体が成功した後でだけ進めます。
- オフセットが 0 なら `"w"`（truncate）で開き、既知なら `"r+"` で開きます。`O_APPEND` は使いません（Linux では位置指定が無視されるため）。
- `position` が無い旧来の出力は、先頭の initial chunk 以外ならファイル末尾の `stat` サイズに書き足します。外部利用者との互換のためです。
- eol では `truncate(total)` で失敗した試行の余りを落とし、Duration、各 Cluster サイズ、Segment サイズを固定オフセットへ上書きします。Segment サイズは `stat(path)` ではなく `total` から計算します。
- 一度失敗したら以降の出力は書かず、同じエラーを再度 throw します。直列化には `PromiseQueue` を使います。

### 3.3 `position` の付与と `saveToFileSystem`

- [packages/rtp/src/extra/processor/webm.ts:184](review-diff:packages/rtp/src/extra/processor/webm.ts:184) で `WebmOutput.position`（公開型への任意フィールド追加）を新設しました。`WebmBase` が initial / cluster / block / cuePoints / eol の各 output に設定します。
- Cues を書いた後に `this.position += cues.length` を足し、eol の `position` が出力全体の長さになるようにしました。
- [packages/rtp/src/extra/processor/webmCallback.ts:50](review-diff:packages/rtp/src/extra/processor/webmCallback.ts:50) で `saveToFileSystem` は `createWebmFileWriter` への薄い委譲になりました。`WebmCallback.onError` が、queue の reject を unhandledRejection にせず通知します。

### 3.4 MediaRecorder / WebmFactory

- [packages/webrtc/src/nonstandard/recorder/writer/webm.ts:87](review-diff:packages/webrtc/src/nonstandard/recorder/writer/webm.ts:87) で、書き込み失敗時に購読解除、RTP source 停止、`onEol` 発火（`stop()` が 5 s 待たないため）、`onError` 通知の順に処理します。
- 同ファイル [:161](review-file:packages/webrtc/src/nonstandard/recorder/writer/webm.ts:161) で、saver を出力ごとではなく録画 1 回につき 1 つ作ります。`written` を持つためです。
- RTP source の停止は `stopSources()` で 1 回に限ります。2 回目の eol が `LipsyncCallback` を壊すためです。
- [packages/webrtc/src/nonstandard/recorder/index.ts:89](review-diff:packages/webrtc/src/nonstandard/recorder/index.ts:89) で、WebM の `onError` を `MediaRecorder.onError` へ中継します（Ogg と同じ形です）。

### 3.5 changelog

[changelog.md](review-diff:changelog.md) に Unreleased の Bug Fixes を追加しました。

## 4. 判断理由

| 論点 | 採用 | 不採用とその理由 |
| --- | --- | --- |
| 二重追記の防止 | 位置指定書き込み | 「`stat` でサイズを検査して truncate してから再試行」は chunk ごとに `stat` が増え、冪等性も弱い |
| ハンドル管理 | chunk ごとに open/close | 録画中ずっと開いたままにする案は、eol が来ない場合（`destroy` など）にハンドルがリークする |
| 再試行対象 | `EBUSY` のみ | `EPERM` の再試行は POSIX では恒久エラーを待つだけになる。根拠のない errno（`EAGAIN` など）も先回りで足さない |
| 下流パッチ | 欠陥の根だけ取り込む | そのまま取り込むと二重追記とハンドルリークが残る。Windows の `EPERM` 再試行は下流の責務として残る |

## 5. レビュアーが確認すべき点とリスク

- **公開型の変更**: `WebmOutput.position` は任意フィールドの追加です。`WebmBase` を使わず `saveToFileSystem` に output を直接渡す利用者は `position` を持たないので、「`written` が 0 より大きい、または initial なら `written`、そうでなければ末尾のサイズ」というフォールバックで動きます。この挙動は [webmFileWriter.test.ts:250](review-file:packages/rtp/tests/processor/webmFileWriter.test.ts:250) で固定されています。
- **`saveToFileSystem` の寿命**: 1 つのライターは 1 回の録画で使います。同じインスタンスを複数の録画に使い回すと `written` が引き継がれます。`examples/save_to_disk/*` は録画ごとに生成する形か、確認してください。
- **I/O 回数**: chunk ごとに open/close が入ります（修正前の `appendFile` も内部では open/close）。性能が問題になれば、別チケットで handle 保持を検討します。
- **失敗後の挙動**: 失敗すると録画は停止し、`MediaRecorder.onError` で通知されます。以降の出力は書かれません。
- 実際の `EBUSY` は障害注入テストでしか再現していません（CIFS や FUSE での実機確認はしていません）。

## 6. 検証結果

テストの所在:

- ライター単体: [packages/rtp/tests/processor/webmFileWriter.test.ts:23](review-file:packages/rtp/tests/processor/webmFileWriter.test.ts:23)（close の EBUSY、部分書き込み後の EBUSY、eol の EBUSY、上限到達、body と close のエラー優先、失敗後は書かない、先頭 chunk による既存ファイルの置換、position なし）
- 再試行ヘルパー: [webmFileWriter.test.ts:288](review-file:packages/rtp/tests/processor/webmFileWriter.test.ts:288)（`EAGAIN` を既定では再試行しない）
- MediaRecorder: [packages/webrtc/tests/nonstandard/recorder.test.ts:454](review-file:packages/webrtc/tests/nonstandard/recorder.test.ts:454)（書き込み失敗が `onError` に届き、クラッシュしない）、[:498](review-file:packages/webrtc/tests/nonstandard/recorder.test.ts:498)（`unlink` できない既存ファイルの置換）

このドキュメント作成時に実行した検証:

- `cd packages/rtp && npx vitest run tests/processor/webmFileWriter.test.ts`: 1 ファイル、19 テスト通過。

未実行（このドキュメント作成では実行していません）: `packages/webrtc` の recorder テスト、`npm run type`、`npm run test:small`、`npm run ci`、実機の CIFS/FUSE での確認。
