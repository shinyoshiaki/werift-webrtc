# Epic 3: SPED over ICE transport を実装する

- 親 Issue: [shinyoshiaki/werift-webrtc#659](https://github.com/shinyoshiaki/werift-webrtc/issues/659) Epic 3
- 仕様ベース: リポジトリ直下 `epic3-sped-over-ice-detailed.md`
- プロトコル原文: `docs/rfc/`（本チケット詳細化時に公式テキストを保存済み）
- 前提 Epic: Epic 1（`packages/dtls` Direct DTLS 1.3、PR #674）/ Epic 2（`packages/webrtc` DTLS 1.3 opt-in と Chromium interop、PR #675）は完了済み
- 対象ブランチ: `warp`（本 worktree は `ticket/923f494d-4d8d-49e5-ac56-2591de00c87a`）
- 主対象パッケージ: **`packages/ice-server`**（STUN wire order）/ **`packages/ice`**（認証境界・SPED・ICE 統合）/ **`packages/dtls`**（awaitable inject と carrier 接続）/ **`packages/webrtc`**（`RTCPeerConnection` の SPED オプトイン。既定 false）
- 本 Epic は **1 つの PR** で完結させる（途中コミット分割は可）

### 規範ソース（`docs/rfc/`）

| ファイル | 役割 |
| --- | --- |
| `draft-hancke-webrtc-sped-00.txt` | SPED 本体。Binding への DATA/ACK、L1/L2、fallback、MTU 表、termination |
| `stun-parameters.xml` | IANA STUN Attributes。draft の TBD1/TBD2 に対する wire 値 |
| `rfc8489.txt` | 現行 STUN。MI の HMAC 範囲、MI より後の attribute 無視、FINGERPRINT 末尾、padding、再送 |
| `rfc5389.txt` | SPED が padding / STUN header サイズで引用する前身（現行処理は 8489） |
| `rfc8445.txt` | ICE。connectivity check Binding の short-term MI、role conflict は認証後 |
| `rfc8656.txt` | TURN。既存 ICE TURN regression の根拠。**TURN 経由 SPED は本 Epic スコープ外** |
| `rfc7675.txt` | Consent Binding。host/srflx で SPED active なら decoration 対象 |
| `rfc7983.txt` / `rfc9443.txt` | 先頭 byte による demux。DTLS は **20–63 inclusive**。SPED は RFC 9443 §3 を引用（7983 を更新） |
| `rfc5764.txt` | DTLS-SRTP 多重化の元。9443/7983 の前提 |
| `rfc9147.txt` | DTLS 1.3。flight、replay（§4.5.1）、RTO（`1.5 × RTT`） |
| `rfc6347.txt` | DTLS 1.2 flight。SPED DATA は 1.2 datagram も載せられるが、本 Epic の E2E は 1.3 |
| `rfc8831.txt` | 典型 DTLS MTU 1200（SCTP）。SPED §3.3.3 がこれを STUN overhead 分減らすと規定 |
| `rfc1952.txt` | CRC-32 多項式（RFC 8489 FINGERPRINT と同じ。SPED ACK は XOR `0x5354554e` しない） |

draft 本文は attribute 名を `DTLS-IN-STUN-DATA` / `DTLS-IN-STUN-ACK`、type を TBD のまま置く。IANA（2024-12-20）は comprehension-optional で次を登録している。実装の wire 値は IANA / Pion に合わせる。

| draft 名称 | IANA 名称 | Type |
| --- | --- | --- |
| DTLS-IN-STUN-DATA | META-DTLS-IN-STUN | `0xC070` |
| DTLS-IN-STUN-ACK | META-DTLS-IN-STUN-ACKNOWLEDGEMENT | `0xC071` |

---

## 1. タスクの目的と背景

### 目的

認証済み ICE Binding Request / Response に SPED draft-00（`draft-hancke-webrtc-sped-00`）の `DTLS-IN-STUN-DATA` / `DTLS-IN-STUN-ACK` を載せ、DTLS 1.3 handshake datagram を ICE connectivity check と並行して搬送する。wire type は IANA の `0xC070` / `0xC071`。

完了時点で、次が自動テストで成立していること。

- **既定**（`sped` 未指定 / `false`）: 現行どおり ICE 完了後に DTLS。SPED attribute を付けない
- **オプトイン**（`new RTCPeerConnection({ sped: true })` のみ）: その PeerConnection の ICE Binding に SPED を載せ、DTLS 1.3 handshake を並行搬送する

プロトコル成立の確認は ICE + DTLS の integration でもよいが、**SPED を有効化する Public インターフェースは `RTCPeerConnection` にだけ**置く。`IceOptions` / `DtlsClient` には公開しない。

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

- werift ↔ werift で SPED 上の DTLS 1.3 handshake が成立する（`RTCPeerConnection({ sped: true })`）
- Pion と STUN/SPED **wire** interoperability が成立する（最新 pion/stun・pion/ice の attribute codec）
- 非 SPED peer へ **元の serialized DTLS flight と完全一致する bytes** で direct fallback できる
- ICE restart / multi-candidate で generation isolation を維持する
- **TURN 経由の SPED はスコープ外**（既存の SPED 無し ICE TURN regression は壊さない）
- Epic 1 / Epic 2 の regression（DTLS 1.2 default、Chromium E2E、`sped: false` の ICE）を壊さない

Epic 4 は early application data / SNAP / SPED stats / `writeReady` など WARP 上位を載せる段階とする。**SPED の有効化スイッチ自体は本 Epic で `RTCPeerConnection` に入れる**（既定無効）。SPED attribute の encode/decode だけでは完了としない。

### 背景（本ワークツリーで確認した現状）

プロトコル層は ICE → DTLS → SCTP/RTP。Epic 1 で DTLS 1.3 endpoint と `DtlsHandshakeCarrier` が入り、Epic 2 で WebRTC 通常経路の DTLS 1.3 opt-in が入った。SPED 実装はまだ無い。

| 箇所 | 現状 | Epic 3 で埋めるギャップ |
| --- | --- | --- |
| `packages/ice-server/src/stun/message.ts` `serializedAttributes` | known attributes を先に出し、続けて **全ての** `rawAttributes` を末尾へ付ける | unknown/SPED を `MESSAGE-INTEGRITY` より前の wire order に置ける内部表現へ変更する |
| `packages/ice/src/stun/message.ts` | ice-server の Message を **再export** しているだけ（実装の単一ソース） | ice 側に二重実装を作らない。wire order 修正は ice-server で行い ice テストでも検証する |
| `StunProtocol.datagramReceived` ほか | Binding **Response** は `parseMessage(data, integrityKey)` で HMAC 検証。Binding **Request** は unauthenticated `parseMessage(data)` のまま `onRequestReceived` へ渡す | Request も USERNAME で credential を決めたあと再 parse / HMAC 検証してから role / filter / SPED / pair 更新へ進む |
| `Connection.ensureProtocol`（`ice.ts` 約 288–354 行） | unauthenticated `msg` で role conflict、`filterStunResponse`、response 送信、`checkIncoming` まで進む。第 3 引数の raw `data` は未使用 | 二段階 parse。SPED DATA は認証後にだけ DTLS inject。response 組み立ては `await inject` の後 |
| `protocol.request()` | integrityKey があるとき **内部で** `addMessageIntegrity` → `addFingerprint` | SPED decoration は必ずこの直前。MI/FP 追加後に DATA を足すと認証範囲外になる |
| `Transaction.retry` | 同じ `Message` を毎回 `sendStun`（`message.bytes` 再計算） | 同一 transaction の再送は **同じ serialized bytes**。L1 round-robin を再送ごとにやり直さない |
| `Connection.onData` / `Protocol.onDataReceived` | `Event<[Buffer]>`。source / protocol / pair / generation / authenticated が落ちる | 内部 `IceDatagramContext` を追加。Public `onData(Buffer)` は維持 |
| `Connection.send` | nominated + consent freshness が無いと送らない | application data の意味は変えない。handshake 専用の authenticated-pair send を内部追加 |
| `packages/ice/src/sped/` | 存在しない | `draft00/` に codec / session / MTU を内部モジュールとして追加。`src/index.ts` から export しない。有効化は ICE 公開 API ではなく PC から内部接続する |
| `DtlsHandshakeCarrier.inject` | `void`。`handleDatagram` は `rxChain` に enqueue するだけ | inject 完了を await できるようにし、同じ Binding Response に server flight を載せる |
| `DirectHandshakeCarrier.send` | 常に `transport.send`（生 DTLS） | SPED active 中は生 DTLS を出さない。`setRetransmissionMode("external")` で内部 RTO を止める |
| `CandidatePair.rtt` | **秒**（`performance.now()` 差分 / 1000） | carrier は **ミリ秒**。`updateRtt(pair.rtt * 1000)` を明示する |
| ICE 500ms floor | RFC 8489 §6.2.1 の STUN RTO SHOULD ≥ 500ms（ICE は例外可）。実装は consent 下限 `CONSENT_RESPONSE_TIMEOUT_MIN = 500`、check 初期 `RETRY_RTO = 50` | どちらも DTLS RTO に流用しない。DTLS は RFC 9147（`1.5 × RTT`、下限 `MIN_RTO_MS = 100`） |
| `PeerConfig` / `RTCPeerConnection` | `dtls.protocolVersions` はある。SPED スイッチは無い。コメントは「this package does not enable SPED」 | **`sped?: boolean` を PC 設定にだけ追加。既定 `false`。true のときだけその PC が SPED を使う** |
| `peerConnection.connect()` | `await iceTransport.start()` のあと `await dtlsTransport.start()` | **`sped: false`（既定）ではこの直列起動を維持。`sped: true` の PC だけ ICE check と DTLS handshake を重ねる** |
| browser E2E | `goog-sped-v1` が SDP に出ないことを既に assert | 既定経路は SPED 無効のまま。Chromium SPED は本 Epic の必須ではない |

Epic 1 carrier コメントの「Epic 2 SPED」は古い番号である。**Issue #659 と `epic3-sped-over-ice-detailed.md` を正**とし、SPED は本 Epic 3 の担当とする。

### Epic 境界（何をやらないか）

| 対象外 | 担当 |
| --- | --- |
| `sped: false` の ICE → DTLS 直列起動 | 維持（既定） |
| early server application data、directional SRTP、early RTP/RTCP/SCTP、SNAP、SPED stats、`writeReady` / `peerAuthenticated` / `handshakeComplete` の WebRTC 公開 | Epic 4 |
| **TURN 経由の SPED**（ChannelData / Data Indication 上の埋め込み、TURN 経路の SPED E2E / Pion TURN+SPED） | **本 Epic スコープ外**。既存の SPED 無し ICE TURN は regression として維持 |
| `IceOptions.sped` や `DtlsClient` 公開オプション | しない。有効化は `RTCPeerConnection` / `PeerConfig.sped` のみ |
| `0xC070` / `0xC071` / L1 / L2 / CRC helper を `packages/ice/src/index.ts` や `packages/dtls/src/index.ts` から export | しない |
| ice-server の `ATTRIBUTES` に SPED を known attribute として登録 | しない（comprehension-optional の raw のまま扱う） |
| Chromium `goog-sped-v1` / browser SPED E2E | しない（既定 SDP に出ないことを維持） |
| 未マージの Pion agent SPED（pion/ice#876、pion/dtls#766、pion/webrtc#3362）を完了条件の前提にする | しない。released codec + werift DTLS で boundary を満たす |

### 確定事項（ユーザー回答 + 2026-08-24 時点の最新版確認）

| 項目 | 決定 |
| --- | --- |
| TURN 経由の SPED | **スコープ外**。ChannelData / Data Indication 上の埋め込み、TURN 経路の SPED E2E、Pion TURN+SPED は完了条件に含めない。既存の SPED 無し ICE TURN / TCP-TURN regression は壊さない。TURN 制御 STUN（Allocate 等）に SPED を付けない |
| Pion STUN codepoint | 最新 **pion/stun v3.1.7**（2026-08-18）をピン。`AttrDtlsInStun = 0xC070` / `AttrDtlsInStunAck = 0xC071` は **v3.1.0 以降**（仕様の `v3.1.6` にも既にある）。v3.1.6 固定は使わない |
| Pion ICE codec | 最新 **pion/ice v4.4.1**（2026-08-06）の `sped.go` は **encode/decode のみ**（ACK max 4、big-endian uint32） |
| Pion agent / DTLS endpoint | pion/ice#876（agent insert/process）、pion/dtls#766（packet intercept/inject）、pion/webrtc#3362（WebRTC glue）は **いずれも未マージ**。released Pion に SPED 対応 ICE agent / DTLS inject endpoint は無い。完了条件は **wire codec ↔ werift** と、released Pion ICE を **非 SPED peer** とした fallback。DTLS handshake 完了は **werift DTLS 1.3**。未マージ PR 待ちにしない |
| SPED 有効化 | **Public インターフェースは `RTCPeerConnection` / `PeerConfig.sped` のみ**。既定 `false`。`IceOptions.sped` も `DtlsClient` 公開オプションも作らない。`sped: false` は現行の ICE → DTLS 直列。`sped: true` の PC だけ ICE check と DTLS handshake を重ねる |
| path MTU 上限 | draft §3.3.3 の MUST どおり RFC 8831 の典型 **1200** から Table 1 の STUN overhead を引く。host / srflx の UDP（必要なら TCP ICE の framing）を実装。TURN ChannelData / Data Indication の overhead は SPED MTU の完了条件に含めない。custom raw はさらに減らす MUST。載らないなら送らない（§4.2 step 2） |

---

## 2. 実装すべき具体的な機能や変更内容

仕様書の依存順に従う。各段階でその層のテストが通ってから次へ進む。

### 2.1 STUN attribute の wire order を保持する

対象: `packages/ice-server/src/stun/message.ts`（parse / serialize）。ice は re-export のみ。

現状の serialize 順:

```text
attributesKeys（known） → rawAttributes（unknown 全部が末尾）
```

`appendRawAttribute()` で SPED を足すと `MESSAGE-INTEGRITY` / `FINGERPRINT` より後ろになり、次の **RFC 8489 違反** になる。

- §9: agents MUST ignore all attributes that follow MESSAGE-INTEGRITY（例外は MESSAGE-INTEGRITY-SHA256 と FINGERPRINT のみ）。DATA/ACK が MI の後ろだと **HMAC 対象外かつ受信側が無視する**
- §14.5: HMAC 入力は MI **直前**の attribute まで（Length は MI 末尾まで調整）
- §14.7: FINGERPRINT があるとき MUST be the last attribute
- ICE は RFC 8445 §7.3 で FINGERPRINT 必須

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
- 4-byte padding は RFC 8489 §14（Length は padding 前、padding bit は送信時 0、受信時 ignore）。現行 `paddingLength()` を維持
- HMAC は STUN 規則どおり padding 込みの message に対して計算する
- SPED ACK の CRC-32 は **DATA value のみ**（padding 除外）。draft §3.3.2.2。多項式は RFC 1952 / RFC 8489 FINGERPRINT と同じ IEEE CRC-32。Fingerprint の XOR `0x5354554e` は **付けない**。`crc32c` は使わない

テスト（ice-server および ice の stun テスト）:

- parse → serialize で unknown の相対位置保持
- DATA/ACK が `MESSAGE-INTEGRITY` より前、`FINGERPRINT` が末尾
- DATA value 改ざんで HMAC 検証失敗
- attribute value length 0/1/2/3 byte の padding

注意: RFC 8489 §14 は `0x8000–0xFFFF` を comprehension-optional とする。IANA `0xC070` / `0xC071` はこの範囲。未知 optional は無視（ice-server の 420 は comprehension-required のみ）。SPED を ice-server `ATTRIBUTES` に足すと STUN サーバが解釈し始めるので **足さない**。draft も SDP ice-option を定義しない（§3.3.4）。`goog-sped-v1` は Chromium 独自で本 Epic の WebRTC 配線対象外。

### 2.2 Binding Request の認証境界を修正する

対象: `packages/ice/src/ice.ts` の request 処理、および UDP/TCP/TURN の request 配信。

現状: RFC 8445 §7.3 は Binding request に short-term `MESSAGE-INTEGRITY` を MUST とし、role conflict（§7.3.1.1）は **受理した request** に対する追加手順である。werift は Response だけ二段階 parse し、Request は未認証 Message のまま role conflict まで進む。SPED DATA をこの経路に載せる前に直す必要がある。

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

UDP / TCP の Request 経路を同じ境界にする。TURN 上に届く Binding Request も HMAC 検証は行う（既存 ICE TURN の安全性）が、**TURN 経路の peer Binding に SPED を載せる実装・試験は本 Epic ではしない**。TURN の Allocate/Refresh/ChannelBind など **サーバ制御 STUN** には SPED を付けない。draft §4.2/§4.3 の対象は **STUN Binding Request or Response** のみ。STUN Indication や TURN 制御メソッドは対象外（RFC 8489 の Indication は再送しない）。

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

`packages/ice/src/index.ts` から export しない。**Public な有効化は `RTCPeerConnection` / `PeerConfig.sped` のみ**（§2.12）。`IceOptions` に `sped` を足さない。ice 内部は PC（および ice パッケージ内の codec/session unit）が呼ぶ **package-private** 接続に閉じる。dtls の `src/internal.ts` や既存 `packages/ice/src/internal/selectAddresses.ts` と同様、barrel 非公開。webrtc は ice の barrel 再export（`packages/webrtc/src/imports/ice.ts`）を経由せず internal を deep import し、webrtc の `src/index.ts` からも SPED 内部型を出さない。

### 2.4 DATA / ACK codec

DATA（draft §3.3.2.1）:

- empty（length = 0）: SPED support advertisement。**DTLS へ inject してはならない**（MUST NOT）
- non-empty: **1 attribute = DTLS handshake datagram 1 個**（RFC 9147 §5.1 / RFC 6347 §4.2 の flight packet）。複数 datagram を coalesce しない
- RFC 8489 §14: 同一 type が複数あっても受信は最初の 1 件でよい。送信側は 1 Binding に DATA を 1 つだけ付ける
- 先頭 byte が DTLS でない（**20–63 inclusive 以外**、RFC 9443 §3 / RFC 7983。draft は RFC 9443 を引用）場合、attribute は **SHOULD silently discarded**。本実装は silent drop する。**inject しないし L2 にも載せない**

ACK（draft §3.3.2.2）:

- 受信済み SPED DATA **value** の CRC-32 配列（受信順）。uint32、padding は CRC に含めない
- **empty ACK は合法**（N = 0）
- 件数の上限 4 は draft の **RECOMMENDED** cap（4–20 bytes = header 4 + 0–16）。MUST ではない。Pion `sped.go` は 4 超を `ErrAttributeSizeInvalid` にするため、**本実装は 4 を hard cap** にして interop する
- 5 件目を 1 attribute に入れない（cap 超過は drop / 先頭 4 件。Pion と不一致にしない）
- malformed length（4 の倍数でない、16 bytes 超）は無視（catch-and-ignore で握りつぶさず、検証可能な drop）

CRC:

- `packages/common` の `crc32`（RFC 1952 多項式。RFC 8489 FINGERPRINT と同じ生成多項式）
- SPED ACK は value の CRC-32 **そのもの**。STUN FINGERPRINT の XOR `0x5354554e` は付けない
- `crc32c` は使わない。Pion ベクトルで確定する

### 2.5 SPED session state machine

ICE **generation ごと** に session を持つ。

state: `disabled` | `probing` | `active` | `fallback` | `complete`

内部: L1（未 ACK の current DTLS flight datagram）/ L2（peer へ返す pending CRC、最大 4）/ `roundRobinIndex` / `peerSupport` / `generation` / `carrierMode` / `rttMs` / `mtu`

新 DTLS flight（`onFlightCreated`）:

```text
旧 L1 clear → 新 packet を defensive copy → roundRobinIndex = 0
```

DTLS flight state machine を SPED 側で再実装しない。`createHandshakeDatagram` と同様、callback と内部 cache で Buffer を共有しない。

handshake complete: L1/L2 clear、round-robin reset、`state = complete`（draft §4.1: L1 は新 flight または handshake complete で clear）。

termination:

draft §4.4 は **どちらも MAY**:

- valid ICE candidate pair ができたら SPED を止めて direct DTLS
- handshake 完了まで embedded を続ける（explicit ACK のため）

§3.3.1 も「valid pair のあと embedded でも usual pair でもよい」とする。

**本 Epic の初期プロファイル**（draft が許す選択。MUST ではない）:

- peer が SPED 対応なら **DTLS handshake 完了まで** SPED を継続する
- nomination 成功だけでは direct に切り替えない（carrier mode を決定的にする）
- 切替は `unsupported → fallback`（§3.3.4 / §4.3 step 1）と `handshake complete → complete` のみ

draft §6 の RECOMMENDED「first STUN Binding Response で DTLS timer を再開」は、埋め込み継続中に raw DTLS 再送が二重になる。本プロファイルでは **埋め込み中は external のまま** とし、timer 再開は fallback または complete に限る。

### 2.6 Binding への付加と受信処理

付加対象: **host / srflx**（必要なら TCP ICE）の peer connectivity check Binding Request/Response（ordinary / nomination / triggered / handshake 中 / **consent 中でまだ SPED active なら同様**）。draft §4.2 は SPED active 中の every Binding に DATA を MUST とするが、本 Epic は TURN 経由 SPED を実装しないため **relay pair には付けない**。

非対象: STUN server discovery（`serverReflexiveCandidate`）、TURN control（Allocate 等）、STUN Indication、**TURN 経路の peer Binding**。relay の Binding は SPED support 判定（最初の authenticated STUN に DATA が無いか）に使わない。`sped: true` の完了試験は TURN 無し（host/srflx）で行う。

- L1 が空、または MTU に載らないなら empty DATA を付ける（draft §4.2 step 3）
- L1 が複数なら 1 Binding = 1 datagram。round-robin は **RECOMMENDED**（本実装は round-robin を採用）
- L2 から ACK を載せる（empty ACK 可。本実装は最大 4 CRC）。L2 は STUN loss 対策で **同じ ACK を再送してよい**（§4.1 MAY）
- 送信順は draft §4.2: **ACK を先、DATA を後**（どちらも MI より前）
- 同一 STUN transaction 再送は同じ serialized message（RFC 8489: resend は同じ transaction ID。新しい tx だけ bit-wise identical でなければ新しい ID）

受信（**認証済み** Binding のみ。draft §4.3。§9.1 は ICE USERNAME + MESSAGE-INTEGRITY で埋め込みを認証する）:

```text
最初の authenticated STUN で DATA が無い → unsupported、SPED 終了（§4.3 step 1）
  → ACK 処理（一致 CRC のみ L1 から除去。未知 CRC は ignore）
  → non-empty DATA: demux 検証 → DTLS inject → CRC を L2 へ
```

- empty DATA: inject しない（MUST NOT）。capability は supported
- invalid demux: attribute ごと discard。inject しない、L2 に載せない
- duplicate DATA: DTLS replay（RFC 9147 §4.5.1）に委ねて drop してよい。CRC ACK は duplicate に対して再送してよい（§4.1）

最初の **current-generation authenticated** Binding（generation は ICE restart 用の werift 拡張。draft 本文には generation は無い）:

- DATA あり（empty 含む）→ `supported`
- DATA なし → `unsupported` → fallback（§3.3.4）

SPED CRC ACK と DTLS 1.3 record ACK は完全に別 state。DTLS transcript に混ぜない。

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

draft §6.1 RECOMMENDED は「SPED active 中は内部 DTLS timeout を止め、最初の Binding Response で再開」。埋め込みを handshake 完了まで続ける本プロファイルでは、**最初の Binding Response だけでは internal に戻さない**（STUN 搬送と DTLS RTO が二重になる）。internal 再開は fallback（非 SPED peer）または handshake complete のみ。

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

consent の Binding も SPED active 中は decoration 対象（host/srflx）。discovery / TURN control / TURN 経路の peer Binding は対象外。

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

既存の SPED 無し ICE TURN では、`StunOverTurnProtocol.handleStunMessage(data, addr)` の peer address と ChannelData の peer context を落とさない（regression）。**TURN 経由で SPED DATA を搬送する経路は実装しない。**

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

MTU（draft §3.3.3 Table 1 + RFC 8831 の典型 1200）:

- Binding skeleton（DATA payload 無し）を serialize し、`outer limit - skeleton = max DTLS datagram`。draft は「typical 1200 を expected overhead だけ減らす」を MUST とする
- **outer limit は RFC 8831 の典型 1200**（本 Epic の固定値。経路ごとに実測 path MTU が取れない場合も 1200 を使う）
- Request と Response の小さい方
- Table 1 の項目（host / srflx UDP）: STUN header 20、ICE-CONTROLLED/CONTROLLING 12、PRIORITY 8、USE-CANDIDATE 4（初回以外）、MI 24、MI-SHA256 36（ice2 のときだけ、RFC 8445 §10）、FINGERPRINT 8、DATA header 4、ACK 4–20、USERNAME 16+
- 追加で実装が考慮: IP/UDP framing、TCP ICE を使う場合の TCP framing、STUN 4-byte padding、custom raw attribute（draft: table 外の custom はさらに MTU を減らす MUST）
- TURN XOR-PEER-ADDRESS / ChannelData / Data Indication の overhead は draft Table 1 にあるが、**TURN 経由 SPED はスコープ外**なので SPED MTU 計算の完了条件に含めない
- `carrier.setMtu` を path / selected pair / attribute / ICE restart で更新
- send 直前に最終 STUN サイズが path 上限超なら送らない（draft §4.2 step 2 の「sufficient space」）
- PQC は draft §6.2 で MTU ~900 の実験言及。本 Epic は large certificate / multi-record を DTLS 断片化で扱う

`Connection.restart()`（既に `generation++`、ufrag/password 更新、`userHistory` 追記、checkList/nominated/consent 破棄）に **同時に** SPED atomic reset を入れる:

```text
L1/L2 clear, roundRobinIndex = 0, peerSupport = unknown, state = probing
RTT/MTU/path clear, carrier mode reset
pending direct fallback / pending inject generation invalidation
```

async は captured generation を持ち、不一致なら return。close / DTLS error / handshake complete / ICE failed / fallback でも timer と pending を破棄。

`restart()` は constructor からも呼ばれる（`generation` 初期 -1 → 0）。SPED 未使用時は no-op で既存 ICE テストを壊さないこと。

### 2.11 テストとドキュメント

層テスト（ice / dtls。Public フラグは作らない）:

```text
codec / session / STUN order / HMAC / awaitable inject
```

ice の unit は package-private で session を直接挿してよい。これは `IceOptions.sped` ではない。

werift ↔ werift の **SPED 有効化 E2E** は `RTCPeerConnection` を使う:

```text
new RTCPeerConnection({ sped: true, dtls: { protocolVersions: ["1.3"] } })
```

必須 matrix（仕様 §20.3 から **TURN 経由 SPED を除外**）:

- role 両方向、Full×Full、Full×Lite
- DTLS client/server 両方向
- empty DATA、embedded CH/server flight、CRC ACK
- loss / reorder / duplicate
- non-SPED fallback
- multi-candidate、ICE restart
- large / multi-record flight
- 双方向 application data
- `sped: false` では SPED attribute が付かないこと、ICE → DTLS 直列が維持されること

wire assert（接続成功だけでは不足）:

- SPED active 中に raw DTLS handshake が直接送信されていない
- DATA=`0xC070`、ACK=`0xC071`、どちらも MI より前
- fallback 時 ClientHello bytes が元 flight と完全一致
- ACK 対象 CRC のみ L1 から削除

Pion（2026-08-24 確認。ピンは最新リリース）:

- `PION_STUN_VERSION=v3.1.7`、`PION_ICE_VERSION=v4.4.1`。必要なら `packages/ice/tools/pion-sped/` に install / wrapper / README
- `WERIFT_PION_SPED` で binary path 上書き
- 既存 `pion-turn` と同様、未設定時は skip して default `npm test` を赤くしない。Epic 完了判定では opt-in を実行して green にする
- **wire codec**: empty / non-empty DATA、ACK 1 と 4、padding、codepoint、MI 境界。両方向（pion/stun + pion/ice `sped.go`）
- **released Pion ICE agent**（#876 未マージ）は SPED を出さない → werift の non-SPED fallback（exact same flight）→ werift DTLS 1.3 完了
- Pion 側に released な DTLS inject endpoint は無い（#766 / #3362 未マージ）。handshake 完了の protocol boundary は **werift DTLS 1.3** で満たす
- 未マージの Pion agent SPED を完了条件にしない。実装中にマージされても任意追加であって必須ではない
- codepoint mismatch / malformed ACK / MI failure / attribute order 不一致を catch-and-ignore しない
- TURN + Pion SPED は試験しない

ドキュメント:

- internal SPED draft00 の振る舞い（codepoint、L1/L2、fallback、generation）
- `PeerConfig.sped`（既定 false、PC のみ）
- `packages/ice` に安定スクリプトやディレクトリを足すなら、ルート `AGENTS.md` に従い **パッケージ案内を新設または更新** する（現在 `packages/ice/AGENTS.md` は無い）
- Public API / typedoc を変える場合は `npm run doc:check`（`PeerConfig.sped` 追加は対象）

### 2.12 RTCPeerConnection の SPED オプトイン

対象: `packages/webrtc/src/peerConnection.ts` の `PeerConfig` / `generateDefaultPeerConfig` / `normalizePeerConfiguration` / `clonePeerConfiguration`、`connect()`、`RTCDtlsTransport.start()`、ICE Connection への内部配線。

追加する Public 面はこれだけ:

```ts
export interface PeerConfig {
  // ...既存...
  /**
   * Opt-in SPED (DTLS handshake embedded in ICE Binding).
   * Default false: ICE completes, then DTLS starts (current serial path).
   * true: this PeerConnection only overlaps ICE checks with DTLS 1.3 handshake.
   */
  sped?: boolean;
}
```

- 既定は `generateDefaultPeerConfig()` で `sped: false`
- `clonePeerConfiguration` は spread でコピーされる。boolean なので追加処理は不要だが、欠落させない
- `IceOptions` / `DtlsClient` / `DtlsServer` の公開コンストラクタには出さない
- `dtls.protocolVersions` のコメント「Independent of SPED (this package does not enable SPED)」と README 同趣旨を、本 Epic で更新する。フラグ自体は独立（DTLS 1.3 と SPED は別オプション）だが、本 Epic の完了試験は **`sped: true` + DTLS 1.3** の組み合わせ。`sped: true` で 1.3 が無い場合は接続開始時に失敗させてよい（1.2 default 経路に SPED を載せない）
- Chromium E2E / 既定 `new RTCPeerConnection()` は SPED 無効のまま。SDP に `goog-sped-v1` を出さない

`sped: false`（既定）の `connect()`:

```text
await iceTransport.start()   // connection.connect() 完了まで待つ
await dtlsTransport.start()  // nominated 後の IceTransport.send
```

現行どおり。SCTP 接続もこの後。変更しない。

`sped: true` の `connect()`（この PC だけ）:

```text
ICE Connection に package-private で SPED session / carrier を接続
carrier.setRetransmissionMode("external")
iceTransport.start() と DTLS handshake 開始を重ねる
  （connection.connect() 完了を待ってから DtlsClient.connect() してはいけない）
ClientHello は L1 → Binding Request の DATA
Server flight は await inject 後の同じ Binding Response
ICE nominated と DTLS handshake complete の両方を待つ
handshake complete 後は carrier を internal に戻し、以降の app data は既存 IceTransport.send
```

現状の阻害:

- `RTCIceTransport.start()` は `await this.connection.connect()` まで返す。SPED は check 中に DTLS を動かす必要がある
- `RTCDtlsTransport` の `IceTransport.send` は `ice.send()`（nominated + consent 必須）。SPED active 中の handshake はここを踏まない
- DTLS 生成は `new DtlsClient` / `new DtlsServer`。SPED 用は `createDtlsClientInternal` / `createDtlsServerInternal` と handshake carrier を使う（Public コンストラクタには出さない）

Epic 4 に残すもの: early application data、directional SRTP、early RTP/RTCP/SCTP、SNAP、SPED stats、`writeReady` / `peerAuthenticated` / `handshakeComplete` の WebRTC 公開。**有効化スイッチと ICE/DTLS の重ね合わせ自体は本 Epic。**

### 2.13 推奨コミット順（1 PR 内）

仕様 §25 に合わせ、WebRTC オプトインを足す。各コミットで可能な範囲で build/test を通す。

1. `refactor(stun): preserve ordered attributes`
2. `fix(ice): authenticate binding requests before state updates`
3. `feat(ice): add internal sped draft00 codec and session`
4. `refactor(dtls): make carrier injection awaitable`
5. `feat(ice): bridge dtls handshake carrier with sped`
6. `feat(ice): add source and generation aware datagram context`
7. `feat(ice): integrate sped with connectivity checks and fallback`
8. `feat(ice): synchronize path mtu and rtt with dtls`
9. `feat(webrtc): add PeerConfig.sped opt-in and overlap ICE/DTLS when enabled`
10. `test(ice): add sped codec session and pion wire interop`
11. `test(webrtc): add sped peerconnection e2e`
12. `test: add restart loss reorder regressions`
13. `docs: document sped draft00 and PeerConfig.sped`

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

`checkStart` も consent も `rtt` を秒で入れる。`DirectHandshakeCarrier.updateRtt` と `computeDtlsRtoMs` はミリ秒。変換忘れは RTO が 1000 倍になり危険。テストで `pair.rtt = 0.050` → `carrier.getRtt() === 50` を固定する。

RFC 8489 §6.2.1 の STUN 初期 RTO SHOULD ≥ 500 ms は、ICE が独自の congestion を使う例外を認める。werift の connectivity check 初期待ちは `RETRY_RTO = 50`、consent 下限は `CONSENT_RESPONSE_TIMEOUT_MIN = 500`。**どちらも DTLS RTO に流用しない。** DTLS は RFC 9147（既知 RTT なら `1.5 × RTT`、下限 `MIN_RTO_MS = 100`）。

### DTLS 1.3 の MTU 断片化

`sendHandshakeFlight` は `carrier.getMtu()` で fragment / coalesce する。SPED は STUN 外枠を引いた値を `setMtu` する。large certificate / multi-record は DTLS 側断片化に任せ、SPED は datagram を 1 DATA に 1 個載せる。

### 既存 ICE / WebRTC テスト資産

- Arrange 共通: `packages/ice/tests/utils.ts`（`createTestConnection` / `inviteAccept` / consent harness）
- 既存 TURN: `tests/ice/turn.test.ts`、opt-in Pion TURN（`PION_TURN_HOST`、`scripts/run-pion-turn.sh`）。**SPED 無し regression として維持。SPED E2E には使わない**
- SPED 有効化 E2E の Arrange は webrtc 側の既存 PC テストユーティリティに寄せ、ice の codec/session unit は ice `tests/utils.ts` に寄せる。Act/Assert に日本語コメント（リポジトリのテスト規約）

WebRTC は `packages/webrtc/src/imports/ice.ts` が ice の barrel を再export している。ice `index.ts` に SPED を足すと WebRTC Public に漏れる。webrtc は ice internal を deep import し、`src/index.ts` からは `PeerConfig.sped` 以外の SPED 面を出さない。

### 仕様との対応（draft / RFC vs Epic プロファイル）

| 項目 | 規範 | 本 Epic の扱い |
| --- | --- | --- |
| DATA/ACK type | draft は TBD。IANA `0xC070`/`0xC071` | IANA 値を constants に固定 |
| DATA 必須 | §4.2: SPED active 中の every Binding | 採用。discovery / TURN control / TURN 経路の peer Binding には付けない（TURN SPED はスコープ外） |
| ACK 先・DATA 後 | §4.2 の手順順 | 採用。どちらも MI より前（RFC 8489 §9 / §14.7） |
| ACK cap 4 | RECOMMENDED | Pion 互換のため hard cap 4 |
| empty ACK | 合法 | 許可 |
| invalid demux | SHOULD silent discard（RFC 9443 の 20–63） | silent drop。L2 に載せない |
| termination | §4.4 MAY（pair 成立で direct でも HS 完了まででも） | HS 完了まで SPED 継続 |
| DTLS timer | §6 RECOMMENDED: 最初の Binding Response で再開 | 埋め込み中は再開しない（二重送信防止） |
| fallback | §3.3.4 / §4.3: 最初の authenticated STUN に DATA 無し | 採用。exact same flight bytes は Epic 品質要件 |
| ICE restart / generation | draft に無し。RFC 8445 ICE restart | current generation 以外は SPED/DTLS を更新しない |
| Binding 認証 | RFC 8445 §7.3 MUST short-term MI | 未認証 Request で role/SPED しない |
| 同一 STUN 再送 | RFC 8489 同じ transaction ID / request message | L1 round-robin を再送ごとにやり直さない |
| 有効化 API | draft は SDP ice-option を定義しない | `PeerConfig.sped` のみ。既定 false |

### Pion（2026-08-24 最新版）

| コンポーネント | 最新リリース | SPED の中身 |
| --- | --- | --- |
| pion/stun | **v3.1.7**（2026-08-18） | `AttrDtlsInStun=0xC070` / `AttrDtlsInStunAck=0xC071`。v3.1.0（2026-01-05 の `fbaf0f0`）以降。v3.1.6 にも含まれる |
| pion/ice | **v4.4.1**（2026-08-06） | `sped.go` は codec のみ（AddTo/GetFrom、ACK max 4） |
| pion/ice#876 | **open**（更新 2026-08-17） | agent の insert/process は未リリース |
| pion/dtls#766 | **open**（更新 2026-08-23） | STUN 埋め込み用の intercept/inject は未リリース |
| pion/webrtc#3362 | **open / draft / dirty**（更新 2026-06-03） | WebRTC glue は未リリース |

完了条件: pion/stun v3.1.7 + pion/ice v4.4.1 `sped.go` との **wire codec** 双方向。released Pion ICE agent は非 SPED peer として fallback 試験。DTLS 完了は werift DTLS 1.3。未マージ PR を待たない。codepoint / MI / order 失敗を catch-and-ignore しない。

---

## 4. 考慮すべき制約や注意点

- **既定動作**: SPED disabled / DTLS 1.2 default を維持。`sped` 未指定の `RTCPeerConnection` と opt-in しない `Connection` は現行 ICE とバイト互換に近いこと（wire order 変更は unknown attribute を含むメッセージに限る）
- **draft vs プロファイル**: §4.4 / §6 の MAY・RECOMMENDED を MUST 扱いしない。HS 完了まで埋め込む選択と、埋め込み中に DTLS RTO を再開しない選択は §2.5 / §2.7 に固定する
- **RFC 8489 MI 境界**: DATA/ACK を MI より後に置くと HMAC 対象外かつ受信側が無視する。FINGERPRINT は末尾
- **RFC 8445 §7.3**: connectivity-check Binding は short-term MI 必須。role conflict は認証後
- **Public API**: draft codepoint、L1/L2、CRC、carrier bridge、`IceOptions.sped` を stable export しない。露出するのは `PeerConfig.sped`（既定 false）だけ。`npm run doc:check` で意図しない typedoc 増を検出する
- **WebRTC 配線**: `sped: false` は `connect()` の ICE → DTLS 直列と `RTCDtlsTransport` の nominated `connection.send` を維持。`sped: true` の PC だけ ICE check と DTLS handshake を重ね、handshake 中は `ice.send()` を踏まない。browser E2E は SPED off。draft も SDP ice-option を定義しない
- **認証前 inject 禁止**: unauthenticated または旧 generation の DATA を DTLS に入れない（draft §9.1 + ICE restart）
- **generation と async**: `await inject` の間に `restart()` / `close()` され得る。captured generation で無効化
- **TURN**: SPED 搬送はスコープ外。既存 ICE TURN の HMAC / peer context / 制御 STUN の MESSAGE-INTEGRITY を壊さない。TURN 制御 STUN に SPED を付けない
- **TCP ICE**: `tcpProtocol` の Request も同じ認証境界。TCP framing を host/srflx の MTU に入れる（TURN ではない）
- **anti-amplification**: SPED 経路は `ice-authenticated`。`dtls-cookie` のまま SPED すると HRR/cookie と STUN 埋め込みが競合しうる
- **CRC**: ACK は RFC 1952 CRC-32、Fingerprint XOR なし。padding は CRC に含めない
- **ice-server `npm test`**: vitest のあと `chrome-e2e` まで走る。STUN serialize 変更時は unit を先に通し、known-only メッセージのバイトが変わっていないことを確認してから Chrome harness を見る
- **Pion CI**: 既存 pion-turn 同様 opt-in。完了条件の **wire codec** と non-SPED fallback はフラグ付きで実行する。失敗を skip や catch-and-ignore しない
- **テスト規約**: Arrange は共有 utils、Act/Assert は日本語コメント
- **DTLS 1.3 継承**: `packages/dtls/src/engine/v1_3` にクラス階層を増やさない。inject の Promise 化は既存 function + carrier に閉じる
- **Windows**: 対象外（Unix-like only）

---

## 5. 完了条件

仕様 §26–27 を本リポジトリの検証コマンドに落とし、ユーザー確定事項で TURN SPED と未マージ Pion agent を除外したもの。encode/decode だけでは不足。

### STUN / 認証

- [ ] known / unknown を含む wire order を保持できる
- [ ] SPED DATA / ACK が `MESSAGE-INTEGRITY` より前に serialize され、HMAC 範囲に入る（RFC 8489 §9 / §14.5）。`FINGERPRINT` が末尾（§14.7）
- [ ] Binding Request は USERNAME で credential 選択後に再 parse / HMAC される（RFC 8445 §7.3）
- [ ] 未認証 request は role conflict / filter / SPED / pair state に到達しない
- [ ] old generation authenticated request が current SPED state を更新しない

### SPED draft00

- [ ] DATA=`0xC070`（IANA META-DTLS-IN-STUN）、ACK=`0xC071`（META-DTLS-IN-STUN-ACKNOWLEDGEMENT）、constants 単一モジュール。ice / dtls の Public API 非露出
- [ ] empty DATA advertisement（inject MUST NOT）、non-empty は 1 attribute = 1 datagram
- [ ] ACK は empty 可。本実装は最大 4 CRC / 16 bytes（draft RECOMMENDED cap）。padding を CRC に含めない。Fingerprint XOR なし
- [ ] invalid DTLS demux（先頭 byte が 20–63 以外）は silent drop、L2 に載せない
- [ ] L1/L2 と DTLS ACK state が分離されている
- [ ] SPED active 中の **host/srflx peer Binding** には DATA が必ず付く。送信順は ACK なら ACK → DATA → MI → FP。TURN 経路には載せない

### DTLS carrier

- [ ] 新 flight で L1 が置換され、bytes は defensive copy
- [ ] inject を await でき、同じ Binding Response に server flight を載せられる
- [ ] SPED active 中は DTLS internal RTO が止まり、生 handshake を直接送らない（埋め込み中は最初の Binding Response だけでは internal に戻さない）
- [ ] fallback で internal timer が再開し、current flight を作り直さない（bytes 完全一致）

### ICE routing / fallback / RTT / MTU / lifecycle

- [ ] internal datagram に source / protocol / pair / generation / authenticated がある
- [ ] Public `onData(Buffer)` 互換、raw address だけで association を選ばない
- [ ] pre-nomination handshake は authenticated current-generation pair のみ（host/srflx）。TURN 経由 SPED は実装しない
- [ ] 非 SPED 判定 → exact same flight → handshake → application data
- [ ] `CandidatePair.rtt` 秒 → carrier ミリ秒。connectivity check / selected pair で更新。ICE 500ms consent floor を DTLS RTO に使わない
- [ ] dynamic MTU が RFC 8831 の 1200 − Table 1（host/srflx）+ custom overhead を考慮し、超過 packet を送らない。TURN ChannelData / Data Indication は計算しない
- [ ] restart で L1/L2 / round-robin / RTT / MTU / peerSupport を reset。stale inject 無効。close/error/complete で timer 破棄

### RTCPeerConnection

- [ ] `PeerConfig.sped` が既定 `false`。`IceOptions` / `DtlsClient` に公開しない
- [ ] `sped: false` の `connect()` は ICE → DTLS 直列のまま。Binding に SPED を付けない
- [ ] `sped: true` の PC だけ ICE check と DTLS 1.3 handshake を重ね、handshake が SPED 上で完了する
- [ ] `new RTCPeerConnection({ sped: true })` 同士で werift ↔ werift の SPED + DTLS 1.3 + 双方向 app data が成立する

### werift E2E / Pion / regression

- [ ] 仕様 §20 の werift ↔ werift matrix（role、Lite、loss/reorder、restart、wire assert）。**TURN 経由 SPED は除外**
- [ ] Pion: pion/stun v3.1.7 + pion/ice v4.4.1 `sped.go` の encode/decode 両方向、codepoint と MI 境界。released Pion ICE を非 SPED peer とした fallback。DTLS 完了は werift DTLS 1.3
- [ ] default DTLS 1.2 と SPED disabled ICE を変えていない
- [ ] 既存 ICE TURN / TCP-TURN regression が green（SPED 無し）
- [ ] Epic 1 BoringSSL DTLS 1.3 / OpenSSL DTLS 1.2 interop が green
- [ ] Epic 2 Chromium DTLS 1.2 / 1.3 browser E2E が green（SPED 無効、SDP に `goog-sped-v1` が無い）

### 検証コマンド

段階的に狭い順:

```bash
cd packages/ice-server && npx vitest run --config ./vitest.config.mts && npm run type
cd packages/ice && npm run type && npm test
cd packages/dtls && npm run type && npm test
cd packages/webrtc && npm run type && npm test
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

Pion SPED wire（環境が揃ってから。未設定 skip に頼って完了としない）:

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
RTCPeerConnection({ sped: true })  ↔  authenticated STUN + SPED  ↔  RTCPeerConnection({ sped: true })
werift ICE+SPED                    ↔  werift DTLS 1.3
werift                             ↔  pion/stun v3.1.7 + pion/ice v4.4.1 sped.go  (wire codec)
werift                             ↔  released Pion ICE (no agent SPED)  →  fallback  ↔  werift DTLS 1.3
```

非 SPED peer:

```text
SPED probe → unsupported → same serialized DTLS flight → direct fallback → handshake complete
```

TURN 経由 SPED と未マージの Pion agent/DTLS/WebRTC PR は完了条件に含めない。

Epic 4 は early application data / SNAP / SPED stats / `writeReady` / `peerAuthenticated` / `handshakeComplete` の WebRTC 公開を載せる段階とする。**SPED 有効化と ICE/DTLS の重ね合わせは本 Epic で完了していること。**
