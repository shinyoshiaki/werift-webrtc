
## 1. タスクの目的と背景

- 既存コードベースには、以下の要素はそれぞれ存在します。  
  - DataChannel の offer/answer 例: `examples/datachannel/offer.ts`, `examples/datachannel/answer.ts`
  - HTTP/REST シグナリング例: `examples/interop/server.ts`, `examples/ice/trickle/dc.ts`
  - TURN/TLS サーバー実装と利用例: `packages/ice-server/src/node/turnServer.ts`, `packages/ice-server/chrome-e2e/server/main.ts`, `e2e/server/turn.ts`
- ただし、**React SPA クライアント + werift サーバー + HTTPS シグナリング + TURN/TLS 公開ポート多重化**をまとめて示す例はありません。
- 本タスクでは、werift の実運用に近いサンプルとして、**HTTPS で offer/answer を交換しつつ、同一公開ポートで TURN over TLS も提供できる loopback/echo ツール**を examples に追加します。
- 追加で、**複数クライアントが同時に独立セッションを張って echo テストできること**を要件に含めます。
- なお、サーバー側の werift peer は TURN クライアントとしては動作させず、`iceTransportPolicy: "relay"` も設定しません。TURN/TLS の利用対象はクライアント側接続経路の提示と、そのための認証提供です。

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
  - サーバー側 peer には **`iceTransportPolicy: "relay"` を設定しない**
  - サーバー側 peer では **TURN サーバー設定を使わない**
- HTTPS の `PUT` で `{ username, answer }` を受け取り、該当セッションの peer に `setRemoteDescription(answer)` してシグナリング完了にする。
- サーバー側 DataChannel は、受信メッセージをそのまま送り返す loopback/echo 動作にする。
- セッション管理を持つ。
  - `username` をキーに `RTCPeerConnection`、password、状態を保持
  - タイムアウトや close 時に破棄
  - **複数クライアントが同時接続しても衝突しない**
- HTTPS と TURN/TLS を**同一公開ポートで多重化**して公開する。
- サーバー証明書と秘密鍵は、**起動時に環境変数でも指定可能**にする。

### クライアント側
- TypeScript + Vite + React の SPA を追加する。
- 起動時またはボタン押下で `POST` を叩いて設定を取得する。
- 返された `offer`, `turns:` URI, `username`, `password` を使ってブラウザ `RTCPeerConnection` を作成する。
  - クライアント側は TURN/TLS を使って接続する前提で構成する
- `setRemoteDescription(offer)` → `createAnswer()` → `setLocalDescription(answer)` を行う。
- ICE gathering 完了後に `PUT` で `{ username, answer }` を送る。
- サーバーが作成した DataChannel を `ondatachannel` で受け取り、open 後に echo メッセージを送る。
- 受信した loopback メッセージを画面表示する。
- 複数ブラウザタブや複数端末から同時に利用しても、各セッションが独立して成立する。

### 付随変更
- 例の起動手順が分かる README/コメントを追加する。
- 必要なら `examples/*` 配下に新しい example package を作り、Vite 用 `package.json` / `vite.config.ts` を持たせる。
- 必要に応じて `packages/ice-server` の `NodeTurnServer` を拡張し、**外部で受けた TLS socket を TURN ハンドラへ渡せるようにする**。
- 上記拡張で、**動的資格情報の参照**や**多セッション同時利用**に必要な実装改善があれば含める。

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
- **接続方針**
  - サーバー側 peer は通常の ICE 構成とし、**TURN 設定や `iceTransportPolicy: "relay"` は入れません**。
  - クライアント側はサーバーから受け取った `turns:` URI と一時資格情報を使って接続します。
- **同一ポート多重化**
  - ここが最大の技術ポイントです。
  - 現状の `NodeTurnServer` は **自前で TLS server を listen する設計**で、既存 API のままでは HTTPS と TURN/TLS の同一ポート共有はできません。
  - 方針は **1. `packages/ice-server` に小さく拡張を入れ、外部で受けた TLS socket を TURN ハンドラへ渡せるようにする** を採用します。
  - 実装上は、**1 個の TLS listener で TLS を終端し、復号後のデータを見て HTTP と TURN を振り分ける**構成が自然です。
- **多重セッション対応**
  - `username` ごとにセッションを分離した Map 管理とし、answer 適用、TURN 認証、peer close、timeout cleanup が相互に干渉しないようにします。
- **証明書設定**
  - 証明書パスや PEM 本文を環境変数で渡せる設計にして、ローカル起動と CI/E2E の両方で使いやすくします。

## 4. 考慮すべき制約や注意点

- **“http の POST/PUT” ではなく、最終的には HTTPS API になる**  
  同一公開ポートで TURN/TLS を多重化するなら、シグナリング API も TLS 配下です。
- **ブラウザの `turns:` は証明書要件が厳しい**  
  ローカルの自己署名証明書では失敗しやすいです。`packages/ice-server/chrome-e2e` でも Chrome 起動時に証明書エラーを無視しています。公開例としては有効な証明書前提、ローカル例としては信頼済み証明書か注意書きが必要です。
- **client は answer 送信前に ICE gathering 完了待ちが必要**  
  ブラウザ側は one-shot signaling なので、gather 完了前に `PUT` すると relay candidate が answer SDP に載り切らない可能性があります。
- **server は session を answer 受信直後に捨ててはいけない**  
  TURN 認証や refresh の都合上、接続中は username/password を引ける状態を維持する必要があります。
- **server 側 peer は TURN に依存させない**  
  このタスクではサーバー側の werift peer に TURN 利用や relay 強制を入れず、サーバーは通常候補で動かします。要件解釈を実装時に崩さないことが必要です。
- **複数クライアント同時利用を前提にする**  
  セッション ID / username の一意性、timeout cleanup、answer の取り違え防止、close 後の再利用防止を明確にする必要があります。
- **Vite は現状 examples に入っていない**  
  新規 example package では `vite`, `@vitejs/plugin-react` などの依存追加と lockfile 更新が必要です。
- **配置場所は `examples/<new-example>` が無難**  
  ルート `package.json` の workspace は `examples/*` なので、Vite client を持つなら immediate child に切るのが扱いやすいです。
- **NodeTurnServer 改修は小さく閉じる**  
  examples 側で TURN 実装詳細を抱え込まず、再利用可能な拡張 API として `packages/ice-server` に寄せる方針を守る必要があります。

## 5. 完了条件

1. サーバーが HTTPS `POST` で `offer`, `turns:` URI, 一意な `username`, `password` を返せる。  
2. サーバーが werift peer を生成して DataChannel 有効状態の offer を作れる。  
3. サーバー側 peer に `iceTransportPolicy: "relay"` や TURN サーバー設定を入れないことが、実装と説明の両方で明確になっている。  
4. クライアント SPA が返却値を使って browser `RTCPeerConnection` を作り、answer を生成し、HTTPS `PUT` で `{ username, answer }` を返せる。  
5. シグナリング完了後、クライアントが DataChannel open を待って echo メッセージを送信し、同じ内容を受信できる。  
6. 複数クライアントが同時にセッションを張っても、各 echo セッションが独立して成功する。  
7. HTTPS と TURN/TLS が同一公開ポートで多重化され、そのための推奨実装として `packages/ice-server` 側の小さな拡張が含まれている。  
8. サーバー証明書と秘密鍵を環境変数でも渡せる。  
9. 起動手順が example 内で分かり、必要なら README から辿れる。  
10. `packages/ice-server` に追加した API や `NodeTurnServer` 改修を含め、型と既存利用箇所の整合が取れている。  

**要点として、既存資産で offer/answer・REST signaling・TURN/TLS 自体は足りていますが、今回の中心設計課題は「`packages/ice-server` を小さく拡張して HTTPS と TURN/TLS を同一ポートで安全に多重化し、かつ複数セッションを同時運用できる形にまとめること」です。**
