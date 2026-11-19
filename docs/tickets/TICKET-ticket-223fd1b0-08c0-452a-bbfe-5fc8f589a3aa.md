# ICE/TURN接続失敗・終了競合時のPromise rejectionとエラー伝播を監査する

## 1. 目的と背景

### 背景
- 下流の [ds-harness-remote#241](https://github.com/liguobao/ds-harness-remote/issues/241) で、TURN TCP（`turn.r2049.cn:3479`、透過プロキシの fake-IP 経由）への `connect ETIMEDOUT` が **unhandledRejection** として表面化し、ホストの fail-loud ハンドラ（`unhandledRejection` / `uncaughtException` で `process.exit(1)`）がプロセスを終了させた。
  - 発生タイミングはピアの再接続ストーム中の `replacing active peer connection` 直後。置き換え対象ピアの TURN/ICE 試行が、ピアの破棄後に reject した可能性が高い。
  - 環境: Electron 44 / Node 24 / **Windows 11**（werift は native Windows を正式サポートしていない）。
  - 下流 Issue は **CLOSED**。オーナーコメントでは「werift 0.26.0 へ更新し、TURN TCP 接続拒否・接続中 RST・未処理 rejection の回帰テストを追加して解決」とされている。更新前に使っていた werift のバージョンは書かれていない。
- 関連: [#749](https://github.com/shinyoshiaki/werift-webrtc/issues/749)（`UdpTransport` の dgram `error` 未処理）は **CLOSED**。現行の `UdpTransport` は常設の `error` リスナーと `onError` イベント（`packages/common/src/transport.ts:85-97`）を持っている。
- 現行リポジトリは `werift` 0.28.0 / `werift-ice` 0.2.3。TURN TCP/TLS の接続タイムアウトは #703（`9d244cc9a`、2026-09-13）で入った。

### 目的
- ICE/TURN の故障系（接続拒否・タイムアウト・RST・接続中 close・close 後の遅延応答）について、現行 werift の Promise rejection 伝播を**監査し、テストで固定する**。
- 現行版で unhandledRejection/uncaughtException が再現しなければ、その事実と残存リスク（ハング・不要なバックグラウンド処理）を記録する。是正は werift 本体に起因するものだけにとどめる。

## 2. 調査結果（現行コードの伝播経路）

### 2.1 TURN 割り当ての経路（下流のクラッシュに相当する経路）
`CandidateGatherer.gatherRelayCandidate` → `createStunOverTurnClient` → `createTurnClient` → `TcpTransport.init` / `TlsTransport.init` / `UdpTransport.init` → `TurnProtocol.connectionMade` → `allocate`

| 段階 | 実装 | rejection の行き先 |
| --- | --- | --- |
| TCP/TLS connect の失敗（`ECONNREFUSED`、OS の `ETIMEDOUT`、接続前 RST） | `StreamTransport.connect()` の `onConnectError` が `connecting` を reject し、socket を destroy する（`common/src/transport.ts:384-389`） | `TcpTransport.init` が close したうえで rethrow する（`:240-249`） |
| werift 側の接続タイムアウト | `connectTimeoutMs`（既定 8000ms、ICE では `turnConnectTimeout` 秒）のタイマーで reject（`:390-398`） | 同上 |
| 接続後の socket `error` | 常設リスナーがログに出すだけ（`:406-408`） | 伝播しない（クラッシュはしない） |
| Allocate の失敗・タイムアウト | `Transaction.run()` が reject | `createTurnClient` の catch が `turn.close()` したうえで rethrow（`turn/protocol.ts:1104-1118`） |
| ICE close（`closing()` signal の abort） | `abort` → `turn.close()` で全 transaction を cancel する | `TransactionCancelled` |
| UDP 失敗時の TCP フォールバック | `gatherRelayCandidate` の `.catch` 内で再試行（`candidateGatherer.ts:963-983`） | `recordFailure` を経て rethrow |
| 最終的な受け手 | `turnCandidatePromises` の `.catch(log)`（`candidateGatherer.ts:773-781`） | **ここで吸収される**。失敗は `onIceCandidateError` で 1 回だけ通知され（cancel と close は除外）、`gatherCandidates()` は resolve する |
| webrtc 層 | `transport/ice.ts:1098-1103` の `void ...catch(log)`、`:827-828` の `connect().catch` | 吸収される |

→ **静的に読む限り、現行 werift では TURN TCP の connect 失敗が unhandledRejection になる経路は見当たらない。** ただしテストで固定されているのはタイムアウト（`turn-connect-timeout.test.ts`、TLS がハングするケース）とリダイレクト中の close（`turn-close-race.test.ts`）だけで、ECONNREFUSED、接続後の RST、ICE close と TCP connect 中の競合を、process レベルの rejection 監視付きで検証したテストはない。

### 2.2 実際に見つかった欠陥・リスク（クラッシュではなく、ハングと後片付け漏れ）

| # | 箇所 | 内容 | 影響 |
| --- | --- | --- | --- |
| R1 | `common/src/transport.ts` `StreamTransport.connect()`（`:401-408`） | 接続**確立後**のピア切断（`end`、`close`、RST による `error`）を監視していない。`closed` は false のままで、上位（TurnProtocol）に通知されない | TURN TCP/TLS の割り当てが黙って死ぬ。refresh ループ（`protocol.ts:561-604`、lifetime の 5/6 周期）は close まで回り続ける。死んだ stream への送信は `failOnSendError` が false なので、各 transaction が RTO の再送上限まで待つ。ICE は consent が失敗するまで気づかない |
| R2 | `turn/protocol.ts` `createTurnClient`（`:1061-1101`） | `signal` の abort リスナーを登録するのが `TcpTransport.init` / `TlsTransport.init` を await した**後**。そのため connect 中の ICE close では connect が中断されない | close 後も socket が最大 `connectTimeoutMs`（既定 8 秒）残る。UDP→TCP フォールバックでも同じ。下流のような再接続ストームでは、破棄済みピアの connect が積み上がる |
| R3 | `stun/tcpProtocol.ts` `TcpActiveProtocol.getSocket`（`:309-350`） | ICE-TCP の active connect にタイムアウトがない（OS 依存で 21〜127 秒）。connect 中に `close()` / `pruneForSelection()` が `socket.destroy()`（error なし）を呼ぶと `error` も `connect` も発火しないため、`connecting` が**永久に settle しない** | `pendingSockets` エントリと `sendFrame` の await が残り続ける。Transaction は cancel されるので利用者から見たハングにはならないが、settle しない Promise と参照が残る |
| R4 | `ice.ts` `Connection.close()`（`:1318-1323`） | protocol を 1 つずつ `await protocol.close()` で閉じ、失敗を隔離していない | どれか 1 つの close が reject すると残りの protocol が閉じられず、`close()` 自体も reject する。現行の組み込み protocol の close は reject しないので潜在リスクにとどまる |
| R5 | `common/src/event.ts` `asPromise`（`:265-271`） | timeLimit 超過時に文字列 `"Event asPromise timeout"` で reject する | Error ではないので、呼び出し側の `instanceof` 判定やスタック取得ができない。今回の経路では timeLimit を使っていないため参考扱い |

### 2.3 正常に扱われていることを確認した経路（テストで固定する対象）
- `Transaction.retry()` の `sendStun` 失敗は `.catch(log)`、`retry()` 自体も `.catch(log)` している（`stun/transaction.ts:248-250, 313-318`）。
- `cancelable()` は executor の reject を `.catch(() => {})` で吸収し、refresh ループの例外は外に出ない（`helper.ts:84`）。
- `TurnProtocol.connectionMade` は応答受信後に close 済みなら `TransactionCancelled` を返し、refresh を開始しない（`protocol.ts:323-325`）。
- `switchServer` は再接続中に close された場合、新しい接続を解放してから `TransactionCancelled` を返す（`protocol.ts:413-419`）。
- `getPermission` / `getChannel` のキューは失敗で汚染されない（`protocol.ts:857-861, 900-904`）。
- UDP socket の `error` は #749 の修正で処理済み。**本チケットでは再実装しない。**

## 3. 実装すべき具体的な変更

### 3.1 故障注入テスト（必須。最初に書く）
`packages/ice/tests/ice/turn-failure-propagation.test.ts`（新規）に、process レベルの監視をかけた故障マトリクスを書く。

- **共通 Arrange**: `packages/ice/tests/utils.ts` に次を追加する（AGENTS.md の「共有 Arrange は 1 ファイル」に従う）。
  - `watchProcessErrors()`: `uncaughtException` / `unhandledRejection` を収集し、`dispose` で外す。`packages/webrtc/tests/fixture.ts:797-809` と同じ形にする。
  - 故障を注入できる TURN TCP サーバ `createFaultyTurnTcpServer(mode)`: `turn-close-race.test.ts` の `listenTcp` を一般化したもの。mode は次のとおり。
    - `refuse`: listen 済みのポートを close して ECONNREFUSED にする
    - `blackhole`: accept するが応答しない
    - `rstOnConnect`: accept 直後に `socket.resetAndDestroy()`
    - `rstAfterAllocate`: Allocate 成功応答の後に RST
    - `endAfterAllocate`: Allocate 成功応答の後に FIN
    - `delayedResponse(ms)`: close 後に応答が届く状況を作る
- **マトリクス**（各ケースで、Act の後に `setImmediate` と短い待機で遅延 rejection を吐き出させ、`errors` が空であることを Assert する）:

| 故障 | 対象 API | 期待結果 |
| --- | --- | --- |
| ECONNREFUSED | `createTurnClient({transport:"tcp"})` | 捕捉可能な reject（`code: "ECONNREFUSED"`）。socket は残らない（`activeResourceCount("TCPSocketWrap")` で確認） |
| 接続タイムアウト（`blackhole` + 短い `connectTimeoutMs`） | 同上 | `tcp connect timed out` で reject |
| connect 直後の RST | 同上 | reject（ECONNRESET または transaction 失敗）。refresh タイマーは残らない |
| Allocate 中の close（`signal.abort()`） | 同上 | `TransactionCancelled`。transaction も socket も残らない |
| **TCP connect 中の abort**（R2） | 同上 | 即座に `TransactionCancelled` で reject し、`connectTimeoutMs` を待たない |
| close 後の遅延 Allocate 応答 | 同上 | 例外なし。refresh も開始しない |
| 割り当て後の RST / FIN（R1） | `TurnProtocol` | refresh ループが止まる。以降の `sendData` は捕捉可能なエラーか no-op になり、再送を続けない |
| ICE 統合: UDP 失敗 → TCP フォールバックも ECONNREFUSED | `Connection.gatherCandidates()`（`iceServers` に TURN） | `gatherCandidates()` が resolve し、`onIceCandidateError` が**ちょうど 1 回**。host candidate は残る |
| ICE 統合: TCP connect 中に `Connection.close()`（再接続ストーム相当。生成と close を N 回繰り返す） | 同上 | `close()` が `connectTimeoutMs` より十分短く完了し、`onIceCandidateError` は 0 回、`errors` は空 |
| ICE-TCP active の connect 中に close（R3） | `TcpActiveProtocol` | 保留中の `getSocket` が reject で settle し、`pendingSockets` が空になる |

### 3.2 是正（テストで欠陥が確認されたものだけ）
1. **R2: connect 中の abort**（優先度: 高。下流の再接続ストームに直結）
   - `createTurnClient` で、トランスポート生成の前から `signal` を監視する。`StreamTransportOptions` に `signal?: AbortSignal` を追加し、`StreamTransport` は abort 時に `rejectConnecting(new TransactionCancelled 相当)` と `client.destroy()` を呼ぶ。もしくは `createTurnClient` 内で `Promise.race` と後始末を組む。
   - `TcpTransport.init` / `TlsTransport.init` が abort で reject した場合も、既存どおり `close()` を通す。
   - 異常系の reject は `TransactionCancelled` に揃え、`gatherRelayCandidate` の「cancel は報告しない」判定（`candidateGatherer.ts:985-991`）と矛盾させない。
2. **R1: 接続確立後の切断検知**（優先度: 中）
   - `StreamTransport` で `close` / `end` を購読し、`closed = true` にしたうえで `Transport.onError?`（もしくは新設の `onClose` Event）を通知する。`Transport` インターフェースは optional を維持し、カスタム transport と互換にする。
   - `TurnProtocol.attachTransport()` でその通知を受け、refresh を停止し、未完了 transaction を失敗で settle させる。`TurnProtocol` 自身の `closed` は利用者の close と区別する。ICE への状態通知は既存の consent 失敗経路に任せ、二重通知を避ける。
   - `switchServer` の意図的な `previous.close()` で誤発火しないよう、古い transport の購読は解除する。
3. **R3: ICE-TCP active の connect が settle しない問題**（優先度: 中）
   - `registerSocket` の `close` リスナーか `pruneForSelection` から、保留中の `connecting` を reject させる。可能なら connect タイムアウトも追加する（既定値は既存オプションに合わせる。新しい公開オプションは必要な場合だけ追加する）。
4. **R4: close の隔離**（優先度: 低）
   - `Connection.close()` の protocol close を `Promise.allSettled` などで隔離し、失敗はログに残して残りの解放を続ける。`close()` 自体は reject させない（既存の利用者は `await close()` している）。
5. **R5**（任意）: `asPromise` の timeout を `Error` にする。影響範囲を `grep "asPromise("` で確認してから判断する。

### 3.3 記録
- 故障注入テストが修正前のコードで**すべて通った**場合（unhandledRejection が再現しない場合）は、本チケットに「現行版では再現しない。下流は werift 0.26.0 への更新で解決済み」と記録し、R1〜R4 は別チケットに分けるか本チケットで対応するかを決めて書き残す。
- 公開 API（`TurnClientOptions` / `StreamTransportOptions` / `Transport`）を変えた場合は、`npm run doc` で doc を再生成し、`changelog.md` を更新する。

## 4. 制約・注意点
- **#749 と重複実装しない**: `UdpTransport` の `error` / `onError` には手を入れない。UDP の故障はテストの前提として使うだけにする。
- **下流起因の可能性**: 下流のクラッシュは Windows 上で起きており、下流自身のライフサイクル（ピア置き換え時に、自前の connect や fetch の rejection を放置した可能性）に起因するかもしれない。werift 側の修正は、テストで再現した欠陥に限る。下流が提案した `socket.setTimeout` は、既存の `connectTimeoutMs` と役割が重なるので採用しない。
- **convenience behavior の維持**: TURN 失敗は今後も `onIceCandidateError`（RTCPeerConnection の `icecandidateerror`）と ICE 状態で通知し、`gatherCandidates()` / `setLocalDescription()` を reject させない。`createTurnClient` を直接呼ぶ利用者には reject で返す。
- **二重通知の禁止**: `onIceCandidateError` は 1 サーバにつき 1 回（UDP と TCP フォールバックを合わせて 1 回）、cancel と close では 0 回という既存の契約（`candidateGatherer.ts:911-917`）を壊さない。
- **erasable syntax**: `enum` やパラメータプロパティを使わない。新しいエラー種別は `exceptions.ts` の既存クラス（`TransactionCancelled` など）を使う。
- **テスト規約**: Arrange / Act / Assert で書き、Act と Assert には日本語コメントを付ける。共有 Arrange は `packages/ice/tests/utils.ts` に置く。タイマーに依存するケースは短い `connectTimeoutMs` / `turnConnectTimeout` と `vi.useFakeTimers` を使い分け、フレークを避ける。
- **ホスト依存**: マルチインターフェースのホストでは既存の一部テストが失敗する（host-dependent failures）。新しいテストは `127.0.0.1` に固定する。
- **プロセス停止**: テストサーバは参照を保持して `close()` / `destroy()` で止める。`pkill` は使わない。
- **作業ツリー**: 比較が必要な場合は `git worktree add --detach` で一時ワークツリーを作る。active worktree で stash / reset しない。

## 5. 完了条件
- [ ] §3.1 の故障マトリクスのテストが追加され、どのケースでも `uncaughtException` / `unhandledRejection` が 0 件。
- [ ] `createTurnClient` を TCP/TLS の connect 中に abort（ICE close）すると、`connectTimeoutMs` を待たずに `TransactionCancelled` で settle し、socket・タイマー・transaction が残らない（R2）。
- [ ] ICE 統合テストで、TURN TCP の connect 中に `Connection.close()` を繰り返しても close が確実に完了し、`onIceCandidateError` の二重通知も 0 回通知の破れも起きない。
- [ ] 接続確立後の RST / FIN で、TURN の refresh ループと再送が停止する（R1）。対応を見送る場合は理由と後続チケットを記録する。
- [ ] ICE-TCP active の connect 中 close で、保留中の Promise が settle する（R3）。見送る場合は R1 と同様に記録する。
- [ ] 再現しなかった場合は、§2 の調査結果と「現行版で非再現」という結論を本チケットに追記している。
- [ ] 検証: `cd packages/ice && npm test`、`npm run type`。`packages/common` を変えた場合は `cd packages/common && npm test` と `npm run test:small`。公開 API を変えた場合は `npm run doc` と `changelog.md` の更新。最後に `npm run format`。
