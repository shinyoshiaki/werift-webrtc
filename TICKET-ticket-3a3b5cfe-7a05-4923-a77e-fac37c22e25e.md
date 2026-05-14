

## 1. タスクの目的と背景

`packages/ice` は werift の ICE 実装本体で、`packages/webrtc` はそれを `RTCPeerConnection` に接続する層です。今回の目的は、**現在の UDP 前提の ICE 実装を RFC 6544 準拠の ICE-TCP まで拡張し、werift を TCP candidate でも接続可能にすること**です。

現状のコードベースを見ると、以下の状態です。

- `packages/ice/src/candidate.ts` と `packages/webrtc/src/sdp.ts` は `tcptype` の **SDP parse / serialize 自体は既に持っている**
- しかし `packages/ice/src/ice.ts` の candidate gathering は **`StunProtocol` を使った UDP host candidate のみ**
- peer-reflexive candidate 生成も `transport: "udp"` 固定
- `packages/webrtc/src/transport/dtls.ts` は **ICE 上に raw DTLS をそのまま流す前提**で、TCP 用の RFC 4571 framing がない
- `e2e` には `turnRelay` テストがあるが、これは **TURN over TCP/TLS** の検証であり、**ICE-TCP candidate 同士の接続確認ではない**

つまり、**`tcptype` の文字列処理だけ先行実装されており、実際の TCP candidate の gather / pair / check / transport 切替は未実装**です。

---

## 2. 実装すべき具体的な機能や変更内容

### `packages/ice` で必要な変更

- **TCP host candidate gathering**
  - passive candidate 用の listen socket
  - active candidate 用の placeholder candidate
  - 必要なら simultaneous-open (`tcptype=so`) も実装。ただし本当に end-to-end で扱える場合のみ
- **TCP candidate の優先度計算**
  - `tcptype` を local preference に反映
  - UDP 優先 / TCP fallback の方針を priority に反映
- **TCP candidate pairing / pruning**
  - RFC 6544 に従い、少なくとも以下のみ pair 可能にする
    - `active` ↔ `passive`
    - `so` ↔ `so`
  - `active` ↔ `active`、`passive` ↔ `passive` は不許可
  - prune 時に local passive pair を落とす
- **TCP connectivity checks**
  - STUN を送る前に TCP 接続を確立
  - STUN over TCP は **RFC 4571 framing**
  - TCP では STUN retransmission をしない
- **TCP peer-reflexive candidate handling**
  - passive/active 側で incoming connection + STUN により prflx を学習できるようにする
- **接続ライフサイクル**
  - ICE 完了まで candidate gathering/check 用 TCP connection を維持
  - ICE 完了後は selected pair 以外を閉じる

### `packages/webrtc` で必要な変更

- `PeerConfig` / `IceOptions` に **ICE-TCP 有効化設定**を追加  
  既存挙動を壊さないため、`iceUseTcp` のような **明示 opt-in** が妥当
- `RTCIceGatherer` / `SecureTransportManager` から TCP gathering を有効化
- **TCP selected pair 上で DTLS / SCTP / RTP を RFC 4571 framing 付きで流す**
- **必要なら SDP の `a=setup` / `a=connection` を出力**
  - RFC 6544 上、default candidate が TCP のとき必要
- stats / diagnostics で
  - selected pair の `protocol === "tcp"`
  - `tcpType`
  - nominated pair の種別
  を確認可能にする

### `./e2e` で必要な変更

- 既存の `datachannel_turn_relay` と同じパターンで
  - `server/handler/datachannel/iceTcp.ts`
  - `tests/datachannel/iceTcp.test.ts`
  を追加
- E2E では **TURN relay ではなく ICE-TCP candidate が選ばれたこと**を確認する
- 確認項目は最低限:
  - Chrome 側 selected candidate pair の protocol が `tcp`
  - werift 側 nominated pair の local / remote candidate transport が `tcp`
  - DataChannel の双方向通信が通る

---

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### コードベース調査結果

- `packages/common/src/transport.ts` には **outbound 用 `TcpTransport` / `TlsTransport` は既にある**
- ただし **passive TCP candidate 用の listener/server abstraction は無い**
- `packages/ice/src/stun/protocol.ts` は **UDP datagram 前提**
- `packages/ice/src/ice.ts` は host candidate を
  - `candidateFoundation("host", "udp", ...)`
  - `transport: "udp"`
  で固定生成している
- `packages/ice/src/ice.ts` の pairing は `canPairWith()` ベースで、**`tcptype` の組み合わせ制約を見ていない**
- `packages/webrtc/src/transport/dtls.ts` は ICE selected pair の上に **raw DTLS packet** を載せるので、TCP 時には framing 層を追加する必要がある
- 既存の `turnTransport: "tcp" | "tls"` は **endpoint ↔ TURN server 間の transport 指定**であり、**ICE candidate transport を TCP にする機能ではない**

### RFC 調査結果

- **RFC 8445 / RFC 8839**
  - ICE の role/checklist/nomination のベース仕様
- **RFC 6544**
  - ICE-TCP 拡張の本体
  - `transport=TCP` と `tcptype=active|passive|so`
  - active candidate の SDP port は **9**
  - pair 可能なのは **active/passive** と **so/so**
  - TCP check は **先に TCP 接続、その後に STUN**
  - TCP では **STUN retransmission 不要**
  - ICE 完了までは関連 TCP connection を保持
- **RFC 4571**
  - TCP 上の packet framing は **16-bit length prefix**
  - STUN / DTLS / SRTP / SCTP もこの framing 上に流す
- **RFC 4145**
  - default candidate が TCP のとき `a=setup` / `a=connection` が必要
  - ただし TCP connection direction と DTLS handshake role は別概念
- **RFC 8835**
  - WebRTC で TCP を使う場合も **RFC 4571 framing 必須**

### 実装方針として妥当な形

1. `packages/ice` に **TCP host candidate 専用 protocol/listener** を追加  
2. active/passive を先に実装し、`so` は本当に扱える場合のみ追加  
3. TCP candidate が selected pair になったときだけ、`packages/webrtc` 側で RFC 4571 framing を有効化  
4. WebRTC の既定動作は **UDP 優先**、TCP は fallback または opt-in にする  

---

## 4. 考慮すべき制約や注意点

- **TURN/TCP と ICE-TCP を混同しないこと**  
  既存 E2E の `turnRelay` は TURN server までが TCP/TLS なだけで、ICE-TCP の検証ではない
- **既存 API の後方互換性**
  - 現在の werift は UDP 前提で安定しているので、TCP candidate gathering は既定 OFF の方が安全
- **Chromium 実行環境の現実的制約**
  - 仕様上の要件とは別に、ブラウザ実装が JS API に TCP ICE candidate を出さない可能性がある
  - この場合、`./e2e` の「Chromium ↔ werift の ICE-TCP 実通信確認」は**コード不足ではなくランタイム制約で成立しない**
- **TCP listener のリソース管理**
  - interface ごとの port 確保、ICE restart 時の再生成、close 漏れ防止が必要
- **TCP 上の packet demux**
  - UDP と違い packet 境界がないため、RFC 4571 フレーミングの decode/encode が必須
- **テスト規約**
  - この repo では Arrange / Act / Assert と日本語コメントの粒度が求められる

---

## 5. 完了条件

### 実装完了の条件

- `packages/ice` で
  - TCP host candidate を gather できる
  - `tcptype` を考慮した pair/prune/check が動く
  - TCP selected pair で nomination まで完了する
- `packages/webrtc` で
  - ICE-TCP selected pair 上で DTLS/SCTP/DataChannel が動く
  - stats / diagnostics から selected pair が TCP と確認できる
- SDP 上で
  - TCP candidate line が RFC 6544 形式になる
  - 必要な場合 `a=setup` / `a=connection` が整合する

### テスト完了の条件

- `packages/ice` の unit/integration test を追加
  - candidate parse/serialize
  - active/passive pair 成功
  - active/active・passive/passive 不成立
  - TCP check の STUN framing
  - non-selected TCP connection の cleanup
- `packages/webrtc` の test を追加
  - TCP candidate を含む SDP/transport 振る舞い
  - TCP selected pair での DataChannel 通信
- `./e2e` に Chromium ↔ werift の ICE-TCP テストを追加し、
  - **selected candidate pair が TCP**
  - **DataChannel が双方向で通る**
  ことを確認する

### 検証コマンドの目安

1. `cd packages/ice && npm test`
2. `cd packages/webrtc && npm test`
3. `npm run type`
4. `npm run test:small`
5. `npm run e2e`

### 重要な補足

**Chromium 実行環境が TCP ICE candidate を実際に出さない場合、E2E 完了条件はその時点で実行環境依存のブロッカーになります。**  
その場合は、少なくとも以下のどちらかが必要です。

1. Chromium で TCP candidate が出る実行条件を用意する  
2. Browser E2E は TURN/TCP と切り分け、ICE-TCP 自体は non-browser peer 間の統合試験で別検証する

--- 

要するに、このタスクは単なる `tcptype` 追加ではなく、**`packages/ice` の transport abstraction・pairing・check 処理、`packages/webrtc` の DTLS/DataChannel の framing、そして E2E の成立条件整理まで含む中規模のプロトコル拡張**として扱うのが適切です。