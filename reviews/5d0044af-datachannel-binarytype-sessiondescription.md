---
ide:
  viewer: review-document
  version: 1
  title: "RTCDataChannel binaryType / RTCSessionDescription 互換性（#375）"
  dock: right
  baseCommit: 3de44f261c2aa1f72b0d36d1742e7b9788c1a029
---
# RTCDataChannel binaryType / onbufferedamountlow と RTCSessionDescription 辞書形式（#375）

## 1. 概要

Issue #375 で現行 develop にも残っていた 3 つの差分を埋めました。`RTCDataChannel.binaryType`、`onbufferedamountlow`、W3C 形式の `new RTCSessionDescription({ type, sdp })` です。

コアの既定動作は変えていません。受信バイナリは従来どおり `Buffer` で、2 引数の `RTCSessionDescription` も使えます。`installPolyfill()` 経由のグローバルだけが W3C 既定の `"arraybuffer"` になり、`RTCSessionDescription` はコアと同一クラスに統合されました。

## 2. 変更前後の流れ

<div style="display:flex;gap:16px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:280px;border:1px solid #c0392b;border-radius:8px;padding:12px">
<b style="color:#c0392b">Before</b>
<ol style="margin:8px 0 0 18px;padding:0">
<li>SCTP 受信 → <code>datachannelReceive</code></li>
<li>常に <code>Buffer</code> で <code>onmessage</code> へ（<code>binaryType</code> なし）</li>
<li><code>addBufferedAmount(-len)</code> → <code>bufferedAmountLow</code> のみ（<code>onbufferedamountlow</code> なし）</li>
<li>破棄経路（<code>discardUnsentMessages</code> など）でも減算して発火。ハンドラ例外で <code>stop()</code> / flush が中断し得る</li>
<li>コアと polyfill に別々の <code>RTCSessionDescription</code> があり <code>instanceof</code> が成立しない</li>
</ol>
</div>
<div style="flex:1;min-width:280px;border:1px solid #1e8449;border-radius:8px;padding:12px">
<b style="color:#1e8449">After</b>
<ol style="margin:8px 0 0 18px;padding:0">
<li>SCTP 受信 → <code>datachannelReceive</code></li>
<li><code>convertDataChannelMessage</code> が <code>binaryType</code>（nodebuffer / arraybuffer / blob）に 1 回変換し、<code>onmessage</code> と <code>"message"</code> に同一オブジェクトを渡す</li>
<li>送信完了の減算だけが <code>notifyBufferedAmountLow</code> へ。3 面（独自 Event → <code>onbufferedamountlow</code> → EventTarget）を個別に隔離して同期通知</li>
<li>破棄経路は <code>bufferedAmount</code> を減算せず、発火もしない（W3C 準拠）</li>
<li>polyfill グローバルもコアクラスそのもの。<code>instanceof</code> が双方向に成立</li>
</ol>
</div>
</div>

図は同じ起点（受信 → 減算 → 説明オブジェクト）から Before / After を並べたものです。左が変更前、右が変更後です。

## 3. 主要変更

### 3.1 RTCDataChannel

- `binaryType` の getter / setter を追加しました。setter は WebIDL の enum 変換に従い、無効値は例外にせず無視します（[packages/webrtc/src/dataChannel.ts:197](review-file:packages/webrtc/src/dataChannel.ts:197)）。
- 受信データの変換は [packages/webrtc/src/dataChannel.ts:77](review-file:packages/webrtc/src/dataChannel.ts:77) の関数です。`"arraybuffer"` は Buffer プールを露出させないようコピーします。
- 低水位通知は [packages/webrtc/src/dataChannel.ts:317](review-diff:packages/webrtc/src/dataChannel.ts:317) の `notifyBufferedAmountLow` に集約しました。各面を個別に try/catch し、例外は握りつぶさず再送出します。これでユーザーハンドラ例外が flush や `stop()` を中断しません。
- 破棄分を減算しない経路は [packages/webrtc/src/dataChannel.ts:310](review-file:packages/webrtc/src/dataChannel.ts:310) の `releaseDiscardedBufferedAmount` です。チャネルが存続したまま SCTP だけ止まる場合の解放用です。

### 3.2 SCTP 転送層と配線

- 受信変換の差し込み位置は [packages/webrtc/src/transport/sctp.ts:638](review-diff:packages/webrtc/src/transport/sctp.ts:638) です。
- 送信完了時の減算は [packages/webrtc/src/transport/sctp.ts:787](review-file:packages/webrtc/src/transport/sctp.ts:787) だけが低水位発火の起点です。
- `stop({ closingChannels })` による破棄経路の切り分けは [packages/webrtc/src/transport/sctp.ts:918](review-diff:packages/webrtc/src/transport/sctp.ts:918) です。
- `PeerConfig.dataChannelBinaryType`（既定 `"nodebuffer"`、不正値は `TypeError`）を追加しました（[packages/webrtc/src/api/peerConfig.ts:287](review-diff:packages/webrtc/src/api/peerConfig.ts:287)）。`sctpManager.ts` 経由で、ローカル作成とリモート作成の両チャネルに効きます。

### 3.3 RTCSessionDescription

- 辞書形式と旧 2 引数形式のオーバーロードを持ちます（[packages/webrtc/src/sdp.ts:886](review-diff:packages/webrtc/src/sdp.ts:886)）。`type` は `RTCSdpType`（rollback 含む）に拡張し、`toJSON()` を追加しました。
- 辞書の変換は [packages/webrtc/src/sdp.ts:829](review-file:packages/webrtc/src/sdp.ts:829) です。WebIDL の規則どおり、メンバーを辞書順（`sdp` → `type`）に 1 回ずつ読みます。
- WebIDL 変換ヘルパーは [packages/webrtc/src/webidl.ts](review-file:packages/webrtc/src/webidl.ts) です。index からは export しません。

### 3.4 polyfill

- 独立実装 `PolyfillRTCSessionDescription` を削除し、コアクラスを再 export します（[packages/webrtc/src/polyfill/rtcSessionDescription.ts](review-diff:packages/webrtc/src/polyfill/rtcSessionDescription.ts)）。
- polyfill 経由の PC は常に `dataChannelBinaryType: "arraybuffer"` を既定で補います（[packages/webrtc/src/polyfill/peerConnectionConfig.ts:64](review-diff:packages/webrtc/src/polyfill/peerConnectionConfig.ts:64)）。PC ごとの指定が優先されます。

### 3.5 WPT runner

- runner が allowlist 掲載の `.window.js` / `.any.js` を生成ページとして実行できるようにしました（[packages/webrtc/tools/wpt-runner/jsTestLogic.ts](review-diff:packages/webrtc/tools/wpt-runner/jsTestLogic.ts)）。
- `RTCDataChannel-binaryType.window.js` と `toJSON.html` を allowlist に追加し、前者の 10 subtest を baseline に入れました（[packages/webrtc/wpt/allowlist.json](review-diff:packages/webrtc/wpt/allowlist.json)）。
- strict な挙動は `WptRTCPeerConnection` 側に閉じ込め、`src` の既定は変えていません（AGENTS.md Do 5）。

### 3.6 テストとドキュメント

- テスト: [packages/webrtc/tests/datachannel/binaryType.test.ts](review-file:packages/webrtc/tests/datachannel/binaryType.test.ts)、[packages/webrtc/tests/datachannel/bufferedAmountLow.test.ts](review-file:packages/webrtc/tests/datachannel/bufferedAmountLow.test.ts)、[packages/webrtc/tests/webidlConversion.test.ts](review-file:packages/webrtc/tests/webidlConversion.test.ts)、[packages/webrtc/tests/rtcSessionDescription.test.ts](review-file:packages/webrtc/tests/rtcSessionDescription.test.ts)、[packages/webrtc/tests/tools/wptJsTest.test.ts](review-file:packages/webrtc/tests/tools/wptJsTest.test.ts)。型互換は `tests/nonstandard/polyfillDomCompile` と `polyfillNodeCompile` の consumer で固定しています。
- ドキュメント: [docs/browser-api-compatibility.md](review-diff:docs/browser-api-compatibility.md)、[docs/polyfill/guide.md](review-diff:docs/polyfill/guide.md)、[changelog.md](review-diff:changelog.md)。`doc/` 配下は生成物です。

## 4. 判断理由

| 論点 | 採用 | 不採用とした案 |
| --- | --- | --- |
| コアの `binaryType` 既定 | `"nodebuffer"`（非標準値を追加） | `"arraybuffer"`。`data.toString()` が `[object ArrayBuffer]` になり既存 Node アプリが無言で壊れる |
| 既定値の与え方 | config キー `dataChannelBinaryType` | 生成後にハンドラで書き換える。`ondatachannel` 前後のタイミングに依存する |
| 低水位の発火 | 同期発火 + 面ごとの例外隔離 | 非同期化。購読者のタイミング変更、close 後の遅延発火、`bufferedAmount` の値のずれが出る |
| 破棄分の `bufferedAmount` | 減算しない（W3C 準拠） | 破棄分も 0 に戻す。データ喪失を送信完了と解釈され得る |
| `RTCSessionDescription` | コアクラスへ統合 | 2 クラス並存、strict 派生クラス。`instanceof` が片方向のままになる |
| 無効な `binaryType` | 無視（`SyntaxError` にしない） | 例外化。固定版 WPT が「無視」を検証しており、現行 IDL の enum 属性でもある |
| 辞書メンバーの読み取り順 | 辞書順（`sdp` → `type`） | IDL 宣言順。WebIDL 仕様と Chromium の実測（`sdp` → `type`）に反する |

## 5. レビュアーが確認すべき点・リスク

- **型レベルの Breaking（v0.28.0）**: `MessageEvent.data` が `string | Buffer | ArrayBuffer | Blob` に、`RTCSessionDescription.type` が `RTCSdpType` に広がります。`data.length` を直接参照するコードや、`desc.type` を狭い union へ代入するコードはコンパイルエラーになります。移行方法は changelog に書きました。
- **実行時の挙動変化（Fixes）**: 破棄経路で `bufferedAmount` を減算しなくなり、低水位イベントも発火しません。以前は減算していた develop の挙動と異なります。仕様に合わせた変更です。
- **型の非対称**: `"nodebuffer"` を含むため、werift の `binaryType` は lib.dom の `BinaryType` へ代入できません。逆方向は代入できます。`@ts-expect-error` で固定し、互換表に記載しました。
- **ブラウザとの差分（互換表に記載済み）**: 低水位イベントを同期発火します。Event の `isTrusted` / `eventPhase` / `composedPath()` は保証しません。polyfill のグローバルでも 2 引数形式が通ります。
- **コピーのコスト**: `"arraybuffer"` と `"blob"` では受信ごとにコピーが発生します。既定の `"nodebuffer"` では発生しません。
- **範囲外**: `send()` への `Blob` / ArrayBuffer 型拡張（Blob 送信は順序保証が必要）、コア既定の将来的な切り替え。

## 6. 検証結果

このドキュメント作成の担当では、テストや WPT を再実行していません。実行済みと言えるのは、差分と生成物の読み取りだけです。変更前後の結果はチケット §8 / §9.5 の完了条件と、直近のレビュー反復の報告を参照してください。

チケットが要求している検証は次のとおりです。

- `cd packages/webrtc && npm run type && npm test`
- ワークスペースの `npm run type` と `npm run test:small`
- `npm run wpt`（`RTCDataChannel-binaryType.window.js` の 10 subtest が PASS、baseline に対する回帰が 0 件）
- `npm run doc:check`（`doc/` の生成物と一致）

レビュー時にはこれらの最新の実行結果を確認してください。
