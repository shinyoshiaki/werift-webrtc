# MediaRecorder drops the head of A/V recordings: media before each track's first RTCP SR is discarded by lip sync

## 1. 目的と背景

### 目的

`MediaRecorder`（WebM、既定の NTP 時刻 + lip sync 有効）で音声 + 映像を録画すると、録画の先頭が欠ける。各トラックの最初の RTCP SR より前に届いたメディアのうち、もう一方のトラックが既に書き出した時刻より前のものが捨てられているため。この欠落をなくすか、少なくとも上限を決めてドキュメントに書く。

### 背景（観測内容）

- record → DataChannel → ブラウザ再生の E2E（`e2e/tests/mediachannel/recordPlayback.test.ts` の `av` ケース。Chrome fake camera、ブラウザが offerer、5 秒録画）を追加したときに見つかった。
- `ntpTime2Sec` の修正（NTP fraction を `/ 2^32` で正しく換算。`changelog.md` v0.26.0 に記載済み）で録画自体は安定したが、録画の長さが実時間より常に短い。
- 欠けているのは先頭で、各トラックの最初の SR より前に送られた分（観測では映像 ≈0.5 s、音声 ≈2 s）。
- 現在のテストは `playback.duration > RECORD_MS / 1000 / 2` という緩い条件でこの欠落を許容している。
- 補足（要確認）: libwebrtc の RTCP 送信間隔の既定は音声 5 s、映像 1 s で、最初の報告はおおむねその半分前後に送られる。観測値（映像 ≈0.5 s、音声 ≈2 s）とも合う。つまり音声の最初の SR は数秒遅れることがある前提で設計する。

## 2. 原因の調査結果

### パイプライン（`packages/webrtc/src/nonstandard/recorder/writer/webm.ts`）

```
video: RtpSource → JitterBufferCallback → NtpTimeCallback → DepacketizeCallback → LipsyncCallback → WebmCallback
audio: RtpSource →                        NtpTimeCallback → DepacketizeCallback → LipsyncCallback → WebmCallback
RTCP:  RtcpSource → NtpTimeCallback（トラックごと）
```

### 処理ごとの挙動（コードで確認済み）

1. **`NtpTimeBase`**（`packages/rtp/src/extra/processor/ntpTime.ts`）
   - `baseNtpTimestamp` / `baseRtpTimestamp` が決まる（最初の SR を受け取る）までは、RTP を `this.buffer` に溜めるだけで `[]` を返す。
   - SR を受け取った後に最初の RTP が届くと、溜めた RTP をまとめて出力する。SR の RTP タイムスタンプより前のパケットは `(rtpTimestamp - baseRtpTimestamp) | 0` が負になり、**SR より前の NTP 時刻**が付く。この時点では時刻は正しい。
   - SR が来ないトラックでは、このバッファが上限なく増え続ける（既存の別の懸念）。
2. **`LipsyncBase`**（`packages/rtp/src/extra/processor/lipsync.ts`）
   - `processInput` で最初に受け取ったフレームの時刻を、トラックに関係なく `baseTime` / `currentTimestamp` / `lastExecutionTime` / `lastCommittedTime` に入れる。
   - `// 過去のフレームを捨てる`（`frame.time < this.lastCommittedTime`）により、`baseTime` より前のフレームは **commit が 1 回も行われていなくても**捨てられる。
   - `executeTask` は wall clock ではなくフレーム時刻（`diff >= interval`、既定 500 ms）で動き、出力するたびに `lastCommittedTime` を進める。
   - リングバッファは `bufferLength = (options.bufferLength ?? 10) * 2` スロット × `bufferDuration = interval / 2`（既定 20 × 250 ms = 5 s）。`index = int(elapsed / bufferDuration) % bufferLength` なので、`baseTime` より前のフレームは負の index になる（今は上の判定で先に捨てられるので表に出ていない）。
   - `stop()`（どちらかのトラックの eol）はリングバッファを **flush せずに捨てる**。末尾が欠ける原因にもなりうる（このチケットの対象外。下の「関連」を参照）。
   - lipsync は入力トラックの構成を知らない。映像だけの WebM 録画でも `disableLipSync` を指定しなければ `LipsyncCallback` を通る。
3. **`WebmBase`**（`packages/rtp/src/extra/processor/webm.ts`）
   - 最初に受け取ったフレームの時刻を全トラック共通の `ClusterTimestamp.baseTime` にする。`elapsed < 0` のフレームは `delayed_frame` として捨てる。
   - 映像はキーフレームが来るまで捨てる（`videoKeyframeReceived`）。

### 結論

チケット起票時の仮説はコード上で裏付けられた。

- 先に SR を受け取ったトラック A の最初のフレームの時刻が lipsync の `baseTime` になる。
- トラック B は SR を受け取った後に、溜めていたフレームを A の `baseTime` より前の時刻、または既に commit 済みの時刻より前の時刻で流してくる。これらは `frame.time < lastCommittedTime` ですべて捨てられる。
- 結果として、トラック B の先頭からトラック A が書き出し済みの位置までが失われる。

### オプションごとの挙動（推定。実測で確認すること）

| 設定 | 先頭欠落 | A/V 同期 | 備考 |
| --- | --- | --- | --- |
| 既定（NTP + lipsync） | あり（遅く SR が来たトラック側） | あり | 本チケットの対象 |
| `disableLipSync: true` | あり | NTP 時刻のみ | `WebmBase` が最初のフレームを `baseTime` にし、それより前（`elapsed < 0`）を `delayed_frame` として捨てるので同じ現象が起きるはず |
| `disableNtp: true` | なし（各トラックの最初のパケットから） | なし | `RtpTimeBase` はトラックごとに独立して 0 から始まるので、A/V の開始時刻がずれる |

## 3. 実装内容

### 3.1 再現テスト（修正の前に追加する）

- `packages/rtp/tests/processor/lipsync.test.ts`（新規）
  - Arrange: 映像フレームを時刻 T から 33 ms 間隔で流し、commit が進むところまで進める。その後で音声フレームを時刻 T から 20 ms 間隔でまとめて流す（SR が遅れて届いたときの溜め込み分を再現）。
  - Assert: 音声の出力が時刻 T 付近から始まる。修正前は失敗することを確認する。
- フレーム生成など Arrange の共通処理は `packages/rtp/tests/utils.ts` に置く（既存の `createSenderReport` / `createRtpAt` / `createNtpTimestamp` の近く）。Act / Assert には日本語でコメントを付ける。
- 必要なら `NtpTimeBase` と組み合わせたテストも書く。SR より前の RTP がまとめて SR より前の時刻で出てくることを固定する。

### 3.2 修正（推奨: lipsync の開始を全トラックの時刻確定まで待たせる）

`LipsyncBase` に「開始待ち」の状態を追加する。

1. **入力トラック構成を渡す**
   - `LipSyncOptions` にオプションを追加し（例: `kinds: MediaKind[]`、名前は要検討）、`WebmFactory` から `inputTracks` の kind を渡す。
   - 未指定のときは audio と video の両方を待つ。ただし映像だけの録画が止まらないように、`WebmFactory` からは必ず渡す。
2. **開始前のバッファリング**
   - `baseTime` が決まるまでは、フレームをリングバッファではなく開始前用の配列に入れる。リングは 5 s で、溜め込み中に一周して衝突する可能性があるため。
3. **開始条件**
   - 必要な kind のすべてから少なくとも 1 フレーム受け取ったら開始する。`baseTime` は各 kind の最初のフレーム時刻の最小値にする。
   - タイムアウトしたときは、届いているトラックだけで開始する。タイムアウトは wall clock で、例えば新オプション `startTimeout`（ms）。音声の最初の SR が数秒遅れることを考え、既定値は 5 s 以上にする。
4. **開始時の処理**
   - 開始前用の配列を時刻順にリングバッファへ入れ直し、既存の `executeTask` のロジックで出力する。
   - `lastFrameReceivedAt` も開始時点で初期化し、`// NTPの同期ずれが疑われるので捨てる` の判定が誤って働かないようにする。
5. **タイムアウトの判定方法**
   - 今の lipsync はフレーム入力でしか動かない。タイマーを使わず「次のフレーム入力時に `Date.now()` で経過時間を判定する」方式にすると、`stop()` でタイマーを片付ける必要がない。どちらにするかは実装時に決め、決めた理由を残す。
   - タイマーを使う場合は `stop()` で確実に解除する（テストに `activeTimeoutCount()` が使える）。
6. **開始前に eol が来たとき**
   - 溜めたフレームの扱い（出力するか捨てるか）を決めて、テストで固定する。

### 3.3 代替案（今回は採用しない想定。理由を記録しておく）

- **SR 前の仮 NTP マッピング**（`NtpTimeBase` で到着時刻から推定し、SR が来たら合わせ直す）
  - 合わせ直すときに時刻が跳ぶ（巻き戻る）ので、lipsync や WebM での扱いが複雑になる。
  - Ogg（`OggFactory` も `NtpTimeCallback` を使う）など他のパイプラインにも影響が広がる。
  - SR が来ないトラックを救えるという利点はあるので、別チケットにする余地がある。

### 3.4 周辺の修正・確認

- `disableLipSync: true` / `disableNtp: true` で先頭欠落を実測し、結果をチケットに追記する。`disableLipSync` で同じ欠落があるなら、`WebmBase` 側を直すかドキュメントに書くかを決める（別チケットにしてもよい）。
- `examples/save_to_disk/pipeline.ts` など、`LipsyncCallback` を直接使っているサンプルに新オプションが必要か確認する。サンプルを変えたら生成ドキュメントを `npm run doc` で再生成する。
- `changelog.md` に Bug Fix を追記する（`werift-rtp` / `werift`。先頭欠落の内容と、新しいオプションとその既定値）。
- `MediaRecorderOptions.lipsync` の JSDoc に、新オプションと開始待ちの挙動を書く。

## 4. 制約・注意点

- **公開 API の互換性**
  - `LipsyncBase` / `LipsyncCallback` / `LipSyncOptions` は `werift-rtp` から公開されている。新オプションは省略可能にし、既存の呼び出しが壊れないようにする。
  - 既定値を変える（開始を待つ）こと自体が挙動の変更なので、changelog に明記する。
- **SR を送らない送信者**
  - `NtpTimeBase` は SR が来るまで何も出力しない。lipsync 側でタイムアウトを設けても、そのトラックの欠落は解決しない（既存の挙動のまま）。`NtpTimeBase.buffer` が上限なく増える問題も残る。これはスコープ外として明記するか、上限を設けるかを決める。
- **メモリと遅延**
  - 開始待ちの間はもう一方のトラックのフレームを保持するので、タイムアウト × ビットレート分のメモリを使う。出力の開始も最大でタイムアウト分遅れる。ストリーム出力（`stream`）の利用者にも影響するので、ドキュメントに書く。
- **WebM 側の条件**
  - 映像はキーフレームまで捨てられる。lipsync を直しても、映像の先頭は最初のキーフレームからになる。
  - E2E の handler は 2 s ごとに PLI を送る。Chrome は開始時にキーフレームを送るので、通常は問題にならない想定。
- **lipsync が動く前提**
  - lipsync はフレーム時刻で動くので、時刻が単調でないと動作が崩れる。並べ替えは映像側の jitter buffer に依存している。WebM の音声経路には jitter buffer がない（Ogg にはある）。
- **リポジトリの規約**
  - テストは Arrange / Act / Assert で書き、共通の Arrange はテスト領域ごとに 1 つの utility ファイルにまとめる。Act / Assert のコメントは日本語。
  - TypeScript は `node --experimental-transform-types --import .../tools/node-ts/register.mjs` で実行する（`tsx` は使わない）。
  - E2E サーバーやブラウザを止めるときは PID か runner の停止処理を使う（`pkill -f` は使わない）。
- **対象外（関連）**
  - `LipsyncBase.stop()` がリングバッファを flush せずに捨てるため、録画の末尾が欠ける可能性がある。必要なら別チケットにする。
  - Firefox や実カメラでの検証。

## 5. 完了条件

- [ ] `packages/rtp/tests/processor/lipsync.test.ts` に再現テストがあり、修正前は失敗し、修正後は通る。テストの内容:
  - [ ] 一方のトラックのフレームが遅れて、より古い時刻で届いても、その先頭が捨てられずに出力される。
  - [ ] 必要な kind がそろわないときは、タイムアウト後に届いているトラックだけで出力が始まる。
  - [ ] 映像だけ（kind が 1 つ）の構成では、待たずにすぐ始まる。
  - [ ] 開始待ちの間に eol が来たときの挙動が固定されている。
- [ ] `WebmFactory` が入力トラックの kind を lipsync に渡しており、映像だけの録画が以前と同じように動く。
- [ ] `cd packages/rtp && npm test` と、webrtc 側の recorder テスト（`packages/webrtc/tests/nonstandard/recorder.test.ts`）が通る。public API を変えた場合は `npm run type` と `npm run test:small` も通る。
- [ ] E2E `recordPlayback.test.ts` の `av` ケースで、次の 2 つを確認できる:
  - 録画の長さが録画時間に近い（目安: `RECORD_MS / 1000 - 1` 秒以上）。
  - 音声の開始時刻が映像とほぼ同じ（`ffprobe` の stream `start_time` などで確認）。
  
  確認できたら、`duration > RECORD_MS / 1000 / 2` の緩い条件を実測に合わせて厳しくする。対象ファイルだけで通ることを確認した後、`npm run e2e` を通す。
- [ ] `disableLipSync: true` / `disableNtp: true` での実測結果がチケットに記録されている。対応が必要な場合は、修正したか別チケットにしたかが明記されている。
- [ ] `changelog.md` と `MediaRecorderOptions.lipsync` / `LipSyncOptions` の JSDoc が更新されている。サンプルや生成ドキュメントに影響がある場合は `npm run doc` で再生成されている。
- [ ] `npm run format` を実行してある。

## 6. 再現手順（元の記載）

1. 1 つ目のシェルで E2E サーバーを起動する: `cd e2e && npm run server`
2. 別のシェルでテストを実行する: `npx vitest run tests/mediachannel/recordPlayback.test.ts --browser.headless`
3. 出力された WebM の長さ（`ffprobe` など）と録画時間を比べる。音声トラックの開始が録画開始より明らかに遅れている。
