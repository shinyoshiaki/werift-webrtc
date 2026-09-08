# Epic 4: WARP-enabled WebRTC transport を完成させる

- 親 Issue: [shinyoshiaki/werift-webrtc#659](https://github.com/shinyoshiaki/werift-webrtc/issues/659) / Epic 4
- 実装仕様: リポジトリ直下 `epic4-warp-webrtc-detailed.md`
- 対象ブランチ: `warp`（調査基準 `9200f25512c656521e181ae5a3b49070ee4bfc65`）
- 前提: Epic 1（DTLS 1.3 endpoint）、Epic 2（WebRTC DTLS 1.3）、Epic 3（ICE/SPED carrier）は実装済み
- 主対象: `packages/dtls`、`packages/webrtc`、必要最小限の `packages/ice`

### スコープ境界

- **TURN relay 使用時の WARP は本タスクのスコープ外**とする。relay candidate pair 上での SPED 搬送・WARP 接続成立・early traffic・direct DTLS carrier fallback の新規実装および相互接続検証は、いずれも完了条件に含めない。
- すでに存在する TURN relay 向け WARP/SPED 関連実装を削除する必要はない。
- 本タスクで TURN について求めるのは、`sped: false` の通常の WebRTC TURN relay 経路を回帰させないことだけである。

## 1. タスクの目的と背景

### 目的

既存の DTLS 1.3 と SPED を `RTCPeerConnection` レイヤーで安全に統合し、`sped: true` の接続では ICE connectivity check と DTLS 1.3 handshake を並行して進める。その上で、両 JSEP role における DataChannel・RTP・RTCP の双方向通信、明示 opt-in の server 0.5-RTT outbound、DTLS 1.3 から 1.2 への direct fallback、ICE restart を成立させる。

最重要要件は、DTLS の暗号学的認証と WebRTC の peer 認証を分離し、**SDP fingerprint 検証前には受信 application data、RTP、RTCP を一件も上位へ配送しない**ことである。

### 現状調査で確認した基盤とギャップ

| 領域 | 実装済み | Epic 4 で解消するギャップ |
| --- | --- | --- |
| PC 起動 | `packages/webrtc/src/peerConnection.ts` は `sped: true` で ICE と DTLS を `Promise.all` により並行起動し、`connectEpoch` で古い接続完了を抑止する | readiness、early traffic、transport-local attempt を接続判定へ組み込む |
| SPED | `packages/ice/src/sped/runtime.ts` は generation/session epoch、stale inject rejection、L1/L2・RTT・MTU reset、fallback/abort を持つ | diagnostics と WebRTC 上位 queue/readiness の generation 連動を追加する |
| DTLS 1.3 | server Finished 後に epoch 3 write key が入り、未接続でも送信可能。early app queue は 256 records / 256 KiB に制限済み | `connected` が複数の意味を兼ねる。write/auth/final ACK を個別 milestone にする。queue に retention time がない |
| fingerprint | `RTCDtlsTransport.completeHandshake()` は DTLS `onConnect` 後に `verifyRemoteCertificateFingerprint()` を呼ぶ | DTLS engine の `markConnected()` が `onConnect` の直後に early data を同期 flush するため、fingerprint 検証前に `dataReceiver` へ届き得る |
| SRTP | `updateSrtpSession()` / `startSrtp()` が local/remote keys と media listener を一括有効化する | outbound と inbound の利用許可を分離し、inbound は fingerprint gate 後だけ復号・配送する |
| SCTP | `connectPromise` による多重開始防止がある | initiator と stream ID parity が ICE role 依存。失敗した Promise が残り retry 不能になり得る |
| fallback | DTLS association 自体は `[1.3, 1.2]` の dual-stack ownership を持つ | `startWithSped()` が `spedHandshakeProtocolVersions()` で実質 1.3-only に狭め、SPED から通常 DTLS 1.2 へ commit できない |
| stats | transport/ICE/DTLS/SRTP の標準的な項目がある | WARP/SPED/early queue/retransmission/handshake RTT の read-only diagnostics がない |

### レイヤー境界

```text
RTCPeerConnection          接続試行・ICE/DTLS/SCTP orchestration
  └─ RTCDtlsTransport      SDP fingerprint、application/media release gate
       └─ DtlsSocket       DTLS version selection、暗号学的 readiness
            └─ ICE/SPED    carrier、nomination、ICE generation
```

- SDP の概念は generic DTLS engine に持ち込まない。
- DTLS certificate / CertificateVerify / Finished の検証完了を、SDP fingerprint による WebRTC peer 認証完了と同一視しない。
- SPED wire format、STUN 認証順序、L1/L2 の Epic 3 semantics は変更しない。

## 2. 実装すべき具体的な機能・変更内容

### 2.1 DTLS 1.3 readiness を三段階に分離する

`packages/dtls/src/engine/v1_3` に単調増加する readiness state と一度だけ発火する latch/event を追加する。

```ts
interface DtlsReadiness {
  writeReady: boolean;
  peerHandshakeAuthenticated: boolean;
  handshakeComplete: boolean;
}
```

- `writeReady`: local application traffic key が利用可能で、該当 Finished flight が carrier に渡された状態。
- `peerHandshakeAuthenticated`: peer Certificate、CertificateVerify、Finished を暗号学的に検証済み。SDP fingerprint は含めない。
- `handshakeComplete`: 最終 flight の loss recovery が完了した状態。

milestone の設定位置は次で固定する。

| role | milestone | 設定位置 |
| --- | --- | --- |
| server | `writeReady` | `flight/server/flight4.ts` で server Finished flight 送信と epoch 3 write key install の後 |
| client | `peerHandshakeAuthenticated` | `flight/client/flight5.ts` で server Certificate/CV/Finished 検証成功後 |
| client | `writeReady` | client Finished flight を carrier に渡し、write epoch を 3 にした後 |
| server | `peerHandshakeAuthenticated` | `flight/server/flight5.ts` で client Finished（相互認証時は client cert/CV も）検証成功後 |
| client | `handshakeComplete` | `record-rx.ts` で client final flight の pending records が ACK により全て消えた後 |
| server | `handshakeComplete` | client Finished を含む ACK の送信成功後 |

`DtlsSocket` から internal に以下を待機できるよう bridge する。既に milestone 済みなら即時 resolve し、subscribe 前通過 race を起こさない latch とする。

```ts
waitForWriteReady(): Promise<void>
waitForPeerHandshakeAuthenticated(): Promise<void>
waitForHandshakeComplete(): Promise<void>
```

既存の `connected` / `onConnect` は互換 view として残すが、新規の WebRTC 制御では readiness 判定に使わない。DTLS 1.2 は従来の単一完了点を各 readiness へ対応付け、early semantics は導入しない。

### 2.2 early application data queue を安全な共通部品にする

現在の record 数・byte 数上限を維持し、retention を追加する。

```text
max records: 256
max bytes:   256 KiB
retention:   2 seconds
```

- queue full 時は新しく来た record を drop し、古い record を追い出さない。
- head が期限切れなら queue 全体を破棄する。後続だけを配送して ordered stream を欠損させない。
- overflow/timeout は handshake 自体を失敗させない。
- fingerprint mismatch、invalid CertificateVerify/Finished、fatal alert、close、SPED fallback、未認証中の ICE restart、generation change で必ず queue と timer を破棄する。
- timer は close/abort 後に callback が state を更新しないよう lifecycle disposer に所有させる。

`early-data-buffer.ts` 等の小さな bounded queue に抽出し、DTLS application data と encrypted media の上限・期限・統計を同じ規則で扱える構成を推奨する。

### 2.3 `RTCDtlsTransport` に WebRTC 認証境界を追加する

`packages/webrtc/src/transport/dtls.ts` に WebRTC 側 readiness を保持する。

```ts
interface WebRtcDtlsReadiness {
  writeReady: boolean;
  peerAuthenticated: boolean;
  handshakeComplete: boolean;
}
```

`peerAuthenticated` は次の両方が成立した時だけ true にする。

```text
DTLS peerHandshakeAuthenticated
AND
SDP fingerprint match
```

変更内容:

1. 現在の `dtls.onData -> dataReceiver` 直結を廃止し、`InboundApplicationGate` を挟む。
2. `peerAuthenticated === false` の protected application data は bounded queue に保持する。
3. fingerprint match 後に gate を authenticate し、受信順のまま SCTP へ drain する。
4. fingerprint mismatch 時は gate を abort し、一件も配送せず DTLS を `failed`、SPED を abort、DTLS を close する。
5. `RTCDtlsTransport.state = "connected"` と `start()` の resolve は `peerAuthenticated` 到達時とする。final ACK は待たない。
6. early server outbound 中も public state は `connecting` のままにする。
7. `waitForWriteReady()`、`waitForPeerAuthenticated()`、`waitForHandshakeComplete()` は internal latch とし、上位 orchestration だけで使用する。

### 2.4 early server outbound を明示 opt-in にする

`PeerConfig` / `RTCPeerConnectionConfig` に以下を追加し、clone/getConfiguration 相当の経路では nested object を defensive copy する。

```ts
warp?: {
  allowEarlyServerData?: boolean;
  earlyMediaPolicy?: "drop" | "buffer";
}
```

既定値:

```ts
warp: {
  allowEarlyServerData: false,
  earlyMediaPolicy: "drop",
}
```

- `allowEarlyServerData: true` は `sped: true` かつ DTLS 1.3 を含む設定でのみ許可する。不正な組み合わせは接続開始前に明示エラーにする。
- server の application/SRTP write permission は `peerAuthenticated || (allowEarlyServerData && writeReady)`。
- client は role にかかわらず SDP fingerprint 検証前に application/media を送らない。
- DTLS 1.2 が選択された場合は early mode を自動停止し、legacy path へ移る。

### 2.5 DTLS-SRTP の key install と read/write permission を分離する

`RTCDtlsTransport` で exporter からの session key 生成と利用許可を別状態にする。

```ts
private srtpKeysInstalled = false;
private srtpWriteReady = false;
private srtpReadReady = false;
```

- key material は exporter が利用可能になった時に一度だけ作る。
- outbound SRTP/SRTCP は、通常は `peerAuthenticated` 後、early server opt-in 時だけ server `writeReady` 後に許可する。
- central ICE demux の media listener は一度だけ早期登録し、`srtpReadReady` 前の packet は policy により encrypted のまま drop または buffer する。
- `earlyMediaPolicy: "buffer"` は application queue と同じ 256 packets / 256 KiB / 2 秒上限を適用し、fingerprint match 後に decrypt して `onRtp` / `onRtcp` を発火する。
- fingerprint 不一致や SRTP authentication error では payload を上位へ渡さない。
- DTLS role に基づき local write key と peer read key、peer write key と local read key が一致することをテストする。

### 2.6 SCTP/DataChannel role と開始条件を修正する

`packages/webrtc/src/transport/sctp.ts` の `isServer` が ICE controlling/controlled を参照する実装を廃止し、DTLS role を唯一の基準にする。

```text
DTLS server: SCTP active initiator、DataChannel stream ID は odd
DTLS client: SCTP passive、DataChannel stream ID は even
```

- `setup:active` と `setup:passive` の双方で同じ規則を適用し、ICE role は SCTP role/parity に影響させない。
- early server mode では server `writeReady` 後に SCTP INIT を開始できるようにする。passive 側は gate drain 前に受信可能状態へ arm する。
- `packages/webrtc/src/sctpManager.ts` の `connectPromise` は成功時だけ再利用し、失敗時には `undefined` に戻して fallback/restart 後に retry 可能にする。
- early mode 無効時は従来どおり DTLS peer authentication 後に SCTP を開始する。

### 2.7 SPED + DTLS 1.2 fallback を association level で完成させる

`startWithSped()` が protocol versions を 1.3-only に狭める構造を除去し、`DtlsSocket` を version-selection owner とする。

```text
DtlsSocket [V1_3, V1_2]
  ├─ 1.3 candidate: SPED handshake carrier
  └─ 1.2 candidate: ordinary direct transport
```

- peer が 1.3/SPED 対応なら 1.3 candidate を commit する。
- 非 SPED または 1.2-only peer では SPED を止め、通常 DTLS 1.2 の direct path を commit する。
- 1.2 commit 時に SPED L1/L2、carrier timer、early queue、early send permission を破棄する。
- Epic 3 の direct fallback invariant を維持し、最初に生成した ClientHello flight の同じ `Buffer` を re-serialize せず direct transport へ送る。
- 1.2 engine 自体へ SPED/readiness/early data の意味を持ち込まない。
- TURN relay 使用時の WARP は対象外とし、relay pair 上の SPED embedding、WARP 接続、early traffic、direct DTLS carrier fallback の成立を要求しない。既存実装は削除しなくてよい。

### 2.8 ICE restart と非同期 callback を試行単位で隔離する

既存の `RTCPeerConnection.connectEpoch` と SPED generation guard に加え、`RTCDtlsTransport` が次を持つ。

```ts
interface TransportAttempt {
  id: number;
  iceGeneration: number;
}
```

- readiness event、fingerprint continuation、queue drain、SCTP start、stats 更新の全 callback で current attempt/generation を確認する。
- handshake 中の restart は旧 application/media queue、pending notification、diagnostics、timer を破棄し、SPED runtime を新 generation で reseed する。
- generation N の injected packet が generation N+1 の readiness、DTLS、SCTP、media に影響しないようにする。
- 認証済み DTLS/SCTP association がある状態の ICE restart では association を不用意に作り直さず、新 selected pair の接続を待つ。

### 2.9 WARP diagnostics を stats に追加する

`RTCTransportStats` に将来の標準 field と衝突しにくい `warp*` prefix の optional field を追加する。

```ts
warpSpedState?: "disabled" | "probing" | "active" | "fallback";
warpCarrier?: "direct" | "sped";
warpHandshakeRttMs?: number;
warpDtlsRetransmissions?: number;
warpSpedRetransmissions?: number;
warpEarlyBufferedPackets?: number;
warpEarlyBufferedBytes?: number;
warpEarlyDroppedPackets?: number;
warpEarlyDroppedBytes?: number;
warpEarlyServerSendUsed?: boolean;
iceGeneration?: number;
```

- DTLS には flight 単位の `retransmitCount` と別に association lifetime 累計 `totalRetransmitCount` を追加する。
- SPED runtime にも累計 retransmission と state/carrier の snapshot getter を追加する。runtime 本体は WebRTC public API に export しない。
- `warpHandshakeRttMs` は `peerAuthenticatedAt - handshakeStartedAt` とし、ICE RTT と混同しない。
- stats 取得は read-only snapshot とし、protocol state を変化させない。

## 3. 技術的な実装アプローチ

### 推奨実装順

1. **DTLS readiness**: state/event/latch と role 別 milestone を実装し、DTLS package の既存テストを green にする。
2. **fingerprint gate**: application data の直結を外し、early send をまだ有効化せず「fingerprint 前は配送ゼロ」を先に保証する。
3. **directional SRTP**: key install、write permission、read permission、encrypted media queue を分離する。
4. **SCTP role**: ICE role 依存を除去し、両 JSEP role で DataChannel を成立させる。
5. **early server traffic**: opt-in config と SCTP/RTP/RTCP の server 0.5-RTT outbound を有効化する。
6. **dual-stack fallback**: association carrier ownershipを整理し、1.3/SPED から 1.2/direct への transition を実装する。
7. **generation isolation**: transport attempt を全非同期処理へ伝播し、restart race をテストする。
8. **stats/interoperability**: diagnostics を追加後、外部 interop と全 regression を実行する。

### 主な変更ファイル

| パッケージ | ファイル | 変更の中心 |
| --- | --- | --- |
| dtls | `src/engine/v1_3/connection-base.ts` | readiness、latch、queue timer、累計 retransmission、timestamps |
| dtls | `src/engine/v1_3/flight/server/flight4.ts` | server `writeReady` |
| dtls | `src/engine/v1_3/flight/server/flight5.ts` | server peer handshake auth |
| dtls | `src/engine/v1_3/flight/client/flight5.ts` | client peer handshake auth / `writeReady` |
| dtls | `src/engine/v1_3/record-rx.ts` | final ACK による completion、early queue expiration |
| dtls | `src/engine/v1_3/types.ts` | readiness/retention 定数と型 |
| dtls | `src/socket.ts`、`src/client.ts`、`src/server.ts` | milestone bridge、dual association/carrier ownership |
| webrtc | `src/transport/dtls.ts` | fingerprint/application/media gate、directional SRTP、attempt、stats |
| webrtc | `src/peerConnection.ts` | `warp` config、parallel completion、early SCTP、stale attempt rejection |
| webrtc | `src/secureTransportManager.ts` | 必要な config のみ transport へ伝播 |
| webrtc | `src/transport/sctp.ts` | DTLS role 基準の initiator/parity |
| webrtc | `src/sctpManager.ts` | retry-safe early start |
| webrtc | `src/media/stats.ts` | optional WARP stats |
| ice | `src/sped/runtime.ts` | diagnostics snapshot、累計 counter、generation notification |

DTLS 1.3 engine では `Dtls13Connection extends Dtls13ConnectionBase` の一段継承だけを維持し、flight/record 処理は `Dtls13Host` を受ける関数として追加する。

## 4. 制約・注意点

### Security invariants

- `peerAuthenticated === false` の間は DataChannel message、`onRtp`、`onRtcp` を一件も発火しない。
- client は SDP fingerprint 検証前に application data、SRTP、SRTCP を送信しない。
- early outbound は明示 opt-in された DTLS server だけに許可し、その間も public DTLS state は `connecting` とする。
- fingerprint mismatch、invalid CV/Finished、fatal alert、close/restart では全 pre-auth queue と timer を確実に破棄する。
- SDP fingerprint の知識を `packages/dtls` に導入しない。

### Compatibility invariants

- `sped: false`、`dtls: {}` の既定経路は ICE → DTLS → SCTP の直列、DTLS 1.2 only のまま変えない。
- DTLS role、ICE controlling/controlled、offerer/answerer は独立した軸として扱う。`offerer === DTLS client` を仮定しない。
- `setup:active`（offerer=DTLS server）と `setup:passive`（offerer=DTLS client）をともに扱う。
- Chromium の通常 DTLS 1.3、OpenSSL DTLS 1.2、`sped: false` の通常の TURN relay 経路、既存 WebRTC convenience behavior を回帰させない。
- WPT 固有の厳格化が必要な場合は `packages/webrtc/tools/wpt-runner` 内に閉じ、通常 API へ漏らさない。
- SPED internals、carrier、L1/L2、wire codepoint を public barrel から export しない。`IceOptions.sped` も追加しない。
- TURN relay 使用時の WARP 全般は対象外。これには TURN ChannelData/Data Indication への SPED embedding、relay pair 上の WARP 接続、early traffic、direct DTLS carrier fallback の実装・検証を含む。既存実装の削除は不要。SNAP、PSK 0-RTT、CID、PQ KEX も対象外。

### 外部 interoperability の前提

- 現在の `packages/ice/tools/pion-sped` は released `pion/stun v3.1.7` / `pion/ice v4.4.1` の DATA/ACK codec interop を検証するものに限定される。
- released Pion ICE agent は SPED を送信しないため、`packages/ice/tools/pion-ice-agent` と `packages/webrtc/tests/integrate/sped-pion-ice.test.ts` が現時点で証明できるのは、Pion の非 SPED Binding Response を検出して同一 ClientHello bytes で direct fallbackし、DTLS 1.3 を完了する経路である。
- Pion 同士を含む full SPED agent orchestration（controlling/controlled、Full/Lite、SPED 上の nomination/restart）を完了条件として実行する場合は、agent inject 対応済みの upstream release または再現可能な固定 commit/harness を先に用意する。未提供の外部機能を local mock で代替して interop 完了と扱わない。

### 実装・テスト上の注意

- `Event` だけで readiness を待たず、状態確認付き latch を使ってイベント通過 race を防ぐ。
- queue は encrypted/protected bytes を保持し、認証前に復号済み media を上位へ露出しない。
- final ACK loss は public connected を取り消さず、`handshakeComplete=false` のまま再送を継続する。
- test code は Arrange / Act / Assert の三段階とし、Arrange helper は package 内の単一共通ファイルへ寄せる。Act / Assert には意図が分かる粒度の日本語コメントを付ける。
- public config/stats/Typedoc surface を変更するため、該当 docs/example と生成 docs を更新し `npm run doc:check` を通す。

## 5. 完了条件

### 機能・セキュリティ

- [ ] DTLS 1.3 の `writeReady`、`peerHandshakeAuthenticated`、`handshakeComplete` が role ごとの正しい順序で一度だけ遷移する。
- [ ] `RTCDtlsTransport.start()` は SDP fingerprint 一致後に resolve し、`state` はその時点で `connected` になる。final ACK は resolve 条件にしない。
- [ ] fingerprint mismatch を注入した early DataChannel/RTP/RTCP テストで、上位受信件数がすべて 0 のまま失敗する。
- [ ] application/media queue の records/packets、bytes、2 秒 retention、ordering、overflow、timeout、abort/close/restart cleanup がテストされる。
- [ ] early mode 無効時は `writeReady` だけで送信せず、peer authentication 後に通常送信する。
- [ ] early mode 有効時は DTLS server が public state `connecting` のまま SCTP、RTP、RTCP を送信でき、受信側は fingerprint 検証後にのみ公開する。
- [ ] DTLS client/server の exporter key direction が SRTP/SRTCP の read/write direction と一致する。

### 接続・fallback・restart

- [ ] 2 つの実 `RTCPeerConnection` により、`setup:active` / `setup:passive`、Full×Full / Full×Lite、SPED on/off、1.3 only / `[1.3,1.2]` を parameterize して接続できる。
- [ ] 全 role mapping で DataChannel の open、text/binary、複数 message、bidirectional ordering が成立し、stream ID parity が DTLS role に一致する。
- [ ] RTP/RTCP が双方向に通り、SRTP auth failure、replay、sequence rollover/ROC を安全に扱う。
- [ ] SPED 非対応または DTLS 1.2-only peer に対し、同一 serialized ClientHello flight で direct DTLS 1.2 fallback できる。
- [ ] handshake 中の ICE restart で旧 generation の injected packet、queue、readiness callback が無視される。
- [ ] 認証完了後の ICE restart で既存 DTLS/SCTP が利用可能なまま、新 selected candidate pair と generation に更新される。
- TURN relay 使用時の WARP は完了条件に含めない。既存実装は残してよく、`sped: false` の通常の TURN relay 経路の非回帰のみを検証対象とする。

### 検証コマンド

狭い package validation から順に実行する。

```bash
cd packages/dtls && npm run type && npm test
cd packages/webrtc && npm run type && npm test
cd packages/ice && npm run type && npm test
npm run type
npm run test:small
npm run doc:check
```

外部環境が利用可能な場合は次も完了させる。

```bash
cd packages/dtls && npm run test:boringssl:docker
cd packages/ice && npm run test:pion-sped
cd packages/webrtc && npm run test:pion-ice-agent
npm run install:browsers
npm run e2e
```

- [ ] BoringSSL client/server の DTLS 1.3、CertificateVerify/Finished、application data、exporter、KeyUpdate、negative cases が通る。
- [ ] released Pion の DATA/ACK codec interop と、非 SPED Pion ICE agent に対する同一-flight direct fallback harness が通る。full SPED agent harness が利用可能なら controlling/controlled、Full/Lite、restart も追加で通る。
- [ ] OpenSSL DTLS 1.2 と `[1.3,1.2] -> 1.2`、Chromium の通常 DTLS 1.3、SPED 無効の TURN/E2E が回帰しない。
- [ ] `npm run type`、`npm run test:small`、`npm run doc:check` が成功する。変更がフルスタックに及ぶため、実行可能なら最終的に `npm run ci` も成功する。