---
ide:
  viewer: review-document
  version: 1
  title: "DataChannel 送信待ち量・バックプレッシャーのレビュー解説"
  dock: right
  baseCommit: bf46cc956c653811c4652d89c9c3bb22a3964a04
---
# DataChannel の送信待ち量とバックプレッシャーを公開 API で扱えるようにする（レビュー解説）

## 1. 概要

下流が `dataChannelQueue` や `addBufferedAmount` などの内部に触って回避していた 3 つの不備（接続中の `close()` でメッセージが消える、`ondatachannel` 内の `close()` が DCEP ACK を追い越す、`send("")` が送られない）を werift 側で直しました。あわせて `bufferedAmount` を W3C 準拠の読み取り専用にし、`onbufferedamountlow` と `SCTP.send()` の戻り値 `SctpSendResult` を追加しました。これで下流は `ch.close()` と `ch.send("")` を呼ぶだけで済みます。

性能の話（#730、キューの計算量）は含みません。変更の対象は API と意味論だけです。範囲は `packages/sctp` と `packages/webrtc` で、比較の基準は `0a03984d9`（チケット実装前の develop マージ）です。

## 2. 変更前後の流れ

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:sans-serif;font-size:12px">
<svg viewBox="0 0 340 250" width="340" role="img" aria-label="Before: close while connecting drops messages">
<rect x="0" y="0" width="340" height="250" rx="8" fill="none" stroke="#c0392b"/>
<text x="10" y="20" font-weight="bold" fill="#c0392b">Before</text>
<rect x="20" y="35" width="300" height="32" rx="4" fill="none" stroke="#888"/><text x="30" y="56">send() x N → dataChannelQueue</text>
<rect x="20" y="85" width="300" height="32" rx="4" fill="none" stroke="#888"/><text x="30" y="106">close() while connecting</text>
<rect x="20" y="135" width="300" height="32" rx="4" fill="#c0392b" fill-opacity="0.2" stroke="#c0392b"/><text x="30" y="156">dataChannelQueue.filter() で未送信を捨てる</text>
<rect x="20" y="185" width="300" height="32" rx="4" fill="#c0392b" fill-opacity="0.2" stroke="#c0392b"/><text x="30" y="206">即 closed。bufferedAmount は減算されない/0 に落ちる</text>
<path d="M170 67v18M170 117v18M170 167v18" stroke="#888"/>
</svg>
<svg viewBox="0 0 340 250" width="340" role="img" aria-label="After: close while connecting keeps messages">
<rect x="0" y="0" width="340" height="250" rx="8" fill="none" stroke="#1e8449"/>
<text x="10" y="20" font-weight="bold" fill="#1e8449">After</text>
<rect x="20" y="35" width="300" height="32" rx="4" fill="none" stroke="#888"/><text x="30" y="56">send() x N → dataChannelQueue</text>
<rect x="20" y="85" width="300" height="32" rx="4" fill="none" stroke="#888"/><text x="30" y="106">close() → closing（closeAfterFlush に登録）</text>
<rect x="20" y="135" width="300" height="32" rx="4" fill="#1e8449" fill-opacity="0.2" stroke="#1e8449"/><text x="30" y="156">確立後 dataChannelFlush() が先に SCTP へ渡す</text>
<rect x="20" y="185" width="300" height="32" rx="4" fill="#1e8449" fill-opacity="0.2" stroke="#1e8449"/><text x="30" y="206">その後 resetStream() → 両側 close</text>
<path d="M170 67v18M170 117v18M170 167v18" stroke="#888"/>
</svg>
</div>

図の凡例: 赤は問題のある経路、緑は修正後に変わった経路、灰色は変更なしです。接続前に `close()` した channel のメッセージを捨てず、association 確立後に「SCTP へ渡す → stream reset」の順で処理します。

## 3. 主要変更

### 3.1 SCTP: `send()` が結果を返す

- [packages/sctp/src/sctp.ts:140](review-file:packages/sctp/src/sctp.ts:140) に `SctpSendResult`（`sent` / `abandoned` / `discarded`）を `as const` オブジェクトと同名の union 型で定義しました（erasable syntax の制約に合わせています）。`index.ts` から export します（[packages/sctp/src/index.ts:16](review-file:packages/sctp/src/index.ts:16)）。
- [packages/sctp/src/sctp.ts:1226](review-diff:packages/sctp/src/sctp.ts:1226) の `send()` は、最後の chunk を送れば `sent`、PR-SCTP で諦めれば `abandoned`、association が閉じれば `discarded` で解決します。この区別が「送れなかった分は `bufferedAmount` から引かない」ための土台です。
- 長さ 0 の `userData` は chunk を作らず、stream sequence も消費せず、すぐ `sent` で解決します。停止済みの association への `send()` は、キュー・TSN・stream sequence を進めずに `discarded` を返します（最後のコミット `bf46cc956` で `isStopped` の判定を `streamSeqNum` を読む前に移しました）。
- `outboundQueue` は `@deprecated` と `@internal` にしました。private 化は v0.30.0 です（[packages/sctp/src/sctp.ts:227](review-file:packages/sctp/src/sctp.ts:227)）。

### 3.2 DataChannel: `bufferedAmount` の公開契約

- [packages/webrtc/src/dataChannel.ts:132](review-diff:packages/webrtc/src/dataChannel.ts:132) で `bufferedAmount` を getter のみにし、値は `_bufferedAmount` に持たせました。
- `changeBufferedAmount()`（[packages/webrtc/src/dataChannel.ts:259](review-diff:packages/webrtc/src/dataChannel.ts:259)）が加減算と閾値通知をまとめます。`closed` の channel には通知しません。旧 `addBufferedAmount()` は `@deprecated` で挙動を保ちます（旧来どおり closed でも通知）。
- `onbufferedamountlow` を追加し、`bufferedAmountLow` Event と `bufferedamountlow` イベントと同時に呼びます。
- `send()` は `closing` / `closed` の channel では無視します。`closing` イベントは「相手が reset した側」でのみ発火します。自分の `close()` 側では発火しません（`setReadyState` の `notifyClosing`、W3C に合わせた結果です）。

### 3.3 RTCSctpTransport: キューと close の順序

- 空メッセージ: [packages/webrtc/src/transport/sctp.ts:866](review-diff:packages/webrtc/src/transport/sctp.ts:866) の `datachannelSend` が、長さ 0 のとき PPID 56 / 57 とペイロード 1 バイトで積みます。`bufferedAmount` と `bytesSent` は 0 のままです。受信側も PPID 56 / 57 では `bytesReceived` に 0 を足します。
- キュー要素: `QueuedMessage` に省略可能な 4 つ目の要素（`bufferedBytes`）を足しました（[packages/webrtc/src/transport/sctp.ts:54](review-file:packages/webrtc/src/transport/sctp.ts:54)）。下流の旧 `_sendEmpty` が積む 3 要素タプルが v0.29.0 でも動きます。
- flush: [packages/webrtc/src/transport/sctp.ts:785](review-diff:packages/webrtc/src/transport/sctp.ts:785) の `dataChannelFlush()` は `closing` の channel のメッセージも送ります。`discarded` で解決したものは減算しません。最後に `closeAfterFlush` の channel の stream を reset します。
- close: [packages/webrtc/src/transport/sctp.ts:1052](review-diff:packages/webrtc/src/transport/sctp.ts:1052) の `dataChannelClose()` は、確立済みなら「flush → `resetStream`」の順に実行します。未確立なら `closeAfterFlush` に登録します。association が終わっている場合と、DCEP OPEN 未送信（`unannounced`）の channel は、従来どおり即 `closed` でキューから捨てます。
- DCEP ACK: [packages/webrtc/src/transport/sctp.ts:584](review-diff:packages/webrtc/src/transport/sctp.ts:584) で、ACK を積んでから `onDataChannel` を呼ぶ順に変えました。ハンドラ内で `close()` しても ACK が reset より先に出ます。ハンドラが閉じた channel を `open` に戻さないよう、`connecting` のときだけ `open` にします。遅れた ACK も `closing` の channel を再び開きません。
- stop: `discardUnsentMessages` は未送信分を捨てても `bufferedAmount` から引きません。

### 3.4 テスト・WPT・ドキュメント

- 新規: [packages/webrtc/tests/datachannel/bufferedAmount.test.ts](review-file:packages/webrtc/tests/datachannel/bufferedAmount.test.ts)（閾値跨ぎ、空メッセージ、pc.close、ロス、部分信頼、旧タプル互換）、[packages/webrtc/tests/datachannel/closeDelivery.test.ts](review-file:packages/webrtc/tests/datachannel/closeDelivery.test.ts)（接続中 close、ondatachannel 内 close、closing イベント）、[packages/sctp/tests/sendResult.test.ts](review-file:packages/sctp/tests/sendResult.test.ts)。共通 Arrange は [packages/webrtc/tests/datachannel/dataChannelFlowUtils.ts](review-file:packages/webrtc/tests/datachannel/dataChannelFlowUtils.ts) と [packages/sctp/tests/utils.ts](review-file:packages/sctp/tests/utils.ts)（`outboundQueueOf`）に置きました。
- 既存テスト [packages/webrtc/tests/transport/sctp.test.ts](review-diff:packages/webrtc/tests/transport/sctp.test.ts) は、stop 後に `bufferedAmount` が減らない新しい期待に反転しました。
- WPT: [packages/webrtc/wpt/allowlist.json](review-diff:packages/webrtc/wpt/allowlist.json) に `RTCDataChannel-bufferedAmount.html` を追加し、[packages/webrtc/wpt/baseline.json](review-diff:packages/webrtc/wpt/baseline.json) に安定して通る subtest を追加しました。runner の sandbox に `Blob` を足し（[packages/webrtc/tools/wpt-runner/runner.ts](review-diff:packages/webrtc/tools/wpt-runner/runner.ts)）、2 ファイルを long timeout にしました（[packages/webrtc/tools/wpt-runner/timeoutLogic.ts](review-diff:packages/webrtc/tools/wpt-runner/timeoutLogic.ts)）。
- ドキュメント: [changelog.md](review-diff:changelog.md)、[packages/webrtc/README.md](review-diff:packages/webrtc/README.md)、再生成した `doc/`。

## 4. 判断理由

- **ACK 量の非標準 API は入れませんでした。** 下流は ACK 待ちをすでにやめており、「close 前に送ったものは届く」は標準の closing procedure（RFC 6525 の Sender's Last Assigned TSN と deferred reset）で保証できます。必要になったら別チケットで扱います。
- **`SCTP.send()` の戻り値を広げました。** 別の通知経路を作るより、送信の結末を 1 箇所で区別できます。`await` するだけの呼び出し側には影響しません。
- **`outboundQueue` の private 化と `addBufferedAmount` の削除は v0.30.0 に送りました。** 下流が移行できる版を 1 つ挟むためです。フォローアップは `020426ac-4feb-492c-bd1e-df3d7301c1a6` に起票済みです（チケット記載）。
- **`closing` イベントは自分の `close()` では発火しません。** W3C と WPT `RTCDataChannel-close.html` の closing 系 4 subtest に合わせた結果です。

## 5. レビュアーが確認すべき点・リスク

| 観点 | 内容 |
| --- | --- |
| 破壊的変更 | `bufferedAmount` の代入が strict mode で TypeError になります。close / stop 後に 0 へ落ちなくなります。`closing` が自分側の `close()` で発火しなくなります。いずれも changelog の Breaking changes と Fixes に記載があります |
| `sctp.send` の差し替え | `() => Promise<void>` で差し替えているコードは型エラーになりえます（changelog に記載） |
| `send()` の挙動 | `closing` / `closed` では無視します（以前はキューに積んで捨てていました） |
| DCEP OPEN 未送信の close | 即 `closed` でメッセージも捨てます。確立前でも保持される channel（negotiated など）と挙動が分かれるので、`unannounced` の判定が妥当か確認してください |
| reset と flush の順序 | `dataChannelClose` と `closeAfterFlush` の処理で「flush → reset」を守っているか、`resetAssociation` 後に `closeAfterFlush` が漏れないか（`clear()` を 3 か所で呼びます） |
| SCTP の不変条件 | `isStopped` を早期 return に移したため、停止後は TSN と stream sequence が進みません。`sendWaiters` の解決順は変わっていません |
| 性能 | flush は同期 1 パスのままです。ベンチマークは取っていません |

## 6. 検証結果

この解説の作成時に私が実行したものは次のとおりです。

- `cd packages/sctp && npx vitest run tests/sendResult.test.ts`: 5 件すべて成功
- `cd packages/webrtc && npx vitest run tests/datachannel/bufferedAmount.test.ts tests/datachannel/closeDelivery.test.ts`: 2 ファイル 26 件すべて成功

`npm run type`、`npm run test:small`、`npm run wpt` / `wpt:coverage`、`npm run format`、`npm run doc` は、この作業では実行していません。チケットの進捗欄には、WPT を 10 回実行して毎回 PASS の subtest だけを baseline に入れたと記載があります。その結果は私は再確認していません。
