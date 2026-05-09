# タスク詳細化: RFC 8656 TURN over TLS 対応

## 1. タスクの目的と背景

このタスクの目的は、**`packages/ice-server` の Node 参照 TURN サーバ**と、**`packages/ice` の TURN クライアント/ICE 接続処理**に対して、RFC 8656 の **TURN over TLS (TLS-over-TCP)** を追加し、Node 同士・Chrome 同士の双方で **TURN-TLS 経由の DataChannel/データ通信**が成立することを確認できるようにすることです。

調査した現状は以下です。

- `packages/ice` は TURN 制御トランスポートとして **UDP/TCP のみ**対応しています。  
  - `packages/ice/src/iceBase.ts` の `turnTransport?: "udp" | "tcp"`
  - `packages/ice/src/turn/protocol.ts` の `createTurnClient()` も UDP/TCP のみ
- `packages/ice` には `ssl?: boolean` が定義されていますが、**実装では未使用**です。
- `packages/common/src/transport.ts` には `UdpTransport` / `TcpTransport` はありますが、**TLS transport は未実装**です。
- `packages/ice-server` の Sans-IO 層は `StunTransport = "udp" | "tcp" | "tls" | "dtls"` を持っており、**プロトコル型自体は TLS を表現可能**です。
- ただし Node 実装の `NodeTurnServer` は **UDP socket + TCP server のみ**で、`node:tls` を使った TURN-TLS listener はありません。
- Chrome E2E は `turn:` の UDP/TCP しか持たず、`turns:` ケースはありません。

RFC 8656 上も、今回必要なのは **client-server 間のみ TLS-over-TCP** であり、**server-peer 間 relay は引き続き UDP** です（RFC 8656 §3.1）。そのため、既存の TURN allocation / permission / channel の中核ロジックは大きく変えず、**制御トランスポート層の拡張**が主作業になります。

---

## 2. 実装すべき具体的な機能や変更内容

### `packages/ice` 側

- `IceOptions.turnTransport` を **`"tls"` まで拡張**する。
- `createTurnClient()` / `createStunOverTurnClient()` の `transport` を **`"udp" | "tcp" | "tls"`** に拡張する。
- `packages/common/src/transport.ts` に以下のいずれかを追加する。
  - `TlsTransport`
  - または `TcpTransport` を抽象化した **stream transport 共通化**
- `TurnProtocol` の stream 判定を、現在の `transport.type === "tcp"` から、**TCP/TLS 共通で TURN frame を扱える形**にする。
  - `padTurnFrame`
  - `splitTurnTcpFrames`
- `Connection.gatherCandidates()` の TURN candidate 収集で、`turnTransport: "tls"` を指定した場合に **TURN-TLS で relay candidate を取得**できるようにする。
- Node テスト用に、TURN クライアントへ **TLS 接続オプション**を渡せるようにする。
  - 例: `rejectUnauthorized: false` または CA 指定
  - **既定値で検証無効にはしない**

### `packages/ice-server` 側

- `NodeTurnServer` に **TLS listener** を追加する。
  - `node:tls` の `createServer` / `tls.TLSSocket` を利用
  - 証明書/秘密鍵を受け取る API を追加
- 既存の `TCP` と `TLS` は同じポートを共有できないため、`NodeTurnServer` の公開 API を調整する。
  - 例: `address` に加えて `tlsAddress`
  - または `tcpPort` / `tlsPort` を分離
- 現在 `handleTcpChunk()` が `transport: "tcp"` を固定しているため、**TLS でも transport を `"tls"` として流せるように一般化**する。
- `sendClient()` など stream 書き戻し処理を、**TCP/TLS 共通**で扱う。
- 既存の Sans-IO TURN state machine (`src/turn/protocol.ts`) は基本流用し、**Node transport adapter (`src/node/*`) 中心**で対応する。

### テスト

- `packages/ice/tests/ice/turn.test.ts` に **TURN-TLS ケース**を追加し、`ice-server` の TURN-TLS サーバを使って
  - relay candidate を取得できること
  - ICE 接続が relay/relay で成立すること
  - 双方向にデータ通信できること  
  を確認する。
- `packages/ice-server/tests/turn.test.ts` に **Allocate over TLS** の単体/統合テストを追加する。
  - `tls.connect()` で接続
  - 既存の TCP frame reader を流用可能
- `packages/ice-server/chrome-e2e/tests/turn-relay.test.ts` に **TLS ケース**を追加する。
  - `turns:` URL を使う
  - relay-only (`iceTransportPolicy: "relay"`) で接続
  - 双方向の DataChannel 通信を確認
  - `relayProtocol === "tls"` まで確認

### ハーネス/設定/ドキュメント

- `packages/ice-server/chrome-e2e/server/main.ts`
  - TURN-TLS サーバを起動
  - `/config` に `tlsUrl` を追加
- `packages/ice-server/chrome-e2e/tests/fixture.ts`
  - `HarnessConfig.turn.tlsUrl` を追加
- `packages/ice-server/chrome-e2e/vitest.config.mts`
  - Chromium 起動オプションで証明書エラーを無効化
  - 例: `--ignore-certificate-errors`（必要なら `--allow-insecure-localhost`）
- テスト用証明書の扱いを実装前に固定する。
  - **第一候補は repo 内 fixture を同梱**し、OpenSSL など外部 CLI 依存を増やさない
  - 生成コードが必要な場合も、**native module 依存のライブラリは使わず、Node 組み込みまたは pure TypeScript 製ライブラリに限定**する
- `packages/ice/README.md`, `packages/ice-server/README.md`
  - TURN control transport が UDP/TCP/TLS になったことを反映

---

## 3. 技術的な実装アプローチ（調査結果の要約）

### コードベース上の自然な実装方針

1. **Sans-IO コアは極力そのまま**
   - `packages/ice-server/AGENTS.md` でも、状態機械は `src/protocol.ts` / `src/turn/protocol.ts`、Node 依存は `src/node/*` に置く方針です。
   - 今回も中心は **Node adapter の拡張**です。

2. **TLS は TCP と同じ TURN framing を使う**
   - 既存の `padTurnFrame` / `splitTurnTcpFrames` は RFC 8656 の TCP/TLS-over-TCP 向け処理としてそのまま再利用できます。
   - `packages/ice/src/turn/protocol.ts` の TCP 分岐を **stream 分岐**に寄せるのが安全です。

3. **`packages/common` に transport 拡張が必要**
   - `packages/ice` は `TcpTransport` を直接使っているため、TURN-TLS だけ個別実装すると重複しやすいです。
   - `TlsTransport` 追加、または `TcpTransport` を基底化して TLS ソケットにも使える形に寄せるのが自然です。

4. **NodeTurnServer の API は port/address を分ける必要がある**
   - いまの `boundPort` / `address` は UDP/TCP 同番ポート前提です。
   - **plain TCP と TLS は同じ TCP port を共有できない**ため、`tlsAddress` のような別公開面が必要です。

5. **Pion 実装の参考点**
    - Pion は server 側で **外から `tls.Listen(...)` した listener を渡す**構成です。
    - client 側は **TLS connection を張ってから STUN/TURN over stream に包む**構成です。
    - この repo でも同様に、**TLS handshake は transport 層、TURN protocol は既存ロジック流用**が最も整合的です。

6. **テスト証明書の実装方針**
   - Chrome E2E は Playwright 側で証明書警告を回避する前提なので、サーバ証明書は**ローカル test fixture として安定供給**できることが重要です。
   - OpenSSL 実行を前提にすると CI/ローカル差異が増えるため、**fixture 同梱を優先**し、どうしても生成が必要なら **pure TypeScript もしくは Node 組み込み API で閉じる**方針が妥当です。
   - 依存追加が必要な場合は、**native addon を含む TLS/PKI ライブラリは避ける**ことを前提条件にします。

7. **RFC 8656 上の要点**
    - §3.1: client-server は UDP/TCP/TLS-over-TCP/DTLS-over-UDP を使えるが、**server-peer は UDP**
    - §4.1: TURN over TLS では **`turns:` URI を使う**。既定 port は **5349**

---

## 4. 考慮すべき制約や注意点

- **証明書検証を既定で無効化しないこと**
  - Node クライアント側は明示的な test option でのみ自己署名証明書を許可する。
  - Chrome 側はユーザー指定どおり **Playwright の Chromium 起動オプション**で回避する。
- **TCP/TLS の同居設計**
  - 現 API の `address` 1本では表現不足。既存 UDP/TCP 利用者を壊さない設計が必要。
- **既存 UDP/TCP の挙動を壊さないこと**
  - `packages/ice` の既存 TURN over UDP/TCP テスト
  - `packages/ice-server` の既存 TURN unit/integration
  - Chrome E2E の UDP/TCP ケース
- **TLS 対応は TURN control transport のみ**
  - relay candidate の SDP 上の `transport` は引き続き `udp`
  - 確認すべきは TURN 制御経路であり、candidate 自体の transport ではない
- **テスト証明書の扱い**
  - OpenSSL 外部依存を増やさず、repo 内 fixture かコード生成で閉じる方が安定
  - 追加ライブラリが必要でも、**native module 依存は避けて pure TypeScript 製を選定**する
- **公開 API 変更**
  - `turnTransport` の型拡張
  - 必要なら `turnTlsOptions` 等の option 追加
  - README / examples / generated docs への反映を忘れない

---

## 5. 完了条件

以下を満たせば完了です。

1. `packages/ice-server` の Node TURN サーバが **TURN over TLS** を受け付けられる。  
2. `packages/ice` で **`turnTransport: "tls"`** を指定すると、TURN-TLS 経由で relay candidate を取得し、ICE 接続に使える。  
3. `packages/ice/tests/ice/turn.test.ts` で、`ice-server` の TURN-TLS サーバを使い、**ICE peer 同士が relay/relay で接続して双方向にデータ通信できる**。  
4. `packages/ice-server/tests/turn.test.ts` に **Allocate over TLS** の検証が追加される。  
5. `packages/ice-server/chrome-e2e/tests/turn-relay.test.ts` で、Chrome の `RTCPeerConnection` 同士が **`turns:` URL を使って TURN-TLS 経由で DataChannel 通信できる**。  
6. Chrome の証明書問題は **Playwright の Chromium 起動オプション**で解決されている。  
7. テスト証明書の供給方法が **repo 内 fixture または pure TypeScript/Node 組み込みベース**で完結し、OpenSSL や native module 追加に依存しない。  
8. 既存の UDP/TCP TURN テストが維持され、README も UDP/TCP/TLS 対応に更新されている。  
