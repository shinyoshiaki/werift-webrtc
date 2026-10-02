---
ide:
  viewer: review-document
  version: 1
  title: "WARP 対応 WebRTC transport：仕様準拠レビュー"
  dock: right
  baseCommit: c026c82091933fcdf06a3c30d87b21a0b4810f22
---
# WARP 対応 WebRTC transport：仕様準拠レビュー

## 1. 概要

`warp` ブランチからの差分（PR #713、HEAD `c026c820`）を対象に、実装箇所が RFC やドラフトに沿っているかをレビューしました。コードは変更していません。

**結論:** 中心の不変条件「SDP fingerprint を検証するまで、application data・RTP・RTCP を上位層へ渡さない」は守られています。MUST に明確に違反する箇所は見つかりませんでした。一方で、仕様の意図から外れる点や確認が必要な点が残っています。今回の差分で入ったものは 9 件（中 4・低 5）で、これとは別に `warp` 時点からあるものを 8 件挙げます。

**対象と方法**

- 領域は5つです。DTLS 1.3、認証境界と DTLS-SRTP、ICE と SPED、SCTP と DataChannel、RTCPeerConnection と JSEP。
- 照合した仕様は次のとおりです。
  - DTLS / TLS: RFC 9147（DTLS 1.3）、RFC 8446（TLS 1.3）、RFC 6347（DTLS 1.2）
  - SDP の fingerprint と DTLS-SRTP: RFC 8122、RFC 8842、RFC 5763、RFC 5764、RFC 9443（多重化）
  - ICE と STUN: RFC 8445（ICE）、RFC 7675（consent）、RFC 8838（trickle）、RFC 8489（STUN）
  - SPED: draft-hancke-webrtc-sped-00
  - SCTP と DataChannel: RFC 9260（SCTP）、RFC 8841、RFC 8831、RFC 8832
  - シグナリングと API: RFC 8829（JSEP）、RFC 8843（BUNDLE）、W3C WebRTC 1.0、W3C webrtc-stats
- RFC 本文は rfc-editor.org から取得して引用しました。draft と W3C 仕様、RFC 8829 の一部は要約経由でしか取得できず、原文と一字一句一致するとは限りません（§9 を参照）。

**判定の区分**

| 判定 | 意味 |
|---|---|
| 準拠 | 仕様の要求どおり |
| 逸脱 | 仕様の要求や意図と異なる（意図的な拡張を含む） |
| 要確認 | 解釈の余地がある、または相互接続で確かめる必要がある |

重大度は「高・中・低・情報」の4段階です。

## 2. 優先して見てほしい指摘

### 2.1 今回の差分で入ったもの

| # | 重大度 | 判定 | 内容 | 根拠 |
|---|---|---|---|---|
| N1 | 中 | 要確認 | 応答側の SCTP が INIT ACK の送信後に取り消されると、相手の COOKIE ECHO を新しい association が受け付けない | RFC 9260 §5.1.5、§5.1.4 |
| N2 | 中 | 要確認 | 古い ICE 世代で受け取った、認証済みの fatal alert / close_notify を捨てている | RFC 8446 §6.2、RFC 9147 §5.10 |
| N3 | 中 | 逸脱 | 接続済みで fingerprint が変わると、新しい association を張らずに failed にする。tls-id も未実装 | RFC 8842 §3.1、§5 |
| N4 | 中 | 逸脱（opt-in） | `allowEarlyServerData` を有効にすると、相手を認証する前に SRTP とデータを送る | RFC 5764 §5.1.1、RFC 5763 §6.2 |
| N5 | 中 | 逸脱 | ICE restart 中、旧選択 pair から届いた DTLS（DataChannel など）を捨てる | RFC 8445 §9、§12.2 |
| N6 | 低 | 要確認 | SPED 経路では、server Finished より先に早期データが wire に出る可能性がある | RFC 8446 §2、RFC 9147 §4.2.1 |
| N7 | 低 | 逸脱 | `createOffer({iceRestart})` の時点で DTLS の attempt が切り替わり、rollback で戻らない | RFC 8829 §4.1.10.2、§5.7 |
| N8 | 低 | 要確認 | `retransmitStartNow()` の即時再送は、T1 の再送回数に数えられない | RFC 9260 §5.1 規則 2/3 |
| N9 | 低 | 情報 | 統計項目 `iceGeneration` は標準外なのに `warp` 接頭辞が付いていない | W3C webrtc-stats |

### 2.2 `warp` 時点からあるもの（今回の範囲外。参考として記載）

| # | 重大度 | 判定 | 内容 | 根拠 |
|---|---|---|---|---|
| E1 | 中 | 逸脱 | ICE restart をした側は、新しい pair が選ばれるまで送信できない | RFC 8445 §9、§12.1 |
| E2 | 中 | 逸脱 | Binding request を受けただけ（`requestsReceived > 0`）の pair を認証済みとして扱い、直接 DTLS や早期データを送る | RFC 7675 §5、§5.1 |
| E3 | 中 | 逸脱 | 確立済みで INIT を受けると、TCB の一部を上書きする | RFC 9260 §5.2.2 |
| E4 | 低 | 逸脱 | T1 の RTO を倍にしない。8回の再送が約27秒で終わる | RFC 9260 §5.1、§6.3.3 E2 |
| E5 | 低 | 逸脱 | 確立済みで受けた重複 COOKIE ECHO で、相手の tag を照合せず常に COOKIE ACK を返す | RFC 9260 §5.2.4 |
| E6 | 低 | 逸脱 | 自分が answerer で role が `auto` のとき、offer の値に関係なく `a=setup:active` で答える | RFC 8829 §5.3.1、RFC 5763 §5 |
| E7 | 低 | 逸脱 | SCTP の INIT を DTLS server 側だけが送る | RFC 8841 §9.3 |
| E8 | 低 | 逸脱 | end-of-candidates を受けた後に届いた候補を無視しない | RFC 8838 §14 |

## 3. DTLS 1.3（早期データと readiness）

**[準拠・重要] 相手の Finished を受けるまで application data を上位層へ渡さない**

DTLS 1.3 の層では、`connected` になるまで epoch 3 の application data を buffer にためるだけにしています。server が `markConnected` を呼ぶのは、client の Certificate、CertificateVerify、Finished をすべて検証した後です。

[packages/dtls/src/engine/v1_3/record-rx.ts:539](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:539)、[packages/dtls/src/engine/v1_3/flight/server/flight5.ts:24](review-file:packages/dtls/src/engine/v1_3/flight/server/flight5.ts:24)

RFC 9147 §5.8.1: "Implementations MUST either discard or buffer all application data records for epoch 3 and above until they have received the Finished message from the peer."

webrtc 層ではさらに、SDP fingerprint が一致するまで `InboundApplicationGate` で保持します（§4 を参照）。

**[準拠] server が書き込めるのは、自分の Finished を送り、epoch 3 の鍵を作った後だけ**

server は自分の Finished を transcript に入れてからアプリケーション鍵を導出し、flight を送った後に `writeEpoch = 3` と `markWriteReady()` を実行します。

[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:626](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:626)、[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:664](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:664)、[packages/dtls/src/engine/v1_3/connection.ts:148](review-file:packages/dtls/src/engine/v1_3/connection.ts:148)

RFC 8446 §4.4.4: "Servers MAY send data after sending their first flight, but because the handshake is not yet complete, they have no assurance of either the peer's identity or its liveness"

**[要確認・低] N6：SPED 経路では、早期データが server Finished より先に wire に出る可能性がある**

SPED では handshake の flight を STUN に埋め込むため、DTLS としての wire 送信は止めています。一方、application data は認証済みの pair へ直接送ります。そのため wire 上では、server Finished より先に epoch 3 のデータが相手に届くことがあり得ます。

[packages/webrtc/src/transport/sped.ts:262](review-file:packages/webrtc/src/transport/sped.ts:262)

論理的には Finished を送った後なので、RFC 8446 §2 の "MUST NOT be sent prior to sending the Finished message" には反しません。受け取った側も、RFC 9147 §4.2.1 の "MAY either buffer or discard" で対処できます。ただし、相手実装が先着した epoch 3 のデータを捨てると、早期送信の効果がなくなります。

**[要確認・中] N2：古い ICE 世代で受けた、認証済みの alert を捨てている**

AEAD で復号に成功した close_notify や fatal alert でも、受け取った世代が古ければ fail も close もしません。

[packages/dtls/src/engine/v1_3/record-rx.ts:635](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:635)

- RFC 8446 §6.2: "Upon transmission or receipt of a fatal alert message, both parties MUST immediately close the connection."
- RFC 9147 §5.10: "alerts are not reliably transmitted; implementations SHOULD NOT depend on receiving alerts"

ICE restart をまたいでも DTLS association（鍵）は同じなので、この alert は正規の相手から届いたものである可能性があります。alert をパケットロスと同じに扱うと解釈すれば許容範囲です。ただし close_notify を捨てると close の境界が記録されず、その後のデータが配送され得ます。安全側に倒すなら、alert だけは世代に関係なく処理する方がよいと考えます。

**[準拠] 早期データの buffer には上限があり、失敗時に破棄する**

上限は 256 件・256 KiB・2 秒です。失敗、teardown、dispose のいずれでも破棄します。

[packages/dtls/src/engine/v1_3/early-data-buffer.ts:30](review-file:packages/dtls/src/engine/v1_3/early-data-buffer.ts:30)

RFC 9147 §4.2.1 の "MAY either buffer or discard" に沿っています。

**[準拠] 最終 flight の ACK と handshake 完了の判定**

client の最終 flight は暗黙の ACK にせず、ACK を受けるまで再送を続けます。

[packages/dtls/src/engine/v1_3/record-rx.ts:385](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:385)、[packages/dtls/src/engine/v1_3/record-rx.ts:770](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:770)

RFC 9147 §5.8.1: "if the ACK was for the final flight, transitions to FINISHED."

**[準拠] 受信世代のトークン**

古い世代の datagram は処理する前に捨てます。そこから出たエラーで、現在の association を fail させることもありません。

[packages/dtls/src/engine/v1_3/record-rx.ts:59](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:59)

RFC 9147 §4.5.2: "Invalid records SHOULD be silently discarded, thus preserving the association"

**[準拠・低] DTLS 1.2 へのフォールバック**

DTLS 1.2 では readiness の3つのフラグ（writeReady、peerHandshakeAuthenticated、handshakeComplete）を、すべて `connected` と同じ値にします。早期送信は `isDtls13` を条件にしているため無効です。

[packages/dtls/src/socket.ts:123](review-file:packages/dtls/src/socket.ts:123)

## 4. 認証境界と DTLS-SRTP

**[準拠] 最も強いハッシュアルゴリズムの fingerprint 集合で照合する**

[packages/webrtc/src/transport/dtls-fingerprint.ts:47](review-file:packages/webrtc/src/transport/dtls-fingerprint.ts:47)

RFC 8122 §5: "An endpoint MUST select the set of fingerprints that use its most preferred hash function (out of those offered by the peer) and verify that each certificate used matches one fingerprint out of that set."

MD2 や MD5 などの未対応アルゴリズムは除外します。対応するものが1つもなければ失敗させます（RFC 8122 §5 "MUST NOT use the MD2 and MD5 hash functions"）。

**[準拠] 一致しなければ、何も配送せずに切断する**

検証は、受信 gate の解放（[packages/webrtc/src/transport/dtls.ts:552](review-file:packages/webrtc/src/transport/dtls.ts:552)）と SRTP 鍵のインストールより前に行います（[packages/webrtc/src/transport/dtls.ts:530](review-file:packages/webrtc/src/transport/dtls.ts:530)）。不一致なら次の処理をまとめて行います。

- `failed` に遷移する
- 受信 gate を abort する
- メディア buffer を破棄する
- DTLS を close する

[packages/webrtc/src/transport/dtls.ts:259](review-file:packages/webrtc/src/transport/dtls.ts:259)

RFC 8842 §5.1: "If fingerprints do not match the hashed certificate, then an endpoint MUST tear down the media session immediately"

PeerConnection の `failed` にも連動します（[packages/webrtc/src/secureTransportManager.ts:205](review-file:packages/webrtc/src/secureTransportManager.ts:205)）。

**[要確認・低] TLS としては確立した後に、SDP fingerprint を照合している**

ハンドシェイク中に証明書を拒否するのではなく、DTLS としての認証が済んだ後で照合しています。

[packages/webrtc/src/transport/dtls.ts:526](review-file:packages/webrtc/src/transport/dtls.ts:526)

RFC 8122 §5 には "the endpoint MUST NOT establish the TLS connection" とあります。ただし、上位層へは何も渡さずにすぐ切断するので、実質的には同等です。一般的な実装も同じ方式です。

**[逸脱・中] N3：fingerprint が変わると、新しい association を張らずに failed にする**

新しい remote description の fingerprint が、接続中の証明書と合わなければ failed にします。tls-id は実装されていません。

[packages/webrtc/src/transport/dtls.ts:232](review-file:packages/webrtc/src/transport/dtls.ts:232)

RFC 8842 §3.1 は、"One or more fingerprint values are modified, added, or removed in either an SDP offer or answer" の場合に新しい DTLS association が必要だとしています。§5 も、tls-id の変更を新しい association の合図と定めています。

古い fingerprint を残さず置き換える点は `warp` からの改善で、安全側に倒れています。ただし相手が証明書を替えて再ネゴシエーションすると、再接続ではなく失敗になります。

**[準拠] 認証前に届いたメディアは暗号化したまま保持し、復号しない**

読み取り権限 `srtpReadReady` は、`peerAuthenticated` が立つまで false のままです。認証前に届いた SRTP と SRTCP は、暗号化されたまま保持するか破棄します（既定は破棄）。

[packages/webrtc/src/transport/dtls.ts:1070](review-file:packages/webrtc/src/transport/dtls.ts:1070)、[packages/webrtc/src/transport/dtls.ts:1119](review-file:packages/webrtc/src/transport/dtls.ts:1119)

RFC 5764 §5.1.1: "Within each RTP session, SRTP processing MUST NOT take place before the DTLS handshake completes."

**[逸脱（opt-in）・中] N4：早期サーバ送信（0.5-RTT）**

次の条件をすべて満たすと、client の fingerprint を検証する前に SRTP、SRTCP、DTLS の application data を送ります。

- SPED が有効
- DTLS role が server
- `warp.allowEarlyServerData` が true
- DTLS 1.3 で書き込み可能

[packages/webrtc/src/transport/dtls.ts:338](review-file:packages/webrtc/src/transport/dtls.ts:338)、[packages/webrtc/src/transport/dtls.ts:1213](review-file:packages/webrtc/src/transport/dtls.ts:1213)

- RFC 5764 §5.1.1（上の引用）
- RFC 5763 §6.2: "The setup:passive endpoint may not yet have validated the fingerprint of the active endpoint's certificate."
- RFC 8446 §2: "any data sent at that point is, of course, being sent to an unauthenticated peer."

既定は OFF で、受信側の不変条件は守られています。ただし、標準の WebRTC セキュリティモデルから外れる拡張です。README と型定義に「相手が未認証のまま機密データを送ることになる」と明記することを推奨します。

**[準拠] SRTP 鍵の導出と、読み取り・書き込み権限の分離**

[packages/webrtc/src/transport/dtls-srtp.ts:17](review-file:packages/webrtc/src/transport/dtls-srtp.ts:17)

RFC 5764 §4.2 の鍵の割り当て（client_write_SRTP_master_key など）どおりです。鍵があるだけでは送受信の権限を与えません。

**[準拠] パケットの振り分け（demux）**

先頭バイトが 20〜63 なら DTLS、128〜191 なら RTP/RTCP として扱い、それ以外は捨てます。さらに、認証済みの選択 pair とその送信元アドレスで絞り込みます。

[packages/webrtc/src/transport/dtls-ice-transport.ts:22](review-file:packages/webrtc/src/transport/dtls-ice-transport.ts:22)、[packages/webrtc/src/transport/dtls.ts:1105](review-file:packages/webrtc/src/transport/dtls.ts:1105)

RFC 9443 §3 "If the value is between 20 and 63 (inclusive), then the packet is DTLS" に沿っています。

**[要確認・低] role が `auto` のとき、ICE の role から DTLS の role を決める**

ICE で controlling なら server、controlled なら client にします。

[packages/webrtc/src/transport/dtls.ts:296](review-file:packages/webrtc/src/transport/dtls.ts:296)

通常は offerer が controlling かつ passive（server）になるので、`a=setup` の結果と一致します。ただし交渉結果ではなく ICE の role に依存しているため、相手が ice-lite のときなどにずれる余地があります。answer を受けたときに role を上書きする処理は準拠しています。

**[逸脱・低] E6：answerer は role が `auto` なら常に `active` を返す（既存の問題）**

[packages/webrtc/src/sdpManager.ts:398](review-file:packages/webrtc/src/sdpManager.ts:398)

offer が `setup:active` だと、双方が DTLS client になります。RFC 5763 §5 は "The answerer MUST use either a setup attribute value of setup:active or setup:passive" とし、offerer と相補的な role を取ることを前提にしています。

## 5. ICE と SPED（draft-hancke-webrtc-sped-00）

**[準拠] 属性の値と、埋め込み DTLS の認証**

SPED の属性値 `0xC070` と `0xC071` は、RFC 8489 §14 の comprehension-optional の範囲にあります。属性は MESSAGE-INTEGRITY と FINGERPRINT より前に置きます。埋め込まれた DTLS を処理するのは、HMAC を検証した現在の世代のメッセージだけです。

[packages/ice/src/sped/draft00/constants.ts:6](review-file:packages/ice/src/sped/draft00/constants.ts:6)、[packages/ice/src/sped/runtime.ts:495](review-file:packages/ice/src/sped/runtime.ts:495)

draft §9.1 の要件を満たしています。送信の手順（ACK を先に、L1 を順番に、データがなければ空の DATA）と、受信の手順（最初の認証済みメッセージで対応可否を判定）も draft §4.2 と §4.3 に沿っています。

**[準拠・低] DTLS 開始前の Binding Response に空の DATA を付ける（直近の修正）**

[packages/ice/src/internal/sped-bind.ts:29](review-file:packages/ice/src/internal/sped-bind.ts:29)、[packages/ice/src/sped/draft00/session.ts:262](review-file:packages/ice/src/sped/draft00/session.ts:262)

draft §4.2 step 3: "Otherwise, include DTLS-IN-STUN-DATA with an empty value simply to indicate SPED support"

ただし、送信する Binding Request 側（[packages/ice/src/ice.ts:1827](review-file:packages/ice/src/ice.ts:1827)）は、runtime を attach する前だと属性を付けません。通常は DTLS を先に開始するので起きない見込みですが、検証はしていません。

**[要確認・低] 空の DATA すら MTU に収まらないと、Binding を送らない**

[packages/ice/src/ice.ts:716](review-file:packages/ice/src/ice.ts:716)

draft §4.2 は、データの埋め込みを「sufficient space remains」の場合に限っています。Binding 自体を送らないことまでは定めていません。ufrag が長いと connectivity check の応答が出なくなる恐れがあります。

**[逸脱・中] N5：ICE restart 中、旧選択 pair から届いた DTLS を捨てる**

今回、旧選択 pair から届いた SRTP は受け付けるようにしました（[packages/ice/src/ice.ts:514](review-file:packages/ice/src/ice.ts:514)、[packages/webrtc/src/transport/dtls.ts:1105](review-file:packages/webrtc/src/transport/dtls.ts:1105)）。一方、DTLS は認証済みの現在の pair からしか受け付けません。

[packages/ice/src/internal/datagram.ts:59](review-file:packages/ice/src/internal/datagram.ts:59)

- RFC 8445 §9: "during the restart, data can continue to be sent using existing data sessions"
- RFC 8445 §12.2: "ICE implementations SHOULD by default be prepared to receive data on any of the candidates provided in the most recent candidate exchange"

handshake 前の認証経路から外すのは妥当です。ただ、確立済みの association の application record（DataChannel）まで捨てるため、相手が新しい pair に移るまで DataChannel の受信が止まります。

**[逸脱・中] E1：ICE restart をした側の送信が止まる（既存の問題）**

`restart()` で `nominated` を消すため、新しい pair が選ばれるまで `send()` は何も送りません。

[packages/ice/src/ice.ts:281](review-file:packages/ice/src/ice.ts:281)、[packages/ice/src/ice.ts:1245](review-file:packages/ice/src/ice.ts:1245)

RFC 8445 §12.1 は、ICE restart 中は以前の選択 pair を使ってよいとしています。今回、受信側では旧 pair を識別するようにしましたが、送信側は `warp` 時点のままです。

**[逸脱・中] E2：Binding request を受けただけの pair を「認証済みで送信可」とみなす（既存の判定を、今回の早期送信経路でも使用）**

[packages/ice/src/internal/datagram.ts:46](review-file:packages/ice/src/internal/datagram.ts:46)、[packages/webrtc/src/transport/sped.ts:621](review-file:packages/webrtc/src/transport/sped.ts:621)

- RFC 7675 §5: "An endpoint gains consent to send on a candidate pair when the pair enters the Succeeded ICE state"
- RFC 7675 §5.1: "MUST NOT send data other than the messages used to establish consent unless the receiving endpoint has consented"

MESSAGE-INTEGRITY 付きの request は送信元を認証しますが、相手が受信に同意したことにはなりません。STUN に埋め込まない DTLS、特に早期のアプリケーションデータやメディアは、SUCCEEDED の pair に限るべきです。

**[逸脱・低] relay や、まだ種別が確定していない UDP prflx の pair では DATA 属性を付けない**

[packages/ice/src/sped/runtime.ts:305](review-file:packages/ice/src/sped/runtime.ts:305)

draft §3.3.2.1: "this attribute MUST be present in every STUN Binding Request or Response sent by a SPED-capable agent"

TURN 上の WARP はスコープ外です。ただし他実装から見ると、werift が SPED 非対応と判定される可能性があります。prflx の判定を保留する処理（[packages/ice/src/sped/runtime.ts:501](review-file:packages/ice/src/sped/runtime.ts:501)）は、これと対になる意図的な拡張です。

**[準拠] consent の失効**

30秒で failed に遷移し、送信を止めます。確認の間隔はランダムにずらしています。

[packages/ice/src/ice.ts:1307](review-file:packages/ice/src/ice.ts:1307)

RFC 7675 §5.1 に沿っています。

**[逸脱・低] E8：end-of-candidates を受けた後に届いた候補を無視しない（既存の問題）**

[packages/ice/src/ice.ts:1534](review-file:packages/ice/src/ice.ts:1534)

RFC 8838 §14: "After an agent has received an end-of-candidates indication, it MUST ignore any newly received candidates"

SPED の prflx 判定は end-of-candidates を確定条件にしているので、その判定と食い違う余地があります。

## 6. SCTP と DataChannel

**[準拠] 開始側：COOKIE ECHO を送信処理へ渡した時点で開始を確定する**

送る前に T1 を開始して COOKIE_ECHOED に遷移します。その後で送信に失敗しても損失として扱い、T1 で再送します。

[packages/sctp/src/sctp.ts:438](review-file:packages/sctp/src/sctp.ts:438)、[packages/sctp/src/sctp.ts:1519](review-file:packages/sctp/src/sctp.ts:1519)

- RFC 9260 §5.1 C: "A then sends the State Cookie ... in a COOKIE ECHO chunk, starts the T1-cookie timer, and enters the COOKIE-ECHOED state."
- RFC 9260 §5.1 規則3: "If the T1-cookie timer expires, the endpoint MUST retransmit COOKIE ECHO chunk"

**[準拠] 応答側：COOKIE ACK を渡すと同時に ESTABLISHED へ遷移する**

COOKIE ACK を同期的に送信処理へ渡してから ESTABLISHED にするので、COOKIE ACK は DATA より先に送られます。

[packages/sctp/src/sctp.ts:519](review-file:packages/sctp/src/sctp.ts:519)

RFC 9260 §5.1 D: "replies with a COOKIE ACK chunk after building a TCB and moving to the ESTABLISHED state ... the COOKIE ACK chunk MUST be the first chunk in the packet"

**[要確認・中] N1：応答側が INIT ACK を送った後に取り消すと、相手が長時間止まる**

応答側で開始が確定するのは COOKIE ACK を渡した時点なので、INIT ACK を送った後なら取消しが通ります。取り消すと、cookie の鍵と verification tag が新しい association が作られます。

[packages/sctp/src/sctp.ts:400](review-file:packages/sctp/src/sctp.ts:400)、[packages/webrtc/src/transport/sctp.ts:114](review-file:packages/webrtc/src/transport/sctp.ts:114)、[packages/webrtc/src/transport/sctp.ts:164](review-file:packages/webrtc/src/transport/sctp.ts:164)

しかし相手はその時点で COOKIE_ECHOED に進んでいる可能性があり、再送してくる古い COOKIE ECHO は新しい association では捨てられます。

- RFC 9260 §5.1.5: "If this comparison fails, the SCTP packet ... MUST be silently discarded."
- RFC 9260 §5.1.4: 相手は Max.Init.Retransmits に達するまで再送を続ける

usrsctp（Chrome）は RTO を倍にしながら8回再送するので、相手が INIT からやり直すまで数分止まる可能性があります。INIT ACK の送信失敗は §5.1 では単なる損失なので、cookie の鍵と verification tag を新しい association に引き継ぐか、応答側は取り消さない設計を推奨します。

**[要確認・低] N8：即時再送は T1 の再送回数に数えない**

[packages/sctp/src/sctp.ts:1538](review-file:packages/sctp/src/sctp.ts:1538)

DTLS の connected や取消しのイベントでだけ呼ばれるので、際限なく続くことはありません。ただし、イベントが繰り返されると Max.Init.Retransmits の上限を迂回できる点は確認が必要です。

**[逸脱・中] E3：確立済みで INIT を受けると、TCB の一部を上書きする（既存の問題）**

状態を確認せずに、相手の verification tag、TSN、rwnd、ストリーム数を上書きします。送信キュー、SSN、再組み立て用の buffer は初期化せず、RESTART の通知もしません。

[packages/sctp/src/sctp.ts:353](review-file:packages/sctp/src/sctp.ts:353)

RFC 9260 §5.2.2: "the INIT ACK chunk MUST contain a new Initiate Tag ... the existing association, including its current state, and the corresponding TCB MUST NOT be changed."

usrsctp が同じ DTLS 上で association を作り直すと、TCB が一部だけ置き換わった状態になります。werift 同士では再接続に応じてしまうため、テストではこの問題が見えにくくなっています。

**[逸脱・低] E4：T1 の RTO を倍にしない（既存の問題）**

再送回数は8回で RFC と同じですが、RTO を毎回3秒のまま再設定するため、約27秒で打ち切られます。

[packages/sctp/src/sctp.ts:1114](review-file:packages/sctp/src/sctp.ts:1114)

RFC 9260 §5.1 は "The T1-init timer and T1-cookie timer SHOULD follow the same rules given in Section 6.3" とし、§6.3.3 E2 で RTO を倍にすることを定めています。

**[逸脱・低] E5：確立済みで受けた重複 COOKIE ECHO の扱い（既存の問題）**

cookie にはタイムスタンプと HMAC しか入っていないため、相手の tag を照合して §5.2.4 の Table のどの処理（A〜D）に当たるかを判定できません。実際には常に D（COOKIE ACK を返す）と同じ動きになり、結果としては問題になりにくい挙動です。

[packages/sctp/src/sctp.ts:486](review-file:packages/sctp/src/sctp.ts:486)

**[準拠] ストリーム ID の偶奇を DTLS role で決める（今回の修正）**

[packages/webrtc/src/transport/sctp.ts:367](review-file:packages/webrtc/src/transport/sctp.ts:367)

RFC 8832 §4: "the side acting as the DTLS client MUST use streams with even stream identifiers; the side acting as the DTLS server MUST use streams with odd stream identifiers"

**[逸脱・低] E7：SCTP の INIT を DTLS server 側だけが送る（既存の方針）**

[packages/webrtc/src/transport/sctp.ts:467](review-file:packages/webrtc/src/transport/sctp.ts:467)

RFC 8841 §9.3 は "both SCTP endpoints MUST initiate the SCTP association" としています。設計書 §18.1 に werift の方針として記載されており、usrsctp との相互接続は成立します。

**[準拠・低] DCEP（RFC 8832）**

DATA_CHANNEL_OPEN の解析、ACK の返送、重複した OPEN への再 ACK は準拠しています。ただし、未知のストリームに ACK が届くと例外を投げます。

[packages/webrtc/src/transport/sctp.ts:255](review-file:packages/webrtc/src/transport/sctp.ts:255)

黙って捨てる方が無難です。

## 7. RTCPeerConnection と JSEP

**[準拠] ICE restart では DTLS association を維持する**

[packages/webrtc/src/secureTransportManager.ts:423](review-file:packages/webrtc/src/secureTransportManager.ts:423)

RFC 8842: "an ICE restart does not by default require a new DTLS association to be established."

**[逸脱・低] N7：`createOffer({iceRestart})` の時点で DTLS の attempt が切り替わる**

[packages/webrtc/src/peerConnection.ts:557](review-file:packages/webrtc/src/peerConnection.ts:557)

JSEP（RFC 8829 §4.1.10.2、§5.7）では、新しい ICE 資格情報は setLocalDescription で有効になり、rollback で破棄されます。ICE を即時に restart するのは以前からの挙動ですが、今回 DTLS の状態も createOffer の時点で変わるようになったため、offer を適用しなかった場合や rollback した場合に元へ戻りません。

**[準拠] BUNDLE では tag の m-line の transport パラメータだけを適用する**

[packages/webrtc/src/peerConnection.ts:1256](review-file:packages/webrtc/src/peerConnection.ts:1256)

RFC 8843 §7.1.3: ICE などの transport 属性は tag の m-line にだけ含め、bundle されたすべての m-line に適用する。

**[準拠・低] PeerConnection の状態の集約**

DTLS が failed なら PeerConnection も failed にします（[packages/webrtc/src/secureTransportManager.ts:205](review-file:packages/webrtc/src/secureTransportManager.ts:205)）。`connect()` の最後で、全 transport の DTLS 状態から connected か failed かを決めます（[packages/webrtc/src/peerConnection.ts:1078](review-file:packages/webrtc/src/peerConnection.ts:1078)）。W3C の RTCPeerConnectionState の表と比べて、保守的な方向にずれるだけです。

**[情報] `setConfiguration()` で `warp` を実行中に変更できる**

[packages/webrtc/src/peerConnection.ts:435](review-file:packages/webrtc/src/peerConnection.ts:435)

`warp` は werift 独自のメンバーで、W3C §4.4.1.6 で変更を禁止されているメンバー（certificates、bundlePolicy など）には当たりません。

**[情報・低] N9：統計の独自フィールド**

`warp*` の各フィールドは、標準の RTCTransportStats のメンバーと衝突しません。ただし `iceGeneration` は標準外なのに接頭辞が付いていないため、`warpIceGeneration` への改名を推奨します。

[packages/webrtc/src/transport/dtls-stats.ts:146](review-file:packages/webrtc/src/transport/dtls-stats.ts:146)

## 8. リスクと推奨対応

| 優先度 | 対応 | 対象 |
|---|---|---|
| 1 | 応答側 SCTP が INIT ACK 後に取り消すときは、cookie の鍵と verification tag を新しい association に引き継ぐ。または取り消さない | N1 |
| 2 | 認証済みの alert は世代に関係なく処理する。少なくとも close_notify の境界は記録する | N2 |
| 3 | 早期サーバ送信のセキュリティ上の性質（相手が未認証）を README と型定義に明記する | N4 |
| 4 | 早期データや直接 DTLS を送る条件を、SUCCEEDED の pair に限る | E2 |
| 5 | restart 中も、確立済み association の DTLS application record を旧選択 pair から受け付ける。送信側も旧 pair を使い続ける | N5、E1 |
| 6 | 確立済みで受けた INIT を RFC 9260 §5.2.2 に沿って扱う。T1 の RTO を倍にする | E3、E4 |
| 7 | 相手が証明書を替えたときの再ネゴシエーション（tls-id と新しい association）を別チケットで検討する | N3 |

E 系の指摘は `warp` 時点からある問題なので、今回のチケットとは別に扱うことを推奨します。特に E3 は、Chrome（usrsctp）との相互接続で association が作り直される場面に影響します。werift 同士のテストでは見えにくいので、外部実装を使った検証が必要です。

## 9. 検証方法と限界

- RFC 9147、8446、6347、9260、8445、8841、8832、8122、8842、5763、5764、9443、7675 は、rfc-editor.org のテキストを取得して引用しました。
- draft-hancke-webrtc-sped-00、W3C WebRTC 1.0、W3C webrtc-stats、RFC 8829 の一部は要約を経由してしか取得できませんでした。引用が原文と一字一句一致するとは限らず、これらに依拠する判定（N7、SPED の各項目、§7 の W3C 関連の項目）は根拠の確度が下がります。
- 行番号は HEAD `c026c820` で grep して確かめました。
- 今回はレビューのみで、テストは追加も実行もしていません。N1、N2、E3 は、Chrome（usrsctp）や外部の DTLS 1.3 実装との相互接続で挙動を確かめることを推奨します。
