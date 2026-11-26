# Epic 3: SPED over ICE transport 実装タスク

## 前提

- 対象ブランチ: `warp`
- Epic 1: Direct DTLS 1.3 endpoint 完了済み
- Epic 2: `packages/webrtc` DTLS 1.3 opt-in / Chromium interoperability 完了済み
- 本 Epic は **1つの PR で完結させる**
- 主な対象:
  - `packages/ice-server`
  - `packages/ice`
  - `packages/dtls`
- `packages/webrtc` の WARP coordinated startup は本 Epic では実施しない
- `RTCPeerConnection` の既存 ICE → DTLS 直列起動は変更しない
- SPED は experimental / internal 機能として実装し、draft codepoint や L1/L2 を stable Public API に露出しない
- DTLS 1.2 default / SPED disabled の既存挙動を維持する

---

# 1. ゴール

認証済み ICE Binding Request / Response 内の SPED draft-00 attribute を使い、DTLS handshake datagram を ICE connectivity check と並行して搬送できるようにする。

Epic 完了時点で、`RTCPeerConnection` を介さない ICE + DTLS integration harness において、以下を成立させる。

```text
DTLS Client
  │ ClientHello flight を生成
  ▼
SPED L1
  │
  ▼
ICE Binding Request
  ├─ DTLS-IN-STUN-DATA
  ├─ MESSAGE-INTEGRITY
  └─ FINGERPRINT
  │
  ▼
ICE Server
  │ request を認証
  │ DTLS datagram を inject
  ▼
DTLS Server
  │ server flight を生成
  ▼
SPED L1
  │
  ▼
ICE Binding Response
  ├─ DTLS-IN-STUN-ACK
  ├─ DTLS-IN-STUN-DATA
  ├─ MESSAGE-INTEGRITY
  └─ FINGERPRINT
  │
  ▼
DTLS Client
  │
  └─ DTLS 1.3 handshake complete
```

さらに以下を満たす。

- werift ↔ werift で SPED 上の DTLS 1.3 handshake が成立する
- Pion と STUN/SPED wire interoperability が成立する
- Pion との ICE/SPED 相互接続が成立する
- 非 SPED peer へ exact same serialized DTLS flight のまま direct fallback できる
- ICE restart / multi-candidate / TURN で generation isolation を維持する
- Epic 1 / Epic 2 の regression を壊さない

---

# 2. 実装方針

本 PR の実装は以下の依存順で進める。

```text
STUN ordered attributes
        ↓
Binding Request authentication boundary
        ↓
SPED draft00 codec / state
        ↓
DTLS carrier bridge
        ↓
ICE connectivity check integration
        ↓
source/generation-aware routing
        ↓
RTT / MTU synchronization
        ↓
fallback / restart / TURN
        ↓
werift self E2E
        ↓
Pion interop
        ↓
full regression
```

途中コミットは分割してよいが、最終的には1 PRとしてマージ可能な状態にする。

---

# 3. STUN attribute の wire order を保持する

## 3.1 現状の問題

`packages/ice-server/src/stun/message.ts` は、serialize 時に以下の順で attribute を出力する。

```text
known attributes
rawAttributes
```

このまま `appendRawAttribute()` で SPED attribute を追加すると、`MESSAGE-INTEGRITY` / `FINGERPRINT` より後ろに配置される可能性があり、SPED DATA / ACK が MESSAGE-INTEGRITY の認証対象外になる。

## 3.2 実装

known / unknown を含む wire order を保持できる内部表現へ変更する。

例:

```ts
type WireAttribute =
  | {
      kind: "known";
      name: AttributeKey;
      value: unknown;
    }
  | {
      kind: "raw";
      type: number;
      value: Buffer;
    };
```

最終的に以下のような順序を明示的に構築できること。

```text
USERNAME
PRIORITY
ICE-CONTROLLING / ICE-CONTROLLED
USE-CANDIDATE
DTLS-IN-STUN-ACK
DTLS-IN-STUN-DATA
MESSAGE-INTEGRITY
FINGERPRINT
```

## 3.3 互換性

既存 API について可能な限り互換 view を残す。

- `attributesKeys`
- `getAttributeValue()`
- `setAttribute()`
- `rawAttributes`
- `appendRawAttribute()`

既存の STUN / TURN の serialization 結果を不要に変更しない。

## 3.4 テスト

- parse → serialize で unknown attribute の相対位置を保持する
- SPED DATA が `MESSAGE-INTEGRITY` より前
- SPED ACK が `MESSAGE-INTEGRITY` より前
- `FINGERPRINT` が末尾
- SPED DATA の value 改ざんで MESSAGE-INTEGRITY validation が失敗する
- attribute value length の 4-byte padding:
  - 0 byte
  - 1 byte
  - 2 byte
  - 3 byte

---

# 4. Binding Request の認証境界を修正する

## 4.1 現状の問題

Binding Request 受信時に unauthenticated parse した `Message` の `USERNAME` から local password を選択した後、その Message のまま以下へ進んでいる。

- role conflict
- filter callback
- response
- candidate-pair update
- `checkIncoming()`

SPED DATA をこの経路へ追加すると、認証前データを DTLS へ inject する危険がある。

## 4.2 二段階 parse

Request 処理を以下へ変更する。

```text
raw STUN bytes
  ↓
parseMessage(data)
  ↓
USERNAME のみ取得
  ↓
local credential を決定
  ↓
parseMessage(data, localPassword)
  ↓
MESSAGE-INTEGRITY verified
  ↓
current ICE generation 検証
  ↓
role conflict
  ↓
filter callback
  ↓
SPED
  ↓
response
  ↓
candidate-pair update
```

## 4.3 generation boundary

`userHistory` により旧 ufrag/password を解決できても、旧 generation の authenticated request は current generation の以下へ影響させない。

- SPED DATA inject
- SPED ACK processing
- L1/L2
- role state
- candidate pair state
- current path RTT / MTU
- DTLS association

旧 generation に STUN response を返す必要がある場合でも、current generation の protocol state は更新しない。

## 4.4 テスト

- forged MESSAGE-INTEGRITY → drop
- MESSAGE-INTEGRITY なし → drop
- username は正しいが HMAC 不正 → drop
- old generation credential で認証成功しても SPED inject されない
- unauthenticated request で role が切り替わらない
- unauthenticated request が `filterStunResponse` より先で拒否される

---

# 5. SPED draft-00 module を追加する

## 5.1 ディレクトリ

```text
packages/ice/src/sped/draft00/
  constants.ts
  codec.ts
  session.ts
  mtu.ts
  types.ts
```

必要に応じてファイル名は既存命名規則に合わせて変更してよい。

## 5.2 codepoint

単一 constants module に隔離する。

```ts
const DTLS_IN_STUN_DATA = 0xc070;
const DTLS_IN_STUN_ACK = 0xc071;
```

metadata として以下を持ってよい。

```text
draft: sped-draft-00
IANA DATA name: META-DTLS-IN-STUN
IANA ACK name: META-DTLS-IN-STUN-ACKNOWLEDGEMENT
```

## 5.3 Public API

以下を package root から export しない。

- `0xC070`
- `0xC071`
- L1
- L2
- CRC helper
- SPED session internals
- carrier bridge internals

---

# 6. SPED DATA / ACK codec

## 6.1 DATA

`DTLS-IN-STUN-DATA` は以下を扱う。

### empty DATA

```text
length = 0
```

peer の SPED support advertisement として使用する。

DTLS へ inject しない。

### non-empty DATA

1 attribute に完全な DTLS handshake datagram を1個だけ格納する。

複数 DTLS datagram を1 attributeに coalesce しない。

## 6.2 ACK

ACK payload は受信済み SPED DATA value の CRC-32 配列。

```text
4 bytes × N
N <= 4
```

- 最大4件
- 最大16 bytes
- STUN padding は CRC 計算に含めない
- value の DTLS datagram bytes のみを CRC 対象にする

## 6.3 validation

非 empty DATA は先頭 byte を確認する。

```text
20 <= firstByte <= 63
```

範囲外なら silent drop する。

## 6.4 テスト

- empty DATA
- DTLS datagram DATA
- ACK 1 / 2 / 3 / 4件
- ACK 5件目を1 attributeに入れない
- malformed ACK length
- padding を CRC に含めない
- invalid DTLS demux byte は inject しない

---

# 7. SPED session state machine

## 7.1 state

ICE generation ごとに SPED session を保持する。

例:

```ts
type SpedState =
  | "disabled"
  | "probing"
  | "active"
  | "fallback"
  | "complete";
```

## 7.2 internal state

```text
L1
  current DTLS flight の未 SPED-ACK datagram

L2
  peer へ返す pending CRC ACK

roundRobinIndex
  L1 の送信位置

peerSupport
  unknown / supported / unsupported

generation
  state が属する ICE generation

carrierMode
  sped / direct

rttMs
  current authenticated path RTT

mtu
  current path で使用可能な最大 DTLS datagram size
```

## 7.3 new DTLS flight

DTLS carrier の `onFlightCreated` を利用する。

```text
onFlightCreated
  ↓
旧 L1 clear
  ↓
新 flight packet を defensive copy
  ↓
roundRobinIndex = 0
```

SPED 側で DTLS flight state machine を再実装しない。

## 7.4 handshake complete

DTLS handshake 完了時:

```text
L1 clear
L2 clear
roundRobin reset
state = complete
```

---

# 8. Binding message へ SPED を付加する

## 8.1 全 peer Binding message に DATA を付加

SPED enabled の間、peer connectivity check 用 Binding Request / Response には必ず `DTLS-IN-STUN-DATA` を付加する。

L1 に packet がなければ empty DATA を付ける。

STUN server discovery や TURN control message には付けない。

## 8.2 DATA selection

L1 が複数ある場合:

```text
1 Binding message = 1 DTLS datagram
```

round-robin で選ぶ。

## 8.3 ACK selection

L2 から最大4件を ACK attribute に載せる。

## 8.4 STUN transaction retransmission

同じ STUN transaction の retransmission では **同じ serialized Binding message** を再送する。

再送ごとに L1 の round-robin 選択をやり直さない。

---

# 9. SPED receive processing

認証済み Binding message に対して以下の順序で処理する。

```text
DATA attribute presence
  ↓
peer SPED capability 判定
  ↓
ACK processing
  ↓
DATA validation
  ↓
DTLS inject
  ↓
CRC を L2 に追加
```

## 9.1 capability

最初の current-generation authenticated Binding message:

- DATAあり → `supported`
- DATAなし → `unsupported`

DATA の value が empty でも「supported」と判定する。

## 9.2 ACK

ACK に含まれる CRC が current L1 packet と一致した場合のみ L1 から除去する。

未知 CRC は ignore。

## 9.3 DATA

- empty → injectしない
- invalid demux → injectしない
- valid → DTLSへ inject
- duplicate → DTLS replay protection に委ねて安全にdrop可能
- CRC ACK自体は duplicate DATA に対して再度返してよい

## 9.4 state separation

SPED CRC ACK と DTLS 1.3 ACK は完全に別 state にする。

SPED ACK を DTLS transcript / DTLS record ACK state に混ぜない。

---

# 10. DTLS carrier bridge

## 10.1 目的

Epic 1 で導入済みの `DtlsHandshakeCarrier` を SPED transport と接続する。

既存 carrier は以下を利用できる。

- immutable `DtlsHandshakeDatagram`
- `flightId`
- `packetIndex`
- `onFlightCreated`
- `onHandshakeComplete`
- `getMtu()`
- `updateRtt()`
- `setRetransmissionMode()`

## 10.2 SPED active

SPED active 中:

```text
DTLS handshake packet
  ↓
direct UDP send しない
  ↓
SPED L1 に渡す
  ↓
STUN Binding message の送信機会で搬送
```

DTLS internal retransmission timer は停止する。

```ts
carrier.setRetransmissionMode("external");
```

## 10.3 direct mode

SPED fallback 後:

```text
same pending DTLS flight
  ↓
authenticated ICE pair
  ↓
direct DTLS datagram
```

internal retransmission timer を再開する。

```ts
carrier.setRetransmissionMode("internal");
```

## 10.4 注意

`DirectHandshakeCarrier.send()` を SPED active のまま使って raw DTLS datagram を送信しない。

必要なら SPED 用 carrier / bridge implementation を追加する。

---

# 11. DTLS inject を awaitable にする

## 11.1 問題

現在の `inject(bytes): void` のままだと、DTLS 1.3 の内部 `rxChain` へ処理を enqueue した直後に ICE Binding Response を組み立てる可能性がある。

その場合:

```text
Binding Request
  ↓
ClientHello inject
  ↓
Binding Response 作成
  ↓
server flight 未生成
```

となり、同じ Binding Response に server flight を載せられない。

## 11.2 修正

internal carrier API を awaitable にする。

例:

```ts
inject(
  bytes: Buffer,
  peer?: InjectPeerAddr,
): Promise<void>;
```

または同等の内部API。

## 11.3 server request processing

以下を保証する。

```text
authenticated Binding Request
  ↓
await inject(ClientHello)
  ↓
DTLS server flight generated
  ↓
L1 updated
  ↓
Binding Response を構築
  ↓
server flight を DATA に載せる
```

carrier は stable Public API ではないため、この Epic 内で内部interfaceを修正してよい。

---

# 12. ICE connectivity check へ統合する

## 12.1 Binding Request

既存の request 構築後、MESSAGE-INTEGRITY追加前に SPED decoration を行う。

```text
buildRequest()
  ↓
decorate SPED DATA / ACK
  ↓
add MESSAGE-INTEGRITY
  ↓
add FINGERPRINT
  ↓
send
```

対象:

- ordinary connectivity check
- nomination check
- triggered check
- handshake 中に利用される peer Binding request

## 12.2 Binding Response

```text
new Binding Response
  ↓
XOR-MAPPED-ADDRESS
  ↓
await received SPED DATA inject
  ↓
decorate SPED ACK / DATA
  ↓
add MESSAGE-INTEGRITY
  ↓
add FINGERPRINT
  ↓
send
```

---

# 13. source-aware / generation-aware internal datagram event

## 13.1 問題

現在の内部経路では最終的に以下へ縮退する。

```ts
onData(Buffer)
```

source address / protocol / candidate pair / generation が失われるため、pre-nomination direct DTLS fallback を安全に routing できない。

## 13.2 internal event

以下相当の internal event を追加する。

```ts
interface IceDatagramContext {
  bytes: Buffer;
  source: Address;
  protocol: Protocol;
  pair?: CandidatePair;
  generation: number;
  authenticated: boolean;
}
```

## 13.3 Public API

既存 Public:

```ts
onData(Buffer)
```

は維持する。

必要なら compatibility adapter として internal event から従来 `onData` を発火する。

## 13.4 routing rule

DTLS handshake datagram を direct route してよいのは:

- current generation
- authenticated STUN check と関連付け済み
- 対応 candidate pair が存在
- source / protocol がその pair と一致

する場合だけ。

**raw source address 一致だけで association を選択しない。**

## 13.5 TURN

`StunOverTurnProtocol` でも peer address / protocol context を失わない。

---

# 14. non-SPED peer への direct fallback

## 14.1 detection

最初の current-generation authenticated Binding message に DATA attribute がなければ非 SPED peer と判断する。

```text
peerSupport = unsupported
state = fallback
```

## 14.2 exact same serialized flight

fallback では DTLS ClientHello / current flight を作り直さない。

```text
original L1 packet bytes
        ==
direct fallback packet bytes
```

を必須テストにする。

## 14.3 pre-nomination direct send

通常 application data 用 `Connection.send()` の security semantics は変更しない。

handshake 専用の internal send path を追加する。

例:

```ts
sendHandshakeOnAuthenticatedPair(
  pair,
  bytes,
  generation,
)
```

条件:

- pair は current generation
- authenticated connectivity check 成功済み
- protocol / remote address が pair と一致
- DTLS handshake 用途のみ

---

# 15. SPED retransmission policy

## 15.1 external mode

SPED active:

- DTLS internal RTO timer停止
- STUN connectivity check の送信機会を利用
- L1 packet は SPED ACKされるまで残す

## 15.2 fallback

SPED unsupported:

- external → internal
- pending flight state を維持
- DTLS internal RTO timerを再開

## 15.3 handshake complete

- pending retransmission cancel
- L1/L2 clear
- SPED session complete

## 15.4 テスト

- external mode 中に DTLS raw retransmit が発生しない
- fallback 後は DTLS timer が再開する
- timer が二重起動しない
- close/restart/error で stale retransmit が発生しない

---

# 16. RTT → DTLS RTO synchronization

## 16.1 単位

`CandidatePair.rtt`:

```text
seconds
```

DTLS carrier:

```text
milliseconds
```

明示変換する。

```ts
carrier.updateRtt(pair.rtt * 1000);
```

## 16.2 更新タイミング

- successful connectivity check
- consent response
- selected pair change
- fallback path selection

## 16.3 ICE RTO と分離

ICE の 500ms floor を DTLS RTOへそのまま流用しない。

DTLS は DTLS 側の RTO calculation を使用する。

## 16.4 テスト

```text
CandidatePair.rtt = 0.050 sec
→ carrier RTT = 50 ms
```

---

# 17. Dynamic MTU

## 17.1 目的

SPED DATA value に格納する DTLS datagram が outer STUN/TURN path MTU を超えないようにする。

## 17.2 overhead

最低限以下を考慮する。

- path MTU
- IP / UDP
- TCP framing
- STUN header
- USERNAME
- PRIORITY
- ICE-CONTROLLING / ICE-CONTROLLED
- USE-CANDIDATE
- MESSAGE-INTEGRITY
- MESSAGE-INTEGRITY-SHA256
- FINGERPRINT
- SPED DATA header
- SPED ACK header + 最大16 bytes
- STUN 4-byte padding
- TURN XOR-PEER-ADDRESS
- ChannelData / Data Indication 差
- application custom STUN attribute

## 17.3 実装方針

可能なら、実際の Binding skeleton を serialize して available DATA payload size を計算する。

```text
outer packet limit
-
serialized Binding without DATA payload
=
max DTLS datagram size
```

Request / Response の両方を計算し、小さい方を使用する。

## 17.4 DTLS carrier

```ts
carrier.setMtu(maxDtlsDatagramSize);
```

を以下で更新する。

- candidate path change
- direct/TURN change
- selected pair change
- attribute configuration change
- ICE restart

## 17.5 send直前検証

serialized STUN / TURN packet がpath上限を超える場合は送信しない。

## 17.6 テスト

- large certificate
- multi-record DTLS flight
- ACK 4件
- long USERNAME
- USE-CANDIDATEあり/なし
- TURN
- custom raw attribute
- MTU境界ぴったり
- MTU + 1 byte を拒否

---

# 18. ICE restart / lifecycle reset

## 18.1 atomic reset

`Connection.restart()` で SPED state を current generation と同時に reset する。

```text
generation++
L1 clear
L2 clear
roundRobinIndex = 0
peerSupport = unknown
state = probing
RTT clear
MTU/path clear
carrier mode reset
pending direct fallback clear
pending inject generation invalidation
```

## 18.2 stale async task

非同期処理は captured generation を保持する。

```ts
if (capturedGeneration !== connection.generation) {
  return;
}
```

## 18.3 lifecycle

以下でも pending state / timer を破棄する。

- close
- DTLS error
- DTLS handshake complete
- ICE failed
- fallback transition

---

# 19. SPED termination policy

初期実装では peer が SPED 対応なら DTLS handshake 完了まで SPED を継続する。

nomination 成功だけでは direct へ切り替えない。

通常の切替は以下だけとする。

```text
SPED unsupported
  → direct fallback

DTLS handshake complete
  → SPED complete
```

これにより carrier mode transition を決定的にする。

---

# 20. werift ↔ werift integration E2E

## 20.1 harness

`RTCPeerConnection` は使用しない。

以下を2組起動する。

```text
ICE Connection
+
SPED Session
+
DTLS Carrier Bridge
+
DtlsClient / DtlsServer
```

## 20.2 最重要シナリオ

```text
DTLS Client flight 1生成
  ↓
SPED L1
  ↓
ICE start
  ↓
Binding Request に ClientHello
  ↓
Server request認証
  ↓
await DTLS inject
  ↓
server flight生成
  ↓
同じ Binding Response に server flight
  ↓
Client inject
  ↓
DTLS handshake complete
  ↓
nominated pair 上で双方向 application data
```

## 20.3 必須 matrix

- controlling → controlled
- controlled 側 triggered check
- Full ICE × Full ICE
- Full ICE × ICE Lite
- DTLS client/server role 両方向
- empty DATA support advertisement
- ClientHello embedded
- server flight embedded
- CRC ACKで L1 削除
- Binding Request loss
- Binding Response loss
- duplicate DATA
- reorder
- non-SPED direct fallback
- multi-candidate
- TURN
- ICE restart
- large DTLS flight
- multi-record flight
- bidirectional DTLS application data

## 20.4 wire assertions

接続成功だけでなく以下を直接 assert する。

- SPED active 中に raw DTLS handshake datagram が直接送信されていない
- DATA = `0xC070`
- ACK = `0xC071`
- DATA/ACK は MESSAGE-INTEGRITY より前
- fallback時のClientHello bytesが元flightと完全一致
- ACK対象CRCのみL1から削除される

---

# 21. Pion STUN/SPED wire interoperability

## 21.1 tooling

`WERIFT_PION_SPED` で binary path を上書き可能にする。

Pion dependency は固定する。

```text
PION_STUN_VERSION=v3.1.6
```

必要であれば:

```text
packages/ice/tools/pion-sped/
```

に install / wrapper / README を追加する。

## 21.2 Pion → werift

- empty DATA
- non-empty DATA
- ACK 1件
- ACK 4件
- padding
- DATA=`0xC070`
- ACK=`0xC071`
- MESSAGE-INTEGRITY 前の attribute order

## 21.3 werift → Pion

同じ vector を逆方向で検証する。

## 21.4 failure

以下を catch-and-ignore しない。

- codepoint mismatch
- malformed ACK
- MESSAGE-INTEGRITY failure
- attribute order incompatibility

---

# 22. Pion ICE/SPED interoperability

wire codec test だけでは Epic 完了としない。

## 22.1 ICE role

最低限:

```text
werift controlling
↕
Pion controlled
```

```text
Pion controlling
↕
werift controlled
```

## 22.2 Full / Lite

- Full ICE × Full ICE
- Full ICE × ICE Lite

## 22.3 protocol boundary

以下まで確認する。

```text
authenticated Binding
→ SPED DATA/ACK
→ DTLS handshake completion
→ bidirectional application data
```

Pion SPED harness 自体に DTLS endpoint がない場合は、Pion ICE/SPED と独立 DTLS 1.3 endpoint を組み合わせて protocol boundary を成立させる。

## 22.4 non-SPED fallback

Pion 側 SPED disabled:

```text
Binding に DATAなし
→ werift detects unsupported
→ exact same serialized DTLS flight
→ direct fallback
→ DTLS handshake complete
```

## 22.5 transport path

可能な範囲で以下をカバーする。

- direct UDP
- TURN

---

# 23. Regression

本 PR 完了前に以下を全て再実行する。

## 23.1 DTLS

- werift ↔ werift DTLS 1.2
- werift ↔ werift DTLS 1.3
- BoringSSL DTLS 1.3 client/server
- OpenSSL DTLS 1.2 client/server
- DTLS 1.3 preferred → 1.2 fallback
- KeyUpdate
- loss/reorder/duplicate
- large certificate

## 23.2 WebRTC

Epic 2 の browser E2E を維持する。

- Chromium ↔ werift DTLS 1.2
- Chromium ↔ werift DTLS 1.3
- offerer / answerer 両方向
- DataChannel
- RTP
- RTCP
- fingerprint verification
- DTLS 1.2 fallback

SPED はこれらの browser E2E では無効のままとする。

## 23.3 ICE

- normal ICE without SPED
- consent freshness
- ICE restart
- ICE Lite
- TURN
- TCP/TLS TURN regression

---

# 24. 本 Epic で変更しないもの

以下は Epic 4 へ残す。

- `RTCPeerConnection` の ICE / DTLS coordinated startup
- nomination 前に `RTCDtlsTransport.start()` を開始する WebRTC orchestration
- `WarpOptions.sped` の最終 WebRTC public option wiring
- WebRTC transport の SPED stats
- `writeReady`
- `peerAuthenticated`
- `handshakeComplete`
- early server application data の WebRTC integration
- directional SRTP readiness
- early RTP / RTCP buffering
- early SCTP / DataChannel
- SNAP

Epic 3 では **ICE/SPED transport と standalone DTLS integration boundary** までを完成させる。

---

# 25. 推奨コミット順

1 PR 内で以下の順序でコミットする。

1. `refactor(stun): preserve ordered attributes`
2. `fix(ice): authenticate binding requests before state updates`
3. `feat(ice): add internal sped draft00 codec and session`
4. `refactor(dtls): make carrier injection awaitable`
5. `feat(ice): bridge dtls handshake carrier with sped`
6. `feat(ice): add source and generation aware datagram context`
7. `feat(ice): integrate sped with connectivity checks and fallback`
8. `feat(ice): synchronize path mtu and rtt with dtls`
9. `test(ice): add werift sped dtls integration e2e`
10. `test(ice): add pion sped wire and agent interop`
11. `test: add restart turn loss reorder regressions`
12. `docs: document internal sped draft00 behavior`

コミット単位では build/test が通る状態を極力維持する。

---

# 26. PR 完了条件

## STUN / authentication

- [ ] known / unknown attribute を含む wire order を保持できる
- [ ] SPED DATA / ACK が `MESSAGE-INTEGRITY` より前に serialize される
- [ ] SPED DATA / ACK が MESSAGE-INTEGRITY の認証範囲に入る
- [ ] Binding Request は USERNAME による credential 選択後に再 parse / HMAC 検証される
- [ ] 未認証 request は role conflict / filter / SPED / pair state に到達しない
- [ ] old generation authenticated request が current SPED state を更新しない

## SPED draft00

- [ ] DATA codepoint は `0xC070`
- [ ] ACK codepoint は `0xC071`
- [ ] codepoint は単一 constants module に隔離される
- [ ] codepoint / L1 / L2 は stable Public API へ露出しない
- [ ] empty DATA advertisement を扱える
- [ ] non-empty DATA は1 attributeにつき1 DTLS datagram
- [ ] ACK は最大4 CRC / 16 bytes
- [ ] CRC はSTUN paddingを含めない
- [ ] invalid DTLS demux byte は silent drop
- [ ] L1 / L2 と DTLS ACK state が完全に分離されている

## DTLS carrier

- [ ] new DTLS flight で L1 が新flightへ置換される
- [ ] flight bytes は defensive copy される
- [ ] DTLS inject を await できる
- [ ] Binding Request の ClientHello inject 後、同じ Binding Response に server flight を載せられる
- [ ] SPED active 中は DTLS internal retransmission timer が停止する
- [ ] SPED active 中に raw DTLS handshake を直接送らない
- [ ] direct fallback で DTLS internal timer が再開する
- [ ] fallback で current flight state を作り直さない

## ICE routing

- [ ] internal datagram event に source / protocol / pair / generation / authenticated state がある
- [ ] Public `onData(Buffer)` 互換性を維持する
- [ ] raw source address だけで DTLS association を選択しない
- [ ] pre-nomination direct handshake は authenticated current-generation pair のみ使用する
- [ ] TURN path でも peer context を失わない

## fallback

- [ ] 最初の authenticated Binding に DATA がなければ non-SPED と判定する
- [ ] fallback の DTLS flight bytes が元の serialized bytes と完全一致する
- [ ] non-SPED peer との DTLS handshake が成立する
- [ ] fallback 後 application data が正常に通る

## RTT / MTU

- [ ] `CandidatePair.rtt` seconds → carrier `rttMs` milliseconds の明示変換がある
- [ ] successful connectivity check で RTT が更新される
- [ ] selected pair change で RTT / path state が更新される
- [ ] ICE 500ms RTO floor を DTLS RTO へ流用しない
- [ ] dynamic MTU が actual STUN/TURN overhead を考慮する
- [ ] large certificate / multi-record flight が SPED MTU 内にfragmentされる
- [ ] send直前に最終 packet size を検証する
- [ ] MTU超過packetを送信しない

## lifecycle

- [ ] new generation で L1 / L2 をclearする
- [ ] new generation で round-robin state をresetする
- [ ] RTT / MTU / path / peerSupport をresetする
- [ ] stale generation async inject を無効化する
- [ ] close / error / complete / restart で timer / pending task をcancelする

## werift E2E

- [ ] werift ↔ werift SPED DTLS 1.3 handshake が成功する
- [ ] controlling / controlled 両方向を通す
- [ ] Full ICE × Full ICE を通す
- [ ] Full ICE × ICE Lite を通す
- [ ] DTLS client/server role 両方向を通す
- [ ] ClientHello が Binding Request に埋め込まれる
- [ ] server flight が Binding Response に埋め込まれる
- [ ] SPED CRC ACK により L1 が削除される
- [ ] loss / reorder / duplicate でhandshakeが成立する
- [ ] multi-candidate で成立する
- [ ] TURN で成立する
- [ ] ICE restart 後に新generationで再接続できる
- [ ] bidirectional DTLS application data が通る

## Pion interop

- [ ] Pion encode → werift decode
- [ ] werift encode → Pion decode
- [ ] empty DATA compatible
- [ ] non-empty DATA compatible
- [ ] ACK 1〜4件 compatible
- [ ] padding compatible
- [ ] `0xC070` / `0xC071` が一致する
- [ ] MESSAGE-INTEGRITY boundary が一致する
- [ ] werift controlling × Pion controlled が成立する
- [ ] Pion controlling × werift controlled が成立する
- [ ] Pion non-SPED への direct fallback が成立する
- [ ] ICE restart interop が成立する
- [ ] direct path interop が成立する
- [ ] TURN path interop を可能な範囲で成立させる

## regression

- [ ] default DTLS 1.2 behavior を変更しない
- [ ] SPED disabled の既存 ICE behavior を変更しない
- [ ] Epic 1 BoringSSL DTLS 1.3 interop が green
- [ ] Epic 1 OpenSSL DTLS 1.2 interop が green
- [ ] Epic 2 Chromium DTLS 1.2 browser E2E が green
- [ ] Epic 2 Chromium DTLS 1.3 browser E2E が green
- [ ] `RTCPeerConnection` の ICE → DTLS 直列起動を変更していない
- [ ] `npm run ci` が成功する

---

# 27. Definition of Done

この Epic は、単に SPED attribute の encode/decode が実装された時点では完了としない。

以下の protocol boundary がすべて成立した時点を完了とする。

```text
werift ICE
  ↕ authenticated STUN + SPED
werift ICE
  ↕
werift DTLS 1.3
```

および

```text
werift
  ↕ STUN / ICE / SPED
Pion
```

さらに non-SPED peer に対して:

```text
SPED probe
  ↓
unsupported detection
  ↓
same serialized DTLS flight
  ↓
direct DTLS fallback
  ↓
handshake complete
```

まで自動テストで確認する。

Epic 4 は、この完成済み ICE/SPED transport を `RTCPeerConnection` の coordinated ICE + DTLS startup に接続する段階とする。
