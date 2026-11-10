## 元報告と判定
元Issue: #355（tylerlong）。**妥当（developの実装で確認）**。
RFC 3605では`a=rtcp:53020`のようにIPアドレス省略が可能。ところが[`sdp.ts L204–208`](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdp.ts#L204-L208)で`divide(value," ")`が返すIPのない部分を必ず`ipAddressFromSdp(rest)`へ渡し、[`ipAddressFromSdp()`](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdp.ts#L591-L596)が`IN IP4/IP6 ...`以外を例外にする。またシリアライズは[`rtcpPort && rtcpHost`両方](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdp.ts#L500-L509)を必要とし、省略形式を保持できない。

## 修正方針
1. `a=rtcp`パースでポート（有効範囲1–65535）を必須、`IN IP4/IP6 address`を**任意**にする。省略時の`rtcpHost`は`undefined`とし、外部から解決すべき有効アドレスはmedia-level `c=`、なければsession-level `c=`に従う（RFC 3605）。
2. `MediaDescription.toString()`等のSDPシリアライズは、`rtcpPort`が存在すれば`a=rtcp:<port>`を出力し、`rtcpHost`がある場合にのみ`IN IP4/IP6`を追記する。`rtcp-mux`の出力は`a=rtcp`の有無に不当に結び付けない。
3. malformedなポート・アドレス・追加トークンの検証はわかりやすいパースエラーにする。既存のRTCP mux/ICEを使う接続への影響を最小化。

## 回帰テスト
- [ ] `a=rtcp:53020` と `a=rtcp:53020 IN IP4 192.0.2.1`、IPv6のparse/serialize round trip。
- [ ] media/sessionの`c=`からアドレスが継承されるケース。
- [ ] `a=rtcp-mux`のみ、RTCPポートとmux併記、invalid値。
- [ ] 元Issue #356にあるRingCentral SDPの`a=rtcp:48037`を解析できる。

**完了条件:** RFC 3605の任意アドレス形式を例外なく処理する。