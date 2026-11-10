# [ICE] STUN/TURN到達失敗をicecandidateerrorとしてアプリへ通知する（#812）

## 元報告と判定
元Issue: #812（sidorares）。**妥当（developの静的検証）**。
`RTCPeerConnection`は[`onicecandidateerror`プロパティ](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/peerConnection.ts#L216-L222)を提供するが、現行コードに対応するエラーイベント生成・通知処理はない。`UdpTransport.onError`のみではDNS、STUN transaction timeout、TURN allocation、EHOSTUNREACHなどの収集失敗がアプリへ伝わらない。

---

## 1. 目的と背景

- W3C WebRTC は、ICE gathering 中に STUN/TURN サーバーの利用に失敗したら `RTCPeerConnectionIceErrorEvent`（`address` / `port` / `url` / `errorCode` / `errorText`）を `icecandidateerror` として発火すると定めている（WebRTC §4.8.2、IDL は `third_party/wpt/interfaces/webrtc.idl:235-250`）。
- werift はハンドラ属性 `onicecandidateerror`（`packages/webrtc/src/peerConnection.ts:216-222`、型は `CallbackWithValue<any>`、`api/peerConnectionEvents.ts:46`）を持つだけで、イベントを発火するコードはない。そのため、TURN の認証情報誤り、DNS 名の誤り、UDP 遮断などで relay / srflx 候補が出なくても、アプリは「接続できない理由」を知る手段がない。ログ（`debug`）を読むしかない。
- 目的: 設定した ICE サーバー（URL）ごとの失敗をアプリが特定できるようにする。正常な gathering 経路（候補の出る順序とタイミング、end-of-candidates、`iceGatheringState`）には影響を与えない。

## 2. 現状調査（develop @ `0f761d0d5`）

### 2.1 ICE 層（`packages/ice/src/ice.ts`）

| 箇所 | 現状 | 問題 |
| --- | --- | --- |
| `getCandidatePromises` `queryReflexive`（`ice.ts:1357-1370`） | `serverReflexiveCandidate()` と `stunGatherTimeout` タイマーを race させ、失敗もタイムアウトも `undefined` を返す | 失敗の理由が呼び出し側に届かない |
| `serverReflexiveCandidate`（`iceBase.ts:468-511`） | `protocol.request()` の例外をすべて `catch` して `log` し、`undefined` を返す（`// todo fix`） | `TransactionTimeout` / `TransactionFailed`（STUN error response）/ DNS `ENOTFOUND` / `AddressFamilyMismatch` を区別できない。`queryReflexive` の `.catch` には到達しない |
| STUN 送信先 DNS | `StunProtocol.request` → `resolveRequestAddress`（`stun/transaction.ts:27-40`、`dns.lookup`）。ソケット × サーバーごとに引く | DNS 失敗は reject されるが、上の catch で握りつぶされる |
| 送信エラー | `Transaction` の `sendStun().catch(log)`（`stun/transaction.ts:311`）、`StunProtocol` の `transport.onError.subscribe(log)`（`stun/protocol.ts:55`）、`TurnProtocol.attachTransport`（`turn/protocol.ts:332`） | EHOSTUNREACH や ENETUNREACH ではトランザクションが再送を続け、タイムアウトで初めて失敗する（理由は失われる） |
| TURN `gatherRelayCandidate`（`ice.ts:1465-1540`） | `createStunOverTurnClient` が失敗すると、UDP なら TCP で 1 回再試行する。最終失敗は `getCandidatePromises` の `.catch(log)`（`ice.ts:1527-1533`） | 失敗の理由（`TransactionFailed` の ERROR-CODE、`TurnRedirectError`、TCP connect timeout、TLS 検証失敗、`ENOTFOUND`）が捨てられる |
| TURN 401/438 | `requestWithRetry`（`turn/protocol.ts:727-770`）が最初の challenge（`TransactionChallenge`）で realm と nonce を得て再送し、2 回目の challenge やその他のエラーで throw する | 正常な再送は内部で完結している。イベントは最終 reject 時だけ出せばよい |
| 世代・close | `stale = () => !this.isGathering(generation)`、`closing.signal`（abort 時は `TransactionCancelled`）、`closedSignal` | 抑制の仕組みは揃っている。エラー通知も同じ `stale()` で判定できる |
| 公開イベント | `Connection` には `onData` / `stateChanged` / `onIceCandidate` しかない（`ice.ts:173-175`）。`IceConnection` interface（`iceBase.ts:18-`）も同じ | エラー用のイベントがない |

### 2.2 サーバー識別子（URL との対応）

- `Connection` に渡るのは `stunServers: Address[]` と `turnServers: Required<TurnServerOptions>[]`（`{address, username, password, transport}`）だけで、**URL 文字列は ICE 層に届かない**。
- webrtc 層の `parseIceServers`（`packages/webrtc/src/utils.ts:141-215`）と `parseIceServerUrl`（`utils.ts:244-`）が URL をパースし、重複（同じ STUN address、または同じ TURN address・transport・credential）を 1 つにまとめる。`stuns:` は `stun:` と同じく UDP 扱い。
- `secureTransportManager.resolveIceServerOptions`（`secureTransportManager.ts:122-160`）は、URL に transport の指定がないとき `turnTransport` / `forceTurnTCP` で決める。ICE restart や `setConfiguration` 後のサーバー差し替えは `RTCIceTransport`（`transport/ice.ts:360`）から `mergeIceServerOptions` に渡る。
- 設定に STUN URL がなく `useDefaultStunServer !== false` のときは、ICE 層が `stun.l.google.com:19302` を補う（`ice.ts:50, 217-224`）。この既定サーバーに対応する URL は設定に存在しない。

### 2.3 webrtc 層の伝播経路

`Connection.onIceCandidate` → `RTCIceGatherer`（`transport/ice.ts:935-`、コールバック `onIceCandidate`）→ `RTCIceTransport.onIceCandidate`（`transport/ice.ts:215, 224`）→ `RTCPeerConnection` が transport を作るときに subscribe（`peerConnection.ts:878-`、`applyingIceRestart` と pending-only transport では抑制）→ `onIceCandidate.execute` / `onicecandidate?.()` / `emit("icecandidate")`。

`RTCPeerConnection extends EventTarget`（`helper.ts:36`、`EventEmitter` ベース）。`emit(type, event)` は event に `type` を付ける。

### 2.4 WPT

- `third_party/wpt/webrtc/RTCPeerConnection-onicecandidateerror.https.html` には 2 つの subtest がある。
  1. `turn:123`（不正ホスト）で `event instanceof RTCPeerConnectionIceErrorEvent`、`300 <= errorCode <= 799`、`port == 0` なら `address === null`、そうでなければ `address` に `.` か `:` を含むこと、`url.includes("123")` を確認する。
  2. 4 サーバー（`turn:…:3478`、`turn:…?transport=tcp`、`turns:…:5349`、`stun:…`）それぞれの URL でイベントが出ることを確認する。**`turns:turn3.invalid:5349` は `"turns:turn3.invalid:5349?transport=tcp"` として期待されている**（Chrome の正規化）。
- `packages/webrtc/wpt/allowlist.json` に、このファイルはまだ登録されていない。
- ラッパー `tools/wpt-runner/runner.ts:567-578` は `onicecandidateerror` を event attribute として定義済み。グローバルの `RTCPeerConnectionIceErrorEvent` は polyfill（`src/polyfill/install.ts:36, 105`、`globals.ts`）に存在せず、`RTCTrackEvent` と同じように追加する必要がある。
- WPT の `port` が `null` だと `null == 0` は false になり、`address.includes` が TypeError で落ちる。そのため、ローカルアドレスが不明なときは **`address: null, port: 0`**（Chrome と同じ）にする。

## 3. 実装内容

### 3.1 ICE 層: 型付きエラーイベント

`packages/ice/src` に次を追加する（`index.ts` から export する）。

```ts
/** One STUN/TURN server of the gathering, as configured. */
export type IceServerRef =
  | { kind: "stun"; address: Address }
  | { kind: "turn"; address: Address; transport: "udp" | "tcp" | "tls" };

export type IceCandidateErrorInfo = {
  server: IceServerRef;
  /** Local address used to contact the server; undefined when unknown or hidden. */
  address?: string;
  /** Local port; undefined when `address` is. */
  port?: number;
  /** STUN error code (300-699) received, or 701 when the server was not reached. */
  errorCode: number;
  /** Reason phrase; never contains credentials. */
  errorText: string;
  generation: number;
};
```

- `Connection` に `readonly onIceCandidateError = new Event<[IceCandidateErrorInfo]>()` を追加し、`IceConnection` interface にも加える。`close()` で `complete()` / `allUnsubscribe()` する（既存の `onIceCandidate` の終了処理に揃える）。
- 701 などの定数とエラーの分類ヘルパーは `exceptions.ts` かその近くに 1 か所でまとめる。

```ts
function classifyGatherError(error: unknown): { errorCode: number; errorText: string } | undefined
```

| 例外 | errorCode | errorText（例） |
| --- | --- | --- |
| `TransactionCancelled`、`closing.signal.aborted` | 通知しない | – |
| `TransactionChallenge`（2 回目の 401/438） | 401 / 438 | `"Unauthorized"` などのサーバーの reason phrase |
| `TransactionFailed`（ERROR-CODE あり。403、437、441、486、508、および STUN Binding の 4xx/5xx） | ERROR-CODE の値 | reason phrase |
| `TurnRedirectError` | 300（cause の ERROR-CODE） | `reason`（`loop` など） |
| `TransactionTimeout`、`stunGatherTimeout` の満了 | 701 | `"STUN binding request timed out"` / `"TURN allocate request timed out"` |
| DNS（`ENOTFOUND`、`EAI_AGAIN` など）、`AddressFamilyMismatch` | 701 | `"Address resolution failed"` / `"No address of the socket family"` |
| TCP / TLS 接続失敗（`ECONNREFUSED`、connect timeout、証明書検証） | 701 | `"TCP connect failed"` / `"TLS handshake failed"` |
| socket error（`EHOSTUNREACH`、`ENETUNREACH`） | 701 | `"Host unreachable"` などの errno 名 |

### 3.2 STUN（srflx）の失敗を捕捉する

- `serverReflexiveCandidate` が例外を握りつぶさないようにする。互換性のため、関数名は変えずに中身を「成功なら Candidate、失敗なら throw」にする。この関数は export されているので、外部の呼び出し元への影響を changelog に書く。throw させずに `{ candidate } | { error }` を返す形にしてもよい。どちらを採るか決めてから着手する。
- `queryReflexive` は、成功なら Candidate を返し、失敗なら `classifyGatherError` の結果と `protocol.localCandidate`（host の address / port）を添えて `emitCandidateError` を呼ぶ。`stunGatherTimeout` が満了したときは 701 を通知し、満了後に届いた遅い成功や失敗は無視する（**サーバー × ソケット × 世代ごとに通知は最大 1 回**）。
- 新規ソケットの経路と、ICE restart で再利用されるソケットの経路（`reusedReflexivePromises`）の両方を対象にする。1 つのサーバーが失敗しても、`Promise.all` の他のサーバーや他のソケットは止めない。各 `stunServers.map` 要素の中で完結させ、外へ throw しない。
- 発火の直前に `stale()` を確認し、古い世代や close 済みなら捨てる。

### 3.3 TURN（relay）の失敗を捕捉する

- `getCandidatePromises` の `.catch`（`ice.ts:1527-1533`）で、`stale()` でなく、かつ `classifyGatherError` が通知対象とした失敗について、`server: { kind: "turn", address, transport }` で通知する。
- **UDP から TCP へのフォールバックは 1 つの設定サーバーに対する試行として扱う**。最初の試行（UDP）の失敗では通知せず、最終的に失敗したときに 1 回だけ通知する。errorCode は、どちらかの試行でサーバーが返した STUN エラーコードを 701 より優先する（例: UDP は 701 で TCP が 401 なら 401）。`gatherRelayCandidate` の中で両方の失敗を保持し、その組み合わせで判断する。
- 正常な 401/438 の再送は `requestWithRetry` の中で完結するので、イベントにしない（最終的に reject されたときだけ通知する）。
- ローカルアドレス: UDP の TURN ソケットは wildcard bind なので通常は不明になる。`address` は undefined（webrtc 層で `null` / `0` にする）。`relayOnly`（`iceTransportPolicy: "relay"`）のときは、ローカルアドレスを常に隠す（`ice.ts:1510-1514` の方針と揃える）。

### 3.4 送信エラーの早期失敗（任意）

- 最低要件は「EHOSTUNREACH でも、タイムアウトによる 701 が最終的に通知されること」。
- 余力があれば、`Transaction` の `sendStun` が reject したとき（DNS 名の送信先、あるいは送信先 address / port 付きの socket error）に、そのトランザクションを `fail(error)` で即時に終わらせる。これで理由を errno のまま早く返せる。ただし ICE connectivity check や consent のトランザクションの挙動も変わるので、gathering 用のトランザクションだけを対象にするか、全体を対象にするかを判断して別のテストで固める。影響が大きければ別チケットに切り出す。

### 3.5 webrtc 層: URL 対応と公開イベント

1. **URL の対応付け**: `parseIceServers` の結果に、各サーバーの `url`（設定値の文字列）を残す。`ParsedTurnServer` に `url` を追加し、STUN 側は `stunServerUrls` か `{address, url}` の並びで持つ。重複してまとめた場合は最初の URL を使う。`resolveIceServerOptions` / `iceServerSettings` で、`IceServerRef`（kind + address + transport）から URL を引く表を作り、`RTCIceGatherer` に渡す。`setConfiguration` / ICE restart でサーバーが入れ替わったときは、表も同じ世代で入れ替える。
   - 既定の STUN（`stun.l.google.com:19302`）は合成した URL `stun:stun.l.google.com:19302` で通知する（設定にない werift 独自の挙動として TSDoc に書く）。
   - `turns:` の URL 表記: **設定値をそのまま返す**のか、WPT subtest 2 の期待どおり Chrome 式に正規化する（`turns:h:p` を `turns:h:p?transport=tcp` に）のかを決める。仕様は「failure の起きたサーバーを識別する URL」としか定めていない。推奨は設定値をそのまま返すこと。その場合 subtest 2 は allowlist の対象外とし、理由を `reason` に書く。正規化を採る場合は `src` 側の挙動として一貫させ、`wpt-runner` だけに入れない。
2. **イベントクラス**: `api/peerConnectionEvents.ts` に `RTCPeerConnectionIceErrorEvent` を追加する（`RTCTrackEvent` と同じ形。`type = "icecandidateerror"` と、`address: string | null`、`port: number | null`、`url`、`errorCode`、`errorText` の readonly。constructor は `(type, init)`）。`index.ts` から export し、polyfill の `install.ts` と `globals.ts` にグローバルとして追加する。
3. **伝播**: `RTCIceGatherer` で `connection.onIceCandidateError` を subscribe し、URL へ変換した `onIceCandidateError` を、`RTCIceTransport`、`SecureTransportManager`（または `RTCPeerConnection` の transport 作成時の subscribe）、`RTCPeerConnection` の順に伝える。`RTCPeerConnection` には `readonly onIceCandidateError = new Event<[RTCPeerConnectionIceErrorEvent]>()` を追加し、同じイベントオブジェクトで `onicecandidateerror?.(event)` と `emit("icecandidateerror", event)` を呼ぶ（`icecandidate` と同じ 3 経路）。`onicecandidateerror` の setter と getter の型は `CallbackWithValue<RTCPeerConnectionIceErrorEvent>` にする。
4. **抑制**:
   - `pc.close()` 後は発火しない（`connectionState === "closed"` を確認する。transport の `close` で Event を complete する）。
   - ICE restart で前の世代になった gathering の失敗は捨てる（ICE 層の `stale()`。webrtc 層では `generation` を照合する）。
   - pending-only transport（rollback で破棄される transport）の失敗の扱いは、`onIceCandidate` の抑制（`peerConnection.ts:879-883`）と揃える。
5. **アドレスの露出**: `address` と `port` は、host candidate のアドレスが分かっていて `iceTransportPolicy !== "relay"` のときだけ設定する。それ以外は `address: null, port: 0`。
6. **errorText**: 生成する文字列にユーザー名、パスワード、realm、nonce、MESSAGE-INTEGRITY を含めない。`TurnRedirectError.message` のようにサーバーのアドレスを含むものは許容するが、URL の credential 部（`turn:user@host` 形式）は出さない。

### 3.6 ドキュメント

- `changelog.md`: `icecandidateerror` の実装、`RTCPeerConnectionIceErrorEvent` の追加、`serverReflexiveCandidate` の挙動変更（変えた場合）。
- `packages/webrtc/README.md` かサンプル: TURN の失敗を `pc.addEventListener("icecandidateerror", …)` でログに出す例を短く載せる。
- `npm run doc` で生成ドキュメントを作り直す。

## 4. 制約・注意点

- **正常経路に影響させない**: 候補が出る順序、`localCandidatesEnd`、end-of-candidates、`iceGatheringState` の遷移は変えない。エラーの通知は同期的に `Event.execute` するだけにし、gathering の Promise を reject させない。アプリのハンドラが throw しても gathering が止まらないようにする（`Event` の既存の挙動を確認する）。
- **重複の抑制**: 同じ (世代, サーバー, ローカルソケット) について通知は 1 回にする。STUN はソケットごとに出るので、IPv4 のホストアドレスが複数あれば同じ URL でも `address` 違いで複数のイベントが出る（仕様どおり）。
- **IPv6**: 現在の STUN query は IPv4 ソケットだけが行う（`ice.ts:1386, 1417-1419`）。IPv6 ソケットは query しないので、AddressFamilyMismatch のイベントは出ない。この範囲は変えない。
- **タイムアウトの二重性**: `stunGatherTimeout`（既定 5 秒）は STUN の再送全体（約 39.5 秒）より短い。タイマーが満了した時点で 701 を通知して確定する。トランザクション自体は従来どおり裏で終わるのを待つ。
- **close 中の abort**: `closing.signal` による `TransactionCancelled` や、close 後の reject はすべて通知しない。listener は `close()` で解除する（memleak の観点。`tests/pbt/leak` の footprint に Event の subscriber が増えないことを確認する）。
- **erasable syntax**: `enum` は使わない（AGENTS.md）。errorCode の定数は `as const` オブジェクトにする。
- **WPT 専用の厳格化は `tools/wpt-runner/*` に閉じ込める**。`src` の挙動を WPT に合わせて変える場合は、werift の利便性を損なわないことを確認する。
- `debug` のログには従来どおり詳細を出してよい。ただし credential は出さない。

## 5. テスト計画

AGENTS.md に従い Arrange / Act / Assert 形式で書き、Act と Assert には日本語のコメントを付ける。

- **ICE（`packages/ice/tests/ice/`、新規 `candidate-error.test.ts`）**。共通の Arrange（応答しない UDP の STUN サーバー、エラーを返す STUN/TURN のスタブ、イベントの収集）は `packages/ice/tests/utils.ts`、またはこのテスト領域用の 1 つのユーティリティファイルにまとめる。
  - [ ] 存在しない DNS 名の STUN（`stun.invalid`）: `errorCode 701`、`server.address` が一致、`address` が host candidate。
  - [ ] 応答しない STUN 宛先（ローカルの閉じた UDP ポートか、無応答のソケット）。`stunGatherTimeout` を短くし、満了で 701 が 1 回だけ出る。
  - [ ] STUN Binding のエラー応答（例: 400）で、そのコードが出る。
  - [ ] TURN で 2 回目の 401（誤った credential）: 401、`errorText` に username / password を含まない。
  - [ ] TURN の UDP 失敗と TCP 失敗: イベントは 1 回で、STUN のエラーコードが 701 より優先される。
  - [ ] 正常な 401 → 再送 → 成功、または 438 → 再送 → 成功のとき、イベントは 0 件で relay candidate が出る（既存の `turn-long-term-credential.test.ts` などのスタブを流用する）。
  - [ ] 正常な STUN/TURN と失敗するサーバーが混在しても、正常な srflx / relay candidate が出て、`gatherCandidates()` が完了する。
  - [ ] close / ICE restart 中に終わった失敗は通知されない（`turn-close-during-allocation`、`gather-generation` 系の Arrange を流用する）。
  - [ ] EHOSTUNREACH: ルーティングできない宛先（例: TEST-NET で到達しない環境依存のもの）は CI で不安定になりうる。`sendStun` の reject をスタブで注入して 701 を確認する。
- **webrtc（`packages/webrtc/tests/`）**
  - [ ] `addEventListener("icecandidateerror")` と `onicecandidateerror` が同じイベントオブジェクト（`instanceof RTCPeerConnectionIceErrorEvent`）を受け取り、`url` が設定値の URL と一致する。
  - [ ] 同じ host で URL / transport が違う 2 つの TURN が、別々の URL で通知される。
  - [ ] `iceTransportPolicy: "relay"` では `address === null && port === 0`。
  - [ ] `close()` 後はイベントが出ない。ICE restart 後は古い世代のイベントが出ない。
- **WPT**
  - [ ] `webrtc/RTCPeerConnection-onicecandidateerror.https.html` を `wpt/allowlist.json` に追加する。subtest 1 は必須。subtest 2 は URL 正規化の決定（3.5-1）に従う。`npm run wpt` と `npm run wpt:coverage` を実行する。

## 6. 検証コマンド

- `cd packages/ice && npm test`、`cd packages/webrtc && npm test`
- 複数パッケージ・公開 API の変更なので、`npm run type` と `npm run test:small`
- `npm run wpt`、`npm run wpt:coverage`（allowlist と baseline の更新）
- `npm run format`、`npm run doc`

## 7. 完了条件

- [ ] DNS 失敗、STUN の無応答やエラー応答、TURN の認証・割り当て・接続の失敗のそれぞれで、`RTCPeerConnectionIceErrorEvent` が `url` / `errorCode` / `errorText` / `address` / `port` 付きで `icecandidateerror`（EventTarget）と `onicecandidateerror` の両方に届く。到達できない失敗は 701、サーバーから受けたエラーはそのコード。
- [ ] 1 つのサーバーが失敗しても、他のサーバーや他のソケットの gathering は続き、正常な候補と end-of-candidates は従来どおり出る。
- [ ] 正常な 401/438 の再送が成功したときは通知しない。`errorText` に credential を含めない。
- [ ] close、ICE restart、世代の切り替え後には古いイベントを出さず、listener がリークしない。
- [ ] WPT `RTCPeerConnection-onicecandidateerror.https.html`（少なくとも subtest 1）が allowlist に入って通る。
- [ ] changelog、README、生成ドキュメントを更新する。

## 8. 着手前に決めること

1. `serverReflexiveCandidate` を「失敗なら throw」に変えるか、別の関数か戻り値の型を追加するか（公開 API の互換性）。
2. `turns:` URL の表記を、設定値のまま返すか Chrome 式に正規化するか（WPT subtest 2 の扱い）。
3. 既定の STUN サーバーの失敗を通知するか（推奨: 合成した URL で通知する）。
4. 送信エラーでトランザクションを即時に失敗させる処理（3.4）を、このチケットに含めるか別チケットにするか。
