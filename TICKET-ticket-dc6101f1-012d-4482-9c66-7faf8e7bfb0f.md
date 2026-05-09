

## 1. タスクの目的と背景

- `packages/ice-server` は現状、`StunServerProtocol` と `NodeStunServer` を持つ **STUN Binding over UDP** のみの実装です。  
  - `packages/ice-server/src/protocol.ts`
  - `packages/ice-server/src/node/server.ts`
- 一方で `packages/ice` にはすでに **TURN client** があり、`Allocate / Refresh / CreatePermission / ChannelBind / Send / Data / ChannelData` を使う前提で実装されています。  
  - `packages/ice/src/turn/protocol.ts`
  - `packages/ice/src/ice.ts`
- `packages/ice` の TURN client は **TURN over TCP** にも対応済みで、`IceOptions.turnTransport` で `"udp" | "tcp"` を選択できます。サーバー実装も初期スコープから TURN UDP と TURN TCP の両方を扱う必要があります。
  - `packages/ice/src/iceBase.ts`
  - `packages/ice/src/turn/protocol.ts`
- さらに `packages/ice` の STUN codec は `packages/ice-server/src/stun/*` を再利用しており、**`ice-server` 側が STUN/TURN wire format の実質的な source of truth** です。  
  - `packages/ice/src/stun/const.ts`
  - `packages/ice/src/stun/attributes.ts`
  - `packages/ice/src/stun/message.ts`

このため本タスクは、**既存の STUN Sans-IO 設計を TURN に拡張し、その成果物を `packages/ice` の既存 TURN client/ICE 実装で実証する**タスクとして整理するのが適切です。

## 2. 実装すべき具体的な機能や変更内容

| 領域 | 具体的な変更内容 |
| --- | --- |
| TURN プロトコル層 | `packages/ice-server` に `TurnServerProtocol` 相当を追加し、`Binding / Allocate / Refresh / CreatePermission / ChannelBind / Send Indication / Data Indication / ChannelData` を処理する |
| 認証 | RFC 8656 の long-term credential に沿って、`401 Unauthorized + REALM + NONCE`、`438 Stale Nonce`、`MESSAGE-INTEGRITY` 検証を実装する |
| TURN 状態管理 | allocation、permission、channel binding、nonce、lifetime、relay address を保持する Sans-IO 状態管理を追加する |
| relay I/O 抽象化 | プロトコル層は socket を直接触らず、`send` / `bind relay` / `close relay` / `timer` などの action を返す形にする |
| TCP フレーミング | TURN over TCP では RFC 8656 の STUN/TURN framing と 4 byte alignment を処理し、STUN message と ChannelData を同一 TCP stream から復元できるようにする |
| Node.js 参照サーバー | `NodeTurnServer` を追加し、Node `dgram` と `net` を使って UDP/TCP control listener と relay socket 群を管理する |
| 共通 codec | `ChannelData` の encode/decode と TURN 固有 helper を `packages/ice-server` 側へ寄せ、必要なら `packages/ice` から再利用する |
| `packages/ice` 側統合 | `createLocalTurnServer` 的な test helper を追加し、2つの `Connection` が TURN server 経由で双方向通信できるテストを UDP/TCP それぞれで追加する |
| 公開 API / ドキュメント | `packages/ice-server/src/index.ts` と `README.md` を TURN 対応内容に更新する |

### 必須で押さえる RFC 8656 コア範囲

`packages/ice` の現行 client が必要とするのは、まず **UDP relay allocation を TURN UDP/TCP の control transport から利用するコアサブセット**です。`REQUESTED-TRANSPORT` は現行 client と同じく UDP relay を要求しますが、TURN server への接続 transport は UDP と TCP の両方を必須対象にします。

- `Allocate` 成功時に `XOR-RELAYED-ADDRESS / XOR-MAPPED-ADDRESS / LIFETIME`
- `Refresh`
- `CreatePermission`
- `ChannelBind`
- `Send Indication` と `Data Indication`
- `ChannelData`
- `NONCE / REALM / MESSAGE-INTEGRITY / FINGERPRINT`

`packages/ice-server/src/stun/const.ts` と `attributes.ts` にはこれらの多くがすでに存在するため、**wire format の土台はある**状態です。

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 推奨アプローチ

1. **既存 STUN パターンをそのまま TURN に拡張する**
   - 現在の `StunServerProtocol.handleDatagram()` は Sans-IO で `action[]` を返します。
   - TURN ではこれを拡張して、`client packet`、`relay socket packet`、`tcp stream chunk`、`timer event` を入力に含める設計にするのが自然です。
   - TCP は Sans-IO 層で connection ごとの受信 buffer を管理し、STUN message と ChannelData の frame 境界を復元してから共通の TURN handler に渡します。

2. **プロトコル層とサーバー層を明確に分ける**
   - プロトコル層: request 検証、auth、allocation state、permission/channel state、response/action 生成
   - サーバー層: UDP socket / TCP listener 作成、TCP connection lifecycle 管理、relay port bind、受信イベントの feed、timer 実行、action の実 IO 化

3. **`packages/ice` client の期待に合わせる**
   - 初回 `Allocate` は auth なしで飛ぶため、サーバーは `401 + REALM + NONCE` を返す必要があります。
   - retry 後は `username:realm:password` の MD5 key で `MESSAGE-INTEGRITY` を検証する必要があります。これは `packages/ice/src/turn/protocol.ts` の `makeIntegrityKey()` と整合していないと動きません。
   - `turnTransport: "tcp"` の場合、client は TCP stream 上で STUN message と ChannelData を 4 byte alignment 付きで送受信するため、サーバーも同じ frame 処理を行う必要があります。

4. **pion/turn の分割を参考にする**
   - `pion/turn/server.go`
   - `pion/turn/server_config.go`
   - `pion/turn/internal/server/turn.go`
   - `pion/turn/internal/allocation/*`
   
   特に参考になる責務分離は以下です。
   - request handler
   - allocation manager
   - permission / channel binding
   - nonce/auth handler
   - relay address allocator

### コードベース観点の要点

- `packages/ice` には **TURN client 実装はあるが TURN server テストはまだない**
- `packages/ice/tests/utils.ts` には STUN 用の `createLocalStunServer()` があり、**同じ形で TURN 用 helper を作るのが既存構成に合う**
- `packages/ice/examples/turn.ts` と `turn_turn.ts` はすでに **ローカル TURN server を前提にした手動確認用サンプル**として使える
- `packages/ice/src/ice.ts` は `turnTransport !== "tcp"` の場合に UDP 失敗後 TCP へ fallback する経路を持つため、参照サーバーは明示 TCP 指定だけでなく fallback 経路の検証にも使える

## 4. 考慮すべき制約や注意点

- **既存 STUN API を壊さないこと**
  - `NodeStunServer` と `StunServerProtocol` は既存利用があるため、TURN 対応は追加実装に寄せるのが安全です。
- **Sans-IO を崩さないこと**
  - protocol 層で `dgram.createSocket()` や `setTimeout()` を直接呼ばないこと。
- **TURN は open relay にしないこと**
  - `Allocate / Refresh / CreatePermission / ChannelBind` は認証必須。
  - nonce expiry、quota、permission 制御を持つべきです。
- **ICE テストでは TURN 経路を強制する必要がある**
  - host candidate が優先されると TURN を使わずに接続できてしまうため、`forceTurn` などを使って relay pair を通す必要があります。
- **TURN over TCP は初期スコープに含める**
  - 現行 `packages/ice` client は TCP control transport に対応済みなので、サーバーも **UDP control + UDP relay** と **TCP control + UDP relay** の両方で相互接続を成立させる必要があります。
  - relay transport 自体は、現行 client が `REQUESTED-TRANSPORT: UDP` を送るため UDP relay を優先範囲にします。
  - API は将来の TCP relay / TLS / DTLS 拡張を塞がない設計にしておくべきです。
- **TCP connection 単位の状態を混同しないこと**
  - TCP control connection では client address だけで allocation を識別しづらいため、connection id と 5-tuple 相当の識別子を Sans-IO 層へ渡せる設計にする必要があります。
  - TCP stream は任意の境界で分割・結合されるため、1回の `data` event を1メッセージとして扱わないこと。
- **未対応の RFC 8656 拡張は黙殺しない**
  - `REQUESTED-ADDRESS-FAMILY`、`EVEN-PORT`、`RESERVATION-TOKEN` などを初回で全部実装しない場合でも、少なくとも適切な error response を返す設計にするべきです。

## 5. 完了条件

- `packages/ice-server` に **TURN の Sans-IO プロトコル層**と **Node.js 参照サーバー層**が追加されている
- 既存の STUN server 機能が壊れていない
- TURN server が少なくとも以下を処理できる
  - `Binding`
  - `Allocate`
  - `Refresh`
  - `CreatePermission`
  - `ChannelBind`
  - `Send/Data`
  - `ChannelData`
  - `401/438` を含む long-term credential auth
- TURN server が UDP control transport と TCP control transport の両方を受け付け、TCP では STUN message / ChannelData の stream framing を正しく処理できる
- `packages/ice` の 2つの `Connection` が **実装した TURN server を使って relay candidate を取得し、双方向にデータ通信できる**
- その確認が **UDP/TCP それぞれの自動テスト**として追加されている
- `packages/ice-server` と `packages/ice` の README / export が新機能に追従している
- クロスパッケージ変更として最低限、以下の検証対象を満たす前提になっている
  - `cd packages/ice-server && npm run type && npm test`
  - `cd packages/ice && npm run type && npm test`
  - 最終的には `npm run type && npm run test:small`

このタスクは、**`packages/ice-server` を STUN-only から TURN 対応へ拡張し、`packages/ice` の既存 TURN client/ICE 実装と結合して、Sans-IO 設計を維持したままローカル TURN 相互接続を証明する**タスクとして定義するのが最も自然です。
