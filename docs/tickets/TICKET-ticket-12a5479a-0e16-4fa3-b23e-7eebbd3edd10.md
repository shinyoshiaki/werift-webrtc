# 上流 RTP ソースを差し替えても下流の seq / timestamp タイムラインを連続させる公開ヘルパー

## 1. 目的と背景

### ユースケース

- Ring → HomeKit ゲートウェイ（`ring-client-api` / `homebridge-ring`）では、Ring 側が約 30 分で live view を `code 10 / answered_timeout` で閉じる。下流の HomeKit SRTP ストリームを維持するには上流 WebRTC 接続を作り直し、**新しい接続の RTP を既存の下流 seq / timestamp タイムラインへ写像**しなければならない（dgreif/ring#1816）。
  - 新しい接続の RTP は seq / timestamp の原点が別になる。そのまま流すと、下流の SRTP 受信側が ROC（rollover counter）推定、replay window、jitter buffer で破棄やデコード停止を起こす。
  - #1816 は `StreamingSession.forwardRtp` に独自の写像を書いている（`unsignedDelta` で前パケットとの差分を足し込む方式。切替時の timestamp step は「直前の増分」、初期値は video 3000 / audio 960）。この方式は**順序入れ替わり（reorder）に弱い**。逆順で届いたパケットの delta が 65535 近くになり、出力が飛ぶ。
  - #1834 マージ後も 30 分タイムアウトは起きるので、連続化は依然必要（同 issue のコメントより）。
- 同じ課題を持つアプリはほかにもある。SFU / リレー、録画した RTP の再生と差し替え、`SrtpSession` を直接使う RTP/SRTP 転送などで、どれも上流が変わっても下流のタイムラインを保ちたい。

### werift の現状（調査結果）

- 連続化のコアは `RtpContinuity`（`packages/rtp/src/rtp/continuity.ts`）。v0.27.0（commit `2c7e6b09b`「RTP 一般の送信側部品を werift-rtp に移す」）で `werift-rtp` に移り、`packages/rtp/src/index.ts` から export、`werift` からも re-export されている（`doc/classes/RtpContinuity.md`, `packages/rtp/doc/classes/RtpContinuity.md`）。
  - チケット題の「`RTCRtpSender` の private 実装」は**半分だけ正しい**。クラス自体は公開済みだが、`RTCRtpSender` 専用の低レベル部品で、アプリが単独で使える形になっていない。
- `RtpContinuity` の API と、そのままではアプリが使いにくい点:
  - API は `schedule(timestampStep)`、`cancel()`、`assign(header, inputSeq, inputTs)`、`mapTimestamp(ts)`、`sequenceNumber` / `timestamp` getter。
  - 方式は output = input + offset。offset は `schedule()` 後に最初に `assign()` されたパケットでだけ再計算される（`seq + 1`, `ts + step`）。同じソース内の reorder には強い。
  - **ソース切替の検出は呼び出し側の責任。** `schedule()` を正しいタイミングで呼ばなければならない。
  - **timestamp step も呼び出し側が決める**（既定 1）。経過時間やフレーム間隔からの推定はない。
  - **古いソースの遅延パケットを捨てる仕組みがない。** `RTCRtpSender` は `sourceEpoch` / `invalidateQueuedSource()`（`packages/webrtc/src/media/rtpSender.ts:749` 付近）で別に捨てている。`RtpContinuity` だけを使うと、切替後に届いた旧ソースのパケットが新しい offset で写像され、出力 seq が衝突したり後退したりする。
  - 新ソースの最初のパケットより古い（reorder した）新ソースのパケットは、旧ソースの最終出力 seq 以下に写像されうる。下流 SRTP では replay 扱いになる（v0.27.0 から werift 自身も `SrtpReplayError` で破棄する）。
  - `assign()` は `header` を直接書き換える。`MediaStreamTrack.onReceiveRtp` の `RtpPacket` は購読者間で共有されるので、アプリは自分で `clone()` しなければならない。
  - 入力値（`inputSequenceNumber` / `inputTimestamp`）を header と別に渡す API は、`RTCRtpSender` 内部の事情に合わせたもの（`mapTimestamp` で先に ts を書き換えてから `assign` する）。
  - SSRC / payload type の書き換えは対象外。
- `RTCRtpSender` 側の連続化フロー（参考。今回は挙動を変えない）:
  - `replaceTrack()`、`MediaStreamTrack.onSourceChanged`（`track.notifySourceChanged(header)`）、`replaceRTP(header, discontinuity, timestampStep)` のどれかが `scheduleRtpContinuity()` を呼ぶ。それが `invalidateQueuedSource()`、`continuity.schedule()`、`rtpCache` クリアを行う。
  - 送信直前に `sendRtpInternal` で `continuity.mapTimestamp` → `continuity.assign` の順に処理する。rewrite が起きたら `stats.resetClockAnchor()` で SR の RTP/NTP 基準も張り直す（`rtpSender.ts:1023`, `:1086-1091`）。
  - RTX / padding は独自の採番で、連続化を通らない。
  - 現状でも werift の送信経路を通すアプリ（受信 track の RTP を `track.writeRtp()` で別の `RTCRtpSender` へ流す構成）は、`notifySourceChanged()` または `sender.replaceRTP()` を呼べば連続化を使える。ただしドキュメントや example はない。
  - `RTCRtpSender` を通さない構成（`SrtpSession.encrypt` で自前送信する HomeKit 経路など）では使えない。これが今回の主対象。

## 2. 実装すべき機能・変更内容

### 2.1 アプリ向けの RTP タイムライン書き換えヘルパー（`werift-rtp`）

`RtpContinuity` を内部に使う高水準クラスを `werift-rtp` に追加する。名前は実装時に確定する。候補は `RtpTimelineRewriter` / `RtpSourceSwitcher` / `RtpStreamContinuity`。

想定 API（案）:

```ts
const rewriter = new RtpTimelineRewriter({
  clockRate: 90000,           // 任意。wall-clock 方式の step 推定に使う
  timestampStep: "auto",      // number | "lastDelta" | "wallClock" | "auto"
  ssrc: downstreamSsrc,       // 任意。出力 SSRC を固定する
  // now: () => performance.now(), // テスト用に時計を注入できるようにする
});

// 上流接続ごとに source キーを変える（接続世代番号など）
const out = rewriter.rewrite(rtp, { source: generation });
if (out) srtpSession.encrypt(out.payload, out.header);

// 明示的な切替予約も可能
rewriter.switchSource({ timestampStep: 3000 });
```

必須要件:

1. **入力パケットを変更しない。** 既定では clone して返す（共有パケット対策）。in-place を許すオプションは任意。
2. **ソース切替の検出。**
   - `source` キーの変化で自動的に切替を予約する。
   - 明示 API（`switchSource()`）でも予約できる。
   - 入力 SSRC の変化でも自動切替するオプションを付けるかを決める（Ring は接続ごとに SSRC が変わりうる）。
3. **切替後の最初のパケットは、直前の出力の続き**（`seq + 1`, `ts + step`）にする。16bit / 32bit の wrap を正しく扱う（`uint16Add` / `uint32Add` を流用）。
4. **同一ソース内の reorder・欠落をそのまま保つ**（offset 方式）。#1816 の delta 積み上げ方式は採らない。
5. **timestamp step の決め方:**
   - 固定値（number）。
   - `"lastDelta"`: 旧ソースで最後に観測した正の ts 増分。#1816 互換で、未観測時の既定値を指定可能にする。
   - `"wallClock"`: 旧ソース最終パケットから新ソース最初のパケットまでの経過時間 × `clockRate / 1000`。再接続にかかった時間を media time に反映し、A/V の相対関係を保つ。
   - `"auto"`: `clockRate` があれば `wallClock`、なければ `lastDelta`、どちらも使えなければ 1。既定値は実装時に決めて TSDoc に明記する。
6. **旧ソースの遅延パケットを捨てる。** 切替後に届いた旧 `source` のパケットは `undefined` を返して破棄する。`RTCRtpSender` の `sourceEpoch` と同じ考え方。
7. **新ソースの「最初のパケットより古い」パケットを捨てる。** 出力が旧ソースの最終出力以下に戻ると、下流 SRTP の replay window で破棄される。判定は 16bit 符号付き差分で行う。捨てるか許すかの境界は TSDoc に明記する。
8. 状態参照: 最後の出力 `sequenceNumber` / `timestamp`、`mapTimestamp(inputTs)`（RTCP SR の書き換えなどアプリ側の補助用）、切替が起きたかどうか（戻り値のメタ情報かイベント）。
9. RTX / padding-only パケットの扱いを決めて明記する。最低限、padding-only を media と同じ seq 空間で写像するかどうかを決める。werift 受信側の `filterProbePaddingOnReceiveRtp` を参照。

### 2.2 `RtpContinuity` の位置づけの整理

- 既存の `RtpContinuity` の公開 API・挙動は変えない（`RTCRtpSender` と `packages/rtp/tests/rtp/sendPath.test.ts` の約束を保つ）。
- 新ヘルパーは `RtpContinuity` を合成して作る。ロジックを重複させない。
- `RtpContinuity` の TSDoc に「アプリ向けには新ヘルパーを使う」と追記する。

### 2.3 werift 送信経路を使うアプリ向けの導線

- `MediaStreamTrack.notifySourceChanged()` / `RTCRtpSender.replaceRTP()` を使えば、`RTCRtpSender` 経由でも連続化できる。このことを README / TSDoc に記す（`replaceRTP` の `header` 引数は互換のためだけに残っていて、offset 計算には使われない点も書く）。
- 任意: `RTCRtpSender` の内部も新ヘルパーへ寄せるかを検討する。epoch 管理・pacing・SR アンカー連携が絡むので、**本チケットでは送信経路の挙動を変えない**ことを優先する。寄せるなら別チケットにする。

### 2.4 ドキュメント・example

- `packages/rtp/README.md`（必要ならルート `README.md`）に「上流を差し替えても下流の RTP タイムラインを連続させる」使い方を追記する。
- example を追加する: `examples/mediachannel/rtp_forward/` 系に、上流 RTP を差し替えながら UDP / SRTP で転送するサンプル。`examples/e2e` のカタログに載せるなら `npm run examples:e2e` も通す。
- `changelog.md` に Features として追記する（新しい export 名も書く）。
- **追加要件（レビュー後のユーザー指示）: より一般的で代表的なユースケースのサンプルアプリを 1 つ追加し、テストする。**
  - 上流接続の定期的な作り直し（`switch_source.ts`、Ring 型）に加え、リレー / SFU・配信スイッチャー・アクティブスピーカー表示で典型的な「複数のライブソースのうち 1 つを、下流の 1 本の RTP ストリームとして転送し、切り替える」構成を示す。
  - 実装: `examples/mediachannel/rtp_forward/camera_switcher.ts` / `.html`。ブラウザが 2 台のカメラ（A / B）を 1 つの接続で送る。サーバーはアクティブな方だけを `RtpTimelineRewriter`（`clockRate: 90000`、出力 `ssrc` / `payloadType` 固定）で UDP 127.0.0.1:1234 へ転送する。
  - 切替はボタンか `SWITCH_INTERVAL_MS` で要求する。新カメラへ PLI を送り、そのキーフレームが届いた時点で切り替える。それまでは旧カメラの転送を続ける。
  - 置き換えた `source` キーは廃止されたままになる。同じカメラへ戻すときは、アクティブ化ごとに新しいキー（`A#3` など）を使う。この点を README にも書く。
  - `RTCRtpSender.replaceTrack()` との使い分けを、サンプル冒頭のコメントと `packages/rtp/README.md` に書く。
    - 下流が werift から送る WebRTC 相手（ブラウザ視聴者、SFU 購読者）なら `replaceTrack()` を使う（`pubsub/offer.ts` と同じ）。
    - WebRTC 以外（UDP の ffmpeg / GStreamer、RTSP、自前の `SrtpSession`、録画）なら `RtpTimelineRewriter` を使う。
    - どちらもキーフレームは待たない。
    - 切替時の timestamp: `replaceTrack()` は +1 固定、Rewriter は経過時間などを選べる。
    - 同じソースへ戻すとき、Rewriter は新しいキーが要る。
  - テスト: `examples/e2e` のカタログに `rtp-forward-camera-switcher` を追加する。A → B → A の切替（`source switch to=A#3`）を待ち、その後も UDP へ RTP が届き続けることを確認する。さらに、転送先で SSRC が 1 つだけであること、連続するパケット間の seq の飛びが 100 以下であることを検証する（`continuousRtpMaxJump`。`switch_source` にも適用する）。
- `npm run doc` で `doc/` と `packages/rtp/doc` を再生成する。

## 3. 技術的な実装アプローチ（調査まとめ）

| 項目 | 方針 |
| --- | --- |
| 置き場所 | `packages/rtp/src/rtp/continuity.ts` に追加するか、新ファイル `packages/rtp/src/rtp/timelineRewriter.ts` を作り `src/index.ts` から export する。`werift` は `imports/rtp` 経由で自動的に re-export される |
| コア | 内部に `RtpContinuity` を 1 つ持つ。source が変わったら `schedule(step)`、各パケットは `clone()` → `assign(clone.header, inSeq, inTs)` |
| stale 判定 | 現在の source キー（世代）を保持し、それ以外の source のパケットは破棄する。`source` を使わない場合は明示 `switchSource()` 以降を新世代として扱う |
| 新ソース内の古いパケット | 新ソースの最初の入力 seq を基準に、16bit 符号付き差分（`(a - b) << 16 >> 16` 相当）が負なら破棄する |
| step 推定 | `lastDelta`: 同一ソース内で ts 差分（32bit 符号付き）が正のときだけ更新する。`wallClock`: 注入可能な `now()`（既定 `performance.now()`）で旧ソース最終受信時刻を記録する |
| SSRC / PT | オプションで出力 SSRC を固定。PT の写像は任意 |
| ブラウザ互換 | `packages/rtp/src/index.ts` はブラウザバンドル対象。Node 専用 API（`perf_hooks` の import など）を使わず、グローバルの `performance.now()` を使う |
| erasable syntax | `enum` を使わない（`as const` + 同名 union）。パラメータプロパティも使わない |

参考となる既存コード:

- `packages/rtp/src/rtp/continuity.ts`（offset 方式のコア）
- `packages/webrtc/src/media/rtpSender.ts:599-660`（`replaceTrack` / `detachTrack` での schedule / cancel）、`:724-790`（`replaceRTP`・`invalidateQueuedSource`・`scheduleRtpContinuity`）、`:1011-1091`（送信時の map / assign と SR アンカーのリセット）
- `packages/webrtc/src/media/track.ts:105-113, 194-215`（`onSourceChanged` / `notifySourceChanged` / `writeRtp` は clone する）
- `packages/webrtc/src/nonstandard/userMedia.ts:312`（ソース変化通知の利用例）
- `packages/rtp/src/srtp/context/context.ts:199-243`（ROC 推定。seq が飛ぶと誤推定する理由）、`packages/rtp/src/srtp/replay.ts`（replay window 1024）
- dgreif/ring#1816 の `forwardRtp`（比較対象、置き換え先）

## 4. 制約・注意点

- **既存挙動の互換**: `RtpContinuity` と `RTCRtpSender` の送信経路（`replaceTrack`、`replaceRTP`、pacing / probe / RTX、SR アンカー）の挙動は変えない。`packages/webrtc` の `tests/pbt/sender`、`tests/pbt/twcc`、`tests/media/rtpSender.test.ts` が通ること。
- **キーフレーム**: 映像では、切替後に新ソースのキーフレームが来るまで下流がデコードできない。上流への PLI / FIR 要求はアプリの責任なので、ドキュメントに明記する（#1816 も `requestKeyFrame()` を呼んでいる）。新ソースの最初のキーフレームまで破棄するオプションを付けるかは任意。
- **RTCP**: 上流の SR をそのまま下流へ転送すると、RTP timestamp / SSRC が合わない。`mapTimestamp()` を使った書き換え、または下流 SR をアプリ自身で生成することをドキュメントで案内する。SR 書き換えヘルパーは本チケットでは任意とする。
- **A/V 同期**: audio と video は別インスタンスで連続化するため、`lastDelta` 方式では切替の前後で両者の相対的なずれが変わりうる。`wallClock` 方式なら同じ経過時間を両者に反映できる。この違いを TSDoc に書く。
- **SRTP の ROC**: 出力 seq を連続させるのは、下流の ROC 推定と replay window を壊さないため。出力 seq の後退や重複を起こさないことを最優先の不変条件とする。
- **共有パケット**: `onReceiveRtp` の `RtpPacket` は購読者間で共有されるので、既定で clone する。
- **ブラウザバンドル**: `werift-rtp` のエントリはブラウザ向けにも提供されている。Node 専用 API を持ち込まない（`packages/rtp/AGENTS.md`）。
- **Node.js type stripping**: `enum` やパラメータプロパティを使わない（ルート `AGENTS.md`）。
- **テスト規約**: Arrange / Act / Assert で書き、Act / Assert に日本語コメントを付ける。共通の Arrange は `packages/rtp/tests/rtp/rtpTestUtils.ts` に集める。

## 5. 完了条件

- [ ] `werift-rtp` に新しいヘルパーが追加され、`werift-rtp` と `werift` の両方から import できる。
- [ ] 単体テスト（`packages/rtp/tests/rtp/` 配下）が以下を満たす:
  - [ ] 最初のソースは入力値をそのまま出力する（SSRC 固定オプションがあれば SSRC だけ書き換える）。
  - [ ] 同一ソース内の reorder / 欠落は相対関係を保つ。
  - [ ] 切替後の最初のパケットは `seq + 1` / `ts + step` になる（固定値、`lastDelta`、`wallClock` の各方式。時計は注入する）。
  - [ ] 16bit seq / 32bit ts の wrap をまたいでも連続する。
  - [ ] 切替後に届いた旧ソースのパケットは破棄される。
  - [ ] 新ソースの最初のパケットより古いパケットは破棄され、出力 seq が後退も重複もしない。
  - [ ] 入力パケットは変更されない（clone）。
  - [ ] 複数回の切替（30 分ごとの再接続を模したもの）でも単調に連続する。
  - [ ] #1816 のテストシナリオ（40000/90000, 40001/93000 → 新接続 100/5000, 101/8000 → 出力 40002/96000, 40003/99000）を `lastDelta` で再現できる。
  - [ ] `SrtpSession` の encrypt → decrypt を通しても、切替をまたいだパケットが ROC 誤推定や `SrtpReplayError` を起こさず受理される。
- [ ] 既存の `RtpContinuity` テストと `RTCRtpSender` 関連テストが変更なしで通る。
- [ ] `packages/rtp/README.md` に使い方（キーフレーム要求と RTCP の注意を含む）、`RTCRtpSender` 経路向けに `notifySourceChanged` / `replaceRTP` の説明を追記する。`changelog.md` にも追記する。
- [ ] example を追加し、`examples/e2e` カタログに載せた場合は `npm run examples:e2e` が通る。
- [ ] 追加要件: 代表的なユースケース（複数ライブソースの切替転送）の example `camera_switcher` を追加し、e2e で切替後の転送継続と単一 SSRC・seq の連続を検証する。
- [ ] `npm run doc` で生成ドキュメントを更新済み。
- [ ] 検証コマンドがすべて通る:
  - `cd packages/rtp && npm test`（`type:public` を含む）
  - `cd packages/rtp && npm run test:browser`（公開エントリを変えるため）
  - `npm run type`
  - `npm run test:small`
  - `npm run format`
- [ ] （任意）dgreif/ring 側で `forwardRtp` を新ヘルパーへ置き換える提案ができる形になっている（API で #1816 の要件を満たせる）。
