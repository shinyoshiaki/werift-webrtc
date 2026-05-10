│ "**/AGENTS.md"


  │ "\bTURN\b|turn tls|turn:|turns:|iceServers|RTCIceServer|useDataChannel|creat
  │ eDataChannel|DataChannel|Vite|React|vite" in *.{ts,tsx,js,md,json}
  │ (examples, packages, docs, website)

  │ packages/ice-server/AGENTS.md

  │ examples/package.json


  │ examples/ice/turn/trickle_offer.ts

  │ "TurnServer|TURN|turn server|turn
  │ tls|tls.createServer|https.createServer|createServer\(" in *.{ts,js}
  │ (packages/ice-server, examples, packages)

  │ "createDataChannel\(|useDataChannel|new RTCPeerConnection|new
  │ PeerConnection|new RTCPeerConnection|RTCPeerConnection" in *.{ts,tsx}
  │ (examples, packages/webrtc)

  │ "createDataChannel\(|onDataChannel|datachannel|RTCDataChannel" in *.ts
  │ (examples)

  │ "vite|createRoot\(|ReactDOM|StrictMode" in *.{ts,tsx,js,jsx,json,html}
  │ (examples, website)

  │ "express\(|app\.(post|put)|https\.createServer|http\.createServer|axios\.(po
  │ st|put)|fetch\(" in *.{ts,tsx,js,html} (examples)

  │ "class NodeTurnServer|interface NodeTurnServer|export
  │ .*TurnServer|createServer\(|listen\(" in *.ts (packages/ice-server/src)

  │ packages/ice-server/package.json

  │ packages/ice-server/src/node/turnServer.ts

  │ "examples/**/vite.config.*"

  │ "examples/**/*.{tsx,html}" in examples/dash,
  │ examples/save_to_disk/react-client, examples/mediachannel/codec

  │ examples/interop/server.ts

  │ examples/interop/client.ts

  │ examples/interop/relay.ts

  │ examples/dash/client/main.tsx

  │ examples/save_to_disk/react-client/main.tsx

  │ examples/playground/signaling/offer.ts

  │ examples/datachannel/offer.ts

  │ examples/datachannel/answer.ts

  │ examples/ice/trickle/dc.ts

  │ "tlsPort === this.port|share the same port|multiplex|ALPN|SNICallback|first
  │ byte|unshift\(|socket\.once\("data"" in *.ts (packages, examples)

  │ "getPassword|credentials:|realm|nonce|TurnServerProtocol\(" in *.ts
  │ (packages/ice-server/src, packages/ice-server/tests)

  │ "connectionStateChange|iceConnectionStateChange|onDataChannel|onRemoteTransc
  │ eiverAdded" in *.ts (packages/webrtc/src)

  │ "peer\.createDataChannel|onMessage\.subscribe\(|stateChanged\.subscribe\("
  │ in *.{ts,tsx} (examples)

  │ ""vite"|"@vitejs/plugin-react"" in package.json

  │ packages/ice-server/src/index.ts

  │ packages/webrtc/src/index.ts

  │ "examples/**/tsconfig*.json"


  │ ""jsx"|"moduleResolution"|"target"" in tsconfig*.json (examples, packages)

  │ "readFileSync\(|certificate|cert-file|key-file" in *.{ts,md} (examples)

  │ packages/ice-server/chrome-e2e/tests/turn.test.ts

  │ "packages/ice-server/chrome-e2e/tests/*.ts"

  │ "turns:|turn:|iceServers|iceTransportPolicy|username|credential" in
  │ *.{ts,tsx,js,mts,html} (packages/ice-server/chrome-e2e,
  │ packages/ice-server/tests, examples)

  │ packages/ice-server/chrome-e2e/tests/fixture.ts

  │ packages/ice-server/chrome-e2e/server/main.ts

  │ packages/ice-server/chrome-e2e/tests/turn-relay.test.ts

  │ "examples/*/package.json"

  │ "examples/*"

  │ "npm run .*examples|cd examples/|examples/.*main\.tsx|tsx watch examples" in
  │ *.{md,json} (README.md, doc, docs, package.json)


  │ "examples/|Example|datachannel|interop" in *.md (README.md, docs, doc)

  │ e2e/package.json

  │ packages/ice-server/chrome-e2e/package.json

  │ packages/ice-server/chrome-e2e/vitest.config.mts

  │ "vite|@vitejs/plugin-react|vitest" in package.json (e2e,
  │ packages/ice-server/chrome-e2e)

  │ examples/ice/turn/trickle_answer.html

  │ examples/ice/trickle/dc.html

  │ "wait\(|watch\(|asPromise\(|setLocalDescription\(|createOffer\(|createAnswer
  │ \(" in *.{ts,tsx,html} (packages/webrtc/src, examples)

  │ "new NodeTurnServer\(|createNodeTurnServer\(" in *.ts (examples, packages)

  │ "cert\.pem|key\.pem|packages/dtls/assets" in *.{ts,md}

  │ "listen\(.*0\)|port: 0|address\?\[0\]" in *.ts (packages/ice-server,
  │ examples)


  │ e2e/server/turn.ts

  │ packages/ice/tests/utils.ts

  │ packages/ice-server/src/turn/protocol.ts

  │ packages/ice-server/src/turn/protocol.ts

  │ "handleTcpChunk\(|handleClientDatagram\(|handleClientClosed\(|handleRelayPac
  │ ket\(" (packages/ice-server/src/turn/protocol.ts)

  │ "iceServer.*urls|username.*credential|transport=tcp" in *.ts
  │ (packages/ice/src, packages/webrtc/src)

  │ "rejectUnauthorized|tlsOptions|turnTls|turn.*tls" in *.ts (packages/ice,
  │ packages/webrtc, examples)

  │ packages/webrtc/src/peerConnection.ts

  │ packages/webrtc/src/utils.ts

  │ packages/ice/tests/ice/turn.test.ts

  │ "examples/**/dist/**"

  │ "examples/**/index.html" in examples

  │ "github pages|GitHub Pages|examples/.*answer|examples/.*offer" in
  │ *.{yml,yaml,md} (.github)

  │ packages/webrtc/src/peerConnection.ts

  │ "iceGatheringState|icegatheringstatechange|onicecandidate|localCandidates|ga
  │ therCandidates\(" in *.{ts,tsx,html} (packages/webrtc/src, examples)

  │ packages/webrtc/src/peerConnection.ts

  │ examples/interop/index.html

以下の粒度まで詳細化できます。**このタスクの本質は、既存の「DataChannel 例」「REST シグナリング例」「TURN/TLS 実装」を 1 つの公開向けサンプルに統合すること**です。

## 1. タスクの目的と背景

- 既存コードベースには、以下の要素はそれぞれ存在します。  
  - DataChannel の offer/answer 例: `examples/datachannel/offer.ts`, `examples/datachannel/answer.ts`
  - HTTP/REST シグナリング例: `examples/interop/server.ts`, `examples/ice/trickle/dc.ts`
  - TURN/TLS サーバー実装と利用例: `packages/ice-server/src/node/turnServer.ts`, `packages/ice-server/chrome-e2e/server/main.ts`, `e2e/server/turn.ts`
- ただし、**ブラウザ SPA クライアント + werift サーバー + TURN over TLS + HTTPS シグナリング + 同一公開ポート**をまとめて示す例はありません。
- そのため本タスクは、werift の実運用に近い構成として、**「HTTPS で設定取得と answer 返却を行い、WebRTC の実データ経路は TURN/TLS 経由で張る」**サンプルを追加するものです。

## 2. 実装すべき具体的な機能や変更内容

### サーバー側
- TypeScript 製のサーバー例を追加する。
- HTTPS の `POST` で新規セッションを作成し、以下を返す。
  - `offer`
  - `turns:` URI
  - 一意な `username`
  - 一意な `password`
- 返却前に、werift の `RTCPeerConnection` を作成する。
  - `DataChannel` を有効にするため、**offer 側で `createDataChannel()` を呼ぶ**
  - `iceTransportPolicy: "relay"` を設定し、TURN/TLS 経由を強制する
  - TURN 認証情報はそのセッション専用のものを使う
- HTTPS の `PUT` で `{ username, answer }` を受け取り、該当セッションの peer に `setRemoteDescription(answer)` してシグナリング完了にする。
- サーバー側 DataChannel は、受信メッセージをそのまま送り返す loopback/echo 動作にする。
- セッション管理を持つ。
  - `username` をキーに `RTCPeerConnection` と password を保持
  - タイムアウトや close 時に破棄

### クライアント側
- TypeScript + Vite + React の SPA を追加する。
- 起動時またはボタン押下で `POST` を叩いて設定を取得する。
- 返された `offer`, `turns:` URI, `username`, `password` を使ってブラウザ `RTCPeerConnection` を作成する。
- `setRemoteDescription(offer)` → `createAnswer()` → `setLocalDescription(answer)` を行う。
- ICE gathering 完了後に `PUT` で `{ username, answer }` を送る。
- サーバーが作成した DataChannel を `ondatachannel` で受け取り、open 後に echo メッセージを送る。
- 受信した loopback メッセージを画面表示する。

### 付随変更
- 例の起動手順が分かる README/コメントを追加する。
- 必要なら `examples/*` 配下に新しい example package を作り、Vite 用 `package.json` / `vite.config.ts` を持たせる。

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 既存資産の再利用先
- **DataChannel offer/answer の作り方**  
  `examples/datachannel/offer.ts` は offer 側で `createDataChannel()` し、`examples/datachannel/answer.ts` は answer 側で `onDataChannel` を受けています。今回の「サーバー offer / クライアント answer」構成と一致します。
- **REST シグナリングの形**  
  `examples/interop/server.ts` と `examples/ice/trickle/dc.ts` に HTTP ベースのシグナリング例があります。今回は trickle ではなく、`POST`/`PUT` の 2 往復に整理できます。
- **TURN/TLS の URL と認証**  
  `packages/ice-server/chrome-e2e/server/main.ts` と `e2e/server/turn.ts` に `turns:host:port?transport=tcp` と動的 username/password の例があります。
- **werift の `turns:` 解釈**  
  `packages/webrtc/src/utils.ts` で `turns:` は `tls` transport として解釈されます。

### 推奨アーキテクチャ
- **API 形状**
  - `POST /session` → `{ offer, turnUrl, username, password }`
  - `PUT /session` → `{ username, answer }`
- **TURN 認証**
  - `NodeTurnServer` の `credentials` 固定表ではなく、`getPassword(username)` を使って **セッション Map から動的に password を返す**形が適しています。
- **relay 強制**
  - サーバー peer / クライアント peer の両方で `iceTransportPolicy: "relay"` を使うべきです。ローカル環境では host 候補が勝ちやすく、TURN を通らないためです。
- **同一ポート多重化**
  - ここが最大の技術ポイントです。
  - 現状の `NodeTurnServer` は **自前で TLS server を listen する設計**で、既存 API のままでは HTTPS と TURN/TLS の同一ポート共有はできません。
  - 実装方針は次のどちらかです。  
    1. **推奨:** `packages/ice-server` に小さく拡張を入れ、外部で受けた TLS socket を TURN ハンドラへ渡せるようにする  
    2. 例側で `TurnServerProtocol` を直接使い、TLS 復号後のソケットを HTTP と TURN に振り分ける  
  - 実装上は、**1 個の TLS listener で TLS を終端し、復号後の先頭バイトで HTTP か TURN かを判定して内部 HTTP server / TURN handler に振る**のが自然です。

## 4. 考慮すべき制約や注意点

- **“http の POST/PUT” ではなく、最終的には HTTPS API になる**  
  同一公開ポートで TURN/TLS を多重化するなら、シグナリング API も TLS 配下です。
- **ブラウザの `turns:` は証明書要件が厳しい**  
  ローカルの自己署名証明書では失敗しやすいです。`packages/ice-server/chrome-e2e` でも Chrome 起動時に証明書エラーを無視しています。公開例としては有効な証明書前提、ローカル例としては信頼済み証明書か注意書きが必要です。
- **client は answer 送信前に ICE gathering 完了待ちが必要**  
  ブラウザ側は one-shot signaling なので、gather 完了前に `PUT` すると relay candidate が answer SDP に載り切らない可能性があります。
- **server は session を answer 受信直後に捨ててはいけない**  
  TURN 認証や refresh の都合上、接続中は username/password を引ける状態を維持する必要があります。
- **Vite は現状 examples に入っていない**  
  新規 example package では `vite`, `@vitejs/plugin-react` などの依存追加と lockfile 更新が必要です。
- **配置場所は `examples/<new-example>` が無難**  
  ルート `package.json` の workspace は `examples/*` なので、Vite client を持つなら immediate child に切るのが扱いやすいです。

## 5. 完了条件

1. サーバーが HTTPS `POST` で `offer`, `turns:` URI, 一意な `username`, `password` を返せる。  
2. サーバーがその資格情報で werift peer を生成し、relay-only + DataChannel 有効状態で offer を作れる。  
3. クライアント SPA が返却値を使って browser `RTCPeerConnection` を作り、answer を生成し、HTTPS `PUT` で `{ username, answer }` を返せる。  
4. シグナリング完了後、クライアントが DataChannel open を待って echo メッセージを送信し、同じ内容を受信できる。  
5. 実際の接続が TURN/TLS 経由で成立するよう `iceTransportPolicy: "relay"` が両端で設定されている。  
6. 起動手順が example 内で分かり、必要なら README から辿れる。  
7. もし `packages/ice-server` に多重化対応の補助 API を追加する場合、その変更も含めて型/テスト観点で破綻がない。  

**要点だけ言うと、既存資産で offer/answer・REST signaling・TURN/TLS 自体は足りていますが、同一ポートでの HTTPS + TURN/TLS 多重化だけは現状 API のままでは不足しており、ここがこのタスクの中心設計課題です。**