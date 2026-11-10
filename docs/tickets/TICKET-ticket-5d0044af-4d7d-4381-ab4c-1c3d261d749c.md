# [WebRTC API] RTCDataChannelのbinaryType/低水位イベントとRTCSessionDescriptionコンストラクタ互換性を改善する（#375）

## 元報告と判定

元Issue: #375（achingbrain）。**一部妥当（developの残存差分のみ対象）**。報告当時の`canTrickleIceCandidates`, `sctp`, `getConfiguration`, `getStats`, `restartIce`, EventTargetベース実装や`iceServers.urls: string[]`等は現行で改善済みのため再Issue化しない。個別の`icecandidateerror`動作は #812 を参照。

調査基準リビジョン: `23a951bbc`（develop 由来、v0.27.0 直後）。

---

## 1. 目的と背景

- werift はブラウザ互換 API を掲げており（`docs/browser-api-compatibility.md`）、`werift/polyfill` でブラウザ向けコード（libp2p など #375 の報告元の利用形態）をそのまま Node で動かす用途がある。
- 現行で残る差分は次の 3 点に絞られる。
  1. `RTCDataChannel.onbufferedamountlow` がない（`addEventListener("bufferedamountlow")` と独自 `bufferedAmountLow` Event はある）。
  2. `RTCDataChannel.binaryType` がない。受信バイナリは常に Node `Buffer` で配送され、ブラウザ向けコードの `event.data instanceof ArrayBuffer` / `Blob` 判定が成り立たない。
  3. コアの `RTCSessionDescription` は `new RTCSessionDescription(sdp, type)` のみで、W3C の `new RTCSessionDescription({ type, sdp })` を受け付けない（polyfill 側には辞書形式の別クラスがある）。
- 目的は **既存 Node アプリ（Buffer 前提の `onmessage`、2 引数の `RTCSessionDescription`）を壊さずに** これらの差分を縮小し、互換ポリシーを文書化すること。

## 2. 現状のコード調査結果

### 2.1 RTCDataChannel（`packages/webrtc/src/dataChannel.ts`）

| 項目 | 現状 |
| --- | --- |
| ハンドラプロパティ | `onopen` / `onclose` / `onclosing` / `onmessage` / `onerror`（`onerror` は未実装の todo）。`onbufferedamountlow` なし |
| `binaryType` | なし |
| `addBufferedAmount(amount)` (L164–173) | 「`bufferedAmount > threshold` かつ `bufferedAmount + amount <= threshold`」のとき同期的に `bufferedAmountLow.execute()` → `emit("bufferedamountlow")` |
| `MessageEvent` 型 (L201–203) | `{ data: string \| Buffer }`（lib.dom と同名の独自 interface、`index.ts` から再 export） |
| `send(data: Buffer \| string)` | 型上は Buffer/string のみ。実装（`sctp.ts` `datachannelSend`）は `Buffer.from()` を経由するため ArrayBuffer / TypedArray も実行時には通る |
| `EventTarget`（`src/helper.ts`） | Node `EventEmitter` 派生。引数なし `emit(type)` は `new Event(type)` を渡す |

### 2.2 受信配送（`packages/webrtc/src/transport/sctp.ts` `datachannelReceive` L252–280）

```ts
channel.onMessage.execute(msg);          // 独自 Event: string | Buffer
channel.emit("message", { data: msg });  // EventTarget
if (channel.onmessage) channel.onmessage({ data: msg });
```

- PPID: `WEBRTC_STRING` → string、`WEBRTC_STRING_EMPTY` → `""`、`WEBRTC_BINARY` → `Buffer`、`WEBRTC_BINARY_EMPTY` → `Buffer.from([])`。
- **binaryType 変換を差し込む場所はここの `emit("message")` と `onmessage` の 2 箇所**。`onMessage` は Buffer のまま残す。

### 2.3 bufferedAmount の減算経路（`sctp.ts`）

| 経路 | 場所 | 備考 |
| --- | --- | --- |
| 送信完了 | `dataChannelFlush` L408–415 `.then(() => addBufferedAmount(-len))` | 非同期（SCTP send 完了後）。例外は `.catch` でログのみ |
| flush 時に閉じていたチャネル | `dataChannelFlush` L371–373 | **同期**。ハンドラが throw すると while ループが中断し、残りのキューが flush されない |
| transport stop | `discardUnsentMessages` L500–515 | **同期**。ハンドラ例外で `stop()` が中断する |
| SCTP 未確立時の `close()` | `dataChannelClose` L532–534 | キューから除去するが **`bufferedAmount` を減算していない**（既存の不整合。今回確認・必要なら修正） |

→ `onbufferedamountlow` を追加すると、同期経路でユーザーハンドラ例外がトランスポート処理を壊し得る。**発火の例外隔離が必要**。

### 2.4 RTCSessionDescription

- コア（`src/sdp.ts` L671–702）: `constructor(sdp: string, type: "offer" | "answer" | "pranswer")`、`Object.defineProperties` で `sdp`/`type` を non-writable・enumerable に定義、`static isThis(o)`、`toSdp()`。`toJSON()` はない。
  - 内部利用は `SessionDescription.toJSON()`（`sdp.ts` L374–384）の 1 箇所のみ。`localDescription` / `currentLocalDescription` 等の getter（`peerConnection.ts` L449–461）や `createOffer()` の戻り値はこのインスタンス。
- polyfill（`src/polyfill/rtcSessionDescription.ts`）: `PolyfillRTCSessionDescription({ type, sdp })`。`type` 必須（欠落で `TypeError`）、`sdp` 既定 `""`、`toJSON()` あり、`"rollback"` 許容。**コアクラスとは無関係の別クラス**で、`instanceof` は相互に成立しない。`installPolyfill()` がグローバル `RTCSessionDescription` にこれを入れる（`install.ts` L95）。
- `RTCSessionDescriptionInit` / `RTCSdpType`（`"answer" | "offer" | "pranswer" | "rollback"`）は `src/sdpManager.ts` L1252–1256 に既存。`type` は parameterless `setLocalDescription` のため optional。
- ドキュメント: `docs/polyfill/guide.md` 「Browser-shaped session descriptions」に「コアは低レベル形式、辞書形式は polyfill を使え」と記載済み → 変更時に更新が必要。

### 2.5 W3C / WPT の要求（`third_party/wpt/webrtc`）

| WPT | 要求 |
| --- | --- |
| `RTCDataChannel-binaryType.window.js` | 既定値は **`"arraybuffer"`**（現行仕様。旧仕様の `"blob"` ではない）。`"blob"`/`"arraybuffer"` は設定可、それ以外（`"jellyfish"`, `""`, `null`, `undefined`, 数値, bigint, 末尾空白付き）は**無視して前の値を保持**（例外にしない） |
| `RTCDataChannel-send.html` | 文字列は binaryType に関わらず string。既定で ArrayBuffer、`"blob"` で Blob。`onbufferedamountlow` を await に使用 |
| `RTCDataChannel-bufferedAmount.html` | `bufferedamountlow` は send 完了後に発火、複数 send 後でも 1 回、送信ごとに閾値を跨げば毎回 |
| `toJSON.html` | `RTCSessionDescription.toJSON()` は `type` / `sdp` の 2 キーのみ（未 allowlist） |
| `RTCPeerConnection-setLocalDescription-parameterless.https.html`（**allowlist 有効**） | `new RTCSessionDescription({ sdp })`（type なし）は `TypeError`。polyfill のグローバル `RTCSessionDescription` を使用 |
| `RTCPeerConnection-canTrickleIceCandidates.html`（**allowlist 有効**） | `setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }))` |
| allowlist（`packages/webrtc/wpt/allowlist.json`） | `RTCDataChannel-send.html` / `-close.html` / `createDataChannel.html` は `enabled: false`。binaryType / bufferedAmount は未登録 |

- 仕様上 `bufferedamountlow` は「データを**送信した**結果 bufferedAmount が閾値を跨いだらタスクをキューして発火」（非同期）。現行は同期発火で、送信せずに破棄した分の減算でも発火する。
- WPT runner（`tools/wpt-runner/runner.ts` L506–540）は `installPolyfill()` 後に `sandbox.RTCPeerConnection` を `WptRTCPeerConnection extends RTCPeerConnection`（コア）で上書きしているため、**polyfill の `peerConnectionConfig` 既定は WPT には自動では効かない**。

### 2.6 既存テスト・利用箇所

- `tests/datachannel/burst.test.ts`: 独自 `bufferedAmountLow` が 1 回だけ発火することを確認済み。Arrange は `tests/utils.ts` の `createDataChannelPair` / `collectChannelMessages`。
- `tests/nonstandard/polyfill.test.ts` L452: polyfill の辞書形式 `RTCSessionDescription` を確認。
- 型互換コンパイルテスト: `tests/nonstandard/polyfillDomCompile`（lib DOM あり）/ `polyfillNodeCompile`（DOM なし）を `compilePolyfillFixture()`（`polyfillTestUtils.ts`）で `tsc` 実行。パッケージの `tsconfig.json` は `lib: ["esnext"]`（DOM なし）でこの 2 fixture を除外している。
- Node 側で `onmessage` の `data` を Buffer 前提に扱う箇所が examples / e2e に多数（`grep onmessage` で 78 ファイル）。e2e の `datachannel.test.ts` L116 はブラウザ側の ArrayBuffer。

## 3. 決定事項（未確定事項の解消）

| # | 論点 | 決定 |
| --- | --- | --- |
| D1 | `binaryType` 既定値と公開 API | コア既定 `"nodebuffer"`、polyfill 経由 `"arraybuffer"`。`"nodebuffer"` 値と `PeerConfig.dataChannelBinaryType` を公開 API として追加 |
| D2 | `MessageEvent.data` の型 | `string \| Buffer \| ArrayBuffer \| Blob` に拡張 |
| D3 | `RTCSessionDescription.type` の型とリリース | `RTCSdpType`（rollback 含む）に拡張。D2・D3 の型変更は次のマイナー **v0.28.0** の Breaking changes に記載 |
| D4 | polyfill とコアの `RTCSessionDescription` | polyfill のグローバルにもコアクラスを入れて 1 クラスに統合。`instanceof` は双方向に成立 |
| D5 | `bufferedamountlow` の発火タイミング | 同期発火を維持し、通知面ごとに例外を隔離。送信完了による減算でのみ発火し、未送信のまま破棄した分では発火しない |

### D1. `binaryType` の既定値ポリシー

**決定**

- 値の型: `RTCDataChannelBinaryType = "nodebuffer" | "arraybuffer" | "blob"`（`as const` オブジェクト + 同名 union、`@enum` タグ）。`"nodebuffer"` は非標準値で、名前は `ws` ライブラリの `binaryType` に揃える。
- 既定値:
  - **コア**（`werift` から直接 `new RTCPeerConnection()`）: `"nodebuffer"`。受信バイナリは現行どおり `Buffer`。
  - **polyfill**（`installPolyfill()` が入れたグローバル `RTCPeerConnection`）: `"arraybuffer"`（W3C 既定）。
  - **WPT runner**: `WptRTCPeerConnection` が config に `dataChannelBinaryType: "arraybuffer"` を補う。
- 既定値はローカル作成（`createDataChannel`）とリモート作成（`ondatachannel`）の両方に効く。
- 公開 API として次を追加する。
  - `RTCDataChannel.binaryType`（getter/setter）。
  - `PeerConfig.dataChannelBinaryType`（`RTCPeerConnectionConfig` から指定可、`generateDefaultPeerConfig()` の既定は `"nodebuffer"`、`getConfiguration()` が返す）。
- 不正値の扱い:
  - `RTCDataChannel.binaryType` の setter は、3 値以外を**無視して前の値を保持**する（WebIDL の enum 属性の挙動、WPT 準拠）。
  - `PeerConfig.dataChannelBinaryType` に 3 値以外を渡すと `createWebRtcTypeError` を投げる（`certificateScope` / `mLineReuse` と同じ werift 設定値の検証方式）。
- `setConfiguration()` での変更は許可し、変更後に作られるチャネルにだけ効く。既存チャネルの `binaryType` は変えない。チャネル単位では setter で切り替える。

**理由**

- コア既定を `"arraybuffer"` にすると、`data.toString()` が `"[object ArrayBuffer]"` になるなど既存 Node アプリが**無言で壊れる**。コア既定は変えない。
- polyfill はブラウザ向けコードを動かす入口なので、W3C 既定に合わせないと #375 の目的（`instanceof ArrayBuffer` 判定）を満たせない。
- リモート作成チャネルにも既定を効かせる経路が要る。チャネル生成後にハンドラで書き換える方式だと、`ondatachannel` 前後のタイミングに依存する。生成時に `RTCSctpTransport` が持つ既定を渡す config キーなら、両経路を一律に扱える。
- 非標準 config キーには `bandwidthEstimator` / `filterProbePaddingOnReceiveRtp` / `mLineReuse` の前例がある。isomorphic なコードを書く Node 利用者も、コアのまま `"arraybuffer"` を選べる。
- コア既定を将来 `"arraybuffer"` に切り替えるかは本チケットの範囲外とする。切り替えるなら別チケットで、メジャー相当の告知を伴って行う。

**型互換への影響**: werift の `binaryType` 型は `"nodebuffer"` を含むため、lib.dom の `RTCDataChannel.binaryType`（`BinaryType`）へは代入できない。逆方向（DOM の値 → werift）は代入できる。`werift/polyfill/dom` 利用者はグローバルを DOM 型で見るので影響を受けない。この非対称は `docs/browser-api-compatibility.md` に明記する。

### D2. `MessageEvent.data` の型

**決定**: `MessageEvent.data` を `string | Buffer | ArrayBuffer | Blob` に拡張する。合わせて型エイリアス `RTCDataChannelMessageData` を export する。独自 `onMessage` Event の型（`string | Buffer`）は変えない。

**理由と検討した案**

| 案 | 評価 |
| --- | --- |
| 型を拡張する（採用） | 実行時に ArrayBuffer / Blob が届くので、型と実体が一致する |
| 現行型を維持する | `binaryType` を変えると型が嘘になり、`Buffer.isBuffer` での絞り込みが漏れる。不採用 |
| `RTCDataChannel` をジェネリック化する | setter による実行時変更を型に反映できない。不採用 |
| `any` にする | 既存の型安全性を失う。不採用 |

**影響範囲**:
- そのまま通るコード: `data.toString()`（4 型すべてにある）、`data as Buffer`、`Buffer.isBuffer(data)` での分岐。
- コンパイルエラーになるコード: `data.length` のように string / Buffer 共通のメンバーへ直接触れるもの。
- 移行手段: `Buffer` を前提にした Node コードは `onMessage` を使う。または `Buffer.isBuffer` / `typeof data === "string"` で絞り込む。changelog に併記する。

### D3. `RTCSessionDescription.type` の型とリリース

**決定**

- クラスの `readonly type` を `RTCSdpType`（`"offer" | "answer" | "pranswer" | "rollback"`、`sdpManager.ts` の既存型）に拡張する。
- 辞書形式 `new RTCSessionDescription({ type, sdp })` は 4 値すべてを受け付ける（W3C 準拠）。
- 旧 2 引数形式 `(sdp, type)` は引数型を `"offer" | "answer" | "pranswer"` のまま据え置き、実行時検証も追加しない（挙動不変）。
- `createOffer()` などの戻り値型の宣言は変えない（いずれも `RTCSessionDescription`）。
- **リリース**: D2・D3 の型レベル変更は次のマイナー **v0.28.0** にまとめ、changelog の「⚠️ Breaking changes」に移行方法と一緒に記載する。werift は 0.x で、v0.27.0 でもマイナーに Breaking を含めた前例がある。既定設定では実行時挙動が変わらないため、非推奨期間は設けない。

**理由**: W3C は `{ type: "rollback" }` の生成を許しており、polyfill の現行クラスも rollback を受け付けている。型を狭いまま残すと、D4 の統合後に rollback を表せないか型が嘘になる。影響は `desc.type` を狭い union の変数へ代入しているコードに限られる（絞り込みで対応できる）。

### D4. polyfill とコアの `RTCSessionDescription` の関係

**決定**

- `installPolyfill()` がグローバルに入れる `RTCSessionDescription` を、**コアの `RTCSessionDescription` クラスそのもの**にする。
- 独立実装の `PolyfillRTCSessionDescription`（`src/polyfill/rtcSessionDescription.ts`）は削除し、`api.ts` の export をコアクラスの再 export に置き換える。
  - `RTCSessionDescriptionInit` / `PolyfillSdpType` を polyfill 側で参照している型は、コアの `RTCSessionDescriptionInit` / `RTCSdpType` の別名として残す。
- `globals.ts` の `var RTCSessionDescription` の型を `typeof` コアクラスに変える。
- **`instanceof` の関係**: `pc.localDescription instanceof globalThis.RTCSessionDescription` と、利用者が作ったインスタンスの `instanceof` が、コア / polyfill のどちらから見ても成立する（ブラウザと同じ）。
- `{ sdp }` のように `type` がないと `TypeError` になる点は、コア辞書形式の検証で維持する（allowlist 有効の WPT parameterless テストを保つ）。
- `toJSON()` は `{ type, sdp }` の 2 キーのみを返す（WPT `toJSON.html`）。

**理由と検討した案**

| 案 | 評価 |
| --- | --- |
| コアクラスに統合する（採用） | `instanceof` が双方向に成立し、実装が 1 つで済む |
| 2 クラスを並存させる（現状） | `pc.localDescription` が polyfill クラスのインスタンスにならず、ブラウザ向けライブラリの `instanceof` 判定が失敗する。不採用 |
| polyfill を「辞書のみ受理する strict 派生クラス」にする | 利用者作成分はコアの instanceof になるが、コアが生成した説明は polyfill クラスの instanceof にならず片方向のまま。不採用 |

**残る差分**: polyfill のグローバルでも 2 引数形式が通る。ブラウザでは文字列を辞書に変換できず `TypeError` になる。これは werift の利便挙動として許容し、互換表に記載する。strict な挙動が必要な WPT ターゲットが出てきたら、`tools/wpt-runner/*` の wrapper で shim する（AGENTS.md Do 5）。

### D5. `bufferedamountlow` の発火タイミングと例外隔離

**決定**

- **同期発火を維持する。** `bufferedAmount` が閾値を上から下へ跨いだその場で、次の 3 面へ順に通知する。
  1. `bufferedAmountLow`（独自 Event）
  2. `onbufferedamountlow`
  3. EventTarget の `"bufferedamountlow"`
  - この順序は `setReadyState` の「独自 Event → `onX` → `emit`」に揃える。
  - 既存の `bufferedAmountLow` 購読者から見たタイミングは変わらない。
- **例外隔離**: 3 面を `RTCDataChannel` 内の 1 つの private メソッドで発火する。
  - 各面の呼び出しを個別に try/catch で囲み、捕捉した例外は `process.nextTick(() => { throw err })` で再送出する。
  - 再送出された例外は `uncaughtException` として報告される。Node 組み込み `EventTarget` のリスナー例外と同じ扱いで、握りつぶさない。
  - これにより、`dataChannelFlush` のループ、`stop()`、送信完了の `.then` がユーザーハンドラ例外で中断しない。
- **発火条件**: 発火するのは、**SCTP に渡したメッセージの送信完了による減算**（`dataChannelFlush` の `.then` 経路）のときだけ。
  - 未送信のまま破棄した分の減算では `bufferedAmount` は減らすが、イベントは発火しない。該当するのは、flush 時点で closing/closed だったチャネルのメッセージ、`discardUnsentMessages`、SCTP 未確立時の `dataChannelClose` の 3 経路。
  - `addBufferedAmount` に「発火するか」を指定する内部引数を設けるか、破棄用の内部メソッドを分ける。
- **既存不整合の修正**: SCTP 未確立時の `dataChannelClose` で、キューから除去した分を `bufferedAmount` から減算する。

**理由**

- 減算は SCTP の送信完了後に行われるので、`send()` から見ればすでに非同期である。WPT の「send 完了後に発火」「複数 send 後でも 1 回」は同期発火のままで満たせる。
- `queueMicrotask` などで非同期にしても例外は `uncaughtException` になるだけで、隔離にはならない。try/catch は結局必要になる。
- 非同期化すると、次の副作用がある。
  - 既存 `bufferedAmountLow` 購読者のタイミングが変わる。
  - ハンドラ内で読む `bufferedAmount` が、跨いだ時点の値とずれる（その間の send で増えている可能性がある）。
  - close 後に遅れて発火し得る。
  - werift の他の DataChannel イベント（open / close / message）はすべて同期なので、一貫性も崩れる。
- 仕様の発火条件は「送信した結果」である。破棄経路で発火を止めると仕様に沿う。さらに、ハンドラが closing/closed チャネルへ `send()` し直した場合の「再キュー → 破棄 → 再発火」の無限ループも防げる。

**ブラウザとの差分**: ブラウザはタスクをキューして発火するが、werift は送信完了時に同期で発火する。この差分を互換表に記載する。破棄経路で発火しなくなる変更は changelog の Fixes に記載する。

## 4. 実装すべき変更

### 4.1 `onbufferedamountlow`（D5）

- `RTCDataChannel` に `onbufferedamountlow?: Callback` を追加する。
- `addBufferedAmount()` の跨ぎ判定（`bufferedAmount > threshold && bufferedAmount + amount <= threshold`）は維持する。発火は private メソッドに集約し、D5 の順序と例外隔離を実装する。
- 破棄経路（`sctp.ts` L371–373、`discardUnsentMessages`、`dataChannelClose` の未確立分岐）は、発火しない減算を使う。`dataChannelClose` の未確立分岐には減算を追加する。

### 4.2 `binaryType`（D1・D2）

- `dataChannel.ts`:
  - `RTCDataChannelBinaryType` を定義し、`binaryType` getter/setter を追加する（不正値は無視）。
  - 初期値はコンストラクタ引数で受け取る（既定 `"nodebuffer"`）。
  - `MessageEvent.data` の型を拡張し、`RTCDataChannelMessageData` を export する。
- `api/peerConfig.ts`:
  - `PeerConfig.dataChannelBinaryType` を追加する（TSDoc に D1 の要点を書く）。
  - 既定値は `"nodebuffer"`、不正値は `TypeError`。
  - `setConfiguration()` での更新を許可する。
- 配線:
  - `peerConnection.ts` → `SctpManager` → `RTCSctpTransport` に既定値を渡す。`sctpManager.ts` L146 と `sctp.ts` L224 で `new RTCDataChannel` に渡す。
  - `setConfiguration()` 後に作られるトランスポートやチャネルにも、更新後の値が効くようにする。
- 受信変換（`sctp.ts` `datachannelReceive`）:
  - 変換は 1 メッセージにつき 1 回行い、同じオブジェクトを `emit("message")` と `onmessage` に渡す。
  - string は常に string のまま渡す。
  - `"arraybuffer"`: `buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)` で**コピー**する。Buffer プールの共有領域は露出させない。
  - `"blob"`: `new Blob([buf])`（Node グローバル `Blob`）。
  - `"nodebuffer"`: 現行どおり Buffer。
  - `onMessage` は常に Buffer / string。
- polyfill:
  - `installPolyfill()` は、`peerConnectionConfig.dataChannelBinaryType` が未指定なら `"arraybuffer"` を補う。PC ごとの config 指定はこれより優先する。
  - 現行の `createPolyfillRTCPeerConnection()` は install config が未指定だとコアクラスをそのまま返す。今後は常に既定値を合成する派生クラスを返すようにする。
- WPT runner: `WptRTCPeerConnection` のコンストラクタで `dataChannelBinaryType: "arraybuffer"` を補う。
- 範囲外として記録するもの: `send()` の型を `ArrayBuffer | ArrayBufferView | Blob` に広げる変更（Blob 送信は非同期で順序保証が要る。WPT `RTCDataChannel-send-blob-order.html`）。別 Issue 候補とする。

### 4.3 `RTCSessionDescription`（D3・D4）

- `sdp.ts`:
  - オーバーロードを追加する: `constructor(init: RTCSessionDescriptionInit)` と `constructor(sdp: string, type: "offer" | "answer" | "pranswer")`。第 1 引数が string なら旧形式とする。
  - 辞書形式では `type` が必須で、未指定・不正値は `createWebRtcTypeError` を投げる。`sdp` の既定は `""`。
  - `type` を `RTCSdpType` に拡張する。`Object.defineProperties` による non-writable・enumerable 定義は維持する。
  - `toJSON(): { type, sdp }` を追加する。`toSdp()` / `isThis()` は維持する。
- `RTCSessionDescriptionInit` / `RTCSdpType` を `sdp.ts` から参照するときは、循環 import にならないよう型 import にする（`sdpManager.ts` → `sdp.ts` 方向が既にある）。必要なら型定義を `sdp.ts` 側へ移し、`sdpManager.ts` から再 export する。
- polyfill: D4 のとおり統合し、`rtcSessionDescription.ts` は型の別名だけを残す（または削除して `api.ts` から直接再 export する）。

### 4.4 型互換テスト・ドキュメント

- `tests/nonstandard/polyfillDomCompile/consumer.ts`（lib DOM あり）に次を追加する。
  - werift `RTCDataChannel` の `onbufferedamountlow` / `bufferedAmountLowThreshold` / `bufferedAmount` / `readyState` / `label` が、lib.dom の対応メンバーと型互換であること。
  - DOM の `BinaryType` が werift の `binaryType` に代入できること。逆方向は `// @ts-expect-error` で非互換を固定する。
  - `new RTCSessionDescription(init)`（`init: globalThis.RTCSessionDescriptionInit`）がコアでコンパイルできること。
- `tests/nonstandard/polyfillNodeCompile/consumer.ts`（DOM なし）に次を追加する: グローバル `RTCSessionDescription` の辞書形式と、`binaryType = "arraybuffer"` の代入。
- `docs/browser-api-compatibility.md`:
  - 「Remaining differences」に次の 4 点を追記する。
    - `binaryType` の既定（コア `"nodebuffer"` / polyfill `"arraybuffer"`）と、`"nodebuffer"` の型非対称
    - `bufferedamountlow` を同期発火すること
    - 2 引数 `RTCSessionDescription` を後方互換として残すこと（polyfill グローバルでも通ること）
  - 「Browser-compatible surface」にも反映する。
- `docs/polyfill/guide.md`: 「Browser-shaped session descriptions」を更新する（コアも辞書形式に対応し、polyfill のグローバルはコアと同一クラスになった）。`binaryType` の既定についても一文追記する。
- `changelog.md`（v0.28.0）に次を記載する。
  - Breaking: D2・D3 の型変更と移行方法
  - Features: `binaryType` / `dataChannelBinaryType` / `onbufferedamountlow` / 辞書形式コンストラクタ / `toJSON`
  - Fixes: 破棄経路での不要な low イベント、未確立 close 時の `bufferedAmount` 減算漏れ
- 生成ドキュメントは `npm run doc` で再生成する（手編集しない）。

## 5. 制約・注意点

- **既存 Node アプリを壊さない**: 次の実行時挙動は変えない。コア既定の受信形式（Buffer）、`onMessage`、2 引数 `RTCSessionDescription`、`toSdp()` / `isThis()`、`bufferedAmountLow` の発火タイミング。
- strict な W3C 挙動を WPT 専用に追加するときは、`tools/wpt-runner/*` の wrapper に閉じる（AGENTS.md Do 5）。
- TypeScript は erasable syntax のみ使う（`enum` / parameter properties は禁止）。
- 例外隔離は broad catch-and-ignore にしない。捕捉した例外は必ず `process.nextTick` で再送出する。
- `Blob` / `ArrayBuffer` への変換にはコピーが伴う。既定の `"nodebuffer"` では変換コストが発生しないことを確認する（`burst.test.ts` 相当の 20MB）。
- `MessageEvent` は lib.dom と同名の独自 interface なので、DOM lib を併用するプロジェクトで衝突しないか `polyfillDomCompile` で確認する。
- polyfill の統合で、allowlist 有効の WPT（parameterless、canTrickleIceCandidates）が引き続き通ることを確認する。
- 長時間の検証（WPT・全テスト）の前に、AGENTS.md Do 8 に従って現在のリビジョン、未コミット差分、意図を記録する。

## 6. 実装ステップ（目安）

1. `dataChannel.ts`: `RTCDataChannelBinaryType`、`binaryType`、`onbufferedamountlow`、発火の集約と例外隔離、発火しない減算。
2. `sctp.ts`: 受信変換、破棄経路の切り替え、未確立 close 時の減算追加、リモート作成チャネルへの既定値伝搬。
3. `peerConfig.ts` / `peerConnection.ts` / `sctpManager.ts`: `dataChannelBinaryType` の追加・検証・配線。
4. `sdp.ts`: オーバーロード、`toJSON()`、型拡張、型定義の配置整理。
5. polyfill（`install.ts` / `peerConnectionConfig.ts` / `api.ts` / `globals.ts` / `rtcSessionDescription.ts`）: D1 の既定値と D4 の統合。
6. WPT runner wrapper に `"arraybuffer"` を指定し、allowlist に `RTCDataChannel-binaryType.window.js` と `toJSON.html`（RTCSessionDescription 分が通るか確認したうえで）を追加する。`RTCDataChannel-bufferedAmount.html` は通るなら追加し、`npm run wpt` を実行する。
7. テストを追加し、compile fixture を更新する。
8. ドキュメントと changelog を更新し、`npm run format` と `npm run doc` を実行する。

## 7. 回帰テスト

テストは Arrange / Act / Assert で書き、Act / Assert には日本語コメントを付ける。DataChannel の Arrange は `tests/utils.ts` の `createDataChannelPair` を再利用し、新しい共通セットアップは `tests/datachannel/` 用の共有ユーティリティ 1 ファイルにまとめる。

- [ ] `bufferedAmountLow`・`onbufferedamountlow`・`addEventListener("bufferedamountlow")` が同じ跨ぎで各 1 回ずつ、D5 の順序で発火する。境界（閾値を跨がない減算、閾値ちょうど、閾値 0）も確認する。
- [ ] 複数 send 後は 1 回だけ発火し、送信ごとに閾値を跨げば毎回発火する（WPT `RTCDataChannel-bufferedAmount.html` 相当）。
- [ ] 各通知面のハンドラが throw しても、残りの面への通知、flush、`stop()`、他チャネルの送信が継続する。例外は `uncaughtException` として観測できる。
- [ ] 破棄経路（closing/closed チャネルの flush、`discardUnsentMessages`、未確立 close）では `bufferedAmount` は減るがイベントは発火しない。未確立 close 後の `bufferedAmount` は 0 になる。low ハンドラ内から closed チャネルへ `send()` しても無限ループにならない。
- [ ] `binaryType` の既定値が、コアでは `"nodebuffer"`、polyfill と WPT wrapper では `"arraybuffer"` になる（ローカル作成・リモート作成の両方）。`dataChannelBinaryType` 指定が優先され、`getConfiguration()` に反映される。不正な config 値は `TypeError` になる。`setConfiguration()` 後は新しいチャネルにだけ効く。
- [ ] setter: 有効な 3 値は設定でき、WPT の無効値リスト（`"jellyfish"`, `"arraybuffer "`, `""`, `null`, `undefined`, 数値, bigint）は無視される。
- [ ] `"nodebuffer"` / `"arraybuffer"` / `"blob"` のそれぞれで受信内容がバイト一致する（空バイナリも含む）。ArrayBuffer の `byteLength` が内容長と一致する（プール非共有）。文字列と空文字列は常に string で届く。`onmessage` と `"message"` イベントには同じオブジェクトが渡る。
- [ ] `onMessage` は `binaryType` に関わらず Buffer / string を受け取る。
- [ ] 旧 `new RTCSessionDescription(sdp, type)` の挙動（non-writable なプロパティ、`toSdp()`、`JSON.stringify` の結果）が変わらない。
- [ ] 新 `new RTCSessionDescription({ type, sdp })`: `sdp` の既定は `""`、`"rollback"` を受け付ける、`type` の欠落・不正値は `TypeError`、`toJSON()` のキーは 2 つ。`setRemoteDescription(new RTCSessionDescription({...}))` で接続が成立する。
- [ ] polyfill のグローバル `RTCSessionDescription` がコアクラスと同一で、`pc.localDescription instanceof globalThis.RTCSessionDescription` が成立する。既存の `polyfill.test.ts` L452 も通る。
- [ ] `polyfillDomCompile` / `polyfillNodeCompile` の `tsc` が通る（lib.dom との互換、`"nodebuffer"` の非対称を `@ts-expect-error` で固定）。

## 8. 完了条件

- 元 Issue で現行も未実装だった `onbufferedamountlow`、`binaryType`、辞書形式 `RTCSessionDescription` が使える。決定事項 D1–D5 のとおりに実装されている。
- 既定設定の既存 Node アプリの実行時挙動が変わらない（Buffer 受信、2 引数コンストラクタ、`onMessage`、`bufferedAmountLow` のタイミング）。型レベルの変更（D2・D3）は changelog v0.28.0 の Breaking に移行方法付きで記載されている。
- polyfill 経由では W3C 既定（`binaryType === "arraybuffer"`）で動作し、`RTCSessionDescription` の `instanceof` がブラウザと同様に成立する。
- 次の検証が通る。
  - `cd packages/webrtc && npm run type && npm test`
  - 公開 API の変更なので、ワークスペースの `npm run type` と `npm run test:small`
  - allowlist を変更したので `npm run wpt`（既存の parameterless / canTrickleIceCandidates を含む）
- `docs/browser-api-compatibility.md`・`docs/polyfill/guide.md`・`changelog.md` が更新され、`npm run doc` で生成ドキュメントが最新になっている。

## 参考

- 元コード根拠（調査時点）: [dataChannel.ts L40–65](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/dataChannel.ts#L40-L65), [`addBufferedAmount()`](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/dataChannel.ts#L166-L173), [sdp.ts L671以降](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdp.ts#L671-L691)
- W3C WebRTC: `RTCDataChannel.binaryType` / `bufferedamountlow`、`RTCSessionDescription` constructor
- WPT: `third_party/wpt/webrtc/RTCDataChannel-binaryType.window.js`, `RTCDataChannel-send.html`, `RTCDataChannel-bufferedAmount.html`, `toJSON.html`, `RTCPeerConnection-setLocalDescription-parameterless.https.html`
- Node.js `EventTarget` のリスナー例外の扱い（`process.nextTick` で uncaught exception として報告）: D5 の例外隔離方式の前例
- 関連: #812（`icecandidateerror`）
