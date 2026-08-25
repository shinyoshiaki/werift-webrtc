---
ide:
  viewer: review-document
  version: 1
  title: "werift 本体の mediasoup 対応実装"
  dock: right
  baseCommit: 589a76f269b60a83321e724c486b313c95793897
---
# werift 本体の mediasoup 対応実装

## 概要

チケット `66f91b2c` の本体側の目的は、Node 上で `installPolyfill({ mediaRegister })` だけを入れれば `mediasoup-client` が `handlerName` なしで Chrome111 Handler を選び、produce / consume / DataChannel まで進めることです。polyfill は `werift/polyfill` 専用エントリで、既定の `src/index.ts` には載せません。

mediasoup（ICE-lite、Chrome111 の SDP/RTP、simulcast RID、DTLS close_notify）に合わせて、DTLS 終了、ICE restart、送信 RID、`replaceTrack` も直しています。fixture のテスト隔離は別文書 `reviews/mediasoup-e2e-isolation.md` です。

## 主要変更

### 1. User-Agent 補完で Chrome111 を自動検出する

[`packages/webrtc/src/polyfill/browserIdentity.ts:5`](review-file:packages/webrtc/src/polyfill/browserIdentity.ts:5) に Chromium 111 互換の固定 UA を置き、未設定・空・`Node.js/<major>` のときだけ補完します。既存のブラウザ UA は保持し、明示 `userAgent` は常に優先します。

解決ロジックは [`packages/webrtc/src/polyfill/browserIdentity.ts:30`](review-file:packages/webrtc/src/polyfill/browserIdentity.ts:30) です。差分は [`packages/webrtc/src/polyfill/browserIdentity.ts:5`](review-diff:packages/webrtc/src/polyfill/browserIdentity.ts:commit:9bd675f9:5) です。

[`packages/webrtc/src/polyfill/install.ts:46`](review-file:packages/webrtc/src/polyfill/install.ts:46) がオプション検証のあと `installUserAgent` を呼び、失敗時は navigator ごと rollback します。

[`packages/webrtc/src/polyfill/install.ts:91`](review-file:packages/webrtc/src/polyfill/install.ts:91)
[`packages/webrtc/src/polyfill/install.ts:91`](review-diff:packages/webrtc/src/polyfill/install.ts:commit:9bd675f9:91)

公開面は [`packages/webrtc/src/polyfill/index.ts:31`](review-file:packages/webrtc/src/polyfill/index.ts:31) の `installPolyfill` です。本体 API からの re-export はありません。

[`packages/webrtc/src/polyfill/index.ts:31`](review-diff:packages/webrtc/src/polyfill/index.ts:commit:9bd675f9:31)

Chrome111 Handler の同時 DataChannel 上限に合わせ、[`packages/webrtc/src/transport/sctp.ts:30`](review-file:packages/webrtc/src/transport/sctp.ts:30) で `maxChannels = 65535` にしています。

[`packages/webrtc/src/transport/sctp.ts:30`](review-diff:packages/webrtc/src/transport/sctp.ts:commit:9bd675f9:30)

### 2. DTLS close_notify を ICE 停止前に出す

mediasoup は ICE-lite のため、相手の切断は ICE disconnect より DTLS Alert で見えます。[`packages/dtls/src/socket.ts:205`](review-file:packages/dtls/src/socket.ts:205) が暗号化 `close_notify` を送り、ICE consent 切れでも nominated pair へ載せる `sendClosing` を使います。

[`packages/dtls/src/socket.ts:205`](review-diff:packages/dtls/src/socket.ts:commit:3a622cbf:205)

WebRTC 側の [`packages/webrtc/src/transport/dtls.ts:504`](review-file:packages/webrtc/src/transport/dtls.ts:504) は notify のあと 20ms 待ってから ICE を止め、UDP 上の Alert が 5-tuple 閉鎖で落ちないようにしています。

[`packages/webrtc/src/transport/dtls.ts:504`](review-diff:packages/webrtc/src/transport/dtls.ts:commit:3a622cbf:504)

consent を迂回する送信口は [`packages/webrtc/src/transport/dtls.ts:713`](review-file:packages/webrtc/src/transport/dtls.ts:713) の `IceTransport.sendClosing` です。

[`packages/webrtc/src/transport/dtls.ts:713`](review-diff:packages/webrtc/src/transport/dtls.ts:commit:3a622cbf:713)

相手 DTLS が `closed` になったときは [`packages/webrtc/src/secureTransportManager.ts:525`](review-file:packages/webrtc/src/secureTransportManager.ts:525) で `connectionState` を `disconnected` にします。明示 `close()` とは分けています。

[`packages/webrtc/src/secureTransportManager.ts:525`](review-diff:packages/webrtc/src/secureTransportManager.ts:commit:3a622cbf:525)

### 3. ICE restart 後も nominated pair を作り直す

以前は DTLS が `connected` のままだと `iceTransport.start()` をスキップし、restart 後に nominated が無い状態で close_notify が落ちていました。[`packages/webrtc/src/peerConnection.ts:890`](review-file:packages/webrtc/src/peerConnection.ts:890) は `nominated` の有無で ICE 再 start を決めます。

[`packages/webrtc/src/peerConnection.ts:890`](review-diff:packages/webrtc/src/peerConnection.ts:commit:3a622cbf:890)

### 4. Chrome111 simulcast 用の MID / RID 送信

Chrome111 の encodings は `r0` / `r1` / `r2` の RID を持ち、SSRC を SDP に書きません。既定の映像ヘッダ拡張を [`packages/webrtc/src/peerConnection.ts:1396`](review-file:packages/webrtc/src/peerConnection.ts:1396) で MID + RID にしました。

[`packages/webrtc/src/peerConnection.ts:1396`](review-diff:packages/webrtc/src/peerConnection.ts:commit:3a622cbf:1396)

[`packages/webrtc/src/media/rtpSender.ts:274`](review-file:packages/webrtc/src/media/rtpSender.ts:274) が `sendEncodings[].rid` を `rtpStreamId` に載せ、[`packages/webrtc/src/media/rtpSender.ts:193`](review-file:packages/webrtc/src/media/rtpSender.ts:193) の `prepareSend` は既存 RID を消しません。

[`packages/webrtc/src/media/rtpSender.ts:274`](review-diff:packages/webrtc/src/media/rtpSender.ts:commit:3a622cbf:274)

パケットへの RID 付与は [`packages/webrtc/src/media/rtpSender.ts:423`](review-file:packages/webrtc/src/media/rtpSender.ts:423) です。

[`packages/webrtc/src/media/rtpSender.ts:423`](review-diff:packages/webrtc/src/media/rtpSender.ts:commit:3a622cbf:423)

### 5. replaceTrack が先頭 RTP 待ちで死なないようにする

simulcast の pump は `replaceTrack` の後に動きます。先頭パケット待ちを外し、[`packages/webrtc/src/media/rtpSender.ts:287`](review-file:packages/webrtc/src/media/rtpSender.ts:287) では登録と RTP ヘッダ引き継ぎだけにしています。

[`packages/webrtc/src/media/rtpSender.ts:287`](review-diff:packages/webrtc/src/media/rtpSender.ts:commit:3a622cbf:287)

## 判断理由

mediasoup-client の検出は `navigator.userAgent` に依存します。Node 既定 UA のままでは Handler が選べず、`handlerName` を渡すと「無設定」の要件を外れます。固定 Chrome/111 UA は Node major からバージョンを合成せず、検出結果を安定させます。

終了と ICE restart は mediasoup が ICE-lite であることに合わせています。切断の合図は DTLS Alert、restart 後は nominated の作り直しが必要です。RID は Chrome111 が encodings に書く識別子で、SDP の SSRC グループではありません。`replaceTrack` の RTP 待ちは、そのパケットを待っている側がまだ送っていないという順序のデッドロックでした。

## リスク

- `close_notify` は UDP なので到達しないことがあります。サーバー側の close 伝播はベストエフォートです。
- `sendClosing` は consent を迂回するため、shutdown 専用です。通常メディア送信には使いません。
- 既定で RID 拡張を出すため、RID を想定しない相手との SDP が変わる可能性があります。
- polyfill の `navigator` はプロセスグローバルです。本体テストは uninstall で戻しますが、並列インストールは呼び出し側の責任です。

## 検証結果

本体テストは次を追加しています。

- UA 補完・明示上書き・復元: [`packages/webrtc/tests/nonstandard/polyfill.test.ts:430`](review-file:packages/webrtc/tests/nonstandard/polyfill.test.ts:430)
  [`packages/webrtc/tests/nonstandard/polyfill.test.ts:430`](review-diff:packages/webrtc/tests/nonstandard/polyfill.test.ts:commit:9bd675f9:430)
- `detectDevice` / `Device.factory` / load / produce / consume: [`packages/webrtc/tests/nonstandard/mediasoupClient.test.ts:18`](review-file:packages/webrtc/tests/nonstandard/mediasoupClient.test.ts:18)
  [`packages/webrtc/tests/nonstandard/mediasoupClient.test.ts:18`](review-diff:packages/webrtc/tests/nonstandard/mediasoupClient.test.ts:commit:9bd675f9:18)
- DTLS close_notify: [`packages/webrtc/tests/transport/dtls.test.ts:25`](review-file:packages/webrtc/tests/transport/dtls.test.ts:25)
  [`packages/webrtc/tests/transport/dtls.test.ts:25`](review-diff:packages/webrtc/tests/transport/dtls.test.ts:commit:3a622cbf:25)
- 相手 DTLS close → `disconnected`: [`packages/webrtc/tests/transport/ice.test.ts:35`](review-file:packages/webrtc/tests/transport/ice.test.ts:35)
  [`packages/webrtc/tests/transport/ice.test.ts:35`](review-diff:packages/webrtc/tests/transport/ice.test.ts:commit:3a622cbf:35)
- ICE restart 後の再 nominated: [`packages/webrtc/tests/integrate/peerConnection.test.ts:140`](review-file:packages/webrtc/tests/integrate/peerConnection.test.ts:140)
  [`packages/webrtc/tests/integrate/peerConnection.test.ts:140`](review-diff:packages/webrtc/tests/integrate/peerConnection.test.ts:commit:3a622cbf:140)

チケット確認レビューは `lifecycle.status` と `reviewStatus` がともに `approved` です。実 mediasoup worker の E2E は fixture 側です。
