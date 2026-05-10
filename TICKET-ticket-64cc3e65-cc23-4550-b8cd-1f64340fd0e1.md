まず関連実装と検証経路を洗って、ICE / e2e / RFCの現状から詳細化します。

  │ "**/AGENTS.md"

  │ "controlling|controlled|role
  │ conflict|USE-CANDIDATE|ice-controlling|ice-controlled" in *.{ts,js}
  │ (packages, e2e)

  │ "ICE lite|ice lite|ICELite|lite" in *.{ts,js,md} (packages, e2e)



  │ docs/rfc/rfc8445.txt

  │ packages/ice/package.json

  │ e2e/package.json

  │ packages/ice/src/ice.ts

  │ packages/ice/src/ice.ts

  │ packages/ice/tests/ice/ice.test.ts

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/transport/ice.ts

  │ "remoteIsLite|iceLite|ice-lite|isControlling|role\b|setSelectedPair|nominate
  │ d|USE-CANDIDATE" in *.ts (packages/ice/src, packages/webrtc/src)

  │ "datachannel|DataChannel|RTCPeerConnection|ice-lite|iceLite|iceTransport|chr
  │ ome" in *.{ts,js} (e2e)

  │ packages/ice/src/iceBase.ts

  │ packages/ice/src/ice.ts

  │ /tmp/copilot-tool-output-1778375269472-xexn4c.txt

  │ "2\.5\.  Lite Implementations|5\.2\.  Lite Implementation Procedures|6\.2\.
  │ Lite Implementation Procedures|7\.3\.2\.  Additional Procedures for Lite
  │ Implementations|8\.2\.  Procedures for Lite Implementations|12\.1\.1\.
  │ Procedures for Lite Implementations|17\.3\.  ICE and ICE-Lite|full agent
  │ MUST take the controlling role|lite agent MUST take the controlled role|MUST
  │ NOT initiate connectivity checks|MUST NOT generate connectivity
  │ checks|USE-CANDIDATE" (docs/rfc/rfc8445.txt)

  │ docs/rfc/rfc8445.txt

  │ packages/webrtc/src/secureTransportManager.ts

  │ e2e/server/handler/datachannel/datachannel.ts

  │ e2e/tests/datachannel/datachannel.test.ts

  │ docs/rfc/rfc8445.txt

  │ docs/rfc/rfc8445.txt

  │ docs/rfc/rfc8445.txt

  │ docs/rfc/rfc8445.txt

  │ docs/rfc/rfc8445.txt

  │ e2e/server/fixture.ts

  │ packages/webrtc/src/transport/ice.ts

  │ packages/webrtc/src/sdp.ts

  │ packages/webrtc/tests/issue/141.test.ts

  │ packages/webrtc/tests/issue/142.test.ts

  │ "new RTCIceParameters|iceLite = false|iceParams|iceLite\b|RTCIceParameters"
  │ in *.ts (packages/webrtc/src)

  │ "peerConfig|iceServers|RTCPeerConnection\(|iceLite|connection\.remoteIsLite|
  │ iceControlling" in *.ts (e2e/server, e2e/tests)

  │ packages/webrtc/src/transport/ice.ts

  │ /tmp/copilot-tool-output-1778375298740-sngx2m.txt

I found the ICE-lite hooks and current test paths; next I’m checking whether the public WebRTC config can actually advertise local `a=ice-lite`, because that looks like a likely implementation gap for the e2e side.

  │ packages/webrtc/src/index.ts

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/sdpManager.ts

  │ "remoteIsLite|iceLite|RTCIceParameters\(|localParameters|setLocalRole\(|crea
  │ teOffer\(|createAnswer\(" in *.ts (packages/webrtc/src)

  │ "export interface PeerConfig|type PeerConfig|class RTCPeerConnection|new
  │ RTCIceGatherer\(|iceTransportPolicy|iceServers|bundlePolicy" in *.ts
  │ (packages/webrtc/src)

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/secureTransportManager.ts

  │ packages/ice/tests/ice/ice.test.ts

  │ "createTestConnection|inviteAccept|test_connect_to_ice_lite|remoteIsLite"
  │ (packages/ice/tests/ice/ice.test.ts)

  │ packages/ice/tests/utils.ts

  │ e2e/server/main.ts

  │ e2e/tests/fixture.ts

  │ packages/ice/src/ice.ts

## 1. タスクの目的と背景

このタスクの本質は、**`packages/ice` に「相手が ICE lite」ではなく「自分が ICE lite」として振る舞う経路を追加し、werift を ICE lite サーバーとして Chrome のフル ICE クライアントと相互接続できるようにすること**です。根拠になる RFC 8445 は主に **2.5 / 5.2 / 6.2 / 7.3.2 / 8.2 / 12.1.1 / 17.3** です。

現状のコードベースには **「remote が ICE lite」への部分対応**はありますが、**「local が ICE lite」対応は未完**です。

- `packages/ice/src/ice.ts` は `remoteIsLite` を持ち、`checkStart()` でも `!this.remoteIsLite` を見て挙動を変えています。
- `packages/webrtc/src/peerConnection.ts` と `packages/webrtc/src/secureTransportManager.ts` も **remote SDP に `a=ice-lite` が来たときだけ** controlling に寄せています。
- 一方で `packages/webrtc/src/transport/ice.ts` の `localParameters` は `iceLite` を返しておらず、**ローカル SDP から `a=ice-lite` を広告できません**。
- `packages/ice/tests/ice/ice.test.ts` の `test_connect_to_ice_lite` は、実質 **「full agent が lite remote に接続する」経路**の確認で、**lite local/server** の確認ではありません。
- `e2e` には DataChannel の既存テストはありますが、**ICE lite シナリオは未整備**です。
- さらに `e2e/server/fixture.ts` はデフォルトで STUN を入れており、**ICE lite の host-only 要件と衝突**します。

## 2. 実装すべき具体的な機能や変更内容

### `packages/ice`
- `Connection` / `IceOptions` に **local ICE lite モード**を追加する。
- ICE lite 時は RFC 8445 どおり:
  - **host candidate のみ**を使う
  - **自分から connectivity check を送らない**
  - **STUN client として動かず、STUN server としてだけ応答する**
  - **受信した `USE-CANDIDATE` 付き Binding Request を受理したら候補ペアを nominated / selected にする**
  - **selected pair が確定するまで送信しない**
- 既存の `checkIncoming()` にある peer-reflexive 相当の pair 学習を活かしつつ、**lite 側の nominated 完了条件**を RFC 7.3.2 / 8.2 に合わせる。

### `packages/webrtc`
- `PeerConfig` に **local ICE lite を有効化する設定**を追加する。
- `RTCIceGatherer.localParameters` から `iceLite: true` を返せるようにして、**SDP に `a=ice-lite` を出す**。
- ICE role 決定を **offerer/answerer 依存だけにしない**ように直す。
  - 現状は `setLocalRole()` が基本的に `offer => controlling`, `answer => controlled` で決めており、**local lite が offer を作ると誤って controlling になり得る**。
  - full/lite の組み合わせでは **full が controlling / lite が controlled** を優先する必要があります。
- ICE role 変更が **DTLS role** に波及するため、`packages/webrtc/src/transport/dtls.ts` の自動 role 決定が壊れないことを確認する。

### `packages/ice` のテスト
- **lite server role の local Connection** と **full client role の remote Connection** を 2 Peer で接続し、双方向送受信できるテストを追加する。
- 既存の remote-lite テストとは別に、少なくとも以下を確認する:
  - lite 側が自発的に check を送らない
  - lite 側で nominated pair が incoming `USE-CANDIDATE` により確定する
  - `send()` が selected pair 確定後にだけ成功する
  - full 側は controlling として完了する

### `e2e`
- `e2e/server/handler/datachannel/*` に **werift が ICE lite サーバーとして動く DataChannel シナリオ**を追加する。
- `e2e/server/main.ts` にハンドラを登録する。
- `e2e/tests/datachannel/*` に **Chrome `RTCPeerConnection` ↔ werift ICE lite** の双方向通信テストを追加する。
- lite シナリオ用の server 側 `PeerConfig` は、少なくとも **`iceServers: []` または lite 時に srflx/relay を出さない設定**に分ける。

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

**実装の中心は `packages/ice/src/ice.ts` と `packages/webrtc/src/transport/ice.ts` / `peerConnection.ts` の 3 箇所です。**

1. **ICE lite のコア制御は `packages/ice/src/ice.ts` に入れる**
   - 既存実装は full ICE 前提で `connect()` → checklist 生成 → `schedulingChecks()` → `checkStart()` の流れです。
   - local lite ではこの流れを使わず、**「候補収集して待受」→ incoming check 受信 → pair 確定** の経路を持たせるのが自然です。
   - `checkIncoming()` は既に remote candidate 学習と pair 生成をしているので、lite 用に拡張しやすいです。

2. **local SDP の `a=ice-lite` は `RTCIceGatherer.localParameters` の配線不足が主因**
   - `packages/webrtc/src/transport/ice.ts` は `RTCIceParameters` を返しているのに `iceLite` を埋めていません。
   - ここに local config を通せば、`packages/webrtc/src/sdp.ts` 側はすでに `a=ice-lite` を出力できます。

3. **role バグの本命は `secureTransportManager.setLocalRole()`**
   - 現状は **remote lite を見たときだけ**強制 controlling にします。
   - local lite のときに **controlled 固定**する分岐が無く、offer/answer ベースの role 決定が RFC 8445 6.1.1 とずれます。
   - ここを直さないと ICE が通っても **DTLS/SCTP/DataChannel が開かない**不具合になりやすいです。

4. **e2e 追加は既存 DataChannel パターンの流用で足りる**
   - 既存の `e2e/server/handler/datachannel/datachannel.ts` と `e2e/tests/datachannel/datachannel.test.ts` をベースに、server 側 config だけ lite 用に切り替える構成が最も低リスクです。
   - 追加で stats / SDP を見て **server が `a=ice-lite` を広告していること**を確認できるとデバッグしやすいです。

## 4. 考慮すべき制約や注意点

- **ICE lite は host candidate のみ**です。server 側に STUN/TURN を残すと RFC 5.2 とズレます。
- **lite 側は connectivity check を生成してはいけません**。`Protocol.request()` が lite 側から走らないことを意識して確認する必要があります。
- **controlled 側は `USE-CANDIDATE` を送ってはいけません**。今の `buildRequest()` は守っていますが、lite 側ではそもそも Binding Request 自体を送らない設計が必要です。
- **role 誤判定は DTLS role 誤判定に直結**します。ICE だけでなく DataChannel まで通して見ないと不具合を見落とします。
- **既存の full ICE / remote-lite 対応を壊さないこと**が重要です。特に restart / bundle / shared transport の経路は影響を受けやすいです。
- `e2e` はブラウザ実環境なので、失敗時は以下を優先的に見るべきです。
  - local / remote SDP に `a=ice-lite` が出ているか
  - ICE role が full=controlling, lite=controlled になっているか
  - incoming Binding Request に `USE-CANDIDATE` があるか
  - nominated pair が werift 側で確定しているか
  - DTLS role が噛み合っているか

## 5. 完了条件

1. `packages/ice` で **local ICE lite server** と **full ICE client** の 2 Peer 接続テストが追加され、**双方向通信が成功**する。  
2. lite 側で **host candidate のみ**が使われ、**自発的な connectivity check を送らない**ことが確認できる。  
3. `packages/webrtc` から local SDP に **`a=ice-lite`** を正しく出せる。  
4. full/lite 接続時に **full=controlling / lite=controlled** が成立し、**DTLS/SCTP/DataChannel まで正常動作**する。  
5. `e2e` で **werift-webrtc（ICE lite server）↔ Chrome `RTCPeerConnection`（full client）** の DataChannel 双方向通信テストが追加され、成功する。  
6. 既存の remote-lite 関連テストや通常の DataChannel 経路に回帰がない。  

**要するに、このタスクは「remote-lite 対応の延長」ではなく、`local ICE lite` を public API・SDP・ICE role・e2e まで一気通貫で通す作業です。現状の最大ギャップは `localParameters` に `iceLite` が載らないことと、local lite 時の role / check 抑止が未実装な点です。**