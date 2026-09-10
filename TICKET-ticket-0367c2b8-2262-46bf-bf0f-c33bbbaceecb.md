# Issue #699: TURN TCP/TLS 接続が ICE gathering を無期限に待たせないようにする

対象: [shinyoshiaki/werift-webrtc#699](https://github.com/shinyoshiaki/werift-webrtc/issues/699)

## 1. タスクの目的と背景

TURN over TCP/TLS のソケット接続（TCP `connect` / TLS `secureConnect`）に完了・失敗の上限時間がない。完了イベントも `error` も来ない接続は `StreamTransport.waitForConnect()` が永遠に pending のままになる。

この待ちは次の経路で `RTCPeerConnection.setLocalDescription()` まで伝播する。

1. `TcpTransport.init()` / `TlsTransport.init()` が `StreamTransport.waitForConnect()` を await する（`packages/common/src/transport.ts`）。
2. `createTurnClient()` / `createStunOverTurnClient()` が TCP/TLS 初期化を await する（`packages/ice/src/turn/protocol.ts`）。
3. `Connection.gatherCandidates()` が TURN 候補収集 Promise を `Promise.allSettled()` に載せる（`packages/ice/src/ice.ts`）。`allSettled` でも **never-settling な Promise は完了しない**。
4. `RTCIceGatherer.gather()` → `SecureTransportManager.gatherCandidates()` → `RTCPeerConnection.setLocalDescription()` が gathering 完了を待つ。

UDP TURN はソケット bind のあと Allocate を STUN Transaction（`RETRY_RTO` / `RETRY_MAX`）で送るため、サーバ無応答でも有限時間で失敗する。TCP/TLS は **Allocate の前** にハンドシェイク完了を待つ点が unbounded になる。

典型シナリオ:

- TCP SYN が黒穴（応答なし）。OS の SYN タイムアウトは数十秒〜分単位になり得る。
- TCP は確立したが TLS ハンドシェイクが完了しない（Issue が挙げているケース。`connectEvent` が `secureConnect`）。
- `turnTransport === "udp"` の Allocate 失敗後、ICE は TCP にフォールバックする（`packages/ice/src/ice.ts`）。フォールバック先 TCP がハングすると、UDP 側が失敗していても gathering が止まる。

期待動作: TURN TCP/TLS 接続は有限時間で失敗し、ソケットを破棄し、host / STUN 候補の収集と `setLocalDescription()` の完了をブロックしない。TURN 失敗は既存どおり `query TURN server` としてログされ、gathering 全体は `allSettled` で完了する。

## 2. 実装すべき具体的な機能や変更内容

### 必須: 接続タイムアウトとクリーンアップ

`StreamTransport.connect()` の `connecting` Promise を、connect / secureConnect / error だけでなく **タイマーと race** させる。

タイムアウト時（Issue の Proposed fix）:

1. connect / error リスナーを外す。
2. タイマーを必ず `clearTimeout` する（成功・失敗経路でも同様）。
3. pending ソケットを `destroy()` する。
4. `connecting` を説明付き Error で reject する（例: `tls connect timed out after 8000ms`）。
5. 自動再接続が走らないようにする（後述）。失敗した `TcpTransport` / `TlsTransport` インスタンスが呼び出し元に返らず捨てられる場合も、ソケットを閉じる。

成功・通常の `error` でもタイマーと once リスナーを外す。`close()` 中の connect 待ちも reject して閉じる（現状 `destroy()` だけでは `error` が飛ばず `connecting` が残り得る）。

`TcpTransport.init` / `TlsTransport.init` は `waitForConnect()` 失敗時に `close()` してから再 throw する。現在は constructor で既に `connect()` しているため、init 失敗でインスタンスが捨てられるとソケットがリークし、`end` ハンドラで再接続し続ける。

### 必須: タイムアウト値を TURN / ICE / PeerConnection まで通す

既存の `stunGatherTimeout`（秒、既定 5）と同じ縦の配線にする。既定は **常に有効** にする（未設定のままでは本番のハングが残る）。

推奨 API（後方互換・追加のみ）:

| 層 | 追加 | 単位 | 既定 |
| --- | --- | --- | --- |
| `StreamTransport` / `TcpTransport.init` / `TlsTransport.init` | `connectTimeoutMs?: number` | ms | `8000` |
| `TurnClientOptions` / `createStunOverTurnClient` の options | `connectTimeoutMs?: number` | ms | transport 既定に委譲 |
| `IceOptions` | `turnConnectTimeout?: number` | **秒**（`stunGatherTimeout` と同じ） | `8`（未指定時） |
| `PeerConfig` | `iceTurnConnectTimeout?: number` | 秒 | `undefined` → ICE 既定 8 秒 |

`TlsConnectionOptions`（`tls.ConnectionOptions` の Omit）にタイムアウトを混ぜない。TLS オプションとは別引数、または `{ connectTimeoutMs }` の専用オブジェクトにする。

配線箇所:

- `createTurnClient()` の `TcpTransport.init(address)` / `TlsTransport.init(address, tlsOptions)` にタイムアウトを渡す。
- `Connection.getCandidatePromises()` の TURN 本経路 **および UDP→TCP フォールバック** の両方に渡す。フォールバックを忘れると #699 が残る。
- `SecureTransportManager.createTransport()` で `stunGatherTimeout: this.config.iceStunGatherTimeout` と同様に `turnConnectTimeout` を渡す。
- `setIceServers()` はサーバ置換用で `stunGatherTimeout` を扱っていない。タイムアウトも **constructor / `createTransport` 側** で足りる。`setConfiguration` 後の未 gather な Connection に効かせたい場合のみ `updateIceServers()` へ足す（必須ではない）。

既定 8 秒の根拠: Issue の 5–10 秒の中央、かつ TCP 接続上限として一般的な WebRTC 実装のオーダー。STUN gather（5 秒）とは独立でよい（UDP Binding 待ちと TCP/TLS ハンドシェイクは別）。

### 推奨（同一変更で扱う）: `end` での自動再接続を止める

`StreamTransport` は `client.on("end", () => this.connect())` でソケットだけ張り直す。`TcpTransport` / `TlsTransport` の利用箇所は現状 TURN のみ。TURN の Allocate / 認証 / Permission / ChannelBind はソケット再接続では復元されない。

#699 の Additional concern。`connect()` を触るなら次を同じ PR に含める:

- タイムアウト・connect 失敗・明示 `close()` のあとで `connect()` を再実行しない（`closed` を立てる）。
- TURN 用途では `end` での透明 reconnect をしない。切断は TURN 層へ失敗として見せる。

**このチケットの範囲外:** 切断後に TURN Allocate を作り直して ICE を継続するフル復旧。それは別タスク。

### テスト

テスト規約: Arrange / Act / Assert。Arrange のサーバ起動は共有ユーティリティへ。Act / Assert に日本語コメント。

1. **`packages/common`（transport 単体）**
   - TLS: ローカル `net.createServer` が TCP を accept するが TLS を完了しない。短い `connectTimeoutMs`（例 200–500ms）で `TlsTransport.init` が timeout 近傍で失敗する。ソケットが閉じている。
   - TCP: 応答しない宛先（例: TEST-NET `192.0.2.1`）へ短いタイムアウト。OS SYN タイムアウトまで待たないことを確認。
   - 正常系: 既存ローカル TURN TCP/TLS（`packages/ice/tests/ice/turn.test.ts`）が壊れないこと。common 単体ではループバック echo サーバでも可。
   - `packages/common/package.json` に現状 `test` スクリプトが無い。`tests/` と `vitest.config.mts` はあるが root `npm run test:small`（`npm run test --workspaces --if-present`）に乗らない。transport テストを common に置くなら `"test": "vitest run ./tests"` を追加する。置かないなら ICE パッケージ側に寄せる。

2. **`packages/ice`（gathering が止まらないこと）**
   - TLS ハングサーバ + host 候補あり。短い `turnConnectTimeout` で `gatherCandidates()` が完了する。host（と設定していれば srflx）は残る。relay は無い。
   - `forceTurn` + ハング TURN でも gathering が完了し、無期限 pending にならない。
   - 可能なら UDP 失敗 → TCP フォールバックがハングする経路でも、渡したタイムアウトで抜けること。

3. **任意: `packages/webrtc`**
   - ハング `turns:` / TLS TURN を `iceServers` に入れた `setLocalDescription()` がタイムアウト近傍で戻り、`iceGatheringState` が `complete` になる。既存の `packages/webrtc/tests/transport/ice.test.ts`（ローカル TURN + gather）の逆ケース。

正常系回帰: `packages/ice/tests/ice/turn.test.ts` の udp / tcp / tls。タイムアウト既定が 8 秒でも、ローカル TURN はハンドシェイクがすぐ終わるので影響しない想定。

## 3. 技術的な実装アプローチ（調査結果）

### ハング点

`StreamTransport.connect()`（`packages/common/src/transport.ts`）:

- `connecting` は `connect`（TCP）または `secureConnect`（TLS）と `error` だけで settle する。
- タイマーなし。`socket.setTimeout` も未使用。
- `waitForConnect()` / `send()` がこの Promise を await する。

`createTurnClient()` は `transportType === "tcp" | "tls"` のとき `init()` 完了まで Allocate に進まない。

### gathering との関係

`getCandidatePromises()` は host /（任意）TCP host / STUN srflx / TURN を並列配列にし、`gatherCandidates()` が `Promise.allSettled` する。TURN 側は `.catch` でログして swallow するため、**settle さえすれば** 他候補を落とさない。問題は TURN Promise が reject も resolve もしないこと。

STUN srflx は既に `stunGatherTimeout`（秒、既定 5）で打ち切っている。TURN ストリーム接続に相当する打ち切りが無い。

### 推奨実装順

1. `StreamTransport` に `connectTimeoutMs`（既定 8000）を入れる。`Promise` の executor 内で timer + once リスナーを登録し、settle 時に両方解除。timeout では `closed = true` 相当にしてから `destroy` + reject。
2. `TcpTransport.init(addr, { connectTimeoutMs })`、`TlsTransport.init(addr, tlsOptions, { connectTimeoutMs })` のようにオプション追加。init 失敗で close。
3. `TurnClientOptions.connectTimeoutMs` を `createTurnClient` / `createStunOverTurnClient` に通す。
4. `IceOptions.turnConnectTimeout`（秒）を ms に変換して TURN 作成（本経路と UDP→TCP フォールバック）へ。
5. `PeerConfig.iceTurnConnectTimeout` を `SecureTransportManager.createTransport()` の `RTCIceGatherer` オプションへ（`iceStunGatherTimeout` と同じ）。
6. テスト。必要なら `npm run doc` で IceOptions / PeerConfig の typedoc を更新（公開 API コメントをソースに書けば CI の `doc` が追従）。

実装上の注意:

- `once` の解除は `client.off(event, handler)`。timeout 後に遅延 `secureConnect` が来ても no-op にする。
- `destroy(err)` は `error` を二重 reject し得る。reject は一度だけ（settled フラグ）。
- Node `socket.setTimeout` はアイドルタイムアウトで、connect 待ちには使わない。明示 `setTimeout` で十分。
- `common` の `format` は `src` のみ。テストを common に足すなら format glob を `tests` まで広げるか、ice 側テストに寄せる。

### 自動再接続

`end` → `connect()` は、timeout で `destroy` したあとに新しい `connecting` を作り、捨てられた transport がサーバへ再接続し続ける。timeout 経路では必ず再接続を抑止する。TURN 専用なので、透明 reconnect 自体を廃止するのが安全。

## 4. 考慮すべき制約や注意点

- **既定タイムアウトは常時有効。** オプトインだけだと Issue の本番ハングは直らない。遅いネットワーク向けに `IceOptions` / `PeerConfig` で伸ばせるようにする。
- **単位を混同しない。** `stunGatherTimeout` / 追加する ICE・PeerConnection オプションは秒。transport 内部は ms。JSDoc に明記する。
- **host / STUN を TURN 失敗で消さない。** 既存の TURN `.catch` + `allSettled` を維持する。タイムアウトは TURN 候補 Promise を settle させることが目的。
- **UDP→TCP フォールバックに同じ timeout を渡す。** ここを忘れると UDP 不通環境で再発する。
- **正常な TURN TCP/TLS を壊さない。** `packages/ice/tests/ice/turn.test.ts` の tcp/tls、および `examples/turn-loopback` の TURNS は、ローカルでは 8 秒未満で握手できる前提。
- **公開 API は追加のみ。** `TcpTransport.init(addr)` の既存シグネチャは維持。
- **WPT に厳しい shim を `packages/webrtc/src` へ漏らさない。** 本変更は werift の gathering 完了保証であり、WPT ラッパーは不要。
- **`setIceServers` のサーバ置換契約を広げすぎない。** timeout は gatherer 構築オプション。サーバ URL 置換に混ぜると WHIP 用 `setIceServers` のテスト契約が曖昧になる。
- **フル TURN セッション再作成は範囲外。** reconnect 抑止まで。Allocate やり直しは別 Issue。
- 実行環境は Linux / macOS 等 Unix。ネイティブ Windows 非対応（リポジトリ方針）。

## 5. 完了条件

- [ ] TCP 接続および TLS `secureConnect` 待ちに有限タイムアウトがある（既定 8 秒、設定変更可）。
- [ ] タイムアウト時にリスナー解除・タイマー解除・ソケット destroy・`connecting` reject が行われる。
- [ ] 失敗した init がソケットをリークせず、`end` による自動再接続がタイムアウト／失敗後に走らない。
- [ ] `createTurnClient` → ICE TURN gather（本経路と UDP→TCP フォールバック）→（公開するなら）`PeerConfig.iceTurnConnectTimeout` まで値が届く。
- [ ] ハングする TLS（TCP accept のみ）に対し、設定したタイムアウト近傍で TURN 試行が失敗するテストがある。
- [ ] 同じ状況で host / STUN 収集と `gatherCandidates()` / `setLocalDescription()` が無期限 pending にならないテストがある。
- [ ] 既存 TURN UDP/TCP/TLS 正常系（少なくとも `packages/ice/tests/ice/turn.test.ts`）が通る。
- [ ] Act / Assert に日本語コメントがあり、Arrange のハングサーバは共有できるなら `packages/ice/tests/utils.ts` 等に寄せている。
- [ ] 検証: `cd packages/common && npm test`（script 追加時）、`cd packages/ice && npm test`（対象テストで可）、ICE オプションを PeerConnection まで出したら `cd packages/webrtc && npm test` の関連パス。公開型を足したら `npm run type`。必要なら `npm run format`。
- [ ] `IceOptions` / `PeerConfig` に単位付き JSDoc がある。typedoc はソースコメント更新で足りる（docs-only なら追加検証不要、API 変更なら CI の `doc` が更新）。

## 実装時の主な参照

| ファイル | 役割 |
| --- | --- |
| `packages/common/src/transport.ts` | `StreamTransport.connect` / `waitForConnect`。修正の中心 |
| `packages/ice/src/turn/protocol.ts` | `createTurnClient` が Tcp/Tls `init` を await |
| `packages/ice/src/ice.ts` | TURN gather と UDP→TCP フォールバック |
| `packages/ice/src/iceBase.ts` | `IceOptions` / `stunGatherTimeout` の先例 |
| `packages/webrtc/src/secureTransportManager.ts` | `createTransport` への IceOptions 渡し |
| `packages/webrtc/src/peerConnection.ts` | `PeerConfig.iceStunGatherTimeout` の先例、`setLocalDescription` → `gatherCandidates` |
| `packages/webrtc/src/transport/ice.ts` | `RTCIceGatherer.gather()` |
| `packages/ice/tests/ice/turn.test.ts` | ローカル TURN TCP/TLS 正常系 |
| `packages/ice/tests/utils.ts` | `createLocalTurnServer` / TLS 証明書ヘルパ |
| `packages/webrtc/tests/transport/ice.test.ts` | PC レベルの TURN gather |

## 推奨しないこと

- gathering 全体の wall-clock で TURN だけを切る（STUN は既に個別 timeout がある。TURN は接続待ちが問題）。
- `TlsConnectionOptions` に timeout を忍ばせる（TLS の `ConnectionOptions` と衝突し、TCP 経路と API が割れる）。
- タイムアウトをテスト専用フラグや環境変数だけにする。
- `Promise.race` だけでソケットを残す（リークと後から来る `secureConnect` の副作用）。
