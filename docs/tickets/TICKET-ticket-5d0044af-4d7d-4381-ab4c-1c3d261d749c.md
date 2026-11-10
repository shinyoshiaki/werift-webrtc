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
| allowlist（`packages/webrtc/wpt/allowlist.json`） | `RTCDataChannel-send.html` / `-close.html` / `createDataChannel.html` は `enabled: false`。binaryType / bufferedAmount は未登録 |

- 仕様上 `bufferedamountlow` は「タスクをキューして発火」（非同期）。現行は同期発火。
- WPT runner（`tools/wpt-runner/runner.ts` L506–540）は `installPolyfill()` 後に `sandbox.RTCPeerConnection` を `WptRTCPeerConnection extends RTCPeerConnection`（コア）で上書きしているため、**polyfill の `peerConnectionConfig` 既定は WPT には自動では効かない**。

### 2.6 既存テスト・利用箇所

- `tests/datachannel/burst.test.ts`: 独自 `bufferedAmountLow` が 1 回だけ発火することを確認済み。Arrange は `tests/utils.ts` の `createDataChannelPair` / `collectChannelMessages`。
- `tests/nonstandard/polyfill.test.ts` L452: polyfill の辞書形式 `RTCSessionDescription` を確認。
- 型互換コンパイルテスト: `tests/nonstandard/polyfillDomCompile`（lib DOM あり）/ `polyfillNodeCompile`（DOM なし）を `compilePolyfillFixture()`（`polyfillTestUtils.ts`）で `tsc` 実行。パッケージの `tsconfig.json` は `lib: ["esnext"]`（DOM なし）でこの 2 fixture を除外している。
- Node 側で `onmessage` の `data` を Buffer 前提に扱う箇所が examples / e2e に多数（`grep onmessage` で 78 ファイル）。e2e の `datachannel.test.ts` L116 はブラウザ側の ArrayBuffer。

## 3. 実装すべき変更

### 3.1 `onbufferedamountlow`

- `RTCDataChannel` に `onbufferedamountlow?: Callback`（他ハンドラと同じ流儀）を追加。
- `addBufferedAmount()` の閾値跨ぎ判定はそのまま（上から下へ跨いだ時のみ）で、`bufferedAmountLow.execute()` / `emit("bufferedamountlow")` / `onbufferedamountlow()` の 3 経路をまとめて発火する private メソッドに集約。
- 例外隔離: 発火を `queueMicrotask` / `setImmediate` 等でタスク化する（仕様の「queue a task」に沿い、`dataChannelFlush` ループや `stop()` を中断させない）か、同期のまま try/catch で隔離するかを決める。**推奨はタスク化**。その場合、発火時点で再判定しない（跨いだ事実で 1 回発火）ことと、`burst.test.ts` の「1 回だけ」が維持されることを確認する。
- 例外ポリシーはパッケージ方針（broad catch-and-ignore 禁止）に従い、ログ出力 or `error` Event 経由など、握りつぶさない形にする。
- 併せて `dataChannelClose`（SCTP 未確立時）でキュー除去分の `bufferedAmount` 減算漏れを確認し、閉じたチャネルで low イベントが出るかを仕様（closed 後も `bufferedAmount` は減らさない／増え続ける記述）と照合して決める。

### 3.2 `binaryType`

- 型: `export type RTCDataChannelBinaryType = "nodebuffer" | "arraybuffer" | "blob"`（`"nodebuffer"` は `ws` ライブラリと同名の非標準値）。`as const` オブジェクト + 同名 union（`@enum`）で定義（enum 禁止）。
- **既定値（推奨案）**: コアは `"nodebuffer"`（現行どおり Buffer 配送＝後方互換）。polyfill 経由で生成されたチャネルは W3C 既定の `"arraybuffer"`。
  - 実現手段: `RTCPeerConnectionConfig`（`src/api/peerConfig.ts` `PeerConfig`）に非標準の `dataChannelBinaryType` を追加し、`SctpManager` → `RTCSctpTransport` 経由でローカル作成（`sctpManager.ts` L146）とリモート作成（`sctp.ts` L224, `ondatachannel`）の両方に初期値を渡す。`installPolyfill()` は `peerConnectionConfig` に既定 `"arraybuffer"` を補う（ユーザー指定を優先）。
  - WPT runner の `WptRTCPeerConnection` は polyfill 既定を通らないため、wrapper 側で `"arraybuffer"` を明示する（AGENTS.md Do 5: strict 挙動は wrapper に閉じる）。
  - 却下案: コア既定を `"arraybuffer"` にする → `data.toString()` が `"[object ArrayBuffer]"` になる等、既存アプリが**無言で壊れる**ためマイナーでは不可。
- setter: `"nodebuffer" | "arraybuffer" | "blob"` 以外は**無視して前の値を保持**（WPT 準拠、例外にしない）。
- 変換（`sctp.ts` `datachannelReceive`）:
  - string は常に string。
  - `"arraybuffer"`: `buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)` で**コピー**（Buffer プールの共有領域を露出させない）。空バイナリは `new ArrayBuffer(0)`。
  - `"blob"`: Node グローバル `Blob`（`node:buffer`、Node 18+）で `new Blob([buf])`。
  - 変換は 1 メッセージにつき 1 回だけ行い、`emit("message")` と `onmessage` に同じオブジェクトを渡す。`onMessage`（独自 Event）は常に Buffer。
- `MessageEvent.data` の型: `string | Buffer | ArrayBuffer | Blob` へ拡張が必要。`data.length` 等を使う TS 利用者はコンパイルエラーになる（実行時は既定で不変）ため、**型レベルの破壊的変更として changelog の Breaking に記載**する。回避策（`onMessage` を使う／`Buffer.isBuffer` で絞る）も併記。
  - 代替案として型を据え置く（実行時とずれる）案があるが、型の嘘になるため非推奨。最終判断はレビューで確定する。
- 範囲外（別 Issue 候補として記録のみ）: `send()` の型を `ArrayBuffer | ArrayBufferView | Blob` に広げる（Blob 送信は非同期で順序保証が必要、WPT `RTCDataChannel-send-blob-order.html`）。ArrayBuffer / TypedArray は実行時に既に送れるので、型拡張だけ本チケットに含めるかは実装時に判断。

### 3.3 `RTCSessionDescription` 辞書オーバーロード

- コアクラスにオーバーロードを追加:
  ```ts
  constructor(init: RTCSessionDescriptionInit);
  /** @deprecated-ではなく後方互換として維持 */ constructor(sdp: string, type: ...);
  ```
  - 判定: 第 1 引数が string なら旧形式、object なら辞書形式。
  - 辞書形式: `type` 必須（欠落・不正値は `TypeError`、`createWebRtcTypeError` を使用）、`sdp` 既定 `""`、`"rollback"` 許容（W3C `RTCSdpType`）。
  - 旧形式: 現行どおり検証なし（挙動不変）。
- `type` の型を `RTCSdpType`（rollback を含む）へ広げるかの判断:
  - 広げると `desc.type` を `"offer" | "answer" | "pranswer"` 変数に代入している TS 利用者が壊れる。`createOffer()` 等の戻り値は実際には rollback にならない。
  - 推奨: クラスの `type` を `RTCSdpType` に広げ、changelog に型変更として記載。`peerConnection.ts` 内の `lastCreatedOffer` 等の利用箇所が型エラーにならないか `npm run type` で確認。
- `toJSON(): RTCSessionDescriptionInit` を追加（W3C）。既存の `toSdp()` / `isThis()` は維持。`JSON.stringify` の出力（現状 enumerable プロパティ由来の `{sdp, type}`）が変わらないことをテストで固定。
- polyfill との統合: `PolyfillRTCSessionDescription` をコアクラスの派生（辞書形式のみ受理する strict 版）にして `instanceof` を揃えるか、コアクラスをそのまま公開するかを決める。ブラウザでは `new RTCSessionDescription("sdp", "offer")` は TypeError なので、polyfill 側は辞書のみ受理を維持するのが妥当。
- `docs/polyfill/guide.md` の「コアは低レベル形式のみ」の記述を更新。

### 3.4 型互換・ドキュメント

- `tests/nonstandard/polyfillDomCompile/consumer.ts`（lib DOM あり）に、werift の型が lib.dom の主要メンバーと互換であることを確認するコードを追加:
  - `onbufferedamountlow` / `bufferedAmountLowThreshold` / `bufferedAmount` 等を `Pick<globalThis.RTCDataChannel, ...>` 相当で照合。
  - DOM 側の `BinaryType`（`"arraybuffer" | "blob"`）が werift の `binaryType` に**代入可能**であること（werift 型は `"nodebuffer"` を含むので逆方向は不可。この非対称は互換表に明記）。
  - `new RTCSessionDescription(init as globalThis.RTCSessionDescriptionInit)` がコア/polyfill 双方でコンパイルできること。
- `docs/browser-api-compatibility.md` の「Remaining differences」に `binaryType` 既定（コア `"nodebuffer"` / polyfill `"arraybuffer"`）、`bufferedamountlow` の発火タイミング、`RTCSessionDescription` 2 引数形式を後方互換として残すことを追記。「Browser-compatible surface」にも反映。
- `changelog.md` に Features / Breaking（型）を記載。`npm run doc` で生成ドキュメントを再生成（手編集しない）。

## 4. 制約・注意点

- **既存 Node アプリを壊さない**: コア既定の受信形式（Buffer）、`onMessage`、2 引数 `RTCSessionDescription`、`toSdp()` / `isThis()` は不変。
- strict な W3C 挙動（既定 `"arraybuffer"` など）を WPT 専用に追加する場合は `tools/wpt-runner/*` の wrapper に閉じる（AGENTS.md Do 5）。
- TypeScript は erasable syntax のみ（`enum` / parameter properties 禁止）。
- 発火を非同期化する場合、`close()` → `closed` 後に遅延した low イベントが届く順序を確認する（WPT `RTCDataChannel-close.html` は現状無効だが、意図しない順序を作らない）。
- `Blob` / `ArrayBuffer` 変換はコピーを伴う。大量受信（`burst.test.ts` 相当の 20MB）でのコストは既定 `"nodebuffer"` では発生しないことを確認。
- `MessageEvent` は lib.dom と同名の独自 interface。DOM lib 併用プロジェクトでの名前衝突・意図しない型マージがないか `polyfillDomCompile` で確認。
- 負荷試験・e2e を回す前に、AGENTS.md Do 8 に従い現在リビジョン・未コミット差分・意図を記録する。

## 5. 実装ステップ（目安）

1. `dataChannel.ts`: `onbufferedamountlow`、`binaryType` getter/setter、型定義、low イベント発火の集約と例外隔離。
2. `sctp.ts`: 受信時の binaryType 変換、`dataChannelClose` の bufferedAmount 減算漏れ確認、リモート作成チャネルへの既定値伝搬。
3. `peerConfig.ts` / `sctpManager.ts` / polyfill `install.ts`（+ `peerConnectionConfig.ts`）: `dataChannelBinaryType` 既定の配線。WPT wrapper で `"arraybuffer"` を指定。
4. `sdp.ts`: `RTCSessionDescription` オーバーロード、`toJSON()`、型拡張。polyfill クラスの整理。
5. テスト追加（下記）、`polyfillDomCompile` / `polyfillNodeCompile` 更新。
6. WPT allowlist に `RTCDataChannel-binaryType.window.js`（および通るなら `RTCDataChannel-bufferedAmount.html`）を追加し `npm run wpt`。
7. ドキュメント・changelog 更新、`npm run format`、`npm run doc`。

## 6. 回帰テスト

テストは Arrange / Act / Assert、Act/Assert に日本語コメント。DataChannel の Arrange は `tests/utils.ts` の `createDataChannelPair` を再利用し、新規共通セットアップは `tests/datachannel/` 用の共有ユーティリティ 1 ファイルにまとめる。

- [ ] `onbufferedamountlow`・`addEventListener("bufferedamountlow")`・独自 `bufferedAmountLow` が同じ跨ぎで各 1 回ずつ発火する。閾値を跨がない減算・閾値ちょうど・閾値 0 の境界を確認。
- [ ] 複数 send 後の 1 回発火、送信ごとに跨げば毎回発火（WPT `RTCDataChannel-bufferedAmount.html` 相当）。
- [ ] ハンドラが throw しても flush / `stop()` / 他チャネルの送信が継続する（例外隔離）。
- [ ] transport stop（`discardUnsentMessages`）・SCTP close・未確立 close 時の `bufferedAmount` と発火回数。
- [ ] `binaryType` 既定値（コア `"nodebuffer"`、polyfill `"arraybuffer"`、リモート作成チャネルにも適用）、有効値の設定、無効値の無視（WPT の無効値リストを網羅）。
- [ ] `"arraybuffer"` / `"blob"` / `"nodebuffer"` で受信内容がバイト一致（空バイナリ含む）。ArrayBuffer がプール共有領域でない（`byteLength` が内容長と一致）。文字列・空文字列は常に string。
- [ ] `onMessage` は binaryType に関わらず Buffer / string。`onmessage` と `"message"` イベントに同一オブジェクトが渡る。
- [ ] 旧 `new RTCSessionDescription(sdp, type)` の挙動（プロパティ non-writable、`toSdp()`、`JSON.stringify` 結果）が不変。
- [ ] 新 `new RTCSessionDescription({ type, sdp })`: `sdp` 既定 `""`、`"rollback"` 許容、`type` 欠落・不正値で `TypeError`、`toJSON()`。`setRemoteDescription(new RTCSessionDescription({...}))` で接続が成立。
- [ ] polyfill の `RTCSessionDescription` 既存テスト（`polyfill.test.ts` L452）が通り、方針に応じて `instanceof` の関係を確認。
- [ ] `polyfillDomCompile` / `polyfillNodeCompile` の `tsc` が通り、lib.dom との主要型互換を確認。

## 7. 完了条件

- 元 Issue で現行も未実装だった `onbufferedamountlow`、`binaryType`、辞書形式 `RTCSessionDescription` が使える。
- 既定設定の既存 Node アプリ（Buffer 受信、2 引数コンストラクタ、`onMessage`）の実行時挙動が変わらない。型レベルの変更は changelog に明記されている。
- polyfill 経由では W3C 既定（`binaryType === "arraybuffer"`）で動作する。
- 追加テストと既存テストが通る: `cd packages/webrtc && npm run type && npm test`、さらに公開 API 変更のため `npm run type` / `npm run test:small`（ワークスペース）、`npm run wpt`（allowlist 追加時）。
- `docs/browser-api-compatibility.md`・`docs/polyfill/guide.md`・`changelog.md` が更新され、`npm run doc` で生成ドキュメントが最新。

## 参考

- 元コード根拠（調査時点）: [dataChannel.ts L40–65](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/dataChannel.ts#L40-L65), [`addBufferedAmount()`](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/dataChannel.ts#L166-L173), [sdp.ts L671以降](https://github.com/shinyoshiaki/werift-webrtc/blob/6cef593e8a5ca0a429da64787dfeca5b9a49ec46/packages/webrtc/src/sdp.ts#L671-L691)
- W3C WebRTC: `RTCDataChannel.binaryType` / `bufferedamountlow`、`RTCSessionDescription` constructor
- WPT: `third_party/wpt/webrtc/RTCDataChannel-binaryType.window.js`, `RTCDataChannel-send.html`, `RTCDataChannel-bufferedAmount.html`
- 関連: #812（`icecandidateerror`）
