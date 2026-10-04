# Feature: monotonic real-time RTP media clock and wall-clock-aware RtpBuilder

## 1. 目的と背景

### Summary

`werift-rtp` に、再利用できる **単調増加（monotonic）なリアルタイム RTP メディアクロック / ペーサー** を追加する。あわせて `RtpBuilder` をこのクロックと連携させ、Node.js のイベントループが遅延・一時停止しても、サーバー側のメディアソースが RTP timestamp をサンプリング時刻のタイムラインに揃えたまま送出できるようにする。

これは **ソース側でオプトインして使うユーティリティ** とする。`RTCRtpSender.sendRtp()` は今まで通り、渡された RTP パケットの timestamp をそのまま正として扱い、送信時刻をもとに書き換えることはしない。

### Motivation

サーバー側の典型的な実装はこうなっている。

```ts
setInterval(() => {
  timestamp += frameSamples;
  sender.sendRtp(packet(timestamp));
}, frameDurationMs);
```

このコードは、タイマーのコールバックが毎回ちょうど予定どおりに呼ばれる前提に立っている。Node.js ではそうならないため、小さな遅延が積み重なり、実時間（wall clock）が RTP メディアクロックより大きく先行していく。

- OpenClaw（werift ベースの GPT-Live relay）で実際に発生した: https://github.com/openclaw/openclaw/pull/146078
  - 20 ms 間隔の旧実装では、コールバック遅延がわずか 1 ms でも、1 分間の回帰テストで **約 2.857 秒** のクロック誤差が溜まった。
  - 修正では monotonic な絶対デッドラインに切り替えた。スケジューラが停止した後は、溜まったパケットをまとめて再送（burst）せず、経過したメディアスロットを skip するようにした。
- Node.js で RTP を生成するアプリなら、同じ種類のバグを簡単に再現できる。

### 既存 `RtpBuilder` の制約（調査結果）

`packages/rtp/src/util.ts` の現行実装:

```ts
export class RtpBuilder {
  sequenceNumber = random16();
  timestamp = random32();
  constructor(private props: { between: number; clockRate: number }) {}
  create(payload: Buffer) {
    this.sequenceNumber = uint16Add(this.sequenceNumber, 1);
    const elapsed = (this.props.between * this.props.clockRate) / 1000;
    this.timestamp = uint32Add(this.timestamp, elapsed);
    // payloadType: 96, extension: true, marker: false が固定。ssrc は未設定（0）
    ...
  }
}
```

- `create()` は呼び出しのたびに「前回からちょうど `between` ms 経った」とみなして timestamp を進める。コールバックが遅れると、RTP クロックは実時間に対して遅れていく。
- **既存の潜在バグ**: `uint32Add`（`packages/common/src/number.ts`）は内部で `BigInt(b)` を使っている。そのため `between * clockRate / 1000` が整数にならない値（例: `between: 10.5, clockRate: 44100` → `463.05`）を渡すと `RangeError` で例外になる。たとえば 44.1 kHz/10.5 ms のような組み合わせでは、小数の frame duration を扱えない。
- 1 フレームを複数パケットに分ける構成（同一 timestamp を共有する video など）や、PT/SSRC/marker の指定には対応していない。
- リポジトリ内に `RtpBuilder` の利用箇所やテストはない（公開 API として export されているのみ: `packages/rtp/src/index.ts` → `export * from "./util"`）。`packages/webrtc/src/imports/rtp.ts` が `export * from "../../../rtp/src"` しているため、`werift` 本体の公開 API にも現れる。

### 関連する既存実装（参考）

- `packages/webrtc/src/nonstandard/dummyMedia.ts` の `ScheduledRtpSource`
  - `nextTickAt += intervalMs` と `performance.now()` による絶対デッドライン方式で、ドリフトは起きない。
  - ただしストール後は `delay = Math.max(0, ...)` が 0 の状態が続き、**遅れた分のパケットを burst 送出する**。今回の skip 方式とは挙動が違う。WPT の dummy media で使われているため、本チケットでは変更しない（後述「フォローアップ候補」を参照）。
- `packages/webrtc/src/nonstandard/userMedia.ts` の `TrackPlaybackRunner`
  - `startedAt` を基準とする絶対時刻で待機し、ファイル上の timestamp から RTP timestamp を算出している（ファイル再生なので、アプリケーションが timeline を所有するケース）。
- `packages/webrtc/src/media/rtpSender.ts` の `dispatchRtp()`
  - 入力 timestamp には `timestampOffset`（`replaceTrack` 時の連続性維持用）を足すだけ。送信時刻による書き換えはしていない。
  - SR 用の `ntpTimestamp` / `rtpTimestamp` は **送信時点** で採取している（SR の clock mapping 問題: #701）。
- `packages/rtp/src/helper.ts` の `timer`（setTimeout/setInterval を「解除関数を返す」形でラップしたもの）。

## 2. 実装すべき機能・変更内容

### 2.1 `RtpMediaClock`（新規、`werift-rtp`）

メディアクロックの計算（純粋ロジック）と、実際のスケジューリング（タイマー）を分ける。

#### (a) タイムライン計算コア（純粋・決定的）

- フレーム番号 `N` から次の値を **絶対値として** 毎回計算する（加算を繰り返さないので誤差が溜まらない）。
  - デッドライン: `deadline(N) = origin + N * frameDurationMs`
  - 経過サンプル数: `elapsedSamples(N) = round(N * frameSamples)`（`frameSamples` が小数の場合も含む）
  - RTP timestamp: `timestamp(N) = (initialTimestamp + elapsedSamples(N)) mod 2^32`
- `frameSamples` と `frameDurationMs` はどちらか一方を指定し、もう一方は `clockRate` から導出する。
  - 例: 48 kHz/960 samples = 20 ms、90 kHz/29.97 fps = 3003.003… samples（小数）。
- 現在時刻 `now` を与えると「到達済みの最新スロット」と「skip したフレーム数」を返す関数として実装し、タイマーなしで単体テストできるようにする。

#### (b) スケジューラ（`RtpMediaClock`）

API 案（最終的な命名は実装時に決めてよいが、責務の分け方はこの案に従う）:

```ts
const clock = new RtpMediaClock({
  clockRate: 48_000,
  frameSamples: 960,            // or frameDurationMs: 20
  initialTimestamp?: number,    // 既定: random32()
  now?: () => number,           // 既定: () => performance.now()（テスト時に注入）
  scheduler?: {                 // 既定: setTimeout/clearTimeout（テスト時に注入）
    setTimeout(cb: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  },
  unref?: boolean,              // timer.unref() するか（既定 false）
  signal?: AbortSignal,         // abort で stop() 相当
});

clock.onTick.subscribe((tick) => { /* 送出処理 */ }); // common の Event を使う
clock.start();      // or clock.start(onTick)
clock.pause();
clock.resume();
clock.stop();       // 終了。この後に timer handle が残らないこと
```

`RtpMediaClockTick` に含める値:

| field | 意味 |
| --- | --- |
| `frameIndex` | 今回のスロット番号 N |
| `timestamp` | uint32 の RTP timestamp（wrap 済み） |
| `elapsedSamples` | 前回 tick からの経過サンプル数（skip 分を含む） |
| `skippedFrames` | 送出せずに飛ばしたスロット数（通常は 0） |
| `deadline` | このスロットの予定時刻（monotonic ms） |
| `lateness` | `now - deadline`（ms） |

挙動の要件:

- 次のタイマー遅延は `max(0, deadline(N+1) - now())` で求める（相対 interval は使わない）。
- **ストール時**: `now >= deadline(N + k)` まで進んでいたら、到達済みの最新スロットについて tick を **1 回だけ** 発火する。間に挟まるスロットは `skippedFrames` に入れ、timestamp のギャップとして表す。遅れた tick を連続で発火（burst）しない。
  - 例（48 kHz/20 ms）: ts=48000 の直後に 5 秒停止 → 次の tick は ts=288960、`skippedFrames=249`、`elapsedSamples=240960`。
- 1 フレーム未満の遅延（例: 毎回 1 ms 遅れ）では skip せず、次のデッドラインで追いつく。
- tick の発火中に `stop()` / `pause()` が呼ばれた場合は、次のタイマーを残さない。
- `onTick` の購読者が例外を投げても、握りつぶす処理は追加しない。`Event` の既存の挙動に従う。ただしクロックの内部状態が壊れないよう、状態を更新してからコールバックを呼ぶ。
- コールバックが Promise を返しても await しない（バックプレッシャーはスコープ外）。この点はドキュメントに明記する。

#### pause / resume の意味（実装時に決めて docs に明記すること）

- **推奨既定**: `resume()` 後の timestamp には、pause していた実時間をギャップとして反映する。ストール時の扱いと同じ「リアルタイム準拠」のセマンティクスで、SR/lipsync との整合も取りやすい。
- オプションとして、`resume({ continuous: true })` のように pause 期間を詰め、次の 1 フレーム分だけ進める挙動も選べるようにする。
- どちらの場合も、resume 時に `origin` を re-anchor して、resume 直後に burst が起きないようにする。

### 2.2 `RtpBuilder` の拡張（後方互換を保つ）

- **既存の呼び出し方は挙動を変えない**: `new RtpBuilder({ between, clockRate })` + `create(payload)` は、引き続き 1 回の呼び出しで seq +1、timestamp `+between*clockRate/1000` とする（初回 `create()` でも先に加算するという現行仕様も維持する）。
- 小数の増分で例外になる問題を直す。端数を内部で累積し（例: サンプル数を実数で持ち、出力時に丸める）、長時間動かしても誤差が溜まらないようにする。
- props を追加する（すべて任意）:
  - `payloadType?`（既定 96）、`ssrc?`、`marker?`、`extension?`（既定 true。現行と互換）
  - `initialSequenceNumber?` / `initialTimestamp?`（テストや wrap 検証のため。既定は現行通り random）
  - `clock?: RtpMediaClock`（指定すると timeline をクロックが持つ）
- 明示的な timeline 操作:
  - `advanceSamples(n)`: timestamp だけを進める（seq は進めない）。skip の表現にも使う。
  - `create(payload, options?)`: `options` には次を受け付ける。
    - `elapsedSamples?: number`: 今回進めるサンプル数。`0` にすると同一フレーム内の 2 パケット目以降を表せる（video）。
    - `timestamp?: number`: 絶対値で指定（アプリケーションが timestamp を所有する relay 用）。
    - `tick?: RtpMediaClockTick`: クロックの tick の timestamp をそのまま使う。
    - `marker?: boolean`
  - `between` を指定せずに `clock` / 明示 API だけで使う構成も許可する。props の型は判別可能な union などで表す。
- seq は **実際に `create()` したパケットだけ** 進める（16-bit wrap）。timestamp はメディアのタイムラインに従って進める（32-bit wrap）。

### 2.3 公開 API・ドキュメント

- 新規ファイル（案）: `packages/rtp/src/rtp/mediaClock.ts`。`packages/rtp/src/index.ts` から export する。`werift` 本体にも re-export されるので、既存のシンボルと名前が衝突しないか確認する。
- `packages/rtp/README.md` に使用例を追記する: クロック + `RtpBuilder` + `sender.sendRtp()`、および relay（timestamp をアプリが所有する）では使わなくてよいことの明記。
- `npm run doc`（rtp パッケージ）で `packages/rtp/doc` を再生成する。

## 3. 技術的な実装アプローチ（調査まとめ）

- **時刻源**: `performance.now()`。monotonic で、システム時刻の変更の影響を受けない。リポジトリ内でも ICE / dummyMedia / userMedia で使われている。`Date.now()` は使わない。
- **誤差が溜まらない計算**: 毎回 `N` から絶対値を計算する（`origin + N*duration`、`round(N*frameSamples)`）。浮動小数の `+=` を繰り返す実装は避ける。サンプル数は 2^53 未満なら Number で十分（90 kHz でも数千年分）。mod 2^32 は `uint32Add` で行うか、`(x % 2**32) >>> 0` の形で行う。`uint32Add` は整数しか受け付けない（BigInt 化する）ので、丸めてから渡す。
- **ストール検出**: tick 時点の `now` から `floor((now - origin) / frameDurationMs)` を求め、到達済みの最新スロット `M` を得る。`M > N + 1` なら `skippedFrames = M - N - 1` として `N = M` にジャンプする。
- **イベント通知**: リポジトリの方針に合わせ、`packages/common/src/event.ts` の `Event` を使って `onTick` を出す。
- **タイマー**: `setTimeout` を毎 tick 張り直す。ハンドルを保持し、`stop()` / `pause()` で `clearTimeout` する。`unref` オプションで、プロセスの終了を妨げないようにもできる。`AbortSignal` にも対応する。
- **テスト容易性**: `now` と `scheduler` を注入できるようにし、手動で進める仮想クロックで決定的にテストする。vitest の fake timers は既定では `performance` を偽装しないので、注入方式を主とする。実タイマーを使うテストは、ハンドルが残らないことの確認など最小限にする。
- **rtpSender は変更しない**: `sendRtp()` / `dispatchRtp()` は timestamp を書き換えない、という現状を維持する。回帰テストで担保する。

## 4. 制約・注意点

- **Non-goals**（本チケットではやらない）
  - `sendRtp()` で呼び出し元の RTP timestamp を書き換えること
  - UDP 送信の完了時刻からサンプリング時刻を推定すること
  - relay / recording / playback の利用者にペーシングを強制すること
  - 「RTP パケット 1 個 = メディアフレーム 1 個」を前提にすること（video では複数パケットが同一 timestamp を共有する。relay はリモートソースのクロックを意図的に保持することがある）
- 既存の `RtpBuilder({ between, clockRate })` 利用者の出力（seq/timestamp の進み方、PT=96、extension=true）を変えない。
- `werift-rtp` はブラウザ向けの利用（`import "buffer"`）にも言及している。`performance.now()` はブラウザでも使えるが、`timer.unref` は Node.js 固有なので、存在するときだけ呼ぶ。
- `packages/webrtc/src/nonstandard/dummyMedia.ts` の burst 挙動は WPT の dummy media で使われているため、本チケットでは触らない（AGENTS.md: WPT 向けの挙動は wrapper に閉じる）。
- SR（#701）の NTP↔RTP マッピングを送信時刻ベースから直すのは別チケットとする。ただし tick に `deadline` / `timestamp` の対応を持たせておき、将来その修正に使えるようにしておく。
- テストは AGENTS.md に従う: Arrange/Act/Assert の 3 フェーズで書き、Act/Assert には日本語コメントを付ける。Arrange 用のユーティリティは `packages/rtp/tests/utils.ts` にまとめる（例: `createManualMediaClockHarness()` = 注入用の `now`/`scheduler` と、時間を進める `advance(ms)`）。
- `packages/rtp` には `AGENTS.md` がない（作成は任意。作る場合はルートの章立てに合わせる）。

## 5. テスト観点（必須カバレッジ）

テストファイル案: `packages/rtp/tests/rtp/mediaClock.test.ts`、`packages/rtp/tests/rtp/builder.test.ts`

- 8/16/24/48 kHz の audio（20 ms 等）と 90 kHz の video（30fps、29.97fps = 小数サンプル）で、`timestamp` と `deadline` が理論値と一致すること
- 小数の frame duration / sample 数で、長時間動かしても累積誤差が 1 sample 以内に収まること（例: 1 時間相当）
- 毎回 1 ms 遅れるスケジューラで 1 分間動かしても、メディアクロックと実時間の差が 1 フレーム未満であること（旧方式の約 2.857 秒の誤差が出ないこと）
- 5 秒のストール後: tick は 1 回だけ、`skippedFrames` と timestamp のギャップが正しく、burst がないこと（seq 100→101、ts 48000→288960 の例）
- RTP timestamp の 32-bit wrap（`initialTimestamp = 0xffffffff - α`）
- sequence number の 16-bit wrap（`initialSequenceNumber = 0xffff`）
- pause/resume: 既定の挙動（ギャップを反映）とオプションの挙動、resume 直後に burst しないこと
- `stop()` / `AbortSignal` の後にタイマーのハンドルが残らないこと（`process.getActiveResourcesInfo()` で確認するなど）。`unref: true` でプロセスの終了を妨げないこと
- `RtpBuilder`
  - 既存モード（`between`）の出力が従来と同じであること
  - 小数の増分で例外にならず、誤差も溜まらないこと
  - `elapsedSamples: 0` で同一 timestamp の複数パケット（video）を作れること
  - `timestamp` を絶対値で指定すると、アプリが timestamp を所有する relay 互換になること
  - `tick` 連携で、seq は送出したパケットの分だけ、timestamp はメディア timeline どおりに進むこと
- `RTCRtpSender.sendRtp()` が入力 timestamp を（`replaceTrack` のオフセット以外は）変更しないことの回帰確認（既存テストで足りなければ追加）

## 6. 完了条件

- [ ] `RtpMediaClock`（計算コア + スケジューラ）が `werift-rtp` から export され、`werift` からも使える
- [ ] monotonic な絶対デッドラインで動き、ストール時は skip（burst しない）し、pause/resume/stop/AbortSignal/unref に対応している
- [ ] `RtpBuilder` が後方互換を保ったまま、クロック / 明示的な timeline API（`advanceSamples`、`create` オプション）に対応し、小数の増分で例外になる問題が直っている
- [ ] 「5. テスト観点」がすべてテストされ、AAA 形式・日本語コメント・`tests/utils.ts` への Arrange 集約の規約を守っている
- [ ] `sendRtp()` の timestamp 非書き換えが維持されている
- [ ] `packages/rtp/README.md` に使用例と、使う場面 / 使わない場面（relay）が追記され、`packages/rtp/doc` が再生成されている
- [ ] 検証: `cd packages/rtp && npm run type && npm test` が通る。公開 API の変更なので、ルートで `npm run type` と `npm run test:small` も通る

## フォローアップ候補（本チケット外）

- `packages/webrtc/src/nonstandard/dummyMedia.ts` の `ScheduledRtpSource` を `RtpMediaClock` に置き換え、ストール後の burst をなくすことを検討する（変更する場合は `npm run wpt --workspace packages/webrtc` で検証する）
- RTCP SR の NTP↔RTP マッピングを、送信時刻ではなくメディアクロックの基準で行う（#701）

## Related

- OpenClaw downstream fix: https://github.com/openclaw/openclaw/pull/146078
- RTCP SR clock-mapping issue: #701
