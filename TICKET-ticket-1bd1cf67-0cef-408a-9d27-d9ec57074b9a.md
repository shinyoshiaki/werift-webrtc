# TURN サーバーエンドポイント選択を UDP / TCP / TLS でトランスポート準拠にする (#726)

- Issue: https://github.com/shinyoshiaki/werift-webrtc/issues/726
- 関連 PR: #725 `fix(ice): resolve TURN server hostname in the UDP socket's address family`（OPEN・未マージ、外部コントリビュータ @ayushguptax、head `ayushguptax/werift-webrtc:fix/turn-dns-family`、`maintainerCanModify: true`、`Closes #726`）
- **作業方針（確定）**: #725 のブランチ上で作り替える。新規 PR は作らず、#725 の head ブランチにメンテナとしてコミットを積む。**PR のマージおよび #726 のクローズは本チケットの作業範囲に含めない。ユーザーから明示的な指示があるまで実施しない**
- 対象パッケージ: `packages/common`（Transport 契約）, `packages/ice`（STUN/TURN）, `packages/webrtc`（`PeerConfig.turnUdpFamily` の伝搬・docs）

## 1. 目的と背景

TURN クライアントが「実際にリクエストを運ぶトランスポート」とは無関係に、サーバーのホスト名を **リクエストごとに DNS 再解決** している。その結果、次の不具合がある。

| # | 症状 | 原因箇所（現行コード） |
|---|------|------------------------|
| 1 | TURN/UDP でホスト名が AAAA を先に返すと、`udp4` ソケットから IPv6 へ送ろうとして失敗し、STUN 再送スケジュール（`RETRY_RTO=50ms` × 倍々 × `RETRY_MAX=6` ≒ 6.35 s）を浪費してから TCP フォールバックする | `TurnProtocol.request()` が `resolveRequestAddress(addr)`（family `0`）を呼ぶ（`packages/ice/src/turn/protocol.ts`） |
| 2 | #725 の修正案と `StunProtocol.request()` が `UdpTransport` の **private** `socketType` を `unknown as {...}` キャストで読んでいる。カスタム Transport は黙って IPv4 扱いになる | `packages/ice/src/stun/protocol.ts` の `request()` |
| 3 | TCP/TLS は `net.connect()`/`tls.connect()` で接続済みなのに、`TurnProtocol.request()` が再度 DNS を引き、その結果を `Transaction.expectedAddr` にする。実際の接続先と食い違うと正当な応答が「unexpected address」で破棄される | `TurnProtocol.request()` + `Transaction.responseReceived()` の `addressEquals` 判定 |
| 4 | `createTurnClient()` が UDP で常に `udp4` を作るため、IPv6 リテラルの TURN サーバー（`[2001:db8::1]:3478`）に UDP で到達できない。ホスト名で `udp6` を選ぶ手段もない | `createTurnClient()` の `UdpTransport.init("udp4", ...)` |

ゴール: **UDP/TCP/TLS すべてで、トランザクションの相手エンドポイント（送信先＝応答の期待送信元）を「実際にリクエストを運ぶトランスポート」から導出**し、アロケーションの寿命中は 1 つの具体エンドポイントに固定する。

## 2. 現状コード調査結果（develop 時点）

### 2.1 Transport 契約（`packages/common/src/transport.ts`）

```ts
export interface Transport {
  type: string; address: AddressInfo; closed: boolean;
  onData: (data: Buffer, addr: Address) => void;
  send: (data: Buffer, addr?: Address) => Promise<void>;
  close: () => Promise<void>;
}
```

- `UdpTransport`: `private socketType: SocketType` をコンストラクタ引数で保持。受信時、IPv6 の場合は `info.address.split("%")` でゾーン ID を除去。
  - `send()` は `addr[0]` が IP でない場合 `socket.send(..., host)` に任せる（Node 側 DNS）。
- `TcpTransport` / `TlsTransport`: 内部の非公開クラス `StreamTransport` に委譲。`onData` には `[client.remoteAddress, client.remotePort]` を渡す（ゾーン ID 正規化なし）。`send()` は `addr` を無視。`address` は `{}` を返す。
  - `TlsTransport` は `tls.connect({ ...options, host: addr[0], port })` → SNI/証明書検証はホスト名ベース（これを壊さないこと）。
- 他パッケージ: `packages/rtp/src/transport.ts`・`packages/sctp/src/transport.ts` は **別の独自 `Transport` interface** を持ち、本変更の影響外。`packages/dtls` は common の `Transport` を import して使う（追加プロパティを optional にすれば影響なし）。

### 2.2 STUN（`packages/ice/src/stun/`）

- `transaction.ts`
  - `resolveRequestAddress(addr, family: 0|4|6 = 0)`: IP リテラルならそのまま返し、そうでなければ `dns.promises.lookup(host, { family })`。
  - `Transaction.expectedAddr = addr`（コンストラクタ引数）。`responseReceived()` は `addressEquals(expectedAddr, addr)` 不一致なら黙って無視 → 結果的にタイムアウト。
  - `retry()` の送信エラーは `failOnSendError` が true でない限り無視されるため、family 不一致の送信失敗でも全再送を待つ。
- `protocol.ts`（`StunProtocol`）: `transport!: UdpTransport`（型は具象クラス）なのに、`request()` で `(this.transport as unknown as { socketType?: string }).socketType` を読んでいる。

### 2.3 TURN（`packages/ice/src/turn/protocol.ts`）

- `TurnProtocol`
  - `public server: Address` を全リクエストの宛先に使用（ALLOCATE / REFRESH / CREATE_PERMISSION / CHANNEL_BIND / SEND indication / ChannelData）。
  - `request()` で毎回 `resolveRequestAddress(addr)`（family 0）→ ホスト名のままなら毎回 DNS。
  - `requestWithRetry()` は `TransactionFailed`（401/438 等）を受けた時に `this.server = error.addr` で **事後的に** IP に置換している（＝暗黙の pinning）。ただし初回 ALLOCATE 前・401 が返らない経路・アドレス不一致で応答が破棄される経路では機能しない。これを明示的な pinning に置き換える。
  - `sendData()` → `sendStun(indicate, this.server)` / `send(encodeChannelData(...), this.server)` は `Transaction` を介さず `transport.send()` に直接渡す。ホスト名のままだと `UdpTransport.send()` が Node DNS に任せる（family は socket 依存）。
  - `dataReceived()` は stream の場合 `splitTurnTcpFrames` でフレーム分割し、`addr`（stream の remote）をそのまま渡す。
- `StunOverTurnProtocol.request()`: ピア宛（候補 IP）なので `resolveRequestAddress(addr)` は実質ノーオペ。今回の変更対象外だが、TURN サーバー宛ではない点に注意。
- `createTurnClient()` / `createStunOverTurnClient()`: UDP は常に `UdpTransport.init("udp4", { portRange, interfaceAddresses })`。オプション型 `TurnClientOptions` と `createStunOverTurnClient` 側のインラインオプション型が **重複定義** されている（新オプション追加時は両方に追加 or 共通化が必要）。
- 外部参照: `packages/ice/tests/ice/turn-protocol-isolation.test.ts` が `turn.server` を mock 応答の送信元として多用 → `server` の意味を変える場合はテスト追随が必要。public プロパティなので **`server` は「設定値」として残し、具体エンドポイントは別プロパティにする** のが互換性上安全。

### 2.4 呼び出し元

- `packages/ice/src/ice.ts`（`Connection.gatherCandidates` 内）: `createStunOverTurnClient(..., { portRange, interfaceAddresses, transport, tlsOptions, connectTimeoutMs })`。UDP 失敗時に TCP へフォールバック（ここで #1 の ~6.35 s 遅延が発生）。
- `packages/ice/src/iceBase.ts` `IceOptions`: `turnServer`, `turnTransport`, `turnTlsOptions`, `turnConnectTimeout`, `useIpv4`, `useIpv6` 等。UDP family 指定は無し。
- `packages/webrtc/src/secureTransportManager.ts` / `utils.ts`: `iceServers` の `turn:`/`turns:` URL をパースして `turnServer`/`turnTransport` を IceOptions に渡す。
- その他 `createTurnClient` 利用: `packages/ice/examples/turn*.ts`, `packages/ice/tests/ice/turn.test.ts`, `pion-turn.integration.test.ts`, `turn-connect-timeout.test.ts`, `packages/dtls/examples/transport/ice.ts`, `packages/ice-server/chrome-e2e/server/main.ts`。

### 2.5 テスト基盤

- 共通 Arrange: `packages/ice/tests/utils.ts`（`createLocalTurnServer(host, { tls })`, `getLocalTurnClientTlsOptions()` 等）。
- #725（2nd commit 時点）で `packages/ice/tests/utils.ts` に `createRecordingTransport` / `recordSends` / `stubDualStackLookup`（ローテーション対応）等が追加済み。stub は公開メタデータ（`addressFamily` / `remoteAddress`）ベースに改められている。
- `NodeTurnServer`（`packages/ice-server`）は `host` 指定で UDP/TCP/TLS を listen 可能。IPv6 ループバック（`::1`）で起動できるかは要確認（CI で IPv6 不可の場合は skip 条件を付ける）。
- pion TURN: `npm run test:pion-turn --workspace packages/ice`（Docker、opt-in。`PION_TURN_HOST` 未設定時は skip）。

## 3. PR #725 の現状（2026-10-02 時点で調査）

#725 には 2 コミットある。1st commit（`f9cc6058`）は private `socketType` キャストによる暫定修正、2nd commit（`698f4bf8` "pin the TURN server endpoint and take it from the transport"）は、本チケット初版の方針どおりに作り直したもの。CI は未実行（fork PR のため workflow の承認待ち。`statusCheckRollup` は空）。作者の検証は Windows 11 / Node 22.20 だけで、pion TURN の opt-in スイートは未実行。

### 3.1 #725 で実装済み（このまま採用する）

| 項目 | #725 の実装 |
|------|-------------|
| Transport 契約 | `IpAddressFamily = 4 \| 6` を export し、`Transport.addressFamily?` / `Transport.remoteAddress?`（optional）を追加。`UdpTransport.addressFamily` getter、`StreamTransport.remoteAddress` getter（`stripZoneId` 正規化）、`TcpTransport`/`TlsTransport` から委譲。stream の `onData` も同じ `remoteAddress` を渡す |
| STUN | `StunProtocol.request()` のキャストを削除し、`this.transport.addressFamily` を使用 |
| family 不一致 | `resolveRequestAddress(addr, family)` は、逆 family の IP リテラルに対して `AddressFamilyMismatch`（`packages/ice/src/exceptions.ts`、新規）を即座に throw する。family 0 のときはチェックしない |
| endpoint pinning | `TurnProtocol` に `pinnedServerEndpoint` / `serverEndpointSelection`（in-flight を共有し、失敗時は再試行可能にする）、`resolveRequestTarget()` / `serverDestination()` / `resolveServerEndpoint()` を追加。public getter `serverEndpoint` も追加。`requestWithRetry()` の `this.server = error.addr` を削除し、`server` は常に設定値を保つ。SEND indication / ChannelData も固定 endpoint 宛てにした |
| stream | 接続済みの `remoteAddress` を使い、DNS を再解決しない。組み込み TCP/TLS で `remoteAddress` が無ければ Error。カスタム stream transport だけ family 0 lookup にフォールバックする |
| UDP ソケット選択 | `createTurnClient` は `(isIP(address[0]) \|\| udpFamily \|\| 4) === 6 ? "udp6" : "udp4"`（リテラル優先で、矛盾しても黙ってリテラルを採用）。`TurnClientOptions.udpFamily`、`createStunOverTurnClient` のインライン型に `udpFamily`、`IceOptions.turnUdpFamily` を追加し、`ice.ts` から渡す |
| テスト | `tests/ice/turn-dns-family.test.ts`（実 `UdpTransport` を使った family 選択と、不一致時の即時 reject）、`tests/ice/turn-server-endpoint.test.ts`（TCP/TLS で再 lookup しないこと、TLS の hostname 検証、別アドレスからの応答拒否、カスタム stream、UDP pinning（401 再送 / CreatePermission+Send / ChannelBind+ChannelData / Refresh）、AAAA 先頭でも 1 秒未満で allocate、`::1` が使えない環境では skip）。AAA 形式で、Act/Assert に日本語コメントあり |

### 3.2 #725 に残っているギャップ（本チケットで追加する作業）

1. IPv6 リテラルと `udpFamily` が矛盾するときの公開動作が、TSDoc の一文以外に明文化もテストもされていない（→ 4.1）
2. webrtc の `PeerConfig` まで設定が届いておらず、`RTCPeerConnection` 利用者はホスト名の TURN/UDP で IPv6 を選べない（→ 4.2）
3. `createStunOverTurnClient` のインラインオプション型と `TurnClientOptions` が重複したまま（→ 5.3）
4. docs（`packages/ice/README.md`、`npm run doc` の生成物）が未更新（→ 5.5）
5. Linux / macOS の CI と、pion TURN の opt-in での検証が未実施（→ 7）

## 4. 決定事項

### 4.1 IPv6 リテラルと `udpFamily` が矛盾する場合: **リテラルを優先する（エラーにしない）**

- `udpFamily`（`IceOptions.turnUdpFamily` / `PeerConfig.turnUdpFamily`）は「**ホスト名を解決するときの UDP family の希望**」と定義する。サーバーが IP リテラルなら、ソケットの family はリテラルから決め、`udpFamily` は無視する。
  - 例: `udpFamily: 4` と `[2001:db8::1]:3478` → `udp6`。`udpFamily: 6` と `192.0.2.1:3478` → `udp4`。
- 理由:
  - IP リテラルは宛先 family を一意に決める。どの family でソケットを開けば届くかに曖昧さが無いので、希望値より事実を優先するのが自然。
  - `turnUdpFamily` は `IceOptions` / `PeerConfig` にある接続単位の設定で、`iceServers` の URL（signaling や WHIP の Link ヘッダで後から差し替わることがある）とは独立に設定される。ここでエラーにすると、明示的に指定されたサーバーに届かなくなるうえ、`ice.ts` の UDP→TCP フォールバックに飲まれて、原因が見えにくい遅延になる。
  - #725 の既存実装と TSDoc（"An IP literal server address uses its own family."）とも整合し、既存挙動を壊さない。
- 安全網として、`resolveRequestAddress` の `AddressFamilyMismatch` は維持する。利用者が `TurnProtocol` に逆 family の `UdpTransport` を直接渡したケースや、カスタム transport の不整合は、再送に入らず即座にエラーになる（矛盾を黙って握りつぶすのはソケット選択の段階だけ）。
- 実装上の扱い:
  - 1 行の三項式 `(isIP(address[0]) || udpFamily || 4) === 6` は、名前付きの小さなヘルパー（例: `selectTurnUdpSocketType(address, udpFamily): "udp4" | "udp6"`、`turn/protocol.ts` 内の非 export 関数）に置き換え、優先順位（リテラル > `udpFamily` > 4）をコードとコメントで明示する。
  - リテラルによって `udpFamily` が無視されたときは、`debug` ログを 1 行出す（`werift-ice:...` 名前空間、警告は不要）。
  - TSDoc（`TurnClientOptions.udpFamily` / `IceOptions.turnUdpFamily` / `PeerConfig.turnUdpFamily`）に「ホスト名にのみ適用し、IP リテラルでは無視する。既定は 4」と書く。

### 4.2 UDP family 設定の公開範囲: **`TurnClientOptions` → `IceOptions` → webrtc `PeerConfig` まで伝搬する**

| 層 | API | 状態 |
|----|-----|------|
| `packages/ice` TURN | `TurnClientOptions.udpFamily?: 4 \| 6`（`createTurnClient` / `createStunOverTurnClient`） | #725 で実装済み |
| `packages/ice` ICE | `IceOptions.turnUdpFamily?: 4 \| 6` → `ice.ts` の `createStunOverTurnClient` 呼び出し | #725 で実装済み |
| `packages/webrtc` | `PeerConfig.turnUdpFamily: 4 \| 6 \| undefined`（既定 `undefined` = 4） → `SecureTransportManager.createTransport()` の `RTCIceGatherer` オプションに `turnUdpFamily: this.config.turnUdpFamily` を渡す | **本チケットで追加** |

- 理由:
  - `packages/webrtc` が主たる公開 API であり、TURN の非標準ノブ（`turnTransport` / `turnTlsOptions` / `iceTurnConnectTimeout`）は既に `PeerConfig` に並んでいる。`ice` 層で止めると、`RTCPeerConnection` 利用者は IPv6 only 環境でホスト名の TURN/UDP を使えない。
  - 命名は既存の `turnTransport` / `turnTlsOptions` に揃えて `turnUdpFamily` とする。
- スコープ外とするもの:
  - `RTCIceServer` 単位（URL 単位）での指定。W3C 標準の辞書を拡張しない。werift は最初の TURN URL しか使わない。
  - `iceUseIpv4` / `iceUseIpv6` からの自動導出（例: v6 only なら `udp6`）。既存構成の挙動が変わるので、必要になったら別チケットにする。
  - udp4/udp6 の Happy Eyeballs 的なレース。
- `updateIceServers()` / `setIceServers()` はサーバー系フィールドだけを差し替える。`turnUdpFamily` は gatherer 構築時のオプションなので、そちらに渡すだけでよい（`setConfiguration` 後の新しい gatherer には `this.config` 経由で反映される）。

### 4.3 PR #725 の扱い: **#725 のブランチ上で作り替える**

- `gh pr checkout 725` で取得し、追加コミットを #725 の head（`ayushguptax/werift-webrtc:fix/turn-dns-family`）へ push する（`maintainerCanModify: true` で許可されている）。force push はせず、コントリビュータのコミットと著者情報を残す。
- develop へ追従させる（現時点で `MERGEABLE`）作業は本チケットの範囲に含める。ただし **PR のマージ（squash 含む）および #726 のクローズは、ユーザーから明示的な指示があるまで実施しない**。squash マージ時に `Co-authored-by` を付ける点はメモとして残すのみとし、実行はしない。
- 1st commit の暫定実装（private `socketType` キャスト）は 2nd commit で既に置き換わっているので、履歴上残っていても問題ない。
- 追加コミットの内容は PR 本文にも追記する（決定事項 4.1 / 4.2、webrtc への伝搬、docs）。fork PR の CI workflow の承認・実行、およびマージ可否の最終判断はユーザー（メンテナ）が行う。

## 5. 残作業（#725 上に積むコミット）

### 5.1 `packages/ice`: 矛盾ポリシーの明文化

- 4.1 のヘルパーを抽出し、`debug` ログと TSDoc を追加する。

### 5.2 `packages/webrtc`: `PeerConfig.turnUdpFamily` を追加

- `packages/webrtc/src/peerConnection.ts`: `PeerConfig` に TSDoc 付きの `turnUdpFamily: 4 | 6 | undefined` を追加し、既定設定オブジェクト（`turnTransport: undefined` 等が並ぶ箇所）に `turnUdpFamily: undefined` を追加する。
- `packages/webrtc/src/secureTransportManager.ts` `createTransport()`: `RTCIceGatherer` に `turnUdpFamily: this.config.turnUdpFamily` を渡す。
- `packages/webrtc` 側で `IceOptions` 型を再 export・参照している箇所があれば型を追従させる。`packages/webrtc/AGENTS.md` を事前に読むこと。

### 5.3 `packages/ice`: オプション型の重複を解消

- `createStunOverTurnClient` の第 3 引数のインライン型を `TurnClientOptions` に置き換える（フィールドは現状同一）。公開シグネチャ上は互換。

### 5.4 テスト追加

Arrange は `packages/ice/tests/utils.ts`（webrtc 側は `packages/webrtc/tests/utils.ts`）に集約し、Act/Assert に日本語コメントを付ける。

- `packages/ice/tests/ice/turn-server-endpoint.test.ts`（または `turn-dns-family.test.ts`）:
  - `udpFamily: 6` + IPv4 リテラル → `udp4` ソケットで allocate できる（`transport.addressFamily === 4`）
  - `udpFamily: 4` + IPv6 リテラル（`::1`）→ `udp6` ソケット（`::1` が使えない環境では既存と同じ条件で skip）
  - ソケット選択ヘルパーを export しない場合は、`createTurnClient` の戻り値の `transport.addressFamily` で検証する
- `packages/webrtc/tests/transport/ice.test.ts`（既存の `turnTransport` 伝搬テストに倣う）:
  - `new RTCPeerConnection({ turnUdpFamily: 6 })` → `iceTransports[0].connection.options.turnUdpFamily === 6`
  - 未指定 → `undefined`（既定挙動は不変）

### 5.5 docs

- `packages/ice/README.md`: TURN の節に「UDP ソケットの family はリテラルから選ぶ / ホスト名は `udpFamily`（既定 4）」「TCP/TLS は接続先を固定し再解決しない」「TLS の SNI は `tlsOptions.servername` を指定した場合のみ送られる（既存挙動）」を簡潔に追記する。
- `npm run doc` で `doc/interfaces/PeerConfig.md` 等を再生成する。

## 6. 制約・注意点

- **セキュリティ**: `Transaction.expectedAddr` の送信元検証を弱めない。トランザクション ID が一致するだけで受理しない。MESSAGE-INTEGRITY 検証（`parseMessage(data, integrityKey)`）は変更しない。ホスト名の任意の A/AAAA からの応答を受理するようなフォールバックは入れない（#725 はこの方針を満たしている。追加コミットで崩さない）。
- **TLS**: 接続先ホスト名を事前解決した IP に置き換えない（証明書のホスト名検証を維持する）。`remoteAddress` は接続後に読むだけ。SNI の送出条件（`servername` 指定時のみ）は今回変えない。
- **互換性**:
  - `Transport` の新プロパティは optional。メタデータの無いカスタム Transport は従来挙動（family 0 / 再解決）にフォールバックし、IPv4 と決め打ちしない。
  - `TurnProtocol.server` は「常に設定値」に意味が確定する（従来は 401 の後に解決済み IP で上書きされていた）。解決済みの値は `serverEndpoint` で取る。外部から `turn.server` を IP として読んでいた利用者向けに、PR 本文と README に一言書く。
  - `createTurnClient` / `IceOptions` / `PeerConfig` の既定（ホスト名 → `udp4`）は変えない。
  - `rtp` / `sctp` の独自 `Transport` interface は別物なので触らない。`dtls` は common の `Transport` を使うが、optional 追加なので影響は無い。
- **IPv6 ゾーン ID**: `remoteAddress` と `onData` の addr は同じ `stripZoneId` を通すこと（#725 で対応済み。崩さない）。
- **ICE 層**: `ice.ts` の UDP→TCP フォールバックは維持する。
- **環境依存**: `::1` を bind できない CI では IPv6 テストを skip する（#725 の skip 条件を流用）。Windows はサポート対象外（AGENTS.md）なので、Linux / macOS での green を必須とする。
- **AGENTS.md**: テストは Arrange/Act/Assert、Arrange ヘルパーは各パッケージの `tests/utils.ts` に集約、Act/Assert に日本語コメント。根本修正のみとし、テストの握りつぶしは禁止。ice パッケージには個別の AGENTS.md が無いのでルートに従う。webrtc は `packages/webrtc/AGENTS.md` に従う。

## 7. 完了条件

#725 で実装済みの項目（レビューで確認すればよいもの）:

- [ ] STUN / TURN の family 選択に `unknown as { socketType?: ... }` アクセスが無い
- [ ] 組み込み `UdpTransport` が `Transport.addressFamily` で、組み込み `TcpTransport` / `TlsTransport` が `Transport.remoteAddress` で実際の値を公開している
- [ ] TURN/UDP がバインド済みソケットの family でサーバーを解決し、family 不一致は再送を待たずに `AddressFamilyMismatch` で即座に失敗する
- [ ] 1 つの TURN アロケーションは寿命中ずっと 1 つの固定 endpoint を使い、ALLOCATE 再送 / REFRESH / CREATE_PERMISSION / CHANNEL_BIND / SEND / ChannelData で DNS を再解決しない
- [ ] 組み込み TURN/TCP・TURN/TLS は接続後にホスト名を再解決せず、送信元検証に `remoteAddress` を使う。TLS の証明書ホスト名検証は保持されている
- [ ] メタデータを持たないカスタム `Transport` が、黙って IPv4 扱いされない

本チケットで追加する項目:

- [ ] IP リテラルと `udpFamily` が矛盾するとリテラルが優先される（4.1）。ヘルパー化、`debug` ログ、TSDoc、テスト（両方向）がある
- [ ] `PeerConfig.turnUdpFamily` が追加され、`RTCIceGatherer` → `IceOptions.turnUdpFamily` → `createStunOverTurnClient` まで伝搬する。既定は `undefined`（= udp4）で、伝搬テストがある
- [ ] `createStunOverTurnClient` のオプション型が `TurnClientOptions` に統一されている
- [ ] `packages/ice/README.md` を更新し、`npm run doc` の生成物を更新している
- [ ] #725 の PR 本文に追加内容と決定事項（4.1 / 4.2、`TurnProtocol.server` の意味の確定）が追記されている
- [ ] 検証（クロスパッケージかつ public API 変更のため、Linux で実施）:
  - `cd packages/common && npm run type && npm test`
  - `cd packages/ice && npm run type && npm test`
  - `cd packages/webrtc && npm run type && npm test`
  - ルートで `npm run type` と `npm run test:small`
  - `npm run test:pion-turn --workspace packages/ice`（Docker 環境がある場合。UDP/TCP が通ること）
  - #725 の GitHub Actions CI が green であることを確認する（fork PR の workflow 承認はユーザー（メンテナ）が行う。本チケットの作業としては実行しない）
- [ ] 任意: Cloudflare TURN（`turn.cloudflare.com:3478`、UDP、デュアルスタックで AAAA 先頭の環境）で、2nd commit 以降の実装でも UDP で即座に allocate できることを再確認する

**本チケットの完了条件に PR #725 のマージおよび #726 のクローズは含めない。** これらはユーザーが明示的に指示した場合にのみ、別途実施する。
