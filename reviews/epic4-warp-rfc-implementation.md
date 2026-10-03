---
ide:
  viewer: review-document
  version: 1
  title: "Epic 4: 仕様に基づく WARP 対応 WebRTC 実装解説"
  dock: right
  baseCommit: c026c82091933fcdf06a3c30d87b21a0b4810f22
---
# Epic 4: 仕様（RFC / draft）に基づく WARP 対応 WebRTC 実装解説

この文書は、Epic 4（WARP 対応 WebRTC transport）の実装箇所を、根拠となる RFC と draft の条文に対応づけて説明します。各節は「仕様の要求 → 実装の対応 → werift 独自の判断・仕様からの逸脱 → 主なテスト」の順に書いています。

- 対象は HEAD `c026c820`（`dtls.ts` のファイル分割後）の作業ツリーです。リンクの行番号は、この時点のファイルを読んで確認しています。
- 設計の一次資料は [epic4-warp-webrtc-detailed.md:1](review-file:epic4-warp-webrtc-detailed.md:1) です。完了条件は [TICKET-ticket-71cc0e0d-e203-4057-816d-a89b993faf26.md:1](review-file:TICKET-ticket-71cc0e0d-e203-4057-816d-a89b993faf26.md:1) を参照してください。
- 節番号の照合状況:
  - `docs/rfc/` に原文がある RFC 5764 / 6347 / 7675 / 7983 / 8445 / 8489 / 8831 / 9147 / 9443 と draft-hancke-webrtc-sped-00 は、原文で節番号を確認しました。
  - RFC 8446 / 8122 / 8827 / 8842 / 5763 / 9260 / 8261 / 8832 / 8841、W3C webrtc-pc / webrtc-stats は手元に原文がありません。これらには **【未照合】** を付けています。
- TURN relay 上の WARP は、チケットのスコープ外です（[epic4-warp-webrtc-detailed.md:50](review-file:epic4-warp-webrtc-detailed.md:50)）。

## 0. 参照する仕様と担当レイヤー

| 仕様 | 内容 | 主な実装 |
| --- | --- | --- |
| RFC 9147（DTLS 1.3）/ RFC 8446（TLS 1.3） | epoch、ACK、early data のバッファ、0.5-RTT | `packages/dtls/src/engine/v1_3/*`、`packages/dtls/src/socket.ts` |
| RFC 6347（DTLS 1.2） | 1.2 への fallback、HelloVerifyRequest | `packages/dtls/src/client.ts`、`packages/dtls/src/socket.ts` |
| RFC 5764（DTLS-SRTP） | exporter による鍵導出、方向別の鍵、handshake 前の SRTP 禁止 | `packages/dtls/src/engine/v1_3/connection.ts`、`packages/webrtc/src/transport/dtls-srtp.ts` |
| RFC 7983 / RFC 9443 | 先頭バイトによる多重分離 | `packages/webrtc/src/utils.ts`、`packages/rtp/src/helper.ts` |
| RFC 8122 / RFC 8827 / JSEP | SDP fingerprint による証明書の束縛 | `packages/webrtc/src/transport/dtls-fingerprint.ts` |
| RFC 5763 / RFC 8842 / RFC 4145 | `a=setup` による DTLS role の決定 | `packages/webrtc/src/const.ts`、`sdpManager.ts`、`peerConnection.ts` |
| draft-hancke-webrtc-sped-00 | DTLS を STUN に埋め込む SPED | `packages/ice/src/sped/*`、`packages/webrtc/src/transport/sped.ts` |
| RFC 8445 / RFC 8489 / RFC 7675 | ICE、STUN の認証、ICE restart、consent | `packages/ice/src/ice.ts` |
| RFC 9260 / RFC 8261 / RFC 8831 / RFC 8832 | SCTP の確立、SCTP over DTLS、DataChannel の stream id | `packages/sctp/src/sctp.ts`、`packages/webrtc/src/transport/sctp.ts`、`sctpManager.ts` |
| W3C webrtc-pc / webrtc-stats | `RTCDtlsTransportState`、`RTCTransportStats` | `packages/webrtc/src/transport/dtls*.ts` |

全体の流れ（[epic4-warp-webrtc-detailed.md:1822](review-file:epic4-warp-webrtc-detailed.md:1822) の sequence）は次のとおりです。

1. SPED を有効にすると、ICE と DTLS 1.3 を同時に開始します。DTLS の flight は STUN Binding に埋め込まれて運ばれます。
2. DTLS 層が相手の Finished を検証すると（peer handshake authenticated）、WebRTC 層が SDP fingerprint を照合します。
3. 照合に成功して初めて、保持していた DataChannel / RTP / RTCP を上位へ渡します。

**最も重要な不変条件は「SDP fingerprint を照合するまで、application data / RTP / RTCP を上位へ配送しない」ことです**（[epic4-warp-webrtc-detailed.md:2336](review-file:epic4-warp-webrtc-detailed.md:2336)）。

---

# 第1部 DTLS コア（packages/dtls）

## 1.1 3段階の readiness マイルストーン

**仕様の要求**
- RFC 9147 §5.8.1: 相手の Finished を受け取るまでは、epoch 3 以上の application data を破棄するか、バッファしなければなりません（MUST）。
- RFC 9147 §7.2: 自分の flight がすべて ACK されたら、その flight の再送をやめます。
- RFC 8446 §4.4.4【未照合】: server は最初の flight を送った後、データを送ってもかまいません。ただし、その時点では相手の身元はまだ確認できていません。

**実装の対応**
- readiness は、一度だけ true になる3つのフラグで表します。本体は [packages/dtls/src/engine/v1_3/connection-base.ts:96](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:96)、型は [packages/dtls/src/engine/v1_3/types.ts:85](review-file:packages/dtls/src/engine/v1_3/types.ts:85) です。

| マイルストーン | フラグを立てる関数 | server で立つ場所 | client で立つ場所 |
| --- | --- | --- | --- |
| `writeReady` | [connection-base.ts:1021](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:1021) | 自分の Finished を送った直後 [server/flight4.ts:665](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:665) | 自分の Finished を送り、epoch 3 に切り替えた後 [client/flight5.ts:130](review-file:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:130) |
| `peerHandshakeAuthenticated` | [connection-base.ts:1027](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:1027) | client の Finished を検証した直後 [server/flight5.ts:48](review-file:packages/dtls/src/engine/v1_3/flight/server/flight5.ts:48) | server の Finished を検証した直後 [client/flight5.ts:41](review-file:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:41) |
| `handshakeComplete` | [connection-base.ts:1038](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:1038) | 未送信の ACK を送り終えた時点 [record-rx.ts:389](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:389) | 最後の flight がすべて ACK された時点 [record-rx.ts:772](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:772) |

- 各マイルストーンを待つ API は [packages/dtls/src/engine/v1_3/connection-base.ts:1059](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:1059) です。close またはエラーが起きると reject します。

**werift 独自の判断**
- readiness を3段階に分けるのは werift の設計で、仕様にこの概念はありません。
- `peerHandshakeAuthenticated` は DTLS の暗号的な検証が済んだことだけを表し、SDP fingerprint の照合は含みません。照合は WebRTC 層が担当します（2.1）。
- server の `handshakeComplete` は「ACK を送った」時点で立ちます。相手がその ACK を受け取ったかどうかは確認しません。

**主なテスト**: [packages/dtls/tests/e2e/self13.test.ts:1151](review-file:packages/dtls/tests/e2e/self13.test.ts:1151)、[packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:186](review-file:packages/dtls/tests/e2e/self13_dual_hvr_resume.test.ts:186)

## 1.2 socket.ts での公開と DTLS 1.2 の扱い

**仕様の要求**: DTLS 1.2（RFC 6347）には 0.5-RTT がありません。このため 1.2 では、3つのマイルストーンはどれも handshake の完了と同じ意味になります。

**実装の対応**
- [packages/dtls/src/socket.ts:123](review-file:packages/dtls/src/socket.ts:123) の `readiness` は、1.3 engine があればその値を返します。1.2 の場合は、3つとも `connected` の値を返します。
- 待機用の API は3つあります。
  - [packages/dtls/src/socket.ts:150](review-file:packages/dtls/src/socket.ts:150) `waitForWriteReady`
  - [packages/dtls/src/socket.ts:158](review-file:packages/dtls/src/socket.ts:158) `waitForPeerHandshakeAuthenticated`
  - [packages/dtls/src/socket.ts:165](review-file:packages/dtls/src/socket.ts:165) `waitForHandshakeComplete`
- 1.2 と 1.3 の両方に対応する dual 構成では、待機を始めた時点でどちらの version になるかが決まっていないことがあります。
  - [packages/dtls/src/socket.ts:240](review-file:packages/dtls/src/socket.ts:240) は、1.3 engine が後から生成されたときにそちらへ追従します。
  - [packages/dtls/src/socket.ts:353](review-file:packages/dtls/src/socket.ts:353) は、1.2 への切り替えを readiness の失敗として扱いません。

**主なテスト**: [packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:538](review-file:packages/dtls/tests/e2e/self12_peer_authenticated_transport.test.ts:538)

## 1.3 server の 0.5-RTT application data

**仕様の要求**
- RFC 8446 §7.1【未照合】: application traffic secret と exporter secret は、server の Finished までの transcript から導出します。つまり server は、自分の Finished を送った時点でこれらを導出できます。
- RFC 9147 §6.1: application_traffic_secret_0 による保護は epoch 3 です。
- RFC 9147 §4.2.1: server は自分の Finished を送ってからデータを送り始めることがある、と書かれています。

**実装の対応**
- server は Finished の後に application secret と exporter を導出します（[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:615](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:615)）。続いて、epoch 3 の送受信両方向の鍵を設定します（[packages/dtls/src/engine/v1_3/flight/server/flight4.ts:625](review-file:packages/dtls/src/engine/v1_3/flight/server/flight4.ts:625)）。
- `send()` は、接続が確定していなくても epoch 3 であれば送信を許します（[packages/dtls/src/engine/v1_3/connection.ts:148](review-file:packages/dtls/src/engine/v1_3/connection.ts:148)）。
- server の `connected` は、client の Finished を検証した後に立ちます（[packages/dtls/src/engine/v1_3/flight/server/flight5.ts:61](review-file:packages/dtls/src/engine/v1_3/flight/server/flight5.ts:61)）。

**werift 独自の判断**
- 0-RTT（epoch 1）は実装していません（[packages/dtls/src/engine/v1_3/flight/client/flight5.ts:24](review-file:packages/dtls/src/engine/v1_3/flight/client/flight5.ts:24)）。
- この文書でいう「early data」は TLS の early_data 拡張（0-RTT）とは別物で、接続が確定する前に届いた epoch 3 のデータを指します。
- 0.5-RTT の送信を実際に許すかどうかは、WebRTC 層で明示的に opt-in した server だけに限ります（2.6）。

## 1.4 early-data buffer（受信側）

**仕様の要求**
- RFC 9147 §4.2.1: handshake が完了する前に新しい epoch の record が届いた場合、バッファしても破棄してもかまいません（MAY）。上位が SCTP のような信頼性のある transport なら、バッファすべきです（SHOULD）。
- RFC 9147 §5.8.1: 1.1 で述べた「破棄またはバッファ」の MUST がここにも当てはまります。

**実装の対応**
- [packages/dtls/src/engine/v1_3/early-data-buffer.ts:9](review-file:packages/dtls/src/engine/v1_3/early-data-buffer.ts:9) は、受信順を保つ上限付きのキューです。上限の既定値は 256 record / 256 KiB / 2 秒です（[packages/dtls/src/engine/v1_3/types.ts:76](review-file:packages/dtls/src/engine/v1_3/types.ts:76)）。
- 上限を超えた record は、新しく届いたものから破棄します（[packages/dtls/src/engine/v1_3/early-data-buffer.ts:30](review-file:packages/dtls/src/engine/v1_3/early-data-buffer.ts:30)）。
- 先頭の record が期限切れになったら、キュー全体を破棄します（[packages/dtls/src/engine/v1_3/early-data-buffer.ts:101](review-file:packages/dtls/src/engine/v1_3/early-data-buffer.ts:101)）。
- 接続確定前に届いた epoch 3 の record は、[packages/dtls/src/engine/v1_3/record-rx.ts:539](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:539) でバッファへ振り分けます。
- 接続が確定すると `markConnected` が1件ずつ配送します（[packages/dtls/src/engine/v1_3/connection-base.ts:980](review-file:packages/dtls/src/engine/v1_3/connection-base.ts:980)）。配送の途中で世代が変わった場合は、残りを破棄します。

**werift 独自の判断**: 2秒という期限と、先頭が期限切れになったらキュー全体を捨てる方式は werift の判断です。順序の途中が欠けたまま、後続の record だけを上位に見せないためです。

**主なテスト**: [packages/dtls/tests/handshake/tls13/early_data_buffer.test.ts:5](review-file:packages/dtls/tests/handshake/tls13/early_data_buffer.test.ts:5)、[early_data_buffer.test.ts:22](review-file:packages/dtls/tests/handshake/tls13/early_data_buffer.test.ts:22)

## 1.5 受信世代（rxGeneration）による ICE restart の隔離

**仕様上の位置づけ**: 受信世代は werift 独自の仕組みで、RFC には定義がありません。近い根拠は RFC 9147 §4.5.2（無効な record は黙って捨てる）と §4.2.1（古い epoch の record は捨てる）です。

**実装の対応**
- WebRTC 層は、期待する受信世代を DTLS 層に渡します（[packages/dtls/src/socket.ts:182](review-file:packages/dtls/src/socket.ts:182)）。古い世代かどうかは [packages/dtls/src/engine/v1_3/host.ts:15](review-file:packages/dtls/src/engine/v1_3/host.ts:15) で判定します。
- DTLS 1.3 での確認箇所:
  - キューから取り出したとき: [packages/dtls/src/engine/v1_3/record-rx.ts:59](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:59)
  - record ごと: [record-rx.ts:157](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:157)
  - 古い世代の Alert: [record-rx.ts:635](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:635)
- Finished の処理中に世代が変わった場合でも、Finished の受理と ACK は確定させます（[packages/dtls/src/engine/v1_3/record-rx.ts:359](review-file:packages/dtls/src/engine/v1_3/record-rx.ts:359)）。確定させないと、相手の再送が replay とみなされて ACK を返せなくなるためです。
- DTLS 1.2 での確認箇所: [packages/dtls/src/socket.ts:580](review-file:packages/dtls/src/socket.ts:580)、[socket.ts:614](review-file:packages/dtls/src/socket.ts:614)、[socket.ts:708](review-file:packages/dtls/src/socket.ts:708)。非同期 handler の所有権は [socket.ts:529](review-file:packages/dtls/src/socket.ts:529) で照合します。
- dual client は、古い世代から届いた ServerHello では version を確定させません（[packages/dtls/src/client.ts:1442](review-file:packages/dtls/src/client.ts:1442)）。

**仕様からの意図的な逸脱**: AEAD で認証済みの fatal Alert であっても、古い世代のものは適用しません。世代は transport 層の概念なので、復号できたかどうかとは別に扱うという判断です。

**主なテスト**: [packages/dtls/tests/e2e/self13_rx_generation.test.ts:239](review-file:packages/dtls/tests/e2e/self13_rx_generation.test.ts:239)、[self13_rx_generation.test.ts:588](review-file:packages/dtls/tests/e2e/self13_rx_generation.test.ts:588)、[packages/dtls/tests/e2e/self12_rx_generation.test.ts:238](review-file:packages/dtls/tests/e2e/self12_rx_generation.test.ts:238)、[packages/dtls/tests/e2e/self13_stale_server_hello_generation.test.ts:59](review-file:packages/dtls/tests/e2e/self13_stale_server_hello_generation.test.ts:59)

## 1.6 DTLS 1.3 → 1.2 の fallback と downgrade 防止

**仕様の要求**
- RFC 8446 §4.1.3【未照合】: 1.3 に対応した server が 1.2 を選ぶ場合、ServerHello.random の末尾に `DOWNGRD\x01` を入れます。1.3 を提示していた client はこれを見たら中止します。RFC 9147 §5.3 と §13 で、この規定が DTLS にも適用されることを確認しました。
- RFC 6347 §4.2.1: HelloVerifyRequest による cookie の交換。

**実装の対応**
- sentinel の判定: [packages/dtls/src/version.ts:73](review-file:packages/dtls/src/version.ts:73)
- client 側の判定: [packages/dtls/src/client.ts:1300](review-file:packages/dtls/src/client.ts:1300)
- 1.2 への確定: [packages/dtls/src/client.ts:680](review-file:packages/dtls/src/client.ts:680)
- `[V1_2, V1_3]` という指定は `[V1_3, V1_2]` に正規化します（[packages/dtls/src/socket.ts:1367](review-file:packages/dtls/src/socket.ts:1367)）。
- Epic 4 で追加したのは、世代の条件、1.2 に確定した後の handler 所有権の維持、readiness の引き継ぎの3点です。sentinel の判定と HVR は既存の実装です。

## 1.7 SRTP 鍵の exporter

**仕様の要求**: RFC 5764 §4.2 では、label `"EXTRACTOR-dtls_srtp"`、空の context で鍵を導出し、client_key / server_key / client_salt / server_salt の順に切り出します。

**実装の対応**
- DTLS 1.3: [packages/dtls/src/engine/v1_3/connection.ts:174](review-file:packages/dtls/src/engine/v1_3/connection.ts:174)、[connection.ts:186](review-file:packages/dtls/src/engine/v1_3/connection.ts:186)
- DTLS 1.2: [packages/dtls/src/socket.ts:1111](review-file:packages/dtls/src/socket.ts:1111)
- Epic 4 では、`waitForWriteReady` の時点で SRTP profile を反映するよう変更しました（[packages/dtls/src/socket.ts:153](review-file:packages/dtls/src/socket.ts:153)）。これにより、server は 0.5-RTT の段階で SRTP 鍵を導出できます。この鍵を実際に使ってよいかは WebRTC 層が判断します（2.4）。

---

# 第2部 WebRTC transport 層（packages/webrtc）

## 2.1 SDP fingerprint の照合を認証の境界にする

**仕様の要求**
- RFC 8122 §5【未照合】: `a=fingerprint` は証明書のハッシュです。受け取った証明書と一致しなければ、接続を拒否します。
- RFC 8827 §6.5【未照合】: WebRTC の機密性は、DTLS 証明書が SDP の fingerprint に束縛されていることに依存します。
- Epic 4 の不変条件として、照合が済むまで application data も media も配送しません（[epic4-warp-webrtc-detailed.md:189](review-file:epic4-warp-webrtc-detailed.md:189)、§13）。

**実装の対応**
- 照合は [packages/webrtc/src/transport/dtls-fingerprint.ts:46](review-file:packages/webrtc/src/transport/dtls-fingerprint.ts:46) の純粋関数で行います。
  - 未対応のアルゴリズムは捨て、残った中で最も強いアルゴリズムだけを比較します（優先順は [dtls-fingerprint.ts:22](review-file:packages/webrtc/src/transport/dtls-fingerprint.ts:22)）。
  - 値は正規化してから比較します（[packages/webrtc/src/utils.ts:44](review-file:packages/webrtc/src/utils.ts:44)）。
- 照合の呼び出しは [packages/webrtc/src/transport/dtls.ts:526](review-file:packages/webrtc/src/transport/dtls.ts:526) です。DTLS 層の `peerHandshakeAuthenticated` を待ってから照合します。
  - 一致しなければ `failAuthenticatedTransport` を呼びます（[dtls.ts:259](review-file:packages/webrtc/src/transport/dtls.ts:259)）。gate、キュー、SPED を破棄して `failed` にします。
- 照合に成功した後は、次の順で処理します（[packages/webrtc/src/transport/dtls.ts:541](review-file:packages/webrtc/src/transport/dtls.ts:541)）。
  1. `peerAuthenticated` を立てる
  2. SRTP の鍵を設定し、保持していた media を復号する
  3. application gate を開いて、保持していたデータを配送する
  4. `connected` にする
- 送信側の境界は [packages/webrtc/src/transport/dtls.ts:1224](review-file:packages/webrtc/src/transport/dtls.ts:1224) の `sendData` です。認証前の送信は、early server の送信許可（2.6）がない限り throw します。
- 再ネゴシエーションで fingerprint が変わったときは、確立済みの association の証明書で照合し直します。一致しなければ fail させます（[packages/webrtc/src/transport/dtls.ts:232](review-file:packages/webrtc/src/transport/dtls.ts:232)）。

**werift 独自の判断・逸脱**
- tls-id（RFC 8842）は実装していません【未照合】。fingerprint が変わっても新しい association は作らず、照合に失敗したら fail させます。
- 弱いアルゴリズムでの一致は受け入れません。

**主なテスト**: [packages/webrtc/tests/transport/dtls.test.ts:63](review-file:packages/webrtc/tests/transport/dtls.test.ts:63)、[dtls.test.ts:98](review-file:packages/webrtc/tests/transport/dtls.test.ts:98)、[dtls.test.ts:1267](review-file:packages/webrtc/tests/transport/dtls.test.ts:1267)、[packages/webrtc/tests/integrate/sped.test.ts:1617](review-file:packages/webrtc/tests/integrate/sped.test.ts:1617)（WARP 有効時に照合が失敗したら、SCTP / RTP / RTCP を一切上位へ渡さないことを確認）

## 2.2 RTCDtlsTransport の state と readiness latch

**仕様の要求**: W3C の `RTCDtlsTransportState`【未照合】では、`connected` は「ネゴシエーションが完了し、リモートの fingerprint も検証済み」の状態です。`close()` は、イベントを発火せずに `closed` にします。

**実装の対応**
- 型は [packages/webrtc/src/transport/dtls-types.ts:21](review-file:packages/webrtc/src/transport/dtls-types.ts:21) です。内部の latch（`writeReady` / `peerAuthenticated` / `handshakeComplete`）は [dtls-types.ts:33](review-file:packages/webrtc/src/transport/dtls-types.ts:33) にあります。
- `start()` で `connecting` にし（[packages/webrtc/src/transport/dtls.ts:304](review-file:packages/webrtc/src/transport/dtls.ts:304)）、fingerprint の照合と drain が済んだ後に `connected` にします（[dtls.ts:560](review-file:packages/webrtc/src/transport/dtls.ts:560)）。
- `handshakeComplete` は `connected` とは別に latch します（[packages/webrtc/src/transport/dtls.ts:621](review-file:packages/webrtc/src/transport/dtls.ts:621)）。
- ICE generation ごとの attempt は [packages/webrtc/src/transport/dtls.ts:378](review-file:packages/webrtc/src/transport/dtls.ts:378) と [dtls.ts:581](review-file:packages/webrtc/src/transport/dtls.ts:581) で管理します。接続後の ICE restart では、association はそのまま維持し、attempt だけを付け替えます（[dtls.ts:607](review-file:packages/webrtc/src/transport/dtls.ts:607)）。
- `stop()` はイベントを出さずに `closed` にします（[packages/webrtc/src/transport/dtls.ts:1324](review-file:packages/webrtc/src/transport/dtls.ts:1324)）。client の connect が遅れて失敗しても、`closed` を `failed` で上書きしません（[dtls.ts:698](review-file:packages/webrtc/src/transport/dtls.ts:698)）。

**werift 独自の判断**
- `connected` は final ACK（`handshakeComplete`）を待たずに出します。
- early server 送信をしている間も、公開する state は `connecting` のままです（[epic4-warp-webrtc-detailed.md:547](review-file:epic4-warp-webrtc-detailed.md:547)）。

**主なテスト**: [packages/webrtc/tests/transport/dtls.test.ts:956](review-file:packages/webrtc/tests/transport/dtls.test.ts:956)、[dtls.test.ts:1043](review-file:packages/webrtc/tests/transport/dtls.test.ts:1043)、[dtls.test.ts:1300](review-file:packages/webrtc/tests/transport/dtls.test.ts:1300)

## 2.3 受信 application data の gate（InboundApplicationGate）

**仕様上の位置づけ**: SDP の照合前に受け取ったデータをどう扱うかは、RFC 9147 も RFC 8446 も定めていません。2.1 の認証境界を守るための werift 独自の仕組みです。

**実装の対応**
- 認証前に受け取ったデータは、256件 / 256 KiB / 2000 ms を上限とするバッファに保持します（[packages/webrtc/src/transport/dtls-application-gate.ts:7](review-file:packages/webrtc/src/transport/dtls-application-gate.ts:7)）。
- 認証後は、`authenticate()` が1件ずつ配送します。配送のたびに attempt と state を確認し直します（[dtls-application-gate.ts:29](review-file:packages/webrtc/src/transport/dtls-application-gate.ts:29)）。
- 照合の失敗や close のときは `abort()` で破棄します（[dtls-application-gate.ts:67](review-file:packages/webrtc/src/transport/dtls-application-gate.ts:67)）。世代が変わったときは `restartForNewAttempt()` で作り直します（[dtls-application-gate.ts:78](review-file:packages/webrtc/src/transport/dtls-application-gate.ts:78)）。
- 古い世代のデータを gate に入れないための判定は [packages/webrtc/src/transport/dtls.ts:985](review-file:packages/webrtc/src/transport/dtls.ts:985) です。

**主なテスト**: [packages/webrtc/tests/transport/dtls.test.ts:734](review-file:packages/webrtc/tests/transport/dtls.test.ts:734)、[dtls.test.ts:825](review-file:packages/webrtc/tests/transport/dtls.test.ts:825)、[dtls.test.ts:912](review-file:packages/webrtc/tests/transport/dtls.test.ts:912)

## 2.4 方向別の SRTP 有効化と early media

**仕様の要求**
- RFC 5764 §4.2: 鍵は方向ごとに使い分けます。server は client_write の鍵を復号にだけ使います。
- RFC 5764 §5.1: "SRTP processing MUST NOT take place before the DTLS handshake completes."（DTLS handshake が完了するまで SRTP の処理をしてはいけない）

**実装の対応**
- SRTP のセッションは [packages/webrtc/src/transport/dtls-srtp.ts:17](review-file:packages/webrtc/src/transport/dtls-srtp.ts:17) で作ります。SRTP profile の優先順は [packages/webrtc/src/secureTransportManager.ts:627](review-file:packages/webrtc/src/secureTransportManager.ts:627) です。
- 鍵の設定と、送受信を許可することは別に扱います（[packages/webrtc/src/transport/dtls.ts:1070](review-file:packages/webrtc/src/transport/dtls.ts:1070)）。
  - 受信を許可する条件: 鍵がある && `peerAuthenticated`
  - 送信を許可する条件: 鍵がある && (`peerAuthenticated` || early server の送信許可)
- early server が有効なときは、`writeReady` の時点で鍵を前倒しで設定します（[dtls.ts:657](review-file:packages/webrtc/src/transport/dtls.ts:657)）。
- `sendRtp` / `sendRtcp` は、送信が許可されていなければ何も送らずに 0 を返します（[dtls.ts:1233](review-file:packages/webrtc/src/transport/dtls.ts:1233)、[dtls.ts:1259](review-file:packages/webrtc/src/transport/dtls.ts:1259)）。
- 受信した media は、`start()` より前に届いたものも取りこぼさないよう、constructor の時点で購読を始めます（[packages/webrtc/src/transport/dtls.ts:157](review-file:packages/webrtc/src/transport/dtls.ts:157)）。
  - 受信を許可するまでは、暗号化されたまま保持します。`earlyMediaPolicy` の既定値 `"drop"` では、保持する容量が 0 になります（[dtls.ts:1119](review-file:packages/webrtc/src/transport/dtls.ts:1119)）。
  - 保持していた media は、認証の後に復号します（[dtls.ts:1161](review-file:packages/webrtc/src/transport/dtls.ts:1161)）。

**仕様からの逸脱**
- 受信側の復号は、final ACK を待たずに「相手を認証できた時点」で始めます。§5.1 の「handshake completes」を、相手の認証完了と解釈しています。
- 明示的に opt-in した server だけが、相手の認証前に SRTP を送ります。これは §5.1 から外れる実験的な拡張です。client 側は、SDP の照合が済むまで送りません。

**主なテスト**: [packages/webrtc/tests/transport/dtls.test.ts:306](review-file:packages/webrtc/tests/transport/dtls.test.ts:306)、[dtls.test.ts:446](review-file:packages/webrtc/tests/transport/dtls.test.ts:446)、[packages/webrtc/tests/integrate/sped.test.ts:1349](review-file:packages/webrtc/tests/integrate/sped.test.ts:1349)

## 2.5 先頭バイトによる多重分離（RFC 7983 / RFC 9443 §3）

**仕様の要求**: RFC 9443 §3 は RFC 7983 §7 を更新し、先頭バイトで次のように振り分けます。どれにも当てはまらないパケットは破棄しなければなりません（MUST）。

| 先頭バイト | 種別 |
| --- | --- |
| 0..3 | STUN |
| 20..63 | DTLS |
| 64..79 | TURN Channel |
| 128..191 | RTP / RTCP |
| 上記以外の一部 | QUIC |

**実装の対応**
- DTLS の判定は [packages/webrtc/src/utils.ts:52](review-file:packages/webrtc/src/utils.ts:52)、RTP / RTCP の判定は [packages/rtp/src/helper.ts:31](review-file:packages/rtp/src/helper.ts:31) です。
- DTLS を運ぶ carrier は、振り分けに加えて、認証済みの pair であること、現在の世代であること、送信元の 5-tuple が一致することを確認します（[packages/webrtc/src/transport/dtls-ice-transport.ts:23](review-file:packages/webrtc/src/transport/dtls-ice-transport.ts:23)、[packages/ice/src/internal/datagram.ts:59](review-file:packages/ice/src/internal/datagram.ts:59)）。
- QUIC と ZRTP の範囲は扱わず、どちらの判定にも当てはまらないパケットは無視します。結果として破棄されます。

## 2.6 early server data（`warp.allowEarlyServerData`）

**仕様の要求**: TLS 1.3 / DTLS 1.3 の server は、自分の Finished を送った後に 0.5-RTT のデータを送れます（1.3）。WebRTC の仕様に、これを使うことを定めた規定はありません。

**実装の対応**
- 既定値は `allowEarlyServerData: false`、`earlyMediaPolicy: "drop"` です（[packages/webrtc/src/peerConnection.ts:1591](review-file:packages/webrtc/src/peerConnection.ts:1591)）。
- `sped` と DTLS 1.3 がそろっていない状態で有効にすると、`connect()` で throw します（[packages/webrtc/src/peerConnection.ts:961](review-file:packages/webrtc/src/peerConnection.ts:961)）。
- 送信を許可するかどうかの判定は、[packages/webrtc/src/transport/dtls.ts:338](review-file:packages/webrtc/src/transport/dtls.ts:338) の `isEarlyServerOutboundReady()` の1か所だけです。次のすべてを満たしたときに許可します。
  - SPED が有効
  - DTLS role が server
  - opt-in 済み
  - fallback していない
  - `writeReady`
  - DTLS 1.3
  - 現在の attempt
- `setConfiguration` で許可を取り消すと、SCTP に通知します（[packages/webrtc/src/transport/dtls.ts:166](review-file:packages/webrtc/src/transport/dtls.ts:166)）。SPED 側では、キューにある early application だけを reject します（[packages/webrtc/src/transport/sped.ts:170](review-file:packages/webrtc/src/transport/sped.ts:170)）。

**主なテスト**: [packages/webrtc/tests/integrate/sped.test.ts:992](review-file:packages/webrtc/tests/integrate/sped.test.ts:992)、[sped.test.ts:1202](review-file:packages/webrtc/tests/integrate/sped.test.ts:1202)、[packages/webrtc/tests/integrate/warpLifecycle.test.ts:115](review-file:packages/webrtc/tests/integrate/warpLifecycle.test.ts:115)

## 2.7 DTLS role と ICE role の分離

**仕様の要求**【未照合】: RFC 5763 §5 / RFC 8842 によると、offerer は `a=setup:actpass` を出し、answerer は `active` か `passive` を選びます。`active` の側が DTLS client になります。DTLS role は ICE role とは関係なく決まります。

**実装の対応**
- `a=setup` の値と role の対応は [packages/webrtc/src/const.ts:31](review-file:packages/webrtc/src/const.ts:31) です。
- answer では、role が未確定なら client（`active`）を選びます（[packages/webrtc/src/sdpManager.ts:398](review-file:packages/webrtc/src/sdpManager.ts:398)）。
- remote answer を受け取ったら、相手の role の逆を自分の role にします（[packages/webrtc/src/peerConnection.ts:1289](review-file:packages/webrtc/src/peerConnection.ts:1289)）。
- `start()` の時点で role がまだ `auto` の場合は、ICE role から決めます（[packages/webrtc/src/transport/dtls.ts:296](review-file:packages/webrtc/src/transport/dtls.ts:296)）。これは werift のヒューリスティックで、通常の offer/answer と同じ結果になるようにしています。
- SCTP の役割は、ICE role ではなく DTLS role から決めます（4.2）。

## 2.8 WebRTC 層での SPED の利用と fallback

**仕様の要求**（draft-hancke-webrtc-sped-00）
- §3.3.1: DTLS を ICE と同時に開始し、有効な pair ができるまでは STUN に埋め込んで送ります。
- §3.3.4 / §4.3: 相手が SPED に対応していなければ、通常の DTLS に fallback します。
- §4.4: 有効な pair ができたら、DTLS を直接送る方式に切り替えてもかまいません（MAY）。
- §6: SPED を使っている間は、DTLS 内部のタイムアウトを止めることを推奨します。
- §3.2: DTLS 1.2 以上のすべての version で動作することを目標にしています。

**実装の対応**
- SPED の印は `PeerConfig.sped` が有効なときだけ付けます。公開 API には出しません（[packages/webrtc/src/transport/dtls-sped.ts:4](review-file:packages/webrtc/src/transport/dtls-sped.ts:4)、[packages/webrtc/src/secureTransportManager.ts:193](review-file:packages/webrtc/src/secureTransportManager.ts:193)）。
- `connect()` では、SPED には DTLS 1.3 が必要であることを確認します（[packages/webrtc/src/peerConnection.ts:951](review-file:packages/webrtc/src/peerConnection.ts:951)）。そのうえで ICE と DTLS を並行して開始します（[peerConnection.ts:996](review-file:packages/webrtc/src/peerConnection.ts:996)）。
- `startWithSped`（[packages/webrtc/src/transport/dtls.ts:711](review-file:packages/webrtc/src/transport/dtls.ts:711)）は、DTLS の再送を ICE 側に任せる `external` モードで動かします（§6 に対応）。
- 相手の認証は `ice-authenticated` で行います（[dtls.ts:498](review-file:packages/webrtc/src/transport/dtls.ts:498)、draft §9.1）。
- 状況ごとのコールバック:
  - ICE restart: [dtls.ts:736](review-file:packages/webrtc/src/transport/dtls.ts:736)
  - 中止: [dtls.ts:794](review-file:packages/webrtc/src/transport/dtls.ts:794)
  - SPED 非対応の相手への fallback: [dtls.ts:810](review-file:packages/webrtc/src/transport/dtls.ts:810)
  - direct 送信への切り替え（§4.4）: [dtls.ts:825](review-file:packages/webrtc/src/transport/dtls.ts:825)
- 接続後の分岐は [packages/webrtc/src/transport/dtls.ts:886](review-file:packages/webrtc/src/transport/dtls.ts:886) です。DTLS 1.2 に決まった場合は、direct carrier に確定します。
- `IceSpedTransport` は、認証済みの pair から届いた DTLS だけを受け取ります（[packages/webrtc/src/transport/sped.ts:74](review-file:packages/webrtc/src/transport/sped.ts:74)）。送信時の分岐は [sped.ts:226](review-file:packages/webrtc/src/transport/sped.ts:226) です。

**仕様からの逸脱**
- SPED は DTLS 1.3 に限っています。dual 構成で 1.2 に決まった場合は、direct DTLS に確定させ、WARP の early semantics は 1.2 に持ち込みません（[epic4-warp-webrtc-detailed.md:1321](review-file:epic4-warp-webrtc-detailed.md:1321)）。
- 有効にするかどうかは SDP では交渉せず、`PeerConfig.sped` で決めます。作成後に変更することはできません（[packages/webrtc/src/peerConnection.ts:442](review-file:packages/webrtc/src/peerConnection.ts:442)）。

**主なテスト**: [packages/webrtc/tests/integrate/sped.test.ts:2414](review-file:packages/webrtc/tests/integrate/sped.test.ts:2414)、[sped.test.ts:2440](review-file:packages/webrtc/tests/integrate/sped.test.ts:2440)、[sped.test.ts:2535](review-file:packages/webrtc/tests/integrate/sped.test.ts:2535)、[packages/webrtc/tests/integrate/spedTiming.test.ts:13](review-file:packages/webrtc/tests/integrate/spedTiming.test.ts:13)

## 2.9 Stats（RTCTransportStats と WARP の診断値）

**仕様の要求**【未照合】: W3C webrtc-stats の `RTCTransportStats` には、`dtlsState`、`tlsVersion`、`dtlsCipher`、`dtlsRole`、`srtpCipher`、`selectedCandidatePairId` などのフィールドがあります。

**実装の対応**
- [packages/webrtc/src/transport/dtls-stats.ts:78](review-file:packages/webrtc/src/transport/dtls-stats.ts:78) で組み立てます。
- werift 独自のフィールド（`warpSpedState`、`warpCarrier`、`warpHandshakeRttMs`、`warpEarly*`、`iceGeneration` など）は [dtls-stats.ts:120](review-file:packages/webrtc/src/transport/dtls-stats.ts:120) で設定します。型の定義は [packages/webrtc/src/media/stats.ts:239](review-file:packages/webrtc/src/media/stats.ts:239) です。

**仕様からの逸脱・注意点**
- `dtlsRole` は、role が未確定のとき仕様の `"unknown"` ではなく undefined になります。
- DTLS 1.3 の `dtlsCipher` は固定値です。
- `warpHandshakeRttMs` の中身は、RTT ではなく「handshake の開始から相手の認証まで」の経過時間です。

---

# 第3部 ICE / SPED（packages/ice）

## 3.1 SPED の STUN 属性（DATA / ACK）

**仕様の要求**（draft-hancke-webrtc-sped-00）
- §3.3.2.1: DATA 属性は DTLS パケットを1つだけ運びます。
  - 値が空の DATA は「SPED に対応している」ことを示します。空の値を DTLS 層に渡してはいけません（MUST NOT）。
  - 先頭バイトが 20〜63 以外の値は、破棄すべきです（SHOULD）。
- §3.3.2.2: ACK 属性は、受け取った DATA の CRC-32 のリストです。4件までを推奨しています。
- §4.2: 送信する flight（L1）から1パケットを round-robin で選び、DATA に入れます。

**実装の対応**
- 属性のコードポイントは draft では TBD のため、`0xC070` / `0xC071` を使っています（[packages/ice/src/sped/draft00/constants.ts:6](review-file:packages/ice/src/sped/draft00/constants.ts:6)）。
- デコードは [packages/ice/src/sped/draft00/codec.ts:23](review-file:packages/ice/src/sped/draft00/codec.ts:23)、CRC-32 の計算は [codec.ts:67](review-file:packages/ice/src/sped/draft00/codec.ts:67) です。
- 送信時に属性を付けるのは [packages/ice/src/sped/draft00/session.ts:226](review-file:packages/ice/src/sped/draft00/session.ts:226) です。MESSAGE-INTEGRITY より前に挿入します。
- 受信は [session.ts:289](review-file:packages/ice/src/sped/draft00/session.ts:289) で処理します。空の DATA と、先頭バイトが範囲外の DATA は DTLS 層に渡しません（[session.ts:309](review-file:packages/ice/src/sped/draft00/session.ts:309)）。

**werift 独自の判断**
- ACK は一度送ったら消費します。draft では同じ ACK を何度送ってもかまいません（MAY）が、werift は1回だけ送ります。
- MESSAGE-INTEGRITY-SHA256 と TURN 経由の SPED は扱いません。

**主なテスト**: [packages/ice/tests/sped/codec.test.ts:27](review-file:packages/ice/tests/sped/codec.test.ts:27)、[packages/ice/tests/sped/session.test.ts:90](review-file:packages/ice/tests/sped/session.test.ts:90)、[session.test.ts:282](review-file:packages/ice/tests/sped/session.test.ts:282)

## 3.2 相手が SPED に対応しているかの判定と状態遷移

**仕様の要求**
- §4.3 step 1: 相手から最初に受け取った認証済みの STUN に DATA がなければ、相手は SPED に対応していないと判断します。
- §3.3.4: その場合は通常の DTLS に fallback します。

**実装の対応**
- 判定は [packages/ice/src/sped/draft00/session.ts:152](review-file:packages/ice/src/sped/draft00/session.ts:152) で、世代ごとに1回だけ行います。
- 外部に見せる状態（`disabled` / `probing` / `active` / `fallback`）への変換は [packages/ice/src/sped/runtime.ts:167](review-file:packages/ice/src/sped/runtime.ts:167) です。
- pair ごとの役割は [runtime.ts:305](review-file:packages/ice/src/sped/runtime.ts:305) で決めます。役割は `full`（L1 と ACK を運ぶ）、`capability`（空の DATA だけを運ぶ）、`none` の3つです。
- 受信した STUN の振り分けは [runtime.ts:489](review-file:packages/ice/src/sped/runtime.ts:489) です。UDP の prflx 候補は後から relay だと判明することがあるため、DATA がなくても判定を保留します（[runtime.ts:501](review-file:packages/ice/src/sped/runtime.ts:501)）。保留を解消するのは [runtime.ts:377](review-file:packages/ice/src/sped/runtime.ts:377) です。
- fallback するときは、L1 の最初の bytes を DTLS としてそのまま送ります（[packages/ice/src/ice.ts:326](review-file:packages/ice/src/ice.ts:326)）。

**draft からの逸脱**: §3.3.2.1 は、SPED が active の間はすべての Binding に DATA を付けること（MUST）を求めています。werift は relay の pair、未確定の prflx、古い世代の ufrag への応答には DATA を付けません。

**主なテスト**: [packages/ice/tests/sped/session.test.ts:142](review-file:packages/ice/tests/sped/session.test.ts:142)、[packages/ice/tests/sped/pair-isolation.test.ts:718](review-file:packages/ice/tests/sped/pair-isolation.test.ts:718)、[packages/ice/tests/sped/auth.test.ts:314](review-file:packages/ice/tests/sped/auth.test.ts:314)

## 3.3 association path の固定と relay の除外

**仕様の要求**: draft に relay を除外する規定はありません。§3.3.3 では TURN 経由の場合のオーバーヘッドも計上されています。§5.9 には、1つの flight を複数の pair に分けて運ぶ例があります。

**実装の対応**
- SPED の対象になる protocol と pair の判定は [packages/ice/src/sped/runtime.ts:73](review-file:packages/ice/src/sped/runtime.ts:73) と [runtime.ts:93](review-file:packages/ice/src/sped/runtime.ts:93) です。TURN と relay は対象外にしています。
- 空でない DATA を最初に受け取った pair を、その世代の association path として固定します（[runtime.ts:365](review-file:packages/ice/src/sped/runtime.ts:365)）。後から relay だと判明した場合は固定を外します（[runtime.ts:331](review-file:packages/ice/src/sped/runtime.ts:331)）。

**draft からの逸脱**: relay を除外するのは werift の判断です（チケットのスコープ境界とも一致します）。また、flight は1本の path だけで運び、複数の pair には分散しません。

**主なテスト**: [packages/ice/tests/sped/pair-isolation.test.ts:42](review-file:packages/ice/tests/sped/pair-isolation.test.ts:42)、[pair-isolation.test.ts:102](review-file:packages/ice/tests/sped/pair-isolation.test.ts:102)

## 3.4 DTLS を開始する前の対応通知

**仕様の要求**
- §3.3.4: offerer は、answer より前に届く ICE チェックにも対応しなければなりません。
- §4.3: 相手は、こちらが最初に返した認証済みの応答に DATA があるかどうかで、SPED への対応を判定します。
- DTLS 層がまだ存在しない間にどう振る舞うかは、draft に書かれていません（曖昧な点）。

**実装の対応**
- WebRTC 層は、DTLS を開始する前に `prepareConnectionSped` を呼びます（[packages/ice/src/internal/sped-bind.ts:20](review-file:packages/ice/src/internal/sped-bind.ts:20)）。
- この段階で返す認証済みの Binding Response には、空の DATA だけを付けます（[sped-bind.ts:29](review-file:packages/ice/src/internal/sped-bind.ts:29)、呼び出し元は [packages/ice/src/ice.ts:715](review-file:packages/ice/src/ice.ts:715)）。
- ACK は返さず、受け取った flight も DTLS 層に渡しません。相手は L1 を保持したままにし、DTLS を開始した後の再送で処理されます。
- これを入れる前は、DATA のない Response を返していたため、相手が「SPED 非対応」と判断して fallback していました。

**主なテスト**: [packages/ice/tests/sped/prestart.test.ts:16](review-file:packages/ice/tests/sped/prestart.test.ts:16)、[prestart.test.ts:84](review-file:packages/ice/tests/sped/prestart.test.ts:84)

## 3.5 direct handshake carrier と再送モード

**仕様の要求**: §4.4 では、有効な pair ができたら DTLS を直接送ってもかまいません（MAY）。§6 では、SPED を使っている間は DTLS のタイムアウトを止めることを推奨しています。

**実装の対応**
- runtime を作った時点で、再送モードを `external` にします（[packages/ice/src/sped/runtime.ts:162](review-file:packages/ice/src/sped/runtime.ts:162)）。
- 送信元が対称な認証済み Response を受け取ったら、モードを `internal` に戻し、DTLS を直接送れるようにします（[runtime.ts:220](review-file:packages/ice/src/sped/runtime.ts:220)）。
  - Full ICE の場合の呼び出しは [packages/ice/src/ice.ts:2116](review-file:packages/ice/src/ice.ts:2116) です。
  - ICE-Lite の場合は [ice.ts:2335](review-file:packages/ice/src/ice.ts:2335) で、USE-CANDIDATE を受け取った後に限ります。
- pair が認証済みかどうかの定義は [packages/ice/src/internal/datagram.ts:46](review-file:packages/ice/src/internal/datagram.ts:46) です。

**werift 独自の判断**: direct 送信に切り替えても、状態は `active` のままで、`carrier` が `direct` に変わるだけです（[runtime.ts:177](review-file:packages/ice/src/sped/runtime.ts:177)）。

**主なテスト**: [packages/ice/tests/sped/direct-handshake.test.ts:58](review-file:packages/ice/tests/sped/direct-handshake.test.ts:58)、[direct-handshake.test.ts:117](review-file:packages/ice/tests/sped/direct-handshake.test.ts:117)、[direct-handshake.test.ts:188](review-file:packages/ice/tests/sped/direct-handshake.test.ts:188)

## 3.6 STUN の認証（RFC 8445 §7.3 / RFC 8489）

**仕様の要求**
- RFC 8445 §7.3: Request と Response を、短期クレデンシャル（MESSAGE-INTEGRITY）で認証します。
- RFC 8445 §7.2.5.2.1: Response の送信元が Request の宛先と一致しない（非対称な）場合、その pair は Failed にします。
- RFC 8489 §14.5: MESSAGE-INTEGRITY には HMAC-SHA1 を使います。
- draft §9.1: 埋め込まれた DTLS の handshake は、ICE の MESSAGE-INTEGRITY によって認証されます。

**実装の対応**
- 受信した Request は、世代ごとのパスワードで検証します（[packages/ice/src/ice.ts:542](review-file:packages/ice/src/ice.ts:542)）。SPED の処理は、検証が済んだ後でだけ行います（[ice.ts:689](review-file:packages/ice/src/ice.ts:689)）。
- 同じ transaction の Request が再送されてきた場合は、最初に返した Response と同じ bytes を返します（[ice.ts:666](review-file:packages/ice/src/ice.ts:666)）。
- Response の送信元の対称性は [packages/ice/src/ice.ts:2095](review-file:packages/ice/src/ice.ts:2095) で確認します。

**RFC からの逸脱**: MESSAGE-INTEGRITY が不正な Request に対して、RFC 8489 §9.1.3 が定める 400 / 401 のエラー応答を返さず、黙って破棄します（[ice.ts:543](review-file:packages/ice/src/ice.ts:543)）。

**主なテスト**: [packages/ice/tests/sped/auth.test.ts:135](review-file:packages/ice/tests/sped/auth.test.ts:135)、[auth.test.ts:688](review-file:packages/ice/tests/sped/auth.test.ts:688)、[auth.test.ts:786](review-file:packages/ice/tests/sped/auth.test.ts:786)

## 3.7 ICE restart と、以前に選択されていた pair でのメディア受信（RFC 8445 §9）

**仕様の要求**: RFC 8445 §9 では、restart で ufrag とパスワードを両方変えなければなりません（MUST）。restart の間も、既存の session でデータを送り続けてかまいません（MAY）。

**実装の対応**
- [packages/ice/src/ice.ts:251](review-file:packages/ice/src/ice.ts:251) の `restart()` で次を行います。
  - generation を増やす
  - ufrag とパスワードを作り直す（[ice.ts:263](review-file:packages/ice/src/ice.ts:263)）
  - SPED をリセットする（[ice.ts:301](review-file:packages/ice/src/ice.ts:301)）
- 古い世代のチェック結果は無視します（[ice.ts:1854](review-file:packages/ice/src/ice.ts:1854)）。SPED のリセットは [packages/ice/src/sped/runtime.ts:577](review-file:packages/ice/src/sped/runtime.ts:577) です。
- 以前に選択されていた pair（自分が nominate した pair と、相手が最後に使った pair）を退避します（[ice.ts:252](review-file:packages/ice/src/ice.ts:252)）。
  - 新しい世代でまだ認証されていない、アドレスが同じ WAITING pair があっても、その pair から届いた media は旧経路のものとして識別します（[ice.ts:514](review-file:packages/ice/src/ice.ts:514)）。
  - この識別結果は media の受信にだけ使い、DTLS の認証経路には使いません（[packages/ice/src/internal/datagram.ts:33](review-file:packages/ice/src/internal/datagram.ts:33)）。

**werift 独自の判断**: restart の間も続けるのは受信だけです。§9 の「送り続けてよい（MAY）」は採用していないので、旧経路の consent を維持する義務（RFC 7675 §5.1）も生じません（[packages/ice/tests/ice/consent.test.ts:219](review-file:packages/ice/tests/ice/consent.test.ts:219)）。

**主なテスト**: [packages/ice/tests/ice/restart-previous-pair.test.ts:64](review-file:packages/ice/tests/ice/restart-previous-pair.test.ts:64)、[packages/ice/tests/sped/restart.test.ts:17](review-file:packages/ice/tests/sped/restart.test.ts:17)

## 3.8 consent freshness（RFC 7675）

**仕様の要求**（RFC 7675 §5.1）
- consent を得るまでは送信しません。
- 30秒間 consent を確認できなければ、送信を停止します。
- 確認の間隔は、基準値の 0.8〜1.2 倍の範囲でランダムにします。
- consent が失効した後に届いた応答で、consent を再確立してはいけません。

**実装の対応**
- consent の確認は [packages/ice/src/ice.ts:1279](review-file:packages/ice/src/ice.ts:1279) です。
  - 失効の判定: [ice.ts:1301](review-file:packages/ice/src/ice.ts:1301)
  - 間隔のランダム化: [ice.ts:1348](review-file:packages/ice/src/ice.ts:1348)
  - 応答を照合する条件: [ice.ts:1430](review-file:packages/ice/src/ice.ts:1430)
- 送信してよいかの判定は [ice.ts:1227](review-file:packages/ice/src/ice.ts:1227) です。相手から nominate されただけでは、consent があるとはみなしません。
- consent 確認の Binding にも SPED の属性を付けます（[ice.ts:1395](review-file:packages/ice/src/ice.ts:1395)）。

**主なテスト**: [packages/ice/tests/ice/consent.test.ts:38](review-file:packages/ice/tests/ice/consent.test.ts:38)、[consent.test.ts:239](review-file:packages/ice/tests/ice/consent.test.ts:239)

---

# 第4部 SCTP / DataChannel

## 4.1 4-way handshake と T1 タイマー（RFC 9260 §5.1）【未照合】

**仕様の要求**
- (A) 開始側は INIT を送り、COOKIE-WAIT に入ります。
- (B) 応答側は INIT ACK に State Cookie を付けて返します。
- (C) 開始側は COOKIE ECHO を送り、COOKIE-ECHOED に入ります。
- (D) 応答側は COOKIE ACK を返し、ESTABLISHED に入ります。
- (E) 開始側は COOKIE ACK を受け取り、ESTABLISHED に入ります。
- T1 タイマーが満了したら再送し、上限を超えたら association の確立を中止します。

**実装の対応**
- INIT の送信は [packages/sctp/src/sctp.ts:1404](review-file:packages/sctp/src/sctp.ts:1404) です。状態遷移と T1 の開始は、送信処理に渡す前に行います（[sctp.ts:1417](review-file:packages/sctp/src/sctp.ts:1417)）。
- INIT への応答（INIT ACK と cookie）は [sctp.ts:353](review-file:packages/sctp/src/sctp.ts:353)、COOKIE ECHO の送信は [sctp.ts:405](review-file:packages/sctp/src/sctp.ts:405) です。
- cookie の検証は [sctp.ts:486](review-file:packages/sctp/src/sctp.ts:486) です。
- COOKIE ACK は、送信処理に渡した直後に ESTABLISHED へ遷移します（[sctp.ts:519](review-file:packages/sctp/src/sctp.ts:519)）。§5.1 (D) のとおりです。
- T1 タイマーが満了したときの処理は [sctp.ts:1114](review-file:packages/sctp/src/sctp.ts:1114)、再送回数の上限は [sctp.ts:62](review-file:packages/sctp/src/sctp.ts:62) です。

**仕様からの逸脱（既存の実装）**
- T1 が満了しても RTO を倍にしません（[sctp.ts:1133](review-file:packages/sctp/src/sctp.ts:1133)）。
- 応答側は INIT を受け取った時点で状態を持ちます。§5.1 (B) の「資源を確保しない」とは異なります。
- 開始側は相手からの INIT を無視するため、§5.2.1 の INIT 衝突の処理はありません（[sctp.ts:355](review-file:packages/sctp/src/sctp.ts:355)）。

**主なテスト**: [packages/sctp/tests/sctp.test.ts:129](review-file:packages/sctp/tests/sctp.test.ts:129)、[sctp.test.ts:368](review-file:packages/sctp/tests/sctp.test.ts:368)、[sctp.test.ts:398](review-file:packages/sctp/tests/sctp.test.ts:398)

## 4.2 SCTP over DTLS と、DTLS role による SCTP の役割

**仕様の要求**
- RFC 8831 §6.1: SCTP は RFC 8261 の DTLS カプセル化で運ばなければなりません（MUST）。
- RFC 8831 §5: DTLS が運ぶペイロードは SCTP だけです。
- どちらの側が INIT を送るかは、どの RFC も定めていません。

**実装の対応**
- SCTP と DTLS は [packages/webrtc/src/transport/sctp.ts:521](review-file:packages/webrtc/src/transport/sctp.ts:521) でつなぎます。
- SCTP の役割は DTLS role から決めます（[packages/webrtc/src/transport/sctp.ts:174](review-file:packages/webrtc/src/transport/sctp.ts:174)）。以前は ICE role から決めていました。
- DTLS server が INIT を送る開始側、DTLS client が応答側です（[sctp.ts:469](review-file:packages/webrtc/src/transport/sctp.ts:469)）。

**werift 独自の判断**: この役割分担は、WARP で early server data を JSEP のどちらの役割の組み合わせでも成り立たせるための方針です（[epic4-warp-webrtc-detailed.md:1074](review-file:epic4-warp-webrtc-detailed.md:1074)）。

## 4.3 DataChannel の stream id の偶奇（RFC 8831 §6.5 / RFC 8832 §6）

**仕様の要求**: DTLS client は偶数、DTLS server は奇数の stream id を使います。RFC 8831 §6.5 は原文で確認しました。RFC 8832 §6 は【未照合】です。

**実装の対応**
- DTLS server は 1 から、client は 0 から id を振ります（[packages/webrtc/src/transport/sctp.ts:462](review-file:packages/webrtc/src/transport/sctp.ts:462)）。
- 使用中の id があれば、2 ずつ増やして空いている id を探します（[sctp.ts:363](review-file:packages/webrtc/src/transport/sctp.ts:363)）。
- DTLS client は、相手の認証より前に受動側の SCTP を待ち受け状態にしておきます（[packages/webrtc/src/peerConnection.ts:1011](review-file:packages/webrtc/src/peerConnection.ts:1011)）。早い段階で INIT を受けたときに、偶奇がまだ決まっていない状態を防ぐためです。

**補足**: id の偶奇そのものを直接確認するテストは見つかりませんでした。関連するテストは [packages/webrtc/tests/integrate/sped.test.ts:1024](review-file:packages/webrtc/tests/integrate/sped.test.ts:1024) です。

## 4.4 開始の確定点（start commit point）と cancelStart

**仕様上の位置づけ**: RFC が定める association の放棄は、ABORT と T1 の再送上限超過だけです。「開始の取消し」は werift が定義した境界です。

**規則**: 相手が association の状態を持ちうる時点で、開始を確定とします。開始側は COOKIE ECHO を、応答側は COOKIE ACK を送信処理に渡した時点です。確定した後は取り消さず、送信に失敗しても損失として扱い、再送で回復させます。

**実装の対応**
- `startCommitted` は [packages/sctp/src/sctp.ts:235](review-file:packages/sctp/src/sctp.ts:235) です。開始側が確定するのは [sctp.ts:440](review-file:packages/sctp/src/sctp.ts:440)、応答側は [sctp.ts:519](review-file:packages/sctp/src/sctp.ts:519) です。
- `cancelStart` は、確立済みか確定済みなら false を返して取消しを拒否します（[sctp.ts:1519](review-file:packages/sctp/src/sctp.ts:1519)）。
- `retransmitStartNow` は、T1 の満了を待たずに即座に再送します（[sctp.ts:1538](review-file:packages/sctp/src/sctp.ts:1538)）。次の場合に呼びます。
  - 取消しが拒否され、開始が確定済みのとき（[packages/webrtc/src/transport/sctp.ts:114](review-file:packages/webrtc/src/transport/sctp.ts:114)）
  - DTLS が connected になったとき（[sctp.ts:135](review-file:packages/webrtc/src/transport/sctp.ts:135)）
- 送信許可の取消し（revoke）で開始を取り消すのは、DTLS server の場合だけです（[packages/webrtc/src/transport/sctp.ts:121](review-file:packages/webrtc/src/transport/sctp.ts:121)）。

cancelStart に至る経路を次の表にまとめます。

| 経路 | 確定前 | 確定後 |
| --- | --- | --- |
| 送信許可の取消し [dtls.ts:180](review-file:packages/webrtc/src/transport/dtls.ts:180) | 取り消し、認証後に別の association で再試行 | 拒否して即時再送 |
| ICE restart（接続済み）[dtls.ts:392](review-file:packages/webrtc/src/transport/dtls.ts:392) / ICE restart（接続中）[dtls.ts:400](review-file:packages/webrtc/src/transport/dtls.ts:400) | 取り消し | 拒否して即時再送 |
| SPED のリセット / 中止 / fallback [dtls.ts:738](review-file:packages/webrtc/src/transport/dtls.ts:738)、[dtls.ts:795](review-file:packages/webrtc/src/transport/dtls.ts:795)、[dtls.ts:811](review-file:packages/webrtc/src/transport/dtls.ts:811) | 取り消し | 拒否して即時再送 |
| INIT ACK の送信失敗 [sctp/sctp.ts:394](review-file:packages/sctp/src/sctp.ts:394) | 取り消し | — |
| COOKIE ECHO / COOKIE ACK の送信失敗 [sctp.ts:441](review-file:packages/sctp/src/sctp.ts:441)、[sctp.ts:520](review-file:packages/sctp/src/sctp.ts:520) | — | 損失として扱い、再送で回復 |
| T1 による再送の失敗 [sctp.ts:1123](review-file:packages/sctp/src/sctp.ts:1123) | 取り消し | 継続（上限に達したら CLOSED） |
| DTLS が failed / closed [packages/webrtc/src/transport/sctp.ts:141](review-file:packages/webrtc/src/transport/sctp.ts:141) | 終了 | 終了 |

**主なテスト**: [packages/sctp/tests/sctp.test.ts:417](review-file:packages/sctp/tests/sctp.test.ts:417)、[sctp.test.ts:446](review-file:packages/sctp/tests/sctp.test.ts:446)、[packages/webrtc/tests/integrate/warpLifecycle.test.ts:47](review-file:packages/webrtc/tests/integrate/warpLifecycle.test.ts:47)、[warpLifecycle.test.ts:115](review-file:packages/webrtc/tests/integrate/warpLifecycle.test.ts:115)（取消しの後も association が同じであることを確認）

## 4.5 早期の SCTP 開始と、再試行（connectAttempt）

**実装の対応**
- DTLS server は `waitForWriteReady()` を待ち、送信が許可されているときだけ早期に INIT を送ります（[packages/webrtc/src/peerConnection.ts:1013](review-file:packages/webrtc/src/peerConnection.ts:1013)）。
  - 早期の開始に失敗しても致命的なエラーにはしません（[peerConnection.ts:1024](review-file:packages/webrtc/src/peerConnection.ts:1024)）。
  - その場合は、認証の後にもう一度開始します（[peerConnection.ts:1069](review-file:packages/webrtc/src/peerConnection.ts:1069)）。
- 開始の試行は、association とひとまとまりで管理します（[packages/webrtc/src/sctpManager.ts:24](review-file:packages/webrtc/src/sctpManager.ts:24)）。
  - 試行は [sctpManager.ts:113](review-file:packages/webrtc/src/sctpManager.ts:113) で開始し、結果は [sctpManager.ts:156](review-file:packages/webrtc/src/sctpManager.ts:156) で待ちます。
  - 試行が失敗したらキャッシュを消します（[sctpManager.ts:149](review-file:packages/webrtc/src/sctpManager.ts:149)）。取り消された早期の試行が、後の再試行に影響しないようにするためです。
- association が確立する前に閉じた場合、DataChannel は閉じずに保持し、次の再試行に引き継ぎます（[packages/webrtc/src/transport/sctp.ts:98](review-file:packages/webrtc/src/transport/sctp.ts:98)）。
  - RFC 8831 §6.2 の「association が閉じたら、すべての channel を閉じる」は、確立済みの association についての規定だと解釈しています。

**主なテスト**: [packages/webrtc/tests/integrate/sped.test.ts:1101](review-file:packages/webrtc/tests/integrate/sped.test.ts:1101)、[packages/webrtc/tests/transport/sctpManager.test.ts:33](review-file:packages/webrtc/tests/transport/sctpManager.test.ts:33)

---

# 第5部 横断まとめ

## 5.1 Epic 4 の不変条件と実装箇所の対応

| 不変条件（[epic4 §52](review-file:epic4-warp-webrtc-detailed.md:2336)） | 担保している箇所 |
| --- | --- |
| `peerAuthenticated` が false の間は、DataChannel / RTP / RTCP を配送しない | gate [dtls-application-gate.ts:29](review-file:packages/webrtc/src/transport/dtls-application-gate.ts:29)、SRTP の受信許可 [dtls.ts:1070](review-file:packages/webrtc/src/transport/dtls.ts:1070) |
| early server data を送れるのは、明示的に opt-in した server だけ。その間も公開 state は `connecting` | [dtls.ts:338](review-file:packages/webrtc/src/transport/dtls.ts:338) |
| client は SDP の照合前に送信しない | [dtls.ts:1224](review-file:packages/webrtc/src/transport/dtls.ts:1224) |
| generation N のパケットが N+1 に影響しない | DTLS の受信世代 [host.ts:15](review-file:packages/dtls/src/engine/v1_3/host.ts:15)、attempt [dtls.ts:378](review-file:packages/webrtc/src/transport/dtls.ts:378)、ICE [ice.ts:1854](review-file:packages/ice/src/ice.ts:1854) |
| DTLS 1.2 に WARP の early semantics を持ち込まない | [dtls.ts:886](review-file:packages/webrtc/src/transport/dtls.ts:886) |
| `sped=false` のときの既定の挙動は変えない | 直列に開始する経路 [peerConnection.ts:996](review-file:packages/webrtc/src/peerConnection.ts:996) |

## 5.2 仕様から意図的に逸脱している点

1. **0.5-RTT の SRTP / SCTP の送信**: RFC 5764 §5.1 から外れる実験的な拡張です。既定では無効で、opt-in した server に限ります。
2. **SRTP の受信を、相手の認証完了の時点で始める**: final ACK は待ちません。
3. **SPED を DTLS 1.3 だけに限る**: draft の §3.2 は DTLS 1.2 以上を目標にしています。
4. **relay 上の SPED を除外し、association path を1本だけ使う**: draft からの逸脱です。チケットのスコープ境界とも一致します。
5. **SPED が active の間でも、一部の Binding に DATA を付けない**: draft §3.3.2.1 の MUST からの逸脱です。
6. **古い世代の、認証済みの Alert を適用しない**: RFC 9147 からの逸脱です。
7. **STUN の認証失敗時に 400 / 401 を返さない**: RFC 8489 §9.1.3 からの逸脱です。既存の挙動です。
8. **SCTP の T1 で RTO を倍にしない、INIT の衝突を処理しない**: RFC 9260 からの逸脱です。既存の挙動です。
9. **tls-id（RFC 8842）を実装していない**: fingerprint が変わったら、新しい association を作らずに fail させます。
10. **stats の `dtlsRole` が `"unknown"` ではなく undefined になる**、**`warpHandshakeRttMs` の中身が RTT ではない**: webrtc-stats との差異です。

## 5.3 未確認の事項

- 【未照合】を付けた RFC と W3C 仕様の節番号・文言は、手元に原文がないため確認していません。正式な引用にする前に、原文での照合が必要です。
- Chrome（usrsctp）が、確立済みの状態で INIT を受け取ったときの挙動（4.1、4.2）は確認していません。
- DTLS 1.3 の `dtlsCipher` が、実際にネゴシエーションされた cipher suite を反映しているかは確認していません。
- 外部実装（Pion の full-SPED など）との相互接続は、この文書の範囲では確認していません。
