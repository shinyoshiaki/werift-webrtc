# MoQ ブログ「WebRTC is still the problem」の主張を WebRTC (werift + Encoded Transform) で再現する example を追加する

- 参照: https://moq.dev/blog/webrtc-is-still-the-problem/
- 種別: example 追加 + werift 改善 (packages/webrtc, 必要に応じて packages/rtp)

## 1. 目的と背景

この記事は Voice AI (STT→LLM→TTS) を題材に、WebRTC が MoQ より劣る点を挙げています。主張の多くは WebRTC というプロトコルの限界ではありません。**ブラウザの libwebrtc 実装 (NetEQ / 到着時刻ベースの再生 / 音声 NACK が既定で無効) の既定動作**から来ています。

そこで次の 2 つを組み合わせ、MoQ 側の利点として挙げられた挙動を WebRTC のまま再現できることを example で示します。

- ブラウザ側: **Encoded Transform で符号化済みフレームを NetEQ の手前で取り出し**、WebCodecs `AudioDecoder` と AudioWorklet でアプリ独自の再生バッファを組む (MoQ の「受信してタイムスタンプで再生する」player に相当)。
- werift 側: 長い再送待ち (latency budget) を扱えるように NACK / 再送 / 送信履歴を改善する。

この example で、「WebRTC で足りない部分はアプリ層とサーバ (werift) で埋められる」ことと、「どこが本当にブラウザ依存の限界か」の両方を可視化します。

### 記事の主張と再現方針

| # | 記事の主張 (WebRTC の弱点) | MoQ の主張 | 本チケットでの再現方針 | 優先度 |
|---|---|---|---|---|
| 1 | 遅れた音声は捨てられる (30ms 超は古すぎる扱い) | 消費側が必要とする限り再送を続ける (例: 最大 5s) | シナリオ A, C | 必須 |
| 2 | 音声再送は既定で無効。SDP munging で有効にできるが NetEQ が再送を待たない。後から来た再送は 10 倍速のバーストで再生される | QUIC 再送。音声は小さい (Opus 64kbps で 1s = 8KB) | シナリオ A (ブラウザ→werift で NACK)、シナリオ C (werift→ブラウザでアプリ層 NACK) | 必須 |
| 3, 4 | NetEQ は到着時刻で再生する。TTS は送信前に sleep が必要で、リアルタイムより速く送れない | データができ次第送り、受信側がタイムスタンプで再生する | シナリオ B (faster-than-realtime 送信 + Encoded Transform で RTP timestamp 基準の再生) | 必須 |
| 5, 10 | 一つのトランスポートに一つのレイテンシ設定しかない | subscription ごとに最大レイテンシを宣言し、同じ upstream を fan-out する (500ms / 5s) | シナリオ C (werift relay から budget の異なる 2 subscriber へ) | 必須 |
| 8 | (MoQ で) 割り込み時に古いバッファを捨てる方法として、track generation を上げる RTP 拡張を提案 | 新しい track を publish し、古い track のバッファを破棄 | シナリオ D (CSRC または DataChannel で generation を通知し、受信 player が旧 generation を破棄) | 必須 |
| 6 | Opus in-band FEC / RED は連続ロスに弱い | 再送を優先 | シナリオ A のオプション (RED と NACK+budget をバーストロスで比較) | 任意 |
| 7 | playout-delay 拡張は映像専用 (音声の再生遅延を指定できない) | subscriber が最大レイテンシを宣言し、player がそれに合わせてバッファする | 自作 player (2.1「自作 player の再生遅延制御」) で、subscriber が宣言する min/max 遅延を実装して再現 | 必須 |
| 9, 11, 12, 13 | ガバナンス / 優先度 track / backfill / STS | — | 対象外 (README で言及するのみ) | 対象外 |

## 2. 実装すべき機能・変更内容

### 2.1 example (新規)

配置案は `examples/mediachannel/latency_budget/` で、名前は実装時に確定します。Node 側は `server.ts` (WebSocket signaling, port 8888)、ブラウザ側は Vite クライアント (`index.html` + `main.ts(x)` + `player-worklet.js` + `transform-worker.js`) です。シナリオはクエリパラメータか UI で切り替えます。

#### シナリオ A: reliable upstream (ブラウザマイク → werift、STT 経路)
- ブラウザは fake mic の Opus を送信し、`a=rtcp-fb:<opus pt> nack` を有効にします。Chrome は音声 NACK を既定で answer に含めないため、記事どおり SDP munging が必要か確認し、必要なら最小限の munging を行います。
- werift は `debug` の擬似ロス (2.2.4) を受信側にかけ、音声 NACK で回収します。latency budget を 0 (従来 WebRTC 相当) と 5000ms で比較します。
- 結果の可視化:
  - werift 側の lost / recovered / unrecovered パケット数を DataChannel か WebSocket でページに表示します。
  - 受信音声を `WebmStream` で `.webm` に保存し、聴き比べられるようにします (既存 `save_to_disk/opus.ts` を参考)。
- 任意: RED (`audio/red`) を有効にした場合と比較し、バーストロスで RED が回復できないことを示します。

#### シナリオ B: faster-than-realtime TTS (werift → ブラウザ)
- werift は「AI 応答」として、シナリオ A で受信・保持した RTP を RTP timestamp を保ったまま**バーストで送信**します。sleep による pacing はしません。
- ブラウザの比較対象は次の 2 つです。
  1. ネイティブ再生 (`<audio>` に track を接続)。NetEQ が早送り・破棄する様子を確認します。
  2. Encoded Transform player。receiver transform で `RTCEncodedAudioFrame` を取得し、`getMetadata().rtpTimestamp` (無い環境では `encodedFrame.timestamp`) を基準に再生します。
     - 経路: WebCodecs `AudioDecoder` (codec `opus`) → AudioWorklet のリングバッファ。
     - 最初のフレームを基準時刻 (アンカー) として、RTP timestamp どおりの時刻に再生します。
- player 使用時はネイティブ経路を muted にし、二重再生しないようにします。

#### シナリオ C: subscriber ごとの latency budget fan-out (Voice AI 2 系統の再現)
- publisher 1 (ブラウザ) → werift relay → subscriber 2 系統へ配信します。subscriber は budget=500ms (speech-to-speech 相当) と budget=5000ms (STT→LLM→TTS 相当) です。2 タブにするか、1 ページに 2 PC を張ります。
- upstream (publisher→werift): werift が NACK し、budget 内なら回収します。
- downstream (werift→subscriber): Chrome の受信側 NACK は NetEQ の NackTracker が駆動するため、再生期限を過ぎたパケットは要求されない見込みです (実機で要確認)。
  - そこで player は `metadata.sequenceNumber` で欠番を検出し、**アプリ層 NACK を DataChannel で werift に送ります**。
  - werift は新 API (2.2.2) で該当パケットを再送します。
  - 要求は自分の budget を超えたら打ち切ります。
- 表示: subscriber ごとの「欠落フレーム数 / 回収フレーム数 / 実効遅延」。

#### シナリオ D: 割り込み (track generation)
- シナリオ B の応答をバースト送信し、player が先行バッファしている最中に、ユーザが「割り込み」ボタンを押します。
- werift は送信を止め、generation を上げます。player は旧 generation のバッファ済みフレームを即時破棄します。
- 通知方法は次のどちらかです。
  - (推奨) **RTP CSRC に generation 番号を入れる**。Encoded Transform の `metadata.contributingSources` で受信側から見えるため、記事が提案する「track generation を上げる RTP 拡張」を in-band で代替できます。
  - (代替) DataChannel で `{generation, fromRtpTimestamp}` を通知する。

#### 自作 player の再生遅延制御 (playout-delay 相当、シナリオ B/C/D 共通)

playout-delay は「送信側が受信側 jitter buffer の min/max 遅延を指示する」RTP 拡張です。Chrome は音声 (NetEQ) にこれを適用しません。ただし Encoded Transform で NetEQ の手前からフレームを取り出して自前で再生すれば、再生遅延はアプリが完全に決められます。そのため**自作 player で MoQ と同等の挙動を実現できます**。moq.dev のブラウザ player も WebCodecs + AudioWorklet で自前再生しており、player 側の構成は同じになります。差は transport (QUIC stream か RTP + NACK か) だけです。

- **遅延の宣言主体は subscriber 側**にします。MoQ の「subscription ごとに max latency を宣言」に合わせ、送信側が決める playout-delay とは向きを変えます。
- player の設定値:
  - `minDelayMs`: 再生開始前に溜める量。ジッタ吸収用。
  - `maxDelayMs` (= latency budget): この時刻までに届かないフレームは concealment して諦める。
- subscriber は budget を DataChannel で werift に通知します。werift はその subscriber への再送 (2.2.3) と upstream への NACK 待ち (2.2.2) を budget で打ち切ります。MoQ の relay が subscription の max latency で配信判断する挙動に相当します。
- 再生時刻: 最初のフレームの `rtpTimestamp` と `AudioContext.currentTime` を対応づけ、`再生時刻 = アンカー + (rtpTimestamp - 基準) / 48000 + minDelay` で AudioWorklet に配置します。予定時刻を過ぎて届いたフレームは、`maxDelayMs` 以内ならバッファ全体を後ろにずらし (遅延を増やし)、超えていれば破棄します。
- werift 側の playout-delay 拡張 (`http://www.webrtc.org/experiments/rtp-hdrext/playout-delay`) の実装は**不要**とします。Encoded Transform の metadata は任意の RTP ヘッダ拡張を公開しないため、自作 player からは読めません。Chrome ネイティブ音声経路も無視します。必要になれば別チケット (werift 同士・映像向け) で扱います。

自作で NetEQ を置き換えると、NetEQ が担っていた次の機能を自分で持つ必要があります。README に「自作 player が肩代わりしたもの」として明記します。

| NetEQ の機能 | 自作 player での扱い |
|---|---|
| PLC (欠損の補間) | WebCodecs `AudioDecoder` は Opus PLC を外部に公開しない。欠損区間は短い fade-out/in 付きの無音で埋める。任意で、次フレームの Opus in-band FEC を使った復元を検討 |
| time-stretch (加速 / 伸長) | 遅延を縮める方向は「無音区間で詰める」程度の簡易実装に留める。budget 内での遅延増加 (後ろへのずらし) を優先 |
| クロックドリフト補償 | 送信側 48kHz と `AudioContext` のクロック差で、長時間再生するとバッファが増減する。バッファ量を監視し、閾値を超えたら無音区間でサンプルを間引く / 挿入する |
| エコーキャンセル (AEC) | Chrome の AEC が WebAudio 出力を参照信号に含めるかはプラットフォームと Chrome のバージョンに依存する。Voice AI 用途でマイクを開いたまま自作 player で再生すると、エコーが残る可能性がある。実機で確認し、README でヘッドセット推奨や制約を明記 |

#### 共通
- `README.md` (example ディレクトリ): 記事の各主張との対応表、各シナリオの操作手順、「ブラウザ既定動作の限界」と「アプリ層で埋めた部分」の区別を書きます。
- 結果は `window` 上のオブジェクト (例: `window.__latencyBudgetResult`) にも公開し、smoke test から Assert できるようにします。

### 2.2 werift 側の改善 (調査で判明した不足)

#### 2.2.1 受信側 NACK を音声にも適用する
- 現状: `packages/webrtc/src/media/rtpReceiver.ts:723` は `track?.kind === "video" && hasFeedback(mediaCodec, "nack")` で、**音声は NACK 対象外**です。
- 変更: codec に `nack` feedback が negotiate されていれば kind を問わず `NackHandler` に通します。音声の既定 codec (`packages/webrtc/src/media/codec.ts`) には nack が無いので、既定の挙動は変わりません。

#### 2.2.2 NACK のリトライ方針を時間ベースにし、latency budget を設定可能にする
- 現状: `packages/webrtc/src/media/receiver/nack.ts` は 5ms 間隔で全欠番を NACK し、`retryCount = 10` で諦めます。つまり**約 50ms で再送待ちを打ち切ります**。`LOST_SIZE = 150` の上限もあります。
- 変更: 「最大待ち時間 (budget ms)」と「リトライ間隔 (RTT 連動か固定)」を設定できるようにします。
  - 設定単位は receiver 単位か `RTCRtpCodecParameters` / `PeerConfig` のいずれかで、設計時に決めます。
  - 既定値は現行の挙動と互換にします。video の既存テスト `packages/webrtc/tests/media/nack.test.ts` を壊さないこと。
- 回収した再送パケットは現状どおり `track.onReceiveRtp` に流します。後段の `JitterBuffer` processor は `latency` に budget を設定して使います。

#### 2.2.3 送信側の再送履歴を設定可能にし、アプリ層 NACK 用の再送 API を追加する
- 現状: `packages/webrtc/src/media/rtpSender.ts:86` は `RTP_HISTORY_SIZE = 128` 固定です (20ms Opus で約 2.5s)。5s budget には最低 250 パケットが必要です。
- 変更:
  - 履歴サイズ (またはミリ秒) を sender / PeerConfig で設定可能にします。既定値は 128 のまま。
  - `GenericNack` 受信時の再送処理 (`rtpSender.ts:833-866` 付近) を関数に切り出し、公開メソッド (例: `RTCRtpSender.retransmit(sequenceNumbers: number[])`) からも呼べるようにします。DataChannel 経由のアプリ層 NACK から使います。nonstandard 扱いにするかは設計時に判断します。
  - 音声 (Chrome は音声 RTX 非対応の見込み) では RTX なしで同一 SSRC のまま再送します。既存ロジック (`rtxPayloadType` 未設定時) がそのまま使えます。

#### 2.2.4 擬似パケットロス (`DebugConfig`) の修正と拡張
- **バグ**: `packages/webrtc/src/transport/dtls.ts:237,379,445,462` の判定が `loss / 100 < Math.random()` です。このため指定 % の**逆 (100-p %) が破棄**されます。`peerConfig.ts:26-35` の `/**% */` とも矛盾します。`Math.random() < loss / 100` に修正し、テストを追加します。
- 拡張: 記事は「輻輳ロスはバースト的」と強調しており、一様ロスでは RED と NACK の差が出ません。そこで debug 用にバーストロスモデルを追加します。
  - 例: `{ burstEveryMs, burstDurationMs }` や Gilbert-Elliott。
  - E2E で安定させるため、決定的に動かせる (seed 可能、または周期的) ようにします。

#### 2.2.5 relay 時の遅延パケットの扱い
- `rtpSender.ts:705-710` は `writeRtp`/`sendRtp` のたびに `this.sequenceNumber` / `this.timestamp` / `rtpTimestamp` を上書きします。upstream で回収した**古い seq の再送パケットを relay すると、送信状態が巻き戻り**ます (SR の rtpTimestamp、replaceTrack 時の continuity 計算に影響)。
- 変更: 「最新より古いパケットは状態を更新しない」よう修正します。seq のオフセット変換はそのまま使えます。

#### 2.2.6 CSRC のパススルー確認
- シナリオ D で使うため、`sendRtp` に渡した `RtpHeader.csrc` が保持されて送出されることを確認します。保持されない場合は修正し、テストを追加します。

## 3. 技術調査の結果 (要約)

- **既存資産**
  - `examples/save_to_disk/encodedTransform/`: Vite + `createEncodedStreams()` (`encodedInsertableStreams: true`) で sender transform を使う既存例があり、構成を流用できます。
  - `examples/mediachannel/red/`: RED の送受信例。
  - `examples/mediachannel/rtx/`: RTX の例。
  - `examples/save_to_disk/packetloss/gst.ts`: ロス下の NACK/PLI の例。
  - `packages/rtp/src/extra/processor/`: `jitterBuffer` (`latency` オプションあり)、`nack`、`depacketizer`、`webmStream` などの processor 群。
- **werift の不足**: 2.2 のとおり、音声 NACK 無効、約 50ms で再送打ち切り、送信履歴 128 固定、擬似ロスの判定反転、relay 時の状態巻き戻り。
- **Chrome (libwebrtc) 側の前提** (いずれも実装初期に実機で検証すること)
  - 音声 NACK は既定 SDP に含まれません。記事どおり SDP munging で有効化します。送信側の音声 RTP 履歴は NACK を negotiate すると有効になる見込みです (libwebrtc の音声 NACK 履歴は約 5s)。
  - 受信側の audio frame transformer は `ChannelReceive` で NetEQ 投入より前に呼ばれます。このため**遅れて届いた再送パケットも transform には届く**見込みで、本チケットの核になる前提です。届かない場合は、DataChannel で再送パケットを別送する方式に切り替えます。
  - `RTCEncodedAudioFrame.getMetadata()` で使う値: `synchronizationSource`, `payloadType`, `contributingSources`, `sequenceNumber`, `rtpTimestamp`, `receiveTime` など。フィールドの有無は Chrome のバージョンに依存するので、feature-detect してフォールバックします。
  - Encoded Transform API: `RTCRtpScriptTransform` (Worker) と旧 `createEncodedStreams()` の両方を feature-detect で扱います。Playwright 同梱 Chromium のバージョンでどちらが使えるかを確認します。
  - ネイティブ track を再生しないとき、受信 transform が回り続けるか (muted `<audio>` への接続が必要か) を確認します。

## 4. 制約・注意点

- `examples/AGENTS.md` に従います。
  - `examples/e2e/tests/helpers/catalog.ts` と AGENTS.md の catalog 表を同時に更新します。
  - smoke test は catalog の Node `.ts` と HTML を起動します。
  - Chromium に werift polyfill を注入しません。fake media device のみを使います。
- 外部サービスや gst/ffmpeg に依存させず、`browser` グループの smoke test に入れます。STUN は使わないか `stun.l.google.com:19302` を使います (ローカル fixture にリダイレクトされます)。
- ロスは確率的なので、smoke の Assert は「budget 大 の回収数 ≥ budget 小 の回収数」「unrecovered=0 (budget 5s、決定的ロス)」のように**決定的に成り立つ条件**にします。音質の主観評価はテストにしません。
- 公開 API を変える場合 (NACK budget、送信履歴設定、`retransmit` API、DebugConfig 拡張):
  - `npm run doc` で生成ドキュメントを再生成します。
  - `changelog.md` と該当 README を更新します。
  - 既定値は現行互換にします (AGENTS.md: 既定の `packages/webrtc/src` の利便性挙動を保つ)。
- WPT 専用の厳格挙動は入れません。debug ロスは `DebugConfig` の範囲に留めます。
- テストは Arrange / Act / Assert で書き、Act / Assert には日本語コメントを付けます。共有 Arrange は既存の helper (`examples/e2e/tests/helpers/`、packages 側は各テスト領域のユーティリティ) に置きます。
- 記事の主張のうち、**ブラウザ実装上どうしても再現できない点** (NetEQ そのものの挙動変更、ネイティブ音声経路での playout-delay 適用など) は再現できたように見せかけません。README に「Encoded Transform + 自作 player で NetEQ を迂回した」と明記し、自作 player の制約 (PLC の簡易化、AEC、クロックドリフト) も併記します。
- 記事の内容は 2026-10 時点のものです。将来 Chrome の既定が変わる可能性があるので、README に検証時の Chrome バージョンを記録します。

## 5. 完了条件

- [ ] 新規 example (シナリオ A〜D) を追加し、ローカルの Chrome で手動確認できる。
  - A: budget 0 と 5000ms で、擬似ロス下の werift 側 recovered / unrecovered に明確な差が出る。
  - B: バースト送信した音声を Encoded Transform player が RTP timestamp どおりの速度で再生する。ネイティブ再生との差が UI で確認できる。
  - C: 500ms / 5000ms の 2 subscriber で、同一ロス条件下の回収率と実効遅延が異なる。
  - D: 割り込み後、旧 generation のバッファ済み音声が再生されない。
  - 自作 player の `minDelayMs` / `maxDelayMs` が subscriber ごとに効く。
    - 同じ入力でも、設定値に応じて実効遅延と、破棄 / 回収されるフレーム数が変わる。
    - budget が DataChannel 経由で werift の再送打ち切りに反映される。
- [ ] werift 改善 (2.2.1〜2.2.6) を実装し、unit test を追加する。
  - 音声 NACK、時間ベースの NACK budget、送信履歴サイズ、再送 API、擬似ロス判定の修正とバーストロス、relay 時に状態が巻き戻らないこと、CSRC パススルー。
- [ ] `examples/e2e/tests/helpers/catalog.ts`、`examples/AGENTS.md` の catalog 表、smoke test (`examples/e2e/tests/...`) を追加・更新し、`window` に公開した結果を Assert する。
- [ ] example の README に、記事の主張との対応表、手順、限界を記載する。公開 API の変更は `changelog.md` と生成ドキュメント (`npm run doc`) に反映する。
- [ ] 検証コマンドがすべて通る。
  - `cd packages/webrtc && npm test` (と、変更があれば `packages/rtp`)
  - `npm run type`
  - `npm run test:small`
  - `cd examples/e2e && npm run type && npm run ci:silent` (または `npm run examples:e2e`)
  - `npm run format`

## 6. 追加要件: 推定をやめ、送信側の事実と照合する (2026-10-28 追加)

レビューで「最初に受信したパケット」「固定時間の待機」「受信数からの推定」を前提にした箇所が、到着順・遅延・先頭/末尾ロスのいずれかで繰り返し破綻した。以降は**送信側が知っている事実**と照合し、照合できないときは推定値を出さずに実行時に `unverified` と表示する。

### 6.1 送信範囲を送信側から通知する (シナリオ A)
- Chrome の送信側 Encoded Transform の metadata には `sequenceNumber` が無い (Playwright 同梱 HeadlessChrome 156.0.8078.4 で確認)。一方 `rtpTimestamp` は wire 上の受信側 `rtpTimestamp` と一致し、Opus 20ms は 1 フレーム = 1 パケット (+960 ticks, +1 seq)。
- publisher に sender transform (ゲート) を入れ、最初のフレーム通過時に `{type:"start", firstRtpTimestamp}`、停止時に `{type:"stop", firstRtpTimestamp, lastRtpTimestamp, frames}` を通知する。停止後のフレームは transform で破棄し、送信範囲に含めない。
- werift は受信済みの任意の 1 パケット (seq s, ts t) から `firstSeq = s − (t − firstTs)/960`、`lastSeq = firstSeq + frames − 1` を求める。
  - 受信した全パケットについて seq と timestamp の対応を検算し、`frames === (lastTs − firstTs)/960 + 1` も確認する。
  - 合わない場合 (DTX・ptime 変化・範囲外のパケット) は範囲を推定せず、統計に `accounting.status: "unverified"` と理由を出す。

### 6.2 NACK の先頭欠落 API (packages/webrtc)
- `NackHandler.markSentFrom(seq)` と `RTCRtpReceiver.markFirstSentSequence(seq)` (nonstandard) を追加する。最初に受信したパケットより前の欠番も lost として NACK する。パケット受信前に呼んでもよい。
- 先頭で順序が入れ替わって届いたパケットは欠番にしない。16bit の折り返しをまたぐ範囲を扱う。
- 諦めた後に届いたパケットを `NackStats.late` として数える (`unrecovered` に含む)。届かなかった数は `unrecovered − late`。
- unit test: 先頭欠落、先頭の入れ替わり、16bit 折り返し、late の計上。

### 6.3 集計を重複なしの集合で定義する
- 受信数は重複を除いた数 (再送の重複応答は 1 回)。重複は relay・保持もしない。
- 不変条件: `uniqueReceived + pending + (unrecovered − late) === frames`、かつ範囲外・対応崩れのパケットが 0 (`balanced`)。

### 6.4 smoke に敵対的な条件を入れる
- シナリオ A に、少なくとも次を決定的にかける。budget 0 / 5000ms とも `verified`・`balanced`・`pending = 0` を Assert する。
  - (a) 先頭ロス: 最初の 8 パケットの初回送信を落とす (`DebugConfig.inboundRtpDrop` で seq 単位に判定し、再送は通す)。
  - (b) 末尾ロス: 停止直前 300ms の初回送信を落とす。
  - (c) 停止通知より後に届く RTP: 最後の 10 フレームを送信側 transform で保持し、停止の 1 秒後に送る。
- 周期ロスは時刻ではなく seq の位置で決める (100 パケットごとに 15 個の初回送信を落とす)。時刻ベースのバーストは停止時刻によって停止後の保持フレームを覆うかどうかが変わり、結果が決定的にならないため。
- werift は報告後も集計を閉じず、後から届いたパケットを `late`・`arrivedAfterStop` に数えて再報告する。budget 0 では、保持フレームの到着後も `verified`・`balanced`・`pending = 0` で、`late === arrivedAfterStop` であることを Assert する。
- budget 5000ms では、先頭・末尾・停止後の分も含めて全フレームを受信し、保存した `.webm` に全フレームが seq 順に書かれていることを Assert する。
- シナリオ C の長いロスは購読の最初のパケットから始め、開始通知で先頭の欠落も検出・回収できることを Assert する。

### 6.5 同じ型の前提の点検
- 固定値の待機 (`SETTLE_ARRIVAL_MS` など) をやめる。停止後の待機は「未解決の欠番が 0 になるまで」とし、上限は budget から決める。
- 「最初に受信したもの」を開始とみなす処理を、送信側の通知で置き換える。
  - 録音: `JitterBufferOptions.startSequenceNumber` (packages/rtp)。
  - シナリオ C の subscriber: werift が最初に relay したパケットを DataChannel で通知し、player は通知までフレームを保留する。
- 折り返す RTP の番号 (16bit seq、32bit timestamp) を固定の開始値と比較しない。最新値を基準に拡張した値で扱い、半周・一周を超える長い入力でも正常なパケットを誤判定しない (購読開始位置、集計のフレーム位置、relay の遅れ判定、player の generation 境界)。開始通知前に届いたパケットも全て集計・検証する。
- relay は subscriber の DTLS 確立後に開始する。確立前に送ったパケットは送信履歴に入らず再送できないため。
- 録音保持の上限 (`RECORDING_MAX_PACKETS`) を超えた分は `recording.evicted` として統計に出す。
- `.webm` の末尾が欠ける問題 (`Lipsync` が終了時にバッファを捨てる) は werift 側で修正する。
  - 映像・音声を録音する場合も、一方の終了で `Lipsync` 全体を止めない。使用中の全種別が終了してから、保持分を時刻順に出力して終える。出力は最も遅れている種別の時刻までに留め、jitter buffer が欠番を待って保持していた音声 (または映像) を古いフレームとして捨てない。登録順 (映像→音声、音声→映像) の両方を録音テストで確認する。
  - リングの区画を再利用する前に古い周回のフレームを出力し、異なる周回のフレームを混在させない。片方の種別がリング容量 (既定 5 秒) 以上止まっても、もう一方のフレームを欠落させないことを、`jitterBuffer` なしの通常録音を含めてテストで確認する。
- `RTCRtpSender.retransmit({ maxAgeMs })` は初回送信からの経過時間で判定する。同じ RTP (同じ seq・timestamp) を再び送っても初回送信時刻を保持する。

### 6.6 進め方
- 修正報告に「未確認・制約」を残さない。残す場合は、RTP の仕組み上観測できないことを根拠で示し、実行時に検出・表示する。
- 再レビューの前に、到着順の入れ替え・遅延・先頭/末尾ロス・重複・16bit 折り返しの観点で自己レビューする。
- 指摘箇所と同じ型の前提は、1 回の修正でまとめて直す。
