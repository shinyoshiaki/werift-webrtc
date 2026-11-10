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
- **WPT の所要時間**: runner の completion timeout は file ごとに 800ms〜2.5s（`tools/wpt-runner/timeoutLogic.ts`）。subtest 1 の `turn:123` は `dns.lookup("123")` で `0.0.0.123` に解決され、UDP の送信はエラーにならない（Linux で確認済み。send callback の error は null）。そのため、UDP の Allocate はトランザクションのタイムアウト（`RETRY_RTO = 50ms` を倍々にして 7 回送るので約 6.35s）で初めて失敗し、そのあと TCP へフォールバックする。subtest 2 の `.invalid` は DNS 失敗ですぐ終わる。この file には、`timeoutLogic.ts` に `onicecandidateerror` 用のプロファイル（completion 10s 程度）を追加する必要がある。これは runner 側だけの変更で、`src` の挙動は変えない。

## 3. 実装内容

### 3.1 ICE 層: 型付きエラーイベント

`packages/ice/src` に次を追加する（`index.ts` から export する）。

```ts
/** One STUN/TURN server of the gathering, as configured. */
export type IceServerRef =
  | { kind: "stun"; address: Address }
  | {
      kind: "turn";
      address: Address;
      transport: "udp" | "tcp" | "tls";
      /** `TurnServerOptions.urls` of the server, passed through (see 3.5-1). */
      urls?: string[];
    };

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

- **決定: `serverReflexiveCandidate` の挙動は変えない（非破壊）。失敗時に throw する関数を別に追加する。**
  - 新しい関数 `queryServerReflexiveCandidate(protocol, stunServer): Promise<Candidate>` を `iceBase.ts` に追加して export する。この関数は失敗を握りつぶさずに reject する。reject するのは、`protocol.request()` の `TransactionTimeout` / `TransactionFailed` / DNS エラー / `AddressFamilyMismatch` / `TransactionCancelled` と、成功応答に `XOR-MAPPED-ADDRESS` がない場合（新しい `Error` サブクラスを用意し、701 に分類する）。`protocol.localCandidate` がない場合は、request を送る前に throw する。
  - 既存の `serverReflexiveCandidate` は、`queryServerReflexiveCandidate(...).catch((error) => { log(...); return undefined; })` の薄いラッパーにする。シグネチャ（`Promise<Candidate | undefined>`）と「失敗しても reject しない」という契約は従来どおり。TSDoc に「失敗の理由が必要なら `queryServerReflexiveCandidate` を使う」と書く（`@deprecated` は付けない）。
  - 理由: (1) `werift-ice` と `werift`（`doc/functions/serverReflexiveCandidate.md`）の公開 API で、戻り値の型にもともと `undefined` が含まれている。呼び出し側は undefined を処理する前提なので、throw に変えると、未処理の rejection やクラッシュとして黙って壊れる。(2) v0.27.0 で破壊的変更をまとめて出した直後であり、Issue の修正で互換性を壊す理由がない。(3) `{ candidate } | { error }` という独自の Result 型は、リポジトリの既存のスタイル（例外クラスで分類する。`exceptions.ts`）と合わない。throw する版を 1 つ追加するのが最小の変更になる。
  - changelog は **🚀 Features** に「`queryServerReflexiveCandidate` の追加」を載せる。Breaking changes には載せない。
- gathering の `queryReflexive`（`ice.ts:1357-1370`）は、`serverReflexiveCandidate` ではなく `queryServerReflexiveCandidate` を呼ぶ。成功なら Candidate を返し、失敗なら `classifyGatherError` の結果と `protocol.localCandidate`（host の address / port）を添えて `emitCandidateError` を呼ぶ。`stunGatherTimeout` が満了したときは 701 を通知し、満了後に届いた遅い成功や失敗は無視する（**サーバー × ソケット × 世代ごとに通知は最大 1 回**）。
- 新規ソケットの経路と、ICE restart で再利用されるソケットの経路（`reusedReflexivePromises`）の両方を対象にする。1 つのサーバーが失敗しても、`Promise.all` の他のサーバーや他のソケットは止めない。各 `stunServers.map` 要素の中で完結させ、外へ throw しない。
- 発火の直前に `stale()` を確認し、古い世代や close 済みなら捨てる。

### 3.3 TURN（relay）の失敗を捕捉する

- `getCandidatePromises` の `.catch`（`ice.ts:1527-1533`）で、`stale()` でなく、かつ `classifyGatherError` が通知対象とした失敗について、`server: { kind: "turn", address, transport, urls }`（`urls` は `TurnServerOptions.urls` をそのまま入れる。credential は入れない）で通知する。
- **UDP から TCP へのフォールバックは 1 つの設定サーバーに対する試行として扱う**。最初の試行（UDP）の失敗では通知せず、最終的に失敗したときに 1 回だけ通知する。errorCode は、どちらかの試行でサーバーが返した STUN エラーコードを 701 より優先する（例: UDP は 701 で TCP が 401 なら 401）。`gatherRelayCandidate` の中で両方の失敗を保持し、その組み合わせで判断する。
- 正常な 401/438 の再送は `requestWithRetry` の中で完結するので、イベントにしない（最終的に reject されたときだけ通知する）。
- ローカルアドレス: UDP の TURN ソケットは wildcard bind なので通常は不明になる。`address` は undefined（webrtc 層で `null` / `0` にする）。`relayOnly`（`iceTransportPolicy: "relay"`）のときは、ローカルアドレスを常に隠す（`ice.ts:1510-1514` の方針と揃える）。

### 3.4 送信エラーの早期失敗（任意）

- 最低要件は「EHOSTUNREACH でも、タイムアウトによる 701 が最終的に通知されること」。
- 余力があれば、`Transaction` の `sendStun` が reject したとき（DNS 名の送信先、あるいは送信先 address / port 付きの socket error）に、そのトランザクションを `fail(error)` で即時に終わらせる。これで理由を errno のまま早く返せる。ただし ICE connectivity check や consent のトランザクションの挙動も変わるので、gathering 用のトランザクションだけを対象にするか、全体を対象にするかを判断して別のテストで固める。影響が大きければ別チケットに切り出す。

### 3.5 webrtc 層: URL 対応と公開イベント

1. **URL の表記（決定: `src` 側で正規化し、Chrome / WPT と合わせる）**
   - `parseIceServerUrl` に、通知用の URL を作る `canonicalIceServerUrl` を追加する。規則は次の 1 つだけにする。
     - 設定値の前後の空白を除き、scheme を小文字にした文字列を基本とする（host、port、その他の query は設定値のまま。port の補完はしない）。
     - **`turns:` で `transport` query がない場合だけ、`?transport=tcp` を付ける**（`turns:h:5349` は `turns:h:5349?transport=tcp` に）。RFC 7065 §3 では `turns:` の既定の transport は TCP（TLS over TCP）なので、既定値を明示するだけで、指しているサーバーは変わらない。
     - `turn:`（既定は UDP）、`stun:`、`stuns:` には何も付けない（WPT は `turn:turn1.invalid:3478` と `stun:stun1.invalid:3478` をそのまま期待している）。werift 独自の「`turn:` の UDP が失敗したら TCP にフォールバックする」挙動があっても、URL は `turn:h:p` のままにする（3.3 の 1 サーバー 1 通知）。
   - 理由: (1) 仕様が定めているのは「failure の起きたサーバーを識別する URL」までで、表記を決めているのは upstream WPT（Chrome が通る）だけ。interop の基準として WPT に従う。(2) 正規化しても指すサーバーは変わらない。アプリが URL を突き合わせる場合も、`turns:` の既定値を明示するだけなので影響は小さい。TSDoc と changelog に規則を書く。(3) AGENTS.md（Do 5）に従い、厳格化を `wpt-runner` だけに入れることはしない。この規則は werift の通常の挙動として `src` に置く。これで subtest 2 も allowlist に含められる。
2. **URL とサーバーの対応付け**
   - STUN: 同じ address の STUN はもともと 1 つのサーバーにまとめられ、credential もない。そのため webrtc 層で `address → url[]` の表を作る。`parseIceServers` の結果に `stunServerUrls: { address, url }[]` を追加し、正規化した URL を設定順に並べる。
   - TURN: 同じ address でも credential が違えば別の allocation になる。address と transport だけでは識別できないので、**`TurnServerOptions` に任意のメタデータ `urls?: string[]` を追加する**（公開型への追加。ICE 層は allocation には使わない）。webrtc の `resolveIceServerOptions` が、正規化した URL を `urls` に入れて渡す。`normalizeIceServerOptions` で重複を 1 つにまとめるときは `urls` を合わせる。ICE 層は、その値を `IceServerRef.urls` にそのまま入れて通知する。これで credential をイベントに載せずに対応付けられる（戻り値の型は `Required<Omit<TurnServerOptions, "urls">> & Pick<TurnServerOptions, "urls">` に変える）。
   - 1 つのサーバーに複数の URL が対応する場合（例: `stun:a:3478` と `stuns:a:3478`、`turn:h:3478` と `turn:h:3478?transport=udp`）は、**対応する URL ごとに 1 イベントずつ出す**（URL の重複は除く）。アプリが設定した URL は、どれも失敗として見える。
   - `setConfiguration` / ICE restart でサーバーが入れ替わると、`urls` も gather options と一緒に入れ替わる。そのため、世代と対応表がずれない。
   - 既定の STUN（`stun.l.google.com:19302`）は合成した URL `stun:stun.l.google.com:19302` で通知する（設定にない werift 独自の挙動として TSDoc に書く）。
3. **イベントクラス**: `api/peerConnectionEvents.ts` に `RTCPeerConnectionIceErrorEvent` を追加する（`RTCTrackEvent` と同じ形。`type = "icecandidateerror"` と、`address: string | null`、`port: number | null`、`url`、`errorCode`、`errorText` の readonly。constructor は `(type, init)`）。`index.ts` から export し、polyfill の `install.ts` と `globals.ts` にグローバルとして追加する。
4. **伝播**: `RTCIceGatherer` で `connection.onIceCandidateError` を subscribe し、URL へ変換した `onIceCandidateError` を、`RTCIceTransport`、`SecureTransportManager`（または `RTCPeerConnection` の transport 作成時の subscribe）、`RTCPeerConnection` の順に伝える。`RTCPeerConnection` には `readonly onIceCandidateError = new Event<[RTCPeerConnectionIceErrorEvent]>()` を追加し、同じイベントオブジェクトで `onicecandidateerror?.(event)` と `emit("icecandidateerror", event)` を呼ぶ（`icecandidate` と同じ 3 経路）。`onicecandidateerror` の setter と getter の型は `CallbackWithValue<RTCPeerConnectionIceErrorEvent>` にする。
5. **抑制**:
   - `pc.close()` 後は発火しない（`connectionState === "closed"` を確認する。transport の `close` で Event を complete する）。
   - ICE restart で前の世代になった gathering の失敗は捨てる（ICE 層の `stale()`。webrtc 層では `generation` を照合する）。
   - pending-only transport（rollback で破棄される transport）の失敗の扱いは、`onIceCandidate` の抑制（`peerConnection.ts:879-883`）と揃える。
6. **アドレスの露出**: `address` と `port` は、host candidate のアドレスが分かっていて `iceTransportPolicy !== "relay"` のときだけ設定する。それ以外は `address: null, port: 0`。
7. **errorText**: 生成する文字列にユーザー名、パスワード、realm、nonce、MESSAGE-INTEGRITY を含めない。`TurnRedirectError.message` のようにサーバーのアドレスを含むものは許容するが、URL の credential 部（`turn:user@host` 形式）は出さない。

### 3.6 ドキュメント

- `changelog.md`（🚀 Features。Breaking changes には載せない）: `icecandidateerror` / `onicecandidateerror` の実装、`RTCPeerConnectionIceErrorEvent` の追加と polyfill のグローバル、`werift-ice` の `Connection.onIceCandidateError`・`queryServerReflexiveCandidate`・`TurnServerOptions.urls` の追加、URL の表記規則（`turns:` に `?transport=tcp` を補う）。`serverReflexiveCandidate` は変えない、と明記する。
- `packages/webrtc/README.md` かサンプル: TURN の失敗を `pc.addEventListener("icecandidateerror", …)` でログに出す例を短く載せる。
- `npm run doc` で生成ドキュメントを作り直す。

## 4. 制約・注意点

- **正常経路に影響させない**: 候補が出る順序、`localCandidatesEnd`、end-of-candidates、`iceGatheringState` の遷移は変えない。エラーの通知は同期的に `Event.execute` するだけにし、gathering の Promise を reject させない。アプリのハンドラが throw しても gathering が止まらないようにする（`Event` の既存の挙動を確認する）。
- **重複の抑制**: 同じ (世代, サーバー, ローカルソケット) について通知は 1 回にする。STUN はソケットごとに出るので、IPv4 のホストアドレスが複数あれば同じ URL でも `address` 違いで複数のイベントが出る（仕様どおり）。
- **IPv6**: 現在の STUN query は IPv4 ソケットだけが行う（`ice.ts:1386, 1417-1419`）。IPv6 ソケットは query しないので、AddressFamilyMismatch のイベントは出ない。この範囲は変えない。
- **タイムアウトの二重性**: `stunGatherTimeout`（既定 5 秒）は UDP の STUN 再送全体（`RETRY_RTO` 50ms を倍々にして 7 回送るので約 6.35 秒）より短い。タイマーが満了した時点で 701 を通知して確定する。トランザクション自体は従来どおり裏で終わるのを待つ。
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
  - [ ] `queryServerReflexiveCandidate` は timeout / error response / DNS 失敗 / `XOR-MAPPED-ADDRESS` 欠落で reject する。同じ条件で `serverReflexiveCandidate` は従来どおり `undefined` を返し、reject しない（互換性の回帰テスト）。
  - [ ] `normalizeIceServerOptions` で重複をまとめるとき、`urls` が合わさる。`IceServerRef.urls` に credential は載らない。
  - [ ] EHOSTUNREACH: ルーティングできない宛先（例: TEST-NET で到達しない環境依存のもの）は CI で不安定になりうる。`sendStun` の reject をスタブで注入して 701 を確認する。
- **webrtc（`packages/webrtc/tests/`）**
  - [ ] `addEventListener("icecandidateerror")` と `onicecandidateerror` が同じイベントオブジェクト（`instanceof RTCPeerConnectionIceErrorEvent`）を受け取り、`url` が設定値の URL と一致する。
  - [ ] 同じ host で URL / transport が違う 2 つの TURN が、別々の URL で通知される。同じ address で credential だけが違う 2 つの TURN は、それぞれの URL でだけ通知される（取り違えない）。
  - [ ] URL の正規化（`canonicalIceServerUrl` の単体テスト）: `turns:h:5349` は `turns:h:5349?transport=tcp` になる。`turns:h:5349?transport=tcp`、`turn:h:3478`、`turn:h:3478?transport=tcp`、`stun:h:3478`、`stuns:h:3478` は変わらない。前後の空白は除き、scheme は小文字にする。
  - [ ] 1 つのサーバーに複数の URL（`stun:a:3478` と `stuns:a:3478`）が対応する場合、URL ごとに 1 件ずつ通知される。
  - [ ] `iceTransportPolicy: "relay"` では `address === null && port === 0`。
  - [ ] `close()` 後はイベントが出ない。ICE restart 後は古い世代のイベントが出ない。
- **WPT**
  - [ ] `webrtc/RTCPeerConnection-onicecandidateerror.https.html` を、**subtest 1（`Surfacing onicecandidateerror`）と subtest 2（`icecandidateerror fires for each failing server`）の両方**を対象に `wpt/allowlist.json` に追加する。
  - [ ] `tools/wpt-runner/timeoutLogic.ts` に、この file 用の completion timeout（10s 程度）を追加する。subtest 1 の `turn:123` は UDP のタイムアウト（約 6.35s）を待ってから失敗するため（2.4）。
  - [ ] `npm run wpt` と `npm run wpt:coverage`（baseline の更新）を実行する。

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
- [ ] WPT `RTCPeerConnection-onicecandidateerror.https.html` の subtest 1 と subtest 2 の両方が allowlist に入って通る。
- [ ] `serverReflexiveCandidate` のシグネチャと「失敗時は `undefined`」という挙動が変わらず、公開 API に破壊的変更がない。
- [ ] 通知される `url` が 3.5-1 の規則（`turns:` だけ `?transport=tcp` を補う）に従い、TSDoc と changelog に書かれている。
- [ ] changelog、README、生成ドキュメントを更新する。

## 8. 決定事項と残りの検討事項

### 決定済み

1. **公開 API の互換性**: `serverReflexiveCandidate` は変えない（失敗しても `undefined` を返し、reject しない）。失敗時に reject する `queryServerReflexiveCandidate` を新しく追加し、gathering はこちらを使う。changelog では Features 扱い（3.2）。
2. **`turns:` URL の表記**: `src` 側で正規化する。`turns:` で `transport` がない場合だけ `?transport=tcp` を補い、それ以外は設定値のまま（trim と scheme の小文字化だけ）。URL とサーバーの対応は、STUN は address で、TURN は `TurnServerOptions.urls` で取る。WPT は subtest 1 と 2 の両方を allowlist に入れる（3.5-1、3.5-2、5、7）。

### 残り（実装中に判断する。完了条件には影響しない）

3. 既定の STUN サーバーの失敗を通知するか（推奨: 合成した URL で通知する。3.5-2）。
4. 送信エラーでトランザクションを即時に失敗させる処理（3.4）を、このチケットに含めるか別チケットにするか。WPT の所要時間は runner の timeout プロファイルで吸収できるので、必須ではない。
