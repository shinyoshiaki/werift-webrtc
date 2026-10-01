# TURN サーバーエンドポイント選択を UDP / TCP / TLS でトランスポート準拠にする (#726)

- Issue: https://github.com/shinyoshiaki/werift-webrtc/issues/726
- 関連 PR: #725 `fix(ice): resolve TURN server hostname in the UDP socket's address family`（OPEN・未マージ。本チケットはこれを包含・置き換える想定）
- 対象パッケージ: `packages/common`（Transport 契約）, `packages/ice`（STUN/TURN）, 必要に応じて `packages/webrtc`（設定伝搬・docs）

## 1. 目的と背景

TURN クライアントが「実際にリクエストを運ぶトランスポート」とは無関係に、サーバーのホスト名を **リクエストごとに DNS 再解決** している。その結果、次の不具合がある。

| # | 症状 | 原因箇所（現行コード） |
|---|------|------------------------|
| 1 | TURN/UDP でホスト名が AAAA を先に返すと、`udp4` ソケットから IPv6 へ送ろうとして失敗し、STUN 再送スケジュール（`RETRY_RTO=50ms` × 倍々 × `RETRY_MAX=6` ≒ 6.35 s）を浪費してから TCP フォールバックする | `TurnProtocol.request()` が `resolveRequestAddress(addr)`（family `0`）を呼ぶ（`packages/ice/src/turn/protocol.ts`） |
| 2 | #725 の修正案と `StunProtocol.request()` が `UdpTransport` の **private** `socketType` を `unknown as {...}` キャストで読んでいる。カスタム Transport は黙って IPv4 扱いになる | `packages/ice/src/stun/protocol.ts` の `request()` |
| 3 | TCP/TLS は `net.connect()`/`tls.connect()` で接続済みなのに、`TurnProtocol.request()` が再度 DNS を引き、その結果を `Transaction.expectedAddr` にする。実際の接続先と食い違うと正当な応答が「unexpected address」で破棄される | `TurnProtocol.request()` + `Transaction.responseReceived()` の `addressEquals` 判定 |
| 4 | `createTurnClient()` が UDP で常に `udp4` を作るため、IPv6 リテラルの TURN サーバー（`[2001:db8::1]:3478`）に UDP で到達できない。ホスト名で `udp6` を選ぶ手段もない | `createTurnClient()` の `UdpTransport.init("udp4", ...)` |

ゴール: **UDP/TCP/TLS すべてで、トランザクションの相手エンドポイント（送信先＝応答の期待送信元）を「実際にリクエストを運ぶトランスポート」から導出**し、アロケーションの寿命中は 1 つの具体エンドポイントに固定する。

## 2. 現状コード調査結果

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
- #725 では `createRecordingTransport`（private `socketType` を模した stub）と `stubDualStackLookup`（`vi.spyOn(dns.promises, "lookup")`）を追加している。今回は stub が `socketType` ではなく **公開メタデータ（`addressFamily`）** を持つ形に改め、`stubDualStackLookup` は「呼び出し回数ごとに異なる IP を返す」ローテーション版も用意する。
- `NodeTurnServer`（`packages/ice-server`）は `host` 指定で UDP/TCP/TLS を listen 可能。IPv6 ループバック（`::1`）で起動できるかは要確認（CI で IPv6 不可の場合は skip 条件を付ける）。
- pion TURN: `npm run test:pion-turn --workspace packages/ice`（Docker、opt-in。`PION_TURN_HOST` 未設定時は skip）。

## 3. 実装内容

### 3.1 `packages/common`: Transport に明示的なエンドポイントメタデータを追加

```ts
export type IpAddressFamily = 4 | 6;

export interface Transport {
  // 既存 ...
  /** ローカル datagram ソケットのアドレスファミリー（UDP 系のみ）。 */
  addressFamily?: IpAddressFamily;
  /** 接続型トランスポートで実際に接続しているピア。未接続/非接続型は undefined。 */
  remoteAddress?: Address;
}
```

- **optional** で追加（既存のカスタム Transport を TS 破壊的変更にしない）。
- `UdpTransport`: `get addressFamily(): IpAddressFamily { return this.socketType === "udp6" ? 6 : 4; }`。`socketType` は private のまま。
- `StreamTransport`: `get remoteAddress(): Address | undefined` を追加（`client.remoteAddress`/`remotePort` が揃っている時のみ）。IPv6 ゾーン ID は UDP 受信経路と同じ規則（`split("%")[0]`）で正規化し、**`onData` に渡す addr にも同じ正規化を適用** して両者を必ず一致させる（共通ヘルパー化推奨）。
- `TcpTransport` / `TlsTransport`: `remoteAddress` を `stream` へ委譲。
- `IpAddressFamily` は `transport.ts` で export すれば `packages/common/src/index.ts` の `export * from "./transport"` 経由で公開される。

### 3.2 `packages/ice`: TURN サーバーエンドポイントの選択と固定

- `TurnProtocol` に具体エンドポイントを保持する private フィールド（例: `private serverEndpoint?: Address`）と、選択処理 `private async resolveServerEndpoint(): Promise<Address>` を追加。`public server` は設定値として残す（互換性維持）。
- 選択ロジック（初回に 1 度だけ実行し、以降はキャッシュ）:
  - **stream（tcp/tls）**:
    - `transport.remoteAddress` があればそれを使う（DNS 再解決しない）。
    - 組み込み `TcpTransport`/`TlsTransport` で `init()` 完了後に無い場合は不変条件違反として明示的エラー。
    - `remoteAddress` を持たないカスタム stream transport のみ、従来どおり `resolveRequestAddress(server, 0)` にフォールバック（コメントで互換用と明記）。
  - **UDP**:
    - `family = transport.addressFamily ?? 0`（メタデータ無しのカスタム Transport は従来の family 0 挙動を維持し、IPv4 と決め打ちしない）。
    - `server[0]` が IP リテラルで `isIP()` の結果と `addressFamily` が食い違えば、**即座に** 説明的なエラー（例: `TURN server 2001:db8::1 is IPv6 but UDP transport is IPv4`）を throw。再送タイムアウトに入らないこと。
    - それ以外は `resolveRequestAddress(server, family)`。
- `request()` で宛先が設定上のサーバー（`server` もしくは選択済み endpoint）の場合は固定エンドポイントを使い、**再解決しない**。宛先引数の扱いは以下いずれかで設計し、PR で明記する:
  - (推奨) 内部呼び出し（`connectionMade` / `refresh` / `createPermission` / `channelBind` / `requestWithRetry`）を `this.server` ではなく固定エンドポイント取得経由に統一する。
  - `requestWithRetry()` 内の `this.server = error.addr` は削除し、固定エンドポイントに一本化（エラー応答の送信元は `expectedAddr` と一致済みなので情報は失われない）。
- `sendData()` の SEND indication / ChannelData の宛先も固定エンドポイントへ。
- `Transaction.expectedAddr` は UDP なら選択済み具体エンドポイント、TCP/TLS なら `transport.remoteAddress` と完全一致させる。`addressEquals` の検証自体は弱めない。
- 対象リクエスト: ALLOCATE / 認証付き ALLOCATE 再送 / REFRESH / CREATE_PERMISSION / CHANNEL_BIND / SEND indication / ChannelData。

### 3.3 `packages/ice`: STUN の private フィールド参照を除去

- `StunProtocol.request()` の `unknown as { socketType?: string }` キャストを削除し、`this.transport.addressFamily` を使う。`transport` は組み込み `UdpTransport` なので family は必ず確定する。
- 可能なら「family 選択 + リテラル不一致チェック」を `stun/transaction.ts` 付近の共通ヘルパー（例: `resolveRequestAddressForTransport(addr, family)`）にまとめ、STUN と TURN/UDP で同一ルールを使う。

### 3.4 `createTurnClient()` で互換 UDP ソケットを選択

- `TurnClientOptions` に `udpFamily?: 4 | 6` を追加（`createStunOverTurnClient` のインライン型にも追加、もしくは `TurnClientOptions` を再利用して重複を解消）。
- 選択規則:
  - `isIP(address[0]) === 4` → `udp4`、`=== 6` → `udp6`（リテラルが優先。`udpFamily` と矛盾する場合はエラーにするか、リテラル優先で明記）。
  - ホスト名 → `udpFamily ?? 4`（既定は従来どおり IPv4）。
- 上位設定への伝搬（任意だが推奨）: `IceOptions` に `turnUdpFamily?: 4 | 6` 等を追加して `ice.ts` の `createStunOverTurnClient` 呼び出しに渡す。既定値は変えない。webrtc の `RTCConfiguration` まで出すかは別判断（出す場合は docs も更新）。
- Happy Eyeballs 的な udp4/udp6 レースは **スコープ外**。

### 3.5 docs / examples

- `packages/ice/README.md` の TURN 説明に IPv6 / `udpFamily` の記述を追加。
- public API（`Transport` の新プロパティ、`TurnClientOptions.udpFamily`、IceOptions 追加分）は TSDoc コメントを付け、必要に応じ `npm run doc` 対象を更新。

## 4. テスト計画

Arrange 用ヘルパーは `packages/ice/tests/utils.ts` に集約し（AGENTS.md 準拠）、Act/Assert には日本語コメントを付ける。

### 4.1 UDP family（新規: 例 `packages/ice/tests/ice/turn-endpoint-family.test.ts`）

可能な限り実 `UdpTransport`（`UdpTransport.init("udp4"|"udp6")`）のメタデータを使う。DNS は `vi.spyOn(dns.promises, "lookup")` で stub。

- udp4 + デュアルスタックホスト名 → lookup family 4、送信先 IPv4
- udp6 + デュアルスタックホスト名 → lookup family 6、送信先 IPv6
- udp4 + IPv4 リテラル → DNS 呼び出しなし
- udp6 + IPv6 リテラル → DNS 呼び出しなし
- udp4 + IPv6 リテラル → 即時に family 不一致エラー（タイムアウト待ちしない）
- udp6 + IPv4 リテラル → 即時に family 不一致エラー
- `addressFamily` を持たないカスタム UDP Transport → family 0 で lookup（4 に強制しない）
- `StunProtocol.request()` も `addressFamily` に従う（既存 STUN テストがあれば拡張）

### 4.2 stream エンドポイント同一性

- TCP: ローカル `NodeTurnServer`（`createLocalTurnServer("127.0.0.1")`）に接続し、`transport.remoteAddress` が実ピアと一致、接続後の `TurnProtocol.request()` で DNS lookup が呼ばれない
- TLS: 同上（`tls: true`、`getLocalTurnClientTlsOptions()`）。SNI/hostname 指定が保持されること（`tls.connect` の `host` がホスト名のまま）
- 2 回目の lookup が別 IP を返すよう stub しても、接続ピアからの正当な応答は受理される
- 別アドレスからの応答は引き続き拒否される（`Transaction.responseReceived` の検証維持）

### 4.3 アロケーション endpoint pinning

DNS stub を「呼ぶたびに異なる IP を返す」ようにし、最初に選択された endpoint から以下が動かないこと・DNS が再度呼ばれないことを検証:

- 認証付き ALLOCATE 再送（401 → retry）
- REFRESH（`channelRefreshTime` / lifetime を短くして発火させるか、フェイクタイマー）
- CREATE_PERMISSION / CHANNEL_BIND
- SEND indication / ChannelData の送信先

### 4.4 結合・回帰

- 既存: `turn.test.ts`, `turn-protocol-isolation.test.ts`, `turn-protocol-lifecycle.test.ts`, `turn-connect-timeout.test.ts`, `consent-wire.test.ts`, `setIceServers.test.ts`, `stun/*.test.ts` が green
- `turn-protocol-isolation.test.ts` は `turn.server` を mock 応答元にしているため、固定 endpoint 導入後の整合を確認
- IPv6 ループバック（`::1`）の TURN/UDP テストを追加し、IPv6 不可環境では skip
- デュアルスタックホスト名（AAAA 先頭）で UDP が ~6.35 s のタイムアウトを経ずに成功する（または family 不一致が即時失敗して TCP フォールバックが速い）ことを検証
- pion TURN interop（opt-in）: `npm run test:pion-turn --workspace packages/ice` で UDP/TCP が通ること

## 5. 制約・注意点

- **セキュリティ**: `Transaction.expectedAddr` の送信元検証を弱めない。トランザクション ID 一致だけで受理しない。MESSAGE-INTEGRITY 検証（`parseMessage(data, integrityKey)`）は変更しない。ホスト名の任意の A/AAAA からの応答を受理するようなフォールバックは追加しない。
- **TLS**: 接続先ホスト名を事前解決 IP に置き換えない（SNI・証明書ホスト名検証を維持）。`remoteAddress` はあくまで接続後に読むだけ。
- **互換性**:
  - `Transport` の新プロパティは optional。メタデータ無しのカスタム Transport は従来挙動（family 0 / 再解決）にフォールバックし、IPv4 と決め打ちしない。組み込み Transport は常にメタデータを提供し、本番経路でフォールバックに入らないこと。
  - `TurnProtocol.server` は public。意味（設定値）を保つか、変える場合は CHANGELOG/docs とテストを同時更新。
  - `createTurnClient` の既定（ホスト名 → `udp4`）は変えない。
  - `rtp` / `sctp` の独自 `Transport` interface は別物なので触らない。
- **IPv6 ゾーン ID**: `remoteAddress` と `onData` の addr の正規化を揃えないと `addressEquals` が不一致になる。
- **ICE 層の挙動**: `ice.ts` の UDP→TCP フォールバックは維持。family 不一致の即時エラーで TCP フォールバックが速くなることを確認。
- **PR #725 との関係**: #725 の `serverLookupFamily()`（private キャスト）とテスト stub（`socketType` 模倣）は本チケットの方針と矛盾するため、#725 をクローズして本チケットで置き換えるか、#725 ブランチ上で本方針に作り替える。マージ順の調整が必要。
- AGENTS.md: テストは Arrange/Act/Assert、Arrange ヘルパーは `packages/ice/tests/utils.ts` に集約、Act/Assert に日本語コメント。根本修正のみ（テストの握りつぶし禁止）。ice パッケージには個別 AGENTS.md が無いのでルート AGENTS.md に従う。

## 6. 完了条件

- [ ] STUN / TURN の family 選択で `unknown as { socketType?: ... }` アクセスが無い
- [ ] 組み込み `UdpTransport` が公開契約（`Transport.addressFamily`）でアドレスファミリーを公開している
- [ ] 組み込み `TcpTransport` / `TlsTransport` が `Transport.remoteAddress` で実接続ピアを公開している
- [ ] TURN/UDP がバインド済みソケットの family でサーバーを解決する
- [ ] TURN/UDP で IPv6 リテラルが `udp6` ソケットで利用できる（`createTurnClient` がリテラルから family を選択）
- [ ] ホスト名で IPv6 UDP を明示選択できるオプション（`udpFamily` 等）がある。既定は IPv4 のまま
- [ ] family 不一致は STUN 再送を待たずに即時エラーになる
- [ ] 1 つの TURN アロケーションは寿命中 1 つの固定エンドポイントを使い、ALLOCATE 再送 / REFRESH / CREATE_PERMISSION / CHANNEL_BIND / SEND / ChannelData で DNS を再解決しない
- [ ] 組み込み TURN/TCP・TURN/TLS は接続後にホスト名を再解決しない
- [ ] stream のトランザクション送信元検証が実接続ピア（`remoteAddress`）を使う
- [ ] TLS の SNI / 証明書ホスト名検証の挙動が保持されている
- [ ] メタデータを持たないカスタム `Transport` が黙って IPv4 扱いされない
- [ ] 上記 4.1〜4.3 のユニットテストと 4.4 の結合テストが追加され、既存 TURN/STUN テストが green
- [ ] 検証コマンド（クロスパッケージ・public API 変更のため）:
  - `cd packages/common && npm run type && npm test`
  - `cd packages/ice && npm run type && npm test`
  - `npm run type` と `npm run test:small`（ルート）
  - 可能なら `npm run test:pion-turn --workspace packages/ice`
- [ ] `packages/ice/README.md` 等の docs、追加 public API の TSDoc を更新
