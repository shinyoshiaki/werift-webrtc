# [MediaRecorder] WebM保存時の一時的なファイルアクセスエラー（EBUSY）に耐える書き込み・終了処理を実装する

> **位置づけ**: native Windows は werift のサポート対象外（ルート `AGENTS.md`）であり、本チケットでも Windows 対応は行わない。下流の Windows 事例は「ファイルアクセスの一時的な衝突で WebM 保存が壊れる／プロセスが落ちる」という問題の発見元として扱い、**同種の問題が Linux 環境（サポート対象）で起きたときに対処できる**ようにすることを目的とする。Windows 固有の挙動（win32 の `EPERM` 再試行、Windows CI、Windows 実機確認）は対象外。

## 1. 目的と背景

### 下流事例

[wolkesson/dronelink PR #63](https://github.com/wolkesson/dronelink/pull/63)（2026-08-27 merge）は、Windows で `MediaRecorder` が WebM を記録している途中に、アンチウイルスや OS のファイルロック競合で `EBUSY` / `EPERM` が返り、プロセスがクラッシュする問題を `patch-package` で回避している（[パッチ](https://github.com/wolkesson/dronelink/blob/main/patches/werift%2B0.24.4.patch)）。

下流パッチの WebM 部分の要約:

```js
async function retryOnTransientFsError(fn) {
  const maxAttempts = 8;                       // 初回 + 7 回
  for (let attempt = 1; ; attempt++) {
    try { return await fn(); }
    catch (err) {
      const retryable = err && (err.code === "EBUSY" || err.code === "EPERM");
      if (!retryable || attempt >= maxAttempts) throw err;
      await new Promise((r) => setTimeout(r, 20 * attempt)); // 線形 20..140ms, 合計 560ms
    }
  }
}
// saveToFile: retryOnTransientFsError(() => appendFile(path, chunk))   ← append 全体を再実行
// eol:        retryOnTransientFsError(async () => { open → write → stat → write → close })  ← try/finally なし
```

このパッチには次の問題があるため、そのまま取り込まない。

- `appendFile` 全体を再実行するので、書き込みが成功した後の close 失敗や部分書き込みで、同じ chunk が二重に追記されうる。
- eol の再試行では、試行ごとに open した `FileHandle` を close しないまま次の試行に進み、ハンドルがリークする。
- 0.24.4 ベースなので、Cluster サイズの書き換え（PR #791）が入っていない。
- `EPERM` を全プラットフォームで再試行している。POSIX の `EPERM` は恒久エラー。

本チケットでは、下流パッチの Windows 固有部分は取り込まない。下流事例から読み取れる **OS に依存しない欠陥**（重複追記しうる書き込み、ハンドルリーク、エラー経路の欠落によるクラッシュ、`unlink` 失敗時の追記）を werift 本体で直し、Linux で一時的なファイルアクセス衝突が起きたときに耐えられるようにする。下流パッチ全体を不要にすることは目標にしない（Windows の `EPERM` 再試行は下流側の責務として残る）。

### Linux で同種の問題が起きうる場面

Linux のローカルファイルシステム（ext4 / xfs など）では、通常ファイルへの `open` / `write` / `close` が一時的な `EBUSY` を返すことはほぼない。起きうるのは主に次のような、ファイルシステムの実装やリモート側の状態に依存する場合:

- CIFS/SMB マウント: サーバー側（Windows 共有など）で別プロセスがファイルを開いていると、共有違反（`STATUS_SHARING_VIOLATION`）が Linux 側で `EBUSY` として返る。
- FUSE ファイルシステム（クラウドストレージ同期、sshfs など）: 実装が任意の errno を返せるので、同期中に一時的な `EBUSY` を返すことがある。
- WSL2 の `/mnt/<drive>`（Windows 側ボリューム）: Linux 上の Node から見ても、Windows 側のアンチウイルスやインデクサーによるロックの影響を受けうる。返る errno は環境依存なので、本チケットでは `EBUSY` として観測された場合だけを扱う。

いずれも頻度は低く再現も難しいので、**障害注入テストで振る舞いを固定する**ことを主な検証手段とする。また、一時エラーの有無にかかわらず、書き込み失敗でプロセスが落ちないこと（エラー経路の整備）は Linux でもそのまま価値がある。

### 現行コード（2026-11-19, `develop` / v0.28.0）

`packages/rtp/src/extra/processor/webmCallback.ts` の `saveToFileSystem(path)`:

| 分岐 | 処理 | 問題 |
| --- | --- | --- |
| `value.saveToFile` | `appendFile(path, chunk)` | 再試行がない。append 全体を再実行すると重複追記になる |
| `value.eol` | `open(path,"r+")` → Duration 書き換え → 各 Cluster のサイズ書き換え → `stat(path)` → Segment サイズ書き換え → `close()` | 再試行がない。途中の `write` / `stat` が throw すると `close()` に届かず、ハンドルがリークする |

調査で分かった関連事実:

- **WebM のエラー経路がない。** `WebmBase` の `output` は `=> void` 型で、戻り値の Promise を await しない。`WebmCallback` は `queue.push(() => cb(output))` の reject を catch しない。`WebmFactory`（`packages/webrtc/src/nonstandard/recorder/writer/webm.ts`）にも `onError` がない。このため WebM の書き込みに失敗すると **unhandledRejection になり、Node のデフォルト設定ではプロセスが落ちる**。下流で "crashes the ground process" と言われているのはこれ。Ogg 側（`OggCallback.onError` → `OggFactory.onError` → `MediaRecorder.onError`）は対応済みで、`recorder.test.ts` の "reports a write failure through onError and stops without crashing" で検証されている。
- `WebmFactory` は出力ごとに `saveToFileSystem(this.props.path)(o)` を呼び、saver を毎回作り直している。そのため saver 内の `PromiseQueue` も状態も 1 回の呼び出しで捨てられる。直列化は `WebmCallback` の queue がしているので現状は動くが、saver に書き込みオフセットなどの状態を持たせるなら、録画 1 回につき 1 インスタンスに直す必要がある。
- `WebmFactory.start()` は `unlink(path).catch((e) => e)` で既存ファイルを消してから append する。既存ファイルの `unlink` が失敗すると（Linux でもディレクトリに書き込み権限がない場合や、CIFS 上でロックされている場合に起きうる）、エラーは握りつぶされ、**古い内容の後ろに追記される**。eol の書き換え位置は出力先頭からの絶対オフセット（`DurationPosition=83`、`SegmentSizePosition=40`、`clusters[].position`）なので、ファイルが壊れる。Ogg は最初の書き込みを `writeFile`（truncate）にしてこれを解決済み（`saveOggToFileSystem`）。
- `WebmBase.position` は initial / cluster / block の出力ごとに chunk 長だけ進む。Cues は最後に書かれ、`position` は進まない。saver が書き込んだバイト数を数えれば、各 chunk の書き込み先オフセットは一意に決まる。
- 参考: libuv の Windows エラー変換は `ERROR_SHARING_VIOLATION` / `ERROR_LOCK_VIOLATION` → `EBUSY`、`ERROR_ACCESS_DENIED` → `EPERM`。下流パッチが `EPERM` も再試行しているのはこのため。ただし Linux（POSIX）の `EPERM` は恒久的な権限エラーなので、本チケットでは再試行しない。
- ルートの `AGENTS.md` では、native Windows はサポート対象外で、CI（`.github/workflows/nodejs.yml`）は `ubuntu-latest` のみ。本チケットもこの方針に従う。
- `saveToFileSystem` は `werift-rtp` の公開 API（`extra/processor/index.ts` から export）で、`examples/save_to_disk/*`（`pipeline.ts`, `h264.ts`, `dtx/server.ts`, `encodedTransform/server.ts`）と `packages/rtp/tests/utils.ts`（`recordWebm`, `recordVp8RtpToWebm`）から使われている。
- Cluster サイズの実値書き換えは PR #791 で実装済み。本件はファイルアクセス障害への耐性だけを扱う。録画先頭の欠落 #789 は原因が別なので対象外。

## 2. 実装する変更

### 2.1 一時エラー用の限定リトライヘルパー（`packages/rtp/src/extra/processor/` 内、非公開）

- 例: `retryTransientFsError<T>(op: () => Promise<T>, options?): Promise<T>`
- 一時エラーの判定:
  - `EBUSY` だけを再試行する。プラットフォームによる分岐（`process.platform` の判定）は入れない。
  - `EPERM` は再試行しない（POSIX では恒久的な権限エラー）。
  - それ以外（`EACCES`, `ENOSPC`, `EROFS`, `ENOENT`, `EISDIR`, `EMFILE` など）も即 throw する。
  - 再試行対象の errno は module 内の定数（例: `TRANSIENT_FS_ERROR_CODES = new Set(["EBUSY"])`）にまとめる。Linux で別の一時エラー（例: NFS / FUSE での `EAGAIN`）が実際に観測されたら、ここに足すだけで済む形にしておく。根拠のない errno を先回りして足さない。
  - テストのため、判定関数を内部 options で注入できるようにする。
- 上限: 最大試行回数（目安 8 回）と総待ち時間（目安 1 s 以内）の両方で打ち切る。backoff は短くする（例: 20 ms × attempt、線形または上限付き指数）。上限を超えたら**最後のエラーをそのまま throw** する（`code` を保つ）。
- 通常経路（初回成功）では `setTimeout` などの待機をしない。
- 定数は module 内に置き、公開オプションにはしない（抽象化を広げない）。

### 2.2 WebM 追記の冪等化（重複追記の防止）

推奨: `appendFile` をやめて、**既知オフセットへの位置指定書き込み**にする。

1. saver は書き込み済みバイト数 `written` を持つ。
2. chunk ごとに 1 つの単位としてリトライする。
   1. `open(path, written === 0 ? "w" : "r+")`。最初の chunk は truncate し、Ogg と同じく `unlink` が失敗した既存ファイルも置き換える。
   2. `handle.write(buf, off, len, written + off)` を、全バイトが書けるまでループする。
   3. `finally` で `handle.close()` を呼ぶ。
3. 位置指定書き込みは同じ位置に同じバイトを書くので、再実行しても結果は変わらない。close が失敗した場合や、部分書き込みの後に再試行した場合も、重複追記は起きない。
4. 単位全体が成功してから `written += buf.length` する。
5. `"a"`（O_APPEND）は使わない。Linux では位置指定が無視されて追記になるため。

代替案（不採用の理由つき）:

- 「`stat` でサイズを検査して、`written` / `written+len` / 中間なら truncate してから再試行」: chunk ごとに `stat` が 1 回増える。冪等性も位置指定書き込みより弱い。
- 「録画中は 1 つの `FileHandle` を開いたままにする」: open/close の回数が減り、AV スキャンのきっかけも減る。ただし、eol が来なかった場合（`destroy`、外部利用者が eol を流さない場合）にハンドルがリークする。公開 API の寿命管理も変わる。今回は採用せず、性能上の理由が出たら別チケットにする。

### 2.3 eol 処理の堅牢化

- 次の手順全体を 1 つの単位としてリトライする。各試行で、`open` に成功したら必ず `finally` で `close()` する。
  1. `open(path, "r+")`
  2. Duration（`DurationPosition`）、各 Cluster（`position + ClusterSizeOffset`）、Segment（`SegmentSizePosition`）を固定オフセットへ書き込む
  3. `close()`
- 書き込みはすべて固定オフセットへの上書きなので、再実行しても結果は同じ。
- Segment サイズは `stat(path)` ではなく saver が持つ `written` から計算する。`handle.truncate(written)` で、失敗した試行が残した余分なバイトがあれば取り除く。`stat(path)` を別に呼ぶのはファイルアクセス 1 回分の無駄で、パスで再オープンして失敗する余地にもなる。`written` を持たない呼び出し方を残すなら、`handle.stat()`（fstat）を使う。
- close エラーの扱い:
  - 本体の処理が成功し、close だけが失敗した場合: close の失敗が一時エラーなら、単位ごと再試行する（冪等なので安全）。恒久エラーなら throw する。
  - 本体の処理が失敗した場合: 本体のエラーを優先して throw する。close のエラーで上書きせず、握りつぶすか `cause` に添える。
  - close を 2 回呼ばないようにする。

### 2.4 WebM 書き込み失敗の通知経路（Ogg と揃える）

- `WebmCallback` に `onError = new Event<[Error]>()` を追加する。`queue.push(...).catch((e) => this.onError.execute(e))` で、unhandledRejection を防ぐ。
- `WebmFactory` に `onError` を追加する。失敗したら購読解除、`rtpSources` の停止、`onEol.execute()`（`stop()` が 5 s 待たないようにする）、`onError.execute(error)` の順に処理する。
- `MediaRecorder` の `case "webm"` で `writer.onError` を `this.onError` へつなぐ。
- `WebmFactory` では `saveToFileSystem(path)` を録画 1 回につき 1 回だけ作り、`written` を保持できるようにする。
- 一度失敗した後は、以降の chunk を書かない（ファイル末尾を不整合にしない）。

### 2.5 互換性

- `saveToFileSystem(path)` のシグネチャと戻り値（`Promise<boolean>`、eol のとき `true`）は変えない。
- 振る舞いの変更点（changelog に書く）:
  - 最初の chunk で既存ファイルを truncate する（`unlink` が失敗したケースが直る）。
  - 一時的なファイルアクセスエラー（`EBUSY`）を限定回数だけ再試行する。
  - 恒久エラーは従来どおりすぐ失敗する。
  - `MediaRecorder` の WebM 書き込み失敗は `onError` に通知され、プロセスは落ちない。
- 外部利用者が出力ごとに `saveToFileSystem(path)` を作り直す使い方（従来の `WebmFactory` と同じ）でも壊れないかを確認する。`written` が失われるとオフセットを決められないので、次のどちらかを実装時に選ぶ。
  - (a) 位置情報を `WebmOutput` に追加する（例: optional の `position`、加算的変更）。
  - (b) state がないときは `handle.stat()` のサイズをオフセットとして使う。
- 推奨は (a)。`WebmBase.position` がそのまま使え、saver の状態に依存しない。
- Ogg（`saveOggToFileSystem`）と MP4（`MP4Callback.saveToFileSystem`）には手を入れない。ヘルパーを共有できる形にはしておくが、適用は別チケットにする。

## 3. 技術的アプローチ（まとめ）

| 論点 | 方針 |
| --- | --- |
| 再試行の対象 | `EBUSY` のみ（プラットフォーム分岐なし）。`EPERM` を含むそれ以外は即失敗 |
| 上限 | 試行回数（約 8）と総待ち時間（約 1 s）の両方。短い backoff。最後のエラーを `code` ごと throw |
| 追記の安全性 | `appendFile` を「`open`（`w`/`r+`）→ `written` 位置への位置指定 write → `finally close`」に置き換え、冪等にする |
| eol | 固定オフセットへの冪等な上書き。Segment サイズは `written` から計算し、`truncate(written)` する。試行ごとに `finally close` |
| close エラー | 本体のエラーを優先する。close だけの一時エラーは単位ごと再試行する |
| エラー通知 | `WebmCallback.onError` → `WebmFactory.onError` → `MediaRecorder.onError`（Ogg と同じ構造） |
| 通常経路 | 待機なし。syscall の数は append と同等（open/write/close） |
| テスト用の注入 | saver の内部実装（例: `createWebmFileWriter(path, { fs, isTransient, sleep })`）に fs 操作と sleep を注入できるようにし、公開の `saveToFileSystem` はそれを既定値で包む。注入できない場合は `vi.mock("fs/promises")` / `vi.spyOn` を使う（`packages/*/tests` に前例あり） |

## 4. 制約・注意点

- **Windows は対象外**: native Windows はサポート対象外（ルート `AGENTS.md`）なので、Windows CI の追加、Windows 実機での確認、win32 専用の分岐（`EPERM` 再試行など）は行わない。検証は Linux 上の障害注入テストで行う。
- Windows 対応をうたわない。changelog / docs / PR では「一時的なファイルアクセスエラー（`EBUSY`）を限定回数だけ再試行する」と事実だけを書き、「Windows で動くようになった」とは書かない。下流の Windows 事例は発見の経緯として PR に触れる程度にとどめる。
- 恒久エラーで待ちを増やさない。`EACCES` / `EPERM` / `ENOSPC` は再試行せず、即失敗する。`recorder.test.ts` の "reports an error when the existing file cannot be overwritten"（`EACCES` を期待し、`stop` は 1 s 未満）を回帰させない。
- `packages/rtp` の `src/index.ts` はブラウザでバンドル可能である必要があるが、`extra` は Node 専用（`packages/rtp/AGENTS.md`）。`process.platform` や `fs/promises` を使うのは `extra/processor` 内だけにする。
- Node の type stripping 制約（`enum` やパラメータプロパティを使わない）を守る。
- `stop()` → `onEol` の 5 s タイムアウトと、リトライの総待ち時間（約 1 s）が干渉しないようにする。eol の再試行中でも `stop()` は正しく完了を待てる必要がある。
- 再開始（`MediaRecorder` の新しい録画、同じ path での再録画）で、前回の saver の状態（`written`）を引き継がない。
- テストは Arrange / Act / Assert で書き、Act / Assert には日本語コメントを付ける。共有の Arrange は `packages/rtp/tests/utils.ts`、`packages/webrtc/tests/nonstandard/recorderTestUtils.ts` に置く。
- 公開 API / 振る舞いの変更なので、`changelog.md` を更新し、必要なら `npm run doc` で再生成する。`WebmOutput.position` を追加する場合は型ドキュメントも更新する。

## 5. テスト計画

### `packages/rtp/tests/processor/webm.test.ts`（または新規 `webmFileWriter.test.ts`）

| ケース | 期待 |
| --- | --- |
| 各 chunk の `open` / `write` / `close` に `EBUSY` を N 回（N < 上限）注入 | 成功に回復する。生成された WebM が「障害なしで保存したもの」とバイト単位で一致する |
| `write` が全バイト書いた後に `close` が `EBUSY` | 再試行してもファイルサイズは chunk 1 つ分しか増えず、重複追記がない |
| 部分書き込みの後に `EBUSY`（write が一部だけ書いて throw） | 再試行後にバイト一致する |
| eol の途中の write に `EBUSY` | 回復する。Duration / Cluster / Segment サイズが正しく、`readEbmlChildren` で Segment が EOF で終わり、Cluster → Cues と辿れる |
| 上限超過（`EBUSY` を常に返す） | 最後のエラーを `code` ごと throw する。試行回数と総待ち時間が上限内（注入した sleep で検証） |
| 恒久エラー（`EACCES`, `ENOSPC`, `EPERM`） | 再試行せず 1 回で throw する |
| 全失敗経路 | open した FileHandle がすべて close される（注入した fs で open/close を数える） |
| 本体の処理が失敗し、close も失敗 | 本体のエラーが throw される |
| 既存ファイルがある | 最初の chunk で truncate され、古い内容が残らない |
| 正常経路 | sleep が一度も呼ばれない |
| ffprobe（`isFfprobeAvailable()` のときだけ） | 障害注入後のファイルに警告が出ない（`probeWebmWarnings`） |

### `packages/webrtc/tests/nonstandard/recorder.test.ts`

- WebM 版 "reports a write failure through onError and stops without crashing": 存在しないディレクトリへの `.webm` 書き込みが `onError` に 1 回だけ通知される。unhandledRejection は起きない。購読は解除され、`stop()` は 2 s 未満で終わる。
- WebM の既存ファイルがロックされたディレクトリにある場合（Ogg の "replaces an existing file that cannot be deleted" に相当）: 古い内容が残らない。
- 一時エラーを注入した WebM 録画が `onError` なしで完了する（可能なら）。

## 6. 完了条件

- [ ] `EBUSY` が、回数と総待ち時間の上限つきの短い backoff で再試行され、上限を超えたら元のエラーが伝わる。`EPERM` を含む恒久エラーは再試行されない。プラットフォーム分岐を持たない。
- [ ] WebM の追記が位置指定書き込みなどで冪等になり、再試行しても重複追記やオフセットのずれが起きない（障害注入テストでバイト一致を確認）。
- [ ] eol のメタデータ書き換えが試行ごとに `finally` で close され、再試行してもメタデータが正しい。未 close のハンドルが残らない（open/close の数で確認）。
- [ ] `MediaRecorder` の WebM 書き込み失敗が `onError` に通知され、unhandledRejection やプロセスクラッシュを起こさず、`stop()` も待たされない。
- [ ] 最初の chunk で既存ファイルを置き換え、`unlink` の失敗で古い内容に追記されない。
- [ ] 正常経路で待機が増えない。既存の WebM / Ogg / MP4 のテストと録画終了・再開始の挙動に回帰がない。
- [ ] `cd packages/rtp && npm test`、`cd packages/webrtc && npm test`（関連するテスト）、`npm run type`、`npm run test:small` が通る。
- [ ] `changelog.md` に振る舞いの変更を書き、公開型を変えた場合は `npm run doc` で再生成した。
- [ ] PR に、本チケットの位置づけ（native Windows は対象外で、Linux で同種の一時エラーが起きた場合への対処であること）と、下流パッチとの対応関係（append / eol の再試行と重複追記・ハンドルリークの問題は本体で解消、Windows の `EPERM` 再試行は対象外）を書く。

関連: PR #791（WebM Cluster サイズ修正済み）、[#789](https://github.com/shinyoshiaki/werift-webrtc/issues/789)（別原因の録画先頭欠落、対象外）。
