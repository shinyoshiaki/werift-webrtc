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

- [x] `packages/rtp/tests/processor/lipsync.test.ts` に再現テストがあり、修正前は失敗し、修正後は通る。テストの内容:
  - [x] 一方のトラックのフレームが遅れて、より古い時刻で届いても、その先頭が捨てられずに出力される。
  - [x] 必要な kind がそろわないときは、タイムアウト後に届いているトラックだけで出力が始まる。
  - [x] 映像だけ（kind が 1 つ）の構成では、待たずにすぐ始まる。
  - [x] 開始待ちの間に eol が来たときの挙動が固定されている。
- [x] `WebmFactory` が入力トラックの kind を lipsync に渡しており、映像だけの録画が以前と同じように動く。
- [x] `cd packages/rtp && npm test` と、webrtc 側の recorder テスト（`packages/webrtc/tests/nonstandard/recorder.test.ts`）が通る。public API を変えた場合は `npm run type` と `npm run test:small` も通る。
- [x] E2E `recordPlayback.test.ts` の `av` ケースで、次の 2 つを確認できる:
  - 録画の長さが録画時間に近い（目安: `RECORD_MS / 1000 - 1` 秒以上）。
  - 音声の開始時刻が映像とほぼ同じ（`ffprobe` の stream `start_time` などで確認）。
  
  確認できたら、`duration > RECORD_MS / 1000 / 2` の緩い条件を実測に合わせて厳しくする。対象ファイルだけで通ることを確認した後、`npm run e2e` を通す。
- [x] `disableLipSync: true` / `disableNtp: true` での実測結果がチケットに記録されている。対応が必要な場合は、修正したか別チケットにしたかが明記されている。
- [x] `changelog.md` と `MediaRecorderOptions.lipsync` / `LipSyncOptions` の JSDoc が更新されている。サンプルや生成ドキュメントに影響がある場合は `npm run doc` で再生成されている。
- [x] `npm run format` を実行してある。
- [x] 追加要件（打開策・案D、2026-11-07）: タイマーで開始するとき（と開始前の eol）も、確定時刻（無音補完を含む）は受信済みの最新フレームの時刻を越えない。無音補完のあり／なし × {入力停止、タイムアウト後に同じ区間の入力が続く} の 4 ケースで、欠落なし（期待する時刻列と完全一致）・時刻順・ダミー音声の最大時刻 ≤ 実フレームの最新時刻をテストで固定している。コメント・changelog・JSDoc にこの条件が書かれている。

## 6. 再現手順（元の記載）

1. 1 つ目のシェルで E2E サーバーを起動する: `cd e2e && npm run server`
2. 別のシェルでテストを実行する: `npx vitest run tests/mediachannel/recordPlayback.test.ts --browser.headless`
3. 出力された WebM の長さ（`ffprobe` など）と録画時間を比べる。音声トラックの開始が録画開始より明らかに遅れている。

## 7. 実施結果（2026-11-06）

### 修正内容

- `LipsyncBase` に開始待ちを追加した（`packages/rtp/src/extra/processor/lipsync.ts`）。
  - 開始前のフレームは開始前用の配列（`pendingFrames`）に溜める。
  - 開始条件: `kinds` のすべてからフレームを受け取り、かつ各 kind の最新時刻の差が `bufferDuration`（`syncInterval / 2`）以内になったとき。遅れたトラックの溜め込み分は同期的にまとめて届くので、最初の 1 フレームで開始すると残りが commit 済みの時刻より古くなって捨てられる。追いつくまで待つことで、開始後のフレームが `lastCommittedTime` より古くならない。
  - `baseTime` は溜めたフレームの最小時刻。溜めたフレームは時刻順に既存の挿入処理へ流す（`executeTask` が時刻に合わせて進むので、5 s のリングを溢れさせない）。`lastFrameReceivedAt` も開始時に初期化する。
  - タイムアウト `startTimeout`（既定 10000 ms）は、最初のフレーム受信時に `setTimeout`（`unref`）で仕掛ける。入力が止まっていても期限で、溜めたフレームを通常経路（`executeTask`、無音補完を含む）で時刻順に出力して開始する。確定は受信済みの最新フレームの時刻まで（下の「打開策（案D）」）。開始時と `stop()` でタイマーを解除する。次のフレーム入力時の `Date.now()` 判定も併用する（レビュー指摘 P2 対応）。
  - 開始前に eol が来たときは、溜めたフレームを時刻順に出力してから eol を出力する（短い録画で SR が片方しか来なかった場合も中身を残すため）。
- 新オプション `LipSyncOptions.kinds`（既定 `["audio", "video"]`）と `startTimeout`。`WebmFactory` は録画するトラックの kind を必ず渡す（ユーザー指定の `lipsync.kinds` より優先）。
- `examples/save_to_disk/pipeline.ts` と `examples/untested/dash` は音声 + 映像なので既定値のままでよく、変更していない。生成ドキュメントには `LipSyncOptions` / `MediaRecorderOptions` が含まれないので再生成していない。

### 打開策（案D）: タイマー開始の確定時刻を最新の実フレームまでに抑える（追加要件、2026-11-07）

レビューがリトライ上限（5/5）で未承認になったため、ユーザーの分析に基づいて対応した。

- **指摘の流れ**: 本筋（遅れて届く音声の先頭を残す）は初回から承認されていた。非承認の指摘は 5 件ともタイマー開始経路の端のケースで、症状ごとの修正が次の不具合を生んでいた。

  | # | 指摘 | 対応 | 対応で生じた次の問題 |
  |---|---|---|---|
  | 1 | 入力が止まるとタイムアウトしない | `setTimeout` を追加 | 保留フレームを直接出力したため通常経路を通らない |
  | 4 | 無音補完がされない | `startAndDrain()`（スロット末尾まで処理） | 処理済みスロットに後続フレームが入る |
  | 6 | タイムアウト後の同じ区間のフレームが欠落 | リング基準を次の境界に取り直し | 無音補完がスロット末尾まで確定時刻を進める |
  | 8, 9 | 無音補完ありで、タイムアウト後の映像が欠落 | 本対応（案D） | — |

- **根本原因**: 通常経路の `insertFrame` は `times = int(diff / bufferDuration) - 1` で処理を進めるので、確定時刻は常に「最新の受信時刻 − 250 ms」以下に保たれ、少し遅れたフレームを受け入れられる。`startAndDrain()` はこの前提を守らず、最新フレームを含むスロットの末尾まで処理・無音補完していた。例: 映像が 10400 ms で終わっていてもダミー音声で 10490 ms まで確定し、後から届く 10420〜10480 ms の映像が捨てられた。
- **守る条件**: タイマーで出力するときも、確定時刻は受信済みの最新フレームの時刻を越えない。
- **実装**（`packages/rtp/src/extra/processor/lipsync.ts`）:
  - `executeTask(end = currentTimestamp + bufferDuration)` に終端引数を追加。無音補完は `time < end` まで、最後に `currentTimestamp = end`。通常経路は既定値なので動作は変わらない。
  - `startAndDrain()`: `last` = 保留フレームの最大時刻。`start()` の後、`currentTimestamp + bufferDuration <= last` の間だけ通常どおり処理し、最後のスロットは `executeTask(last)` で `last` まで確定する（`last` ちょうどのフレームも出力される）。リングの基準（`baseTime` / `lastExecutionTime`）は `last` に取り直し、`index = 0`。境界ではなく `last` に取り直すので、`last` 以降のダミー音声は次のスロットから隙間なく続く。
  - 開始前の eol（`stop()`）は同じ `startAndDrain()` を使う。`stop()` 後の入力は捨てられるので副作用はない。
  - 案A（タイマーでは `start()` のみ）は、保留が短いと入力停止中に何も出力されず指摘 #1 に戻るため採用しない。
- **回帰テスト**: `lipsync.test.ts` の `timer start without/with dummy audio`（`describe.each`）で 4 ケース。旧テスト `keeps frames of the drained interval…`（`toContain(T + 140)` のみ）は完全一致比較のこのケースに置き換えた。
  - 映像 T〜T+400（20 ms 間隔）を入れて期限切れにし、入力停止 → 映像が全部そのまま出力される。
  - その後 T+420〜 を入れ続ける → 出力が入力列の先頭からの連続列と完全一致（T+420〜T+480 を含む）。
  - 無音補完ありでは、ダミー音声が T から時刻順に ptime 以下の間隔で続き、最大時刻が実フレームの最新時刻以下。
  - 修正前の実装（HEAD `29e6c1ac6`、一時 worktree）では無音補完ありの 2 ケースが失敗することを確認した（ダミー音声が 10490 ms まで出る、10420 ms 以降の映像が欠落）。
- **補足**: ダミー音声の時刻は 250 ms のスロット境界ごとに格子が取り直される（例: 240 → 250 ms）。これは develop からの既存挙動で、今回は変えていない。

### テスト

- `packages/rtp/tests/processor/lipsync.test.ts`（新規）: 遅れて古い時刻で届いたトラックの先頭が出力される / タイムアウト後に届いているトラックだけで始まる / `kinds: ["video"]` は待たない / 開始前の eol / 入力が止まっても `startTimeout` で出力される / `stop()` でタイマーが解除される。修正前は 4 件中 3 件が失敗することを確認した（音声の出力開始が T + 2.5 s だった）。
- `packages/rtp/tests/processor/ntpTime.test.ts`: SR より前の RTP がまとめて SR より前の時刻で出てくることを固定した。
- `packages/webrtc/tests/nonstandard/recorder.test.ts`: 映像だけの WebM 録画が停止前から書き出される（`kinds` を渡さないと失敗することを確認）/ SR が遅れた音声の先頭が書き出される。
- E2E `recordPlayback.test.ts`: `duration > RECORD_MS / 1000 - 1` に厳しくし、MSE の共通区間の開始が 0.2 s 未満であること（av では音声の開始が映像とほぼ同じこと）を追加した。

### 実測（Chrome fake camera、5 s 録画、ffprobe）

| 設定 | 種類 | duration | 音声 start_time | 映像 start_time |
| --- | --- | --- | --- | --- |
| 既定（修正後） | av | 4.48 s | 0.001 s | 0.000 s |
| 既定（修正後） | video | 4.45 s | - | 0.000 s |
| `disableLipSync: true` | av | 4.98 s / 4.97 s | 1.90 s / 1.91 s | 0.000 s |
| `disableNtp: true` | av | 4.48 s | 0.000 s | 0.000 s |

- `disableLipSync: true`: 推定どおり、遅れて SR が来た音声の先頭（≈1.9 s）が `WebmBase` の `delayed_frame` で捨てられる。この設定では E2E の `av` ケースも失敗する（MSE の共通区間）。今回は直さず changelog に書いた。`WebmBase` 側の修正（最初の SR がそろうまで待つ、など）は別チケットにする想定。
- `disableNtp: true`: 先頭欠落はないが、各トラックが独立して 0 から始まるので A/V は同期しない（推定どおり）。
- 既定と `disableLipSync` の duration の差（≈0.5 s）は、`LipsyncBase.stop()` がリングバッファを flush せずに捨てる末尾欠落（対象外として記載済み）によるもの。
- SR を送らない送信者のトラックは、今回も `NtpTimeBase` が出力しない（既存の挙動のまま。`NtpTimeBase.buffer` の上限もスコープ外）。
