## 元報告と判定
元Issue: #812（sidorares）。**妥当（developの静的検証）**。
`RTCPeerConnection`は[`onicecandidateerror`プロパティ](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/peerConnection.ts#L216-L222)を提供するが、現行コードに対応するエラーイベント生成・通知処理はない。`UdpTransport.onError`のみではDNS、STUN transaction timeout、TURN allocation、EHOSTUNREACHなどの収集失敗がアプリへ伝わらない。

## 修正方針
1. ICE gathering層にサーバー単位の失敗を表す型付きイベント（`url`, `address`, `port`, `errorCode`, `errorText`、必要に応じgeneration）を導入し、`RTCPeerConnection`へ伝播させる。EventTarget `icecandidateerror`と`onicecandidateerror`ハンドラを同じ意味で発火する。
2. [ice.ts のcandidate gathering](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/ice/src/ice.ts#L1140-L1540) でDNS失敗、STUN Binding timeout、TURN Allocate/認証失敗、非同期socket errorを捕捉し、**他候補や他サーバーの収集を継続**しつつ失敗を通知する。到達失敗はW3Cに従い701、サーバーから受信したSTUN errorは対応するコードを使う。
3. サーバーURLの対応付け（同じhostでもURL/transportが異なる）、候補のlocal address/portが不明なDNS失敗時の値、認証や秘密情報をerrorTextに出さない方針を決める。401 challenge等の正常なリトライはエラーイベントとして扱わない。
4. close / ICE restart / candidate gather世代切替による後発イベントの抑制と、リスナー解除を実装。イベント欠落による「接続不可の理由が見えない」状態を解消する。

## 回帰テスト
- [ ] 存在しないDNS名、応答しないSTUN宛先、EHOSTUNREACH、TURN非認証エラーでURL・コードを含むイベント。
- [ ] 正常STUN/TURNと失敗サーバーが混在してもgatheringが継続。
- [ ] 正常な401/438再試行は最終的に成功すれば誤通知しない。
- [ ] `addEventListener("icecandidateerror")`と`onicecandidateerror`、close後イベントなし。
- [ ] WPT `RTCPeerConnection-onicecandidateerror.https.html`相当。

**完了条件:** アプリから各ICEサーバーの利用失敗を特定でき、正常経路に影響しない。