# Epic 3: SPED over ICE transport を実装する

- 親 Issue: [shinyoshiaki/werift-webrtc#659](https://github.com/shinyoshiaki/werift-webrtc/issues/659) Epic 3
- 仕様ベース: リポジトリ直下 `epic3-sped-over-ice-detailed.md`
- 前提 Epic: Epic 1（`packages/dtls` Direct DTLS 1.3、PR #674）/ Epic 2（`packages/webrtc` DTLS 1.3 opt-in と Chromium interop、PR #675）は完了済み
- 対象ブランチ: `warp`（本 worktree は `ticket/923f494d-4d8d-49e5-ac56-2591de00c87a`）
- 主対象パッケージ: **`packages/ice-server`**（STUN wire order）/ **`packages/ice`**（認証境界・SPED・ICE 統合）/ **`packages/dtls`**（awaitable inject と carrier 接続）
- 本 Epic は **1 つの PR** で完結させる（途中コミット分割は可）

---

## 1. タスクの目的と背景

### 目的

認証済み ICE Binding Request / Response に SPED draft-00 の `DTLS-IN-STUN-DATA` / `DTLS-IN-STUN-ACK` を載せ、DTLS 1.3 handshake datagram を ICE connectivity check と並行して搬送する。

完了時点で、`RTCPeerConnection` を介さない ICE + DTLS integration harness において次が自動テストで成立していること。

```text
DTLS ClientHello
  → SPED L1
  → ICE Binding Request（DATA + MESSAGE-INTEGRITY + FINGERPRINT）
  → ICE が request を認証し DTLS へ await inject
  → DTLS Server flight 生成
  → 同じ Binding Response に server flight（ACK + DATA + MI + FP）
  → Client inject
  → DTLS 1.3 handshake complete
  → nominated pair 上の双方向 application data
```

加えて:

- werift ↔ werift で SPED 上の DTLS 1.3 handshake が成立する
- Pion と STUN/SPED wire および ICE/SPED 相互接続が成立する
- 非 SPED peer へ **元の serialized DTLS flight と完全一致する bytes** で direct fallback できる
- ICE restart / multi-candidate / TURN で generation isolation を維持する
- Epic 1 / Epic 2 の regression（DTLS 1.2 default、Chromium E2E、SPED disabled ICE）を壊さない

Epic 4（`RTCPeerConnection` の ICE/DTLS coordinated startup と `WarpOptions.sped`）の土台を、ICE/SPED transport と standalone DTLS の境界まで完成させる。SPED attribute の encode/decode だけでは完了としない。

### 背景（本ワークツリーで確認した現状）

プロトコル層は ICE → DTLS → SCTP/RTP。Epic 1 で DTLS 1.3 endpoint と `DtlsHandshakeCarrier` が入り、Epic 2 で WebRTC 通常経路の DTLS 1.3 opt-in が入った。SPED 実装はまだ無い。

| 箇所 | 現状 | Epic 3 で埋めるギャップ |
| --- | --- | --- |
| `packages/ice-server/src/stun/message.ts` `serializedAttributes` | known attributes を先に出し、続けて **全ての** `rawAttributes` を末尾へ付ける | unknown/SPED を `MESSAGE-INTEGRITY` より前の wire order に置ける内部表現へ変更する |
| `packages/ice/src/stun/message.ts` | ice-server の Message を **再 consport** しているだけ（実装の単一ソース） | ice 側に二重実装を作らない。wire order 修正は ice-server で行い ice テストでも検証する |
| `StunProtocol.datagramReceived` ほか | Binding **Response** は `parseMessage(data, integrityKey)` で HMAC 検証。Binding **Request** は unauthenticated `parseMessage(data)` のまま `onRequestReceived` へ渡す | Request も USERNAME で credential を決めたあと再 parse / HMAC 検証してから role / filter / SPED / pair 更新へ進む |
| `Connection.ensureProtocol`（`ice.ts` 約 288–354 行） | unauthenticated `msg` で role conflict、`filterStunResponse`、response 送信、`checkIncoming` まで進む。第 3 引数の raw `data` は未使用 | 二段階 parse。SPED DATA は認証後にだけ DTLS inject。response 組み立ては `await inject` の後 |
| `protocol.request()` | integrityKey があるとき **内部で** `addMessageIntegrity` → `addFingerprint` | SPED decoration は必ずこの直前。MI/FP 追加後に DATA を足すと認証範囲外になる |
| `Transaction.retry` | 同じ `Message` を毎回 `sendStun`（`message.bytes` 再計算） | 同一 transaction の再送は **同じ serialized bytes**。L1 round-robin を再送ごとにやり直さない |
| `Connection.onData` / `Protocol.onDataReceived` | `Event<[Buffer]>`。source / protocol / pair / generation / authenticated が落ちる | 内部 `IceDatagramContext` を追加。Public `onData(Buffer)` は維持 |
| `Connection.send` | nominated + consent freshness が無いと送らない | application data の意味は変えない。handshake 専用の authenticated-pair send を内部追加 |
| `packages/ice/src/sped/` | 存在しない | `draft00/` に codec / session / MTU を内部モジュールとして追加。`src/index.ts` から export しない |
| `DtlsHandshakeCarrier.inject` | `void`。`handleDatagram` は `rxChain` に enqueue するだけ | inject 完了を await できるようにし、同じ Binding Response に server flight を載せる |
| `DirectHandshakeCarrier.send` | 常に `transport.send`（生 DTLS） | SPED active 中は生 DTLS を出さない。`setRetransmissionMode("external")` で内部 RTO を止める |
| `CandidatePair.rtt` | **秒**（`performance.now()` 差分 / 1000） | carrier は **ミリ秒**。`updateRtt(pair.rtt * 1000)` を明示する |
| ICE 500ms floor | `CONSENT_RESPONSE_TIMEOUT_MIN = 500`（consent 待ち）。STUN transaction の初期 RTO は `RETRY_RTO = 50` | この 500ms を DTLS RTO に流用しない。DTLS は RFC 9147（`1.5 × RTT`、下限 `MIN_RTO_MS = 100`） |
| `peerConnection.connect()` | `await iceTransport.start()` のあと `await dtlsTransport.start()` | **この直列起動は変更しない**（Epic 4） |
| browser E2E | `goog-sped-v1` が SDP に出ないことを既に assert | 本 Epic でも browser 経路の SPED は無効のまま |

Epic 1 carrier コメントの「Epic 2 SPED」は古い番号である。**Issue #659 と `epic3-sped-over-ice-detailed.md` を正**とし、SPED は本 Epic 3 の担当とする。

### Epic 境界（何をやらないか）

| 対象外 | 担当 |
| --- | --- |
| `RTCPeerConnection` の ICE / DTLS coordinated startup | Epic 4 |
| nomination 前に `RTCDtlsTransport.start()` を始める WebRTC orchestration | Epic 4 |
| `WarpOptions.sped` の WebRTC public option | Epic 4 |
| WebRTC transport の SPED stats、`writeReady` / `peerAuthenticated` / `handshakeComplete` の WebRTC 公開 | Epic 4 |
| early server application data の WebRTC 統合、directional SRTP、early RTP/RTCP/SCTP、SNAP | Epic 4 |
| DTLS 1.2 default や SPED disabled の既存 ICE 挙動の意図的変更 | しない |
| `0xC070` / `0xC071` / L1 / L2 / CRC helper を `packages/ice/src/index.ts` や `packages/dtls/src/index.ts` から export | しない |
| ice-server の `ATTRIBUTES` に SPED を known attribute として登録 | しない（comprehension-optional の raw のまま扱う） |

---

## 2. 実装すべき具体的な機能や変更内容

仕様書の依存順に従う。各段階でその層のテストが通ってから次へ進む。

### 2.1 STUN attribute の wire order を保持する

対象: `packages/ice-server/src/stun/message.ts`（parse / serialize）。ice は re-export のみ。

現状の serialize 順:

```text
attributesKeys（known） → rawAttributes（unknown 全部が末尾）
```

`appendRawAttribute()` で SPED を足すと `MESSAGE-INTEGRITY` / `FINGERPRINT` より後ろになり、DATA/ACK が HMAC 対象外になる。

実装:

- known / raw を混ぜた **wire order 配列** を内部表現にする（仕様の `WireAttribute` 例でよい）
- parse → serialize で unknown の相対位置を保持する
- 既存 view は残す: `attributesKeys` / `getAttributeValue()` / `setAttribute()` / `rawAttributes` / `appendRawAttribute()`
- 目標順（peer Binding）:

```text
USERNAME
PRIORITY
ICE-CONTROLLING / ICE-CONTROLLED
USE-CANDIDATE（任意）
DTLS-IN-STUN-ACK
DTLS-IN-STUN-DATA
MESSAGE-INTEGRITY
FINGERPRINT
```

- 既存 STUN/TURN の「known だけの新規 Message」の serialize 結果は不要に変えない
- 4-byte padding は現行 `paddingLength()` を維持。HMAC は padding 込みの STUN 規則、SPED CRC は **DATA value のみ**（padding 除外）

テスト（ice-server および ice の stun テスト）:

- parse → serialize で unknown の相対位置保持
- DATA/ACK が `MESSAGE-INTEGRITY` より前、`FINGERPRINT` が末尾
- DATA value 改ざんで HMAC 検証失敗
- attribute value length 0/1/2/3 byte の padding

注意: `0xC070` / `0xC071` は comprehension-optional（`isComprehensionRequiredAttribute` は `type <= 0x7fff`）。ice-server STUN サーバは未知 optional を 420 にしない。SPED を `ATTRIBUTES` に足すと STUN サーバが解釈し始めるので **足さない**。

### 2.2 Binding Request の認証境界を修正する

対象: `packages/ice/src/ice.ts` の request 処理、および UDP/TCP/TURN の request 配信。

現状: Response だけ二段階 parse。Request は未認証 Message のまま進む。

```text
StunProtocol / TcpProtocol / StunOverTurnProtocol
  parseMessage(data)                    // 未認証
  onRequestReceived(message, addr, data) // data は既にある
    USERNAME → userHistory / localPassword
    role conflict / switchRole          // 未認証のまま
    filterStunResponse
    Binding Response + checkIncoming
```

変更後:

```text
raw STUN bytes
  → parseMessage(data) で USERNAME のみ見る
  → local credential 決定（userHistory[ufrag] ?? localPassword）
  → parseMessage(data, localPassword) で HMAC 検証。失敗・MI 無しは drop
  → current generation 検証
  → role conflict / filter / SPED / response / checkIncoming
```

generation:

- `userHistory` で旧 ufrag/password が解けても、旧 generation の authenticated request は current の SPED / L1/L2 / role / pair / RTT/MTU / DTLS を更新しない
- 旧 generation へ STUN response を返す必要がある場合でも current protocol state は触らない

テスト:

- forged / 欠落 / 誤 HMAC の MI → drop
- old generation 認証成功でも SPED inject しない
- 未認証 request で role が切り替わらない
- 未認証 request が `filterStunResponse` より先で拒否される

UDP / TCP / TURN（`StunOverTurnProtocol.handleStunMessage`）の Request 経路を同じ境界にする。TURN の Allocate/Refresh/ChannelBind など **サーバ制御 STUN** には SPED を付けない（既存 TURN auth を壊さない）。

### 2.3 SPED draft-00 module

配置（ファイル名は既存命名に合わせてよい）:

```text
packages/ice/src/sped/draft00/
  constants.ts
  codec.ts
  session.ts
  mtu.ts
  types.ts
```

codepoint は constants に隔離:

- `DTLS_IN_STUN_DATA = 0xc070`（IANA 名 META-DTLS-IN-STUN）
- `DTLS_IN_STUN_ACK = 0xc071`（IANA 名 META-DTLS-IN-STUN-ACKNOWLEDGEMENT）

`packages/ice/src/index.ts` から export しない。opt-in は experimental / internal（既定 disabled）。`IceOptions` の typedoc 公開面に codepoint や L1/L2 を出さない。harness は `packages/ice/src/internal` パターン（既存 `selectAddresses.ts` と同様、barrel 非公開）を優先する。

### 2.4 DATA / ACK codec

DATA:

- empty（length = 0）: peer の SPED support advertisement。DTLS へ inject しない
- non-empty: **1 attribute = DTLS handshake datagram 1 個**。複数 datagram を coalesce しない
- 先頭 byte が `20 <= firstByte <= 63` 以外なら silent drop（RFC 7983 / DTLS demux）

ACK:

- 受信済み SPED DATA **value** の CRC-32 配列。4 bytes × N、N ≤ 4（最大 16 bytes）
- STUN padding は CRC に含めない
- 5 件目を 1 attribute に入れない
- malformed length は無視（catch-and-ignore で握りつぶさず、検証可能な drop）

CRC は `packages/common` の `crc32`（STUN fingerprint と同じ IEEE CRC-32）を使い、Pion ベクトルで確定する。`crc32c` は使わない。

### 2.5 SPED session state machine

ICE **generation ごと** に session を持つ。

state: `disabled` | `probing` | `active` | `fallback` | `complete`

内部: L1（未 ACK の current DTLS flight datagram）/ L2（peer へ返す pending CRC、最大 4）/ `roundRobinIndex` / `peerSupport` / `generation` / `carrierMode` / `rttMs` / `mtu`

新 DTLS flight（`onFlightCreated`）:

```text
旧 L1 clear → 新 packet を defensive copy → roundRobinIndex = 0
```

DTLS flight state machine を SPED 側で再実装しない。`createHandshakeDatagram` と同様、callback と内部 cache で Buffer を共有しない。

handshake complete: L1/L2 clear、round-robin reset、`state = complete`。

termination（初期実装）:

- peer が SPED 対応なら **DTLS handshake 完了まで** SPED を継続
- nomination 成功だけでは direct に切り替えない
- 切替は `unsupported → fallback` と `handshake complete → complete` のみ

### 2.6 Binding への付加と受信処理

付加対象: peer connectivity check の Binding Request/Response（ordinary / nomination / triggered / handshake 中 / **consent 中でまだ SPED active なら同様**）。

非対象: STUN server discovery（`serverReflexiveCandidate`）、TURN control（Allocate 等）。

- L1 が空なら empty DATA を必ず付ける（support advertisement）
- L1 が複数なら 1 Binding = 1 datagram、round-robin
- L2 から最大 4 CRC を ACK に載せる
- 同一 STUN transaction 再送は同じ serialized message

受信（認証済み Binding のみ）:

```text
DATA presence → peer capability
  → ACK 処理（一致 CRC のみ L1 から除去。未知 CRC は ignore）
  → DATA validation
  → DTLS inject（empty / invalid demux は inject しない）
  → CRC を L2 へ
```

最初の **current-generation authenticated** Binding:

- DATA あり（empty 含む）→ `supported`
- DATA なし → `unsupported` → fallback

SPED CRC ACK と DTLS 1.3 record ACK は完全に別 state。DTLS transcript に混ぜない。

duplicate DATA は DTLS replay に委ねて drop してよい。CRC ACK は duplicate に対して再送してよい。

### 2.7 DTLS carrier bridge と awaitable inject

対象: `packages/dtls/src/carrier/types.ts` / `direct.ts`、`engine/v1_3/record-rx.ts` の `handleDatagram` / `rxChain`、ice 側 bridge。

既存で使えるもの:

- immutable `DtlsHandshakeDatagram`、`flightId`、`packetIndex`
- `onFlightCreated` / `onHandshakeComplete`
- `getMtu()` / `setMtu()` / `updateRtt()` / `setRetransmissionMode()`
- `createDtlsClientInternal` / `createDtlsServerInternal`（`src/internal.ts`。Public `index.ts` からは出ない）
- external mode は既に timer 停止 + `onRetransmissionModeChange` で internal 復帰時に `scheduleRetransmit`

必須修正:

`inject` は現状 void で、`handleDatagram` が `rxChain.then(handleDatagramAsync)` するだけなので、ICE が ClientHello を inject した直後に Binding Response を組むと server flight が間に合わない。

```ts
inject(bytes: Buffer, peer?: InjectPeerAddr): Promise<void>;
```

その datagram の `handleDatagramAsync` 完了（当該 rxChain エントリ）を待つ。無限の chain 全体を待たない。既存の `inject()` 呼び出しは Promise を無視しても動くが、型と `setInjectHandler` は更新する。

SPED active:

```text
DTLS handshake packet → 生 UDP に出さない → L1 → Binding の送信機会で搬送
carrier.setRetransmissionMode("external")
```

`sendHandshakeFlight` は `onFlightCreated` のあと **必ず** `carrier.send` する（`flight-tx.ts` 約 202–216 行）。そのため:

- SPED 用 carrier の `send()` は wire に生 DTLS を出さない（L1 へ渡す、または `onFlightCreated` 済みなら no-op）
- `DirectHandshakeCarrier.send()` を SPED active のまま使わない

fallback:

```text
同じ pending flight bytes → authenticated ICE pair へ direct datagram
setRetransmissionMode("internal")  // timer 二重起動しない（既存 association hook を再利用）
```

harness の DTLS は `addressValidation: "ice-authenticated"`（anti-amp cookie HRR を払わない。Epic 2 と同じ前提）。

### 2.8 ICE connectivity check への統合

Request（`checkStart` の `buildRequest()` の後、`protocol.request()` の前）:

```text
buildRequest()
  → decorate SPED DATA / ACK
  → protocol.request() が MI + FP を付与して送信
```

Response（`ensureProtocol` の Binding Response）:

```text
new Binding Response
  → XOR-MAPPED-ADDRESS
  → await inject(received DATA)
  → decorate ACK / DATA（server flight が L1 に入っていること）
  → MI + FP
  → send
```

handler は現状同期。inject 待ちのため **async** にする。generation を capture し、await 後に stale なら response/state を更新しない。

consent の Binding も SPED active 中は decoration 対象。discovery / TURN control は対象外。

### 2.9 source / generation-aware datagram context

内部 event 相当:

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

Public `Connection.onData: Event<[Buffer]>` は維持し、internal から互換発火する。

direct DTLS handshake を route してよい条件:

- current generation
- authenticated STUN check と関連付け済み
- 対応 candidate pair が存在
- source / protocol がその pair と一致

**raw source address 一致だけで association を選ばない。**

`StunOverTurnProtocol` では `handleStunMessage(data, addr)` の peer address を落とさない。ChannelData 経路も peer context を維持する。

pre-nomination direct handshake 用:

```ts
sendHandshakeOnAuthenticatedPair(pair, bytes, generation)
```

条件: current generation、authenticated check 成功、protocol / remote が pair と一致、DTLS handshake 専用。`Connection.send()` の consent / nominated セマンティクスは変えない。

### 2.10 fallback / RTT / MTU / restart

fallback:

- 最初の current-generation authenticated Binding に DATA が無ければ `peerSupport = unsupported`、`state = fallback`
- L1 の **元 bytes** をそのまま direct 送信。ClientHello を作り直さない
- 必須 assert: `original L1 packet bytes === direct fallback packet bytes`

RTT:

- 成功した connectivity check / consent response / selected pair 変更 / fallback path 選択で `carrier.updateRtt(pair.rtt * 1000)`
- `pair.rtt` 未設定なら `updateRtt` しない（carrier は RTT unknown → DTLS initial RTO 1000ms / DTLS-SRTP なら 400ms）

MTU:

- Binding skeleton（DATA payload 無し）を serialize し、`outer limit - skeleton = max DTLS datagram`
- Request と Response の小さい方
- overhead: IP/UDP/TCP framing、STUN header、USERNAME/PRIORITY/ICE-CONTROLLED|CONTROLLING/USE-CANDIDATE、MI / MI-SHA256、FP、SPED DATA header、ACK header+最大 16 bytes、STUN padding、TURN XOR-PEER-ADDRESS、ChannelData vs Data Indication、custom raw attribute
- `carrier.setMtu` を path / TURN / selected pair / attribute / ICE restart で更新
- send 直前に最終 STUN/TURN サイズが path 上限超なら送らない

`Connection.restart()`（既に `generation++`、ufrag/password 更新、`userHistory` 追記、checkList/nominated/consent 破棄）に **同時に** SPED atomic reset を入れる:

```text
L1/L2 clear, roundRobinIndex = 0, peerSupport = unknown, state = probing
RTT/MTU/path clear, carrier mode reset
pending direct fallback / pending inject generation invalidation
```

async は captured generation を持ち、不一致なら return。close / DTLS error / handshake complete / ICE failed / fallback でも timer と pending を破棄。

`restart()` は constructor からも呼ばれる（`generation` 初期 -1 → 0）。SPED 未使用時は no-op で既存 ICE テストを壊さないこと。

### 2.11 テストとドキュメント

werift self E2E（`RTCPeerConnection` 不使用）:

```text
ICE Connection + SPED session + DTLS carrier bridge + DtlsClient/DtlsServer
```

必須 matrix は仕様 §20.3（role 両方向、Full×Full、Full×Lite、DTLS client/server 両方向、empty DATA、embedded CH/server flight、CRC ACK、loss/reorder/duplicate、non-SPED fallback、multi-candidate、TURN、ICE restart、large/multi-record flight、双方向 app data）。

wire assert（接続成功だけでは不足）:

- SPED active 中に raw DTLS handshake が直接送信されていない
- DATA=`0xC070`、ACK=`0xC071`、どちらも MI より前
- fallback 時 ClientHello bytes が元 flight と完全一致
- ACK 対象 CRC のみ L1 から削除

Pion:

- `PION_STUN_VERSION=v3.1.6` を固定。必要なら `packages/ice/tools/pion-sped/` に install / wrapper / README
- `WERIFT_PION_SPED` で binary path 上書き
- 既存 `pion-turn` と同様、未設定時は skip して default `npm test` を赤くしない。Epic 完了判定では opt-in を実行して green にする
- wire: empty / non-empty DATA、ACK 1 と 4、padding、codepoint、MI 境界。両方向
- ICE: werift controlling ↔ Pion controlled および逆。Full×Full / Full×Lite。DTLS complete と双方向 app dataまで
- Pion 側 SPED 無し → werift fallback（exact same flight）
- Pion harness に DTLS endpoint が無い場合は Pion ICE/SPED + 独立 werift DTLS 1.3 で protocol boundary を満たす
- codepoint mismatch / malformed ACK / MI failure / attribute order 不一致を catch-and-ignore しない

ドキュメント:

- internal SPED draft00 の振る舞い（codepoint、L1/L2、fallback、generation）
- `packages/ice` に安定スクリプトやディレクトリを足すなら、ルート `AGENTS.md` に従い **パッケージ案内を新設または更新** する（現在 `packages/ice/AGENTS.md` は無い）
- Public API / typedoc を変える場合は `npm run doc:check`

### 2.12 推奨コミット順（1 PR 内）

仕様 §25 に合わせる。各コミットで可能な範囲で build/test を通す。

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

---

## 3. 技術的な実装アプローチ（調査結果）

### STUN 実装の置き場所

Message / attributes / `parseMessage` の実体は `packages/ice-server`。`packages/ice/src/stun/message.ts` は `export * from "../../../ice-server/src/stun/message"`。wire order を ice だけ直すと ice-server テスト・TURN サーバと分岐する。**ice-server を直して ice から使う。**

`parseMessage` は HMAC/fingerprint 失敗時に **throw せず `undefined`**（`ice-server/tests/message-integrity.test.ts`）。古い `packages/ice/tests/stun/stun.test.ts` の throw 期待は現状と不一致。stun テストを触るときは現行の silent-undefined に合わせ、失敗を握りつぶさない。

### 認証済み Request の raw bytes

`onRequestReceived` のシグネチャは既に `[Message, Address, Buffer]`。再 parse 用 bytes を新イベント無しで渡せる。UDP（`stun/protocol.ts`）、TCP（`tcpProtocol.ts` `handleFrame`）、TURN（`StunOverTurnProtocol.handleStunMessage`）で同じ形。

Response 側の二段階 parse は再利用する。Request に同じ `integrityKey` 必須化を載せる。

### SPED を known attribute にしない理由

ice-server `StunServerProtocol` は comprehension-required の unknown に 420 を返す。`0xC070` は optional なので STUN サーバは無視できる。known に登録すると pack/unpack とサーバ応答が SPED を意識し始め、discovery Binding の互換が崩れる。codec は ice の draft00 モジュールが raw attribute type/value を扱う。

### Transaction 再送と round-robin

`Transaction.retry` は `protocol.sendStun(this.request)` を繰り返す。Message を decorate してから `request()` に渡せば、再送は同じ attribute を再 serialize する。decorate を `sendStun` や `onRequestSent` に置くと再送ごとに L1 選択が変わる。**checkStart / consent の request 構築直後・`protocol.request` 前に一度だけ decorate。** 必要なら最初の serialize bytes を cache して再送する。

`protocol.request` が MI/FP を付けるため、decorate は「MI 前」になる。Response は自前で MI/FP しているので、inject → decorate → MI → FP の順を明示する。

### DTLS inject と server flight の同一 Response

`record-rx.handleDatagram` は `rxChain` に enqueue して即 return。server が ClientHello を処理して `sendHandshakeFlight` → `onFlightCreated` するまで待たないと L1 が空のまま Response が行く。

awaitable inject は **carrier / association 内部 API** の変更でよい（`DtlsInternalOptions` / `src/internal.ts` と同じ非公開境界）。Public `DtlsClient` / `DtlsServer` のコンストラクタには出さない。

SPED carrier は `send()` で UDP を踏まないこと。さもないと Binding と生 DTLS が二重送信になる。external mode は既存テスト `carrier_external_association.test.ts` が「external 中は raw retransmit が増えない」「internal 復帰で timer 再開」を既に担保している。SPED はこれを ICE 送信機会に接続する。

### RTT 単位

`checkStart` も consent も `rtt` を秒で入れる。`DirectHandshakeCarrier.updateRtt` と `computeDtlsRtoMs` はミリ秒。変換忘れは RTO が 1000 倍になり危険。テストで `pair.rtt = 0.050` → `carrier.getRtt() === 50` を固定する。consent の 500ms floor（`consentResponseTimeoutMs`）は ICE 待ち時間専用。

### DTLS 1.3 の MTU 断片化

`sendHandshakeFlight` は `carrier.getMtu()` で fragment / coalesce する。SPED は STUN 外枠を引いた値を `setMtu` する。large certificate / multi-record は DTLS 側断片化に任せ、SPED は datagram を 1 DATA に 1 個載せる。

### 既存 ICE テスト資産

- Arrange 共通: `packages/ice/tests/utils.ts`（`createTestConnection` / `inviteAccept` / consent harness）
- TURN: `tests/ice/turn.test.ts`、opt-in Pion TURN（`PION_TURN_HOST`、`scripts/run-pion-turn.sh`）
- 新規 SPED E2E も Arrange を utils に寄せ、Act/Assert に日本語コメントを付ける（リポジトリのテスト規約）

WebRTC は `packages/webrtc/src/imports/ice.ts` が ice の barrel を再 consport している。ice `index.ts` に SPED を足すと WebRTC Public に漏れる。

### Pion

`pion/stun` に `AttrDtlsInStun = 0xC070` / `AttrDtlsInStunAck = 0xC071` がある。`pion/ice` に `sped.go`（ACK 最大 4、big-endian uint32）がある。仕様の `v3.1.6` ピンに codepoint が入っているかは実装時に確認し、無ければ codepoint を含む版へピンを更新してドキュメントする。

---

## 4. 考慮すべき制約や注意点

- **既定動作**: SPED disabled / DTLS 1.2 default を維持。opt-in しない `Connection` は現行 ICE とバイト互換に近いこと（wire order 変更は unknown attribute を含むメッセージに限る）
- **Public API**: draft codepoint、L1/L2、CRC、carrier bridge を stable export しない。`npm run doc:check` で意図しない typedoc 増を検出する
- **WebRTC 非配線**: `peerConnection.connect()` の ICE→DTLS 直列、`RTCDtlsTransport` の `connection.send` / `onData` 契約、browser E2E の SPED off を維持
- **認証前 inject 禁止**: unauthenticated または旧 generation の DATA を DTLS に入れない
- **generation と async**: `await inject` の間に `restart()` / `close()` され得る。captured generation で無効化
- **TURN**: peer Binding にだけ SPED。ChannelData / Data Indication の overhead を MTU に入れる。TURN 制御 STUN の MESSAGE-INTEGRITY を壊さない
- **TCP ICE**: `tcpProtocol` の Request も同じ認証境界。TCP framing を MTU に入れる
- **anti-amplification**: harness は `ice-authenticated`。`dtls-cookie` のまま SPED すると HRR/cookie と STUN 埋め込みが競合しうる
- **ice-server `npm test`**: vitest のあと `chrome-e2e` まで走る。STUN serialize 変更時は unit を先に通し、known-only メッセージのバイトが変わっていないことを確認してから Chrome harness を見る
- **Pion CI**: 既存 pion-turn 同様 opt-in。完了条件の interop はフラグ付きで実行する。失敗を skip や catch-and-ignore しない
- **テスト規約**: Arrange は共有 utils、Act/Assert は日本語コメント
- **DTLS 1.3 継承**: `packages/dtls/src/engine/v1_3` にクラス階層を増やさない。inject の Promise 化は既存 function + carrier に閉じる
- **Windows**: 対象外（Unix-like only）

---

## 5. 完了条件

仕様 §26–27 を本リポジトリの検証コマンドに落としたもの。encode/decode だけでは不足。

### STUN / 認証

- [ ] known / unknown を含む wire order を保持できる
- [ ] SPED DATA / ACK が `MESSAGE-INTEGRITY` より前に serialize され、HMAC 範囲に入る
- [ ] Binding Request は USERNAME で credential 選択後に再 parse / HMAC される
- [ ] 未認証 request は role conflict / filter / SPED / pair state に到達しない
- [ ] old generation authenticated request が current SPED state を更新しない

### SPED draft00

- [ ] DATA=`0xC070`、ACK=`0xC071`、constants 単一モジュール、Public API 非露出
- [ ] empty DATA advertisement、non-empty は 1 attribute = 1 datagram
- [ ] ACK 最大 4 CRC / 16 bytes、padding を CRC に含めない
- [ ] invalid DTLS demux は silent drop
- [ ] L1/L2 と DTLS ACK state が分離されている

### DTLS carrier

- [ ] 新 flight で L1 が置換され、bytes は defensive copy
- [ ] inject を await でき、同じ Binding Response に server flight を載せられる
- [ ] SPED active 中は DTLS internal RTO が止まり、生 handshake を直接送らない
- [ ] fallback で internal timer が再開し、current flight を作り直さない（bytes 完全一致）

### ICE routing / fallback / RTT / MTU / lifecycle

- [ ] internal datagram に source / protocol / pair / generation / authenticated がある
- [ ] Public `onData(Buffer)` 互換、raw address だけで association を選ばない
- [ ] pre-nomination handshake は authenticated current-generation pair のみ。TURN でも peer context を失わない
- [ ] 非 SPED 判定 → exact same flight → handshake → application data
- [ ] `CandidatePair.rtt` 秒 → carrier ミリ秒。connectivity check / selected pair で更新。ICE 500ms consent floor を DTLS RTO に使わない
- [ ] dynamic MTU が実 STUN/TURN overhead を考慮し、超過 packet を送らない
- [ ] restart で L1/L2 / round-robin / RTT / MTU / peerSupport を reset。stale inject 無効。close/error/complete で timer 破棄

### werift E2E / Pion / regression

- [ ] 仕様 §20 の werift ↔ werift matrix（role、Lite、loss/reorder、TURN、restart、wire assert）
- [ ] Pion encode/decode 両方向、codepoint と MI 境界、controlling 両方向、non-SPED fallback、可能な範囲の TURN
- [ ] default DTLS 1.2 と SPED disabled ICE を変えていない
- [ ] `RTCPeerConnection` の ICE → DTLS 直列起動を変えていない
- [ ] Epic 1 BoringSSL DTLS 1.3 / OpenSSL DTLS 1.2 interop が green
- [ ] Epic 2 Chromium DTLS 1.2 / 1.3 browser E2E が green（SPED 無効）

### 検証コマンド

段階的に狭い順:

```bash
cd packages/ice-server && npx vitest run --config ./vitest.config.mts && npm run type
cd packages/ice && npm run type && npm test
cd packages/dtls && npm run type && npm test
```

carrier / handshake 変更後:

```bash
cd packages/dtls && npm run test:boringssl
```

交差変更後:

```bash
npm run type
npm run test:small
```

Pion SPED（環境が揃ってから。未設定 skip に頼って完了としない）:

```bash
# WERIFT_PION_SPED / ツール README に従う
cd packages/ice && npm test -- pion-sped
```

PR 前 regression:

```bash
cd packages/ice-server && npm test    # unit + chrome-e2e
npm run ci
npm run install:browsers   # 未導入時
npm run e2e                # Chromium DTLS 1.2/1.3。SDP に goog-sped-v1 が無いこと
```

Public / docs を触った場合: `npm run doc:check`

### Definition of Done

次の protocol boundary が自動テストで成立したときのみ完了とする。

```text
werift ICE  ↔ authenticated STUN + SPED  ↔  werift ICE
werift ICE  ↔  werift DTLS 1.3
werift      ↔  STUN / ICE / SPED  ↔  Pion
```

非 SPED peer:

```text
SPED probe → unsupported → same serialized DTLS flight → direct fallback → handshake complete
```

Epic 4 は、この完成済み ICE/SPED transport を `RTCPeerConnection` の coordinated startup に接続する段階とする。
