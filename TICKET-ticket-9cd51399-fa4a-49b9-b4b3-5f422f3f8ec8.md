

# 1. タスクの目的と背景

`packages/ice-server` と `packages/ice` には、すでに **TURN の udp/tcp/tls 実装** と **TLS クライアント経路** が存在します。具体的には `packages/ice-server/src/node/turnServer.ts` は UDP/TCP/TLS の TURN サーバを起動でき、`packages/ice/src/ice.ts` と `packages/ice/src/turn/protocol.ts` は `turnTransport: "udp" | "tcp" | "tls"` と `turnTlsOptions` を扱えます。

一方で、`packages/webrtc` の公開 API 側ではその能力が十分に表に出ていません。`parseIceServers` は `turn:` しか見ておらず `turns:` を解釈できず、`SecureTransportManager` も `forceTurnTCP` で `udp/tcp` しか切り替えていません（`packages/webrtc/src/utils.ts:105-128`, `packages/webrtc/src/secureTransportManager.ts:95-107`）。  
そのため **低レイヤでは対応済みだが、`RTCPeerConnection` 経由では TURN over TLS を使い切れていない** のが現状です。

また、ルートの `./e2e` は現在 Google STUN を前提にした Chrome ↔ werift の試験構成で、`packages/ice-server` のローカル TURN サーバを使う仕組みも、TLS 用の Chrome 起動フラグもありません（`e2e/server/fixture.ts:37-41`, `e2e/tests/datachannel/datachannel.test.ts:9-11`, `e2e/vitest.config.mts:30-45`）。

---

# 2. 実装すべき具体的な機能や変更内容

## `packages/webrtc`
1. `RTCIceServer` / `PeerConfig` 経由で **TURN transport の選択** を扱えるようにする。  
   - `turn:` + `?transport=udp|tcp`
   - `turns:` + `?transport=tcp` を解釈対象にする
2. TURN over TLS 接続時に必要な **TLS クライアントオプション** を `PeerConfig` から `IceOptions.turnTlsOptions` へ渡せるようにする。
3. 既存の `forceTurnTCP` との後方互換を保ちながら、TLS を含む transport 解決ロジックへ整理する。
4. `parseIceServers` の単体テストを拡張し、`turns:` と query 付き URL を追加する。

## `./e2e`
1. `packages/ice-server` の `NodeTurnServer` を使って、**ローカル TURN サーバを e2e サーバ起動時に立ち上げる**。
2. サーバ/ブラウザ両方がその TURN 設定を使えるように、**動的ポート・資格情報・URL を共有**する。
3. Chrome ↔ werift の **datachannel 相互接続試験を udp/tcp/tls の 3 ケース追加**する。
4. 各ケースで **双方向通信** を確認する。
5. relay 強制で本当に TURN 経由になっていることを確認する。  
   - Chrome 側は `getStats()` の selected candidate pair で `relay` を確認
   - werift 側は `iceTransports[].connection.nominated` や protocol 側状態で relay 利用を確認
6. TLS ケースのために、ルート `e2e` の Chromium 起動オプションへ **証明書エラー無視フラグ** を入れる。

## デバッグ・修正対象
相互接続試験で失敗した場合は、少なくとも以下を切り分けて原因修正まで含める必要があります。
- TURN URI 解析不備
- TLS ハンドシェイク/証明書検証失敗
- TURN Allocate / auth / ChannelBind の失敗
- relay candidate が収集されない
- relay-only なのに host/srflx が選ばれる
- ICE 接続は成立するが datachannel open / 双方向送受信が失敗する

---

# 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

## 既存実装の再利用方針
- **TURN サーバ実装は新規作成不要**  
  `packages/ice-server/src/node/turnServer.ts` をそのまま使える。
- **TURN/TLS クライアント実装も新規作成不要**  
  `packages/ice/src/ice.ts` は `turnTransport: "tls"` と `turnTlsOptions` をすでに扱える。
- つまり主作業は **`packages/webrtc` の公開設定から lower layer へ正しく流す配線** と **root e2e への統合**。

## `packages/webrtc` の実装方針
- `parseIceServers` の URL 解析を、現状の単純な `split(":")` ベースから、`turn:` / `turns:` / query を扱える実装へ置き換える。
- `SecureTransportManager` では `parseIceServers()` の結果を優先し、必要なら `PeerConfig` の TLS オプションを `turnTlsOptions` に渡す。
- transport 指定は `forceTurnTCP` の bool より、**`udp/tcp/tls` を表せる値** に寄せるのが自然。

## `./e2e` の実装方針
- `packages/ice-server/chrome-e2e` がほぼ完成形の先行例。特に以下を流用しやすいです。  
  - TLS 証明書読込 (`packages/ice-server/chrome-e2e/server/main.ts`)
  - TURN URL の動的生成
  - udp/tcp/tls 3 ケースの relay 試験 (`packages/ice-server/chrome-e2e/tests/turn-relay.test.ts`)
  - Chrome の TLS 緩和フラグ (`packages/ice-server/chrome-e2e/vitest.config.mts`)
- ルート `e2e` では既存の **Chrome ↔ werift signaling 基盤** を維持しつつ、TURN 用の handler/test を追加するのが最小変更です。
- datachannel 試験は既存の `e2e/tests/datachannel/datachannel.test.ts` と `e2e/server/handler/datachannel/datachannel.ts` のパターンをベースに、**TURN 設定付き専用ケース** を増やすのがよいです。

---

# 4. 考慮すべき制約や注意点

1. **self-signed 証明書**
   - `NodeTurnServer` の TLS はローカル証明書を使う想定です。
   - Chrome 側は現状の root `e2e` では `--ignore-certificate-errors` が無いため、TLS ケースはそのままだと失敗する可能性が高いです。

2. **`turns:` 未対応が現状の主要ギャップ**
   - `parseIceServers` は `turn:` 前提で、`turns:` を拾えません。
   - ここが `packages/webrtc` 側の最重要修正ポイントです。

3. **relay-only を両端で強制する必要**
   - Chrome 側だけ `iceTransportPolicy: "relay"` にしても、werift 側が host 候補を使うと試験の意味が薄れます。
   - server 側も relay 優先ではなく **relay-only 相当** に寄せる必要があります。

4. **動的ポート運用**
   - e2e は毎回空きポートを取る設計です。
   - TURN URL をテストへ埋め込まず、起動時に配布する必要があります。

5. **既存 test convention**
   - テスト追加時は Arrange / Act / Assert を保ち、共有セットアップは fixture 化する必要があります。
   - `packages/ice-server/chrome-e2e/tests/fixture.ts` のような共通 helper を root `e2e` 側にも寄せるのが安全です。

---

# 5. 完了条件

- `packages/webrtc` の `RTCPeerConnection` から、**`turns:` URI を使った TURN over TLS** が利用できる。
- `./e2e` で **Chrome ↔ werift** の datachannel 相互接続試験が **udp / tcp / tls の 3 transport すべて** 追加されている。
- 各 transport で **TURN 経由の双方向通信** が確認できる。
- TLS ケースで Chrome がローカル TURN サーバへ接続できるよう、必要な起動条件が整っている。
- 問題が発生した場合は、**原因を特定してコード修正まで反映** されている。
- 変更に応じて少なくとも以下の検証が通ること。  
  1. `packages/webrtc` の関連 unit/integration test  
  2. `packages/ice-server` を変更した場合はその package test/type  
  3. `cd e2e && npm run type && npm run ci:silent`  
  4. cross-package/public API 変更として必要なら `npm run type` と `npm run test:small`