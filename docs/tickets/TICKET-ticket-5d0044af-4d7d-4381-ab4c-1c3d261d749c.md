## 元報告と判定
元Issue: #375（achingbrain）。**一部妥当（developの残存差分のみ対象）**。報告当時の`canTrickleIceCandidates`, `sctp`, `getConfiguration`, `getStats`, `restartIce`, EventTargetベース実装や`iceServers.urls: string[]`等は現行で改善済みのため再Issue化しない。個別の`icecandidateerror`動作は #812 を参照。

## 未解決点のコード根拠
- [dataChannel.ts L40–65](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/dataChannel.ts#L40-L65): `RTCDataChannel`にWebRTC互換の`binaryType`と`onbufferedamountlow`がない。一方[`addBufferedAmount()`](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/dataChannel.ts#L166-L173)は独自`bufferedAmountLow`イベントとEventTarget経由の`bufferedamountlow`のみ発火する。
- [sdp.ts L671以降](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdp.ts#L671-L691): `RTCSessionDescription`は`constructor(sdp, type)`のみで、W3Cの`new RTCSessionDescription({type,sdp})`と互換でない。

## 修正方針
1. `RTCDataChannel`に`onbufferedamountlow`プロパティを追加し、既存EventTarget/独自イベントとともに**閾値を上から下に跨いだ時だけ**呼び出す。破棄・SCTP close・`bufferedAmount`変動時の発火回数と例外隔離を検証。
2. `binaryType`をW3C互換の`"blob" | "arraybuffer"`としてサポートし、受信バイナリの`onmessage`/messageイベントを指定形式に変換する。Nodeの既存Buffer配送を直接使うアプリに影響が大きいため、後方互換の既定動作かpolyfill経由でのW3C互換既定を明文化し、`onMessage`独自APIは従来どおりのBufferを保持する。
3. `RTCSessionDescription`に辞書オーバーロードを追加し、現行の2引数コンストラクタを後方互換として維持。`type`の有効値（rollback扱い等）と`sdp`デフォルトをW3C APIと照合する。
4. `lib.dom.d.ts`を用いたTypeScript互換性テストとWPT相当のイベント/Blob/ArrayBuffer/説明オブジェクト試験を追加。互換ポリシーは`docs/browser-api-compatibility.md`に記載する。

## 回帰テスト
- [ ] `onbufferedamountlow`・`addEventListener`・独自イベントの整合とthreshold跨ぎ時の一度だけの発火。
- [ ] `binaryType="arraybuffer"/"blob"`の両方で内容一致、文字列メッセージは文字列のまま。
- [ ] 旧`Buffer`利用API、旧`RTCSessionDescription(sdp,type)`が壊れず、新`RTCSessionDescription({type,sdp})`が動作。
- [ ] TypeScript `lib.dom`との主要な型互換性を確認。

**完了条件:** 元Issueで現行も未実装の主要API差分を縮小し、既存Nodeアプリを壊さない。