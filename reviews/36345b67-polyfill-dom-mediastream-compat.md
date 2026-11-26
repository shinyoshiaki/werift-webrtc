---
ide:
  viewer: review-document
  version: 1
  title: "polyfill の DOM 型互換（キャスト不要化）のレビュー"
  dock: right
  baseCommit: 1c70e82b7572ad54d45d95c6f2e39956c7bd2183
---
# polyfill 使用時の `as unknown as ProducerOptions["track"]` を不要にする変更のレビュー

## 1. 概要

werift の `MediaStreamTrack` / `MediaStream` を、DOM の同名型に**構造的に代入できる**ようにしました。`mediasoup-client` の `sendTransport.produce({ track })` に werift の track をキャストなしで渡せます。実行時は元から動いていたので、問題は型だけでした。そのため「嘘の型を返すヘルパー」ではなく、DOM 型が要求するメンバーを実際に実装して型を合わせています。

差分の基準は develop マージ後の `42b7594d4` から HEAD（`c63d90b51`）までです。生成ドキュメントと website を除くと、ソースは `packages/webrtc` に集中しています。

### 受け入れテスト（ここだけ見れば目的の達成を確認できます）

[packages/webrtc/tests/nonstandard/acceptance.test.ts](review-file:packages/webrtc/tests/nonstandard/acceptance.test.ts) の 2 件で、チケットの目的（キャストなしで DOM 型の `produce({ track })` に渡せ、実際に送られる）を確認します。型検査の対象は [packages/webrtc/tests/nonstandard/acceptanceDomCompile/consumer.ts](review-file:packages/webrtc/tests/nonstandard/acceptanceDomCompile/consumer.ts) です。

| テスト | 確認すること |
|---|---|
| 1章・5章: チケットのコードがキャストなしで lib.dom の型検査を通る | チケット冒頭のコードからキャストを外したものが `lib.dom` + `skipLibCheck: false` で通り、`producer.track?.nonexistent` は型エラーのまま（any にならない） |
| 1章・2章: キャストせず渡した track が送られ ended が届く | polyfill の `RTCPeerConnection` 2 つを loopback で接続し、渡した track の RTP が受信側に届き、`stop()` でライブラリの `"ended"` listener が 1 回呼ばれる |

実行: `cd packages/webrtc && npx vitest run tests/nonstandard/acceptance.test.ts`（約 10 秒。大半は tsc）。実装を 6 か所壊すとどれかの件が落ち、チケット作成前のリビジョンでは型検査がチケット記載の TS2740 で落ちます（詳細はチケット 8 章）。

## 2. 修正前と修正後

<div style="display:flex;gap:16px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:300px;border:2px solid #c0392b;border-radius:8px;padding:12px">
<b style="color:#c0392b">Before</b>（DOM あり構成）
<pre style="white-space:pre-wrap">new WeriftMediaStreamTrack({kind})
  ↓ produce({ track })   // track?: DOM MediaStreamTrack
<span style="color:#c0392b">TS2740: contentHint, onended, onmute,
onunmute, getSettings … が無い
id?: string ≠ string / onReceiveRtp の定義が不一致</span>
  ↓ 回避
track as unknown as ProducerOptions["track"]</pre>
</div>
<div style="flex:1;min-width:300px;border:2px solid #27ae60;border-radius:8px;padding:12px">
<b style="color:#27ae60">After</b>（同じ構成）
<pre style="white-space:pre-wrap">new WeriftMediaStreamTrack({kind})
  ↓ produce({ track })
<span style="color:#27ae60">DomEventTarget を継承、id: string、
contentHint / onended / onmute / onunmute /
getSettings / getConstraints /
getCapabilities / applyConstraints を実装
→ DOM 型にそのまま代入可能</span>
  ↓
キャスト不要</pre>
</div>
</div>

図の説明: 左は型だけが合わずキャストを強いられていた経路、右は実装を足して型が合う経路です。`werift/polyfill`（DOM なし）側は `globals.ts` で型を宣言し、ライブラリの `.d.ts` が werift の型に解決されます。

## 3. 主要変更

### 3.1 `MediaStreamTrack` / `MediaStream` の DOM 互換

- [packages/webrtc/src/media/track.ts:177](review-file:packages/webrtc/src/media/track.ts:177) `MediaStreamTrack<K extends Kind = Kind>` が `DomEventTarget` を継承します。`kind` を型引数にしたのは、`mediabunny` が DOM の `getAudioTracks()` を `kind: "audio"` の型に狭めているためです。
- [packages/webrtc/src/media/track.ts:194](review-file:packages/webrtc/src/media/track.ts:194) `contentHint` は保持するだけです。
- [packages/webrtc/src/media/track.ts:309](review-file:packages/webrtc/src/media/track.ts:309) `getSettings()`、[packages/webrtc/src/media/track.ts:375](review-file:packages/webrtc/src/media/track.ts:375) `applyConstraints()`。ended の track は `deviceId` / `groupId` だけを返します。必須制約が合わない場合や未対応名の場合は `OverconstrainedError` で reject し、以前の制約を保ちます。
- [packages/webrtc/src/media/track.ts:485](review-file:packages/webrtc/src/media/track.ts:485) `MediaStream` も `DomEventTarget` を継承し、`onaddtrack` / `onremovetrack` を持ちます。
- 変更の全体は [packages/webrtc/src/media/track.ts](review-diff:packages/webrtc/src/media/track.ts) です。

### 3.2 DOM イベント互換を 1 か所に集約

[packages/webrtc/src/media/domEventTarget.ts:61](review-file:packages/webrtc/src/media/domEventTarget.ts:61) の `DomEventTarget` が、`dispatchEvent` の戻り値、`on<type>` ハンドラ属性、`handleEvent` オブジェクト、重複登録の無視、`once` / `passive` / `signal` を扱います。`dispatchEvent`（[:109](review-file:packages/webrtc/src/media/domEventTarget.ts:109)）は cancelable なイベントが cancel されたときだけ `false` を返します。差分は [packages/webrtc/src/media/domEventTarget.ts](review-diff:packages/webrtc/src/media/domEventTarget.ts) です。

共通の `helper.ts` の `EventTarget` は変えていません。`RTCPeerConnection` などへの影響を避けるためです。

### 3.3 制約まわりの型とロジック

[packages/webrtc/src/media/trackConstraints.ts:44](review-file:packages/webrtc/src/media/trackConstraints.ts:44) に、DOM 型を参照しない `WeriftMediaTrackSettings` などを定義しました。コアは `lib.dom` なしでビルドされるためです。`selectSettings.ts` にあった制約判定を共通化したため、[packages/webrtc/src/polyfill/selectSettings.ts](review-diff:packages/webrtc/src/polyfill/selectSettings.ts) は約 180 行減っています。

### 3.4 polyfill の型エントリ

- [packages/webrtc/src/polyfill/dom.ts:9](review-file:packages/webrtc/src/polyfill/dom.ts:9) augmentation を werift のクラスから `Pick` で導出します。これで `onReceiveRtp` が `RtpReceiveInfo` を含む形でクラスと一致します。
- 同ファイル [:32](review-file:packages/webrtc/src/polyfill/dom.ts:32) の `MediaStreamTrack` は、DOM クラスのコンストラクタ型で export します。`lib.dom` のグローバルは引数なしのコンストラクタなので、グローバルの型は差し替えられないためです。
- [packages/webrtc/src/polyfill/globals.ts:43](review-file:packages/webrtc/src/polyfill/globals.ts:43) DOM なし構成向けに `interface MediaStreamTrack extends WeriftMediaStreamTrack {}` を追加し、値と型を merge しています。
- [packages/webrtc/src/polyfill/mediaDevices.ts](review-diff:packages/webrtc/src/polyfill/mediaDevices.ts) は、選択済みの settings と制約を track に渡します。

## 4. 判断理由

- **採用しなかった案**: `asDomTrack(track)` のような変換ヘルパーや、ライブラリ内部の `as unknown as`。キャストの場所が移るだけで、`getSettings` などが実行時に無い嘘の型になります。
- **ハンドラの例外は記録して隔離する**: DOM は listener の例外を呼び出し元に伝えません。DataChannel（#815）の方針とも揃えています。`stop()` や polyfill の cleanup が `onended` の例外で失敗しなくなります。
- **`on*` は `dispatchEvent` でも呼ぶ**: HTML ではハンドラ属性が listener の一種だからです。werift 自身は `mute` / `unmute` / `addtrack` / `removetrack` を発火しません。
- **レビューで繰り返し出た差異を、ネイティブ `EventTarget` との差分テストで収束させる**: 個別修正だと、同種の差異が別クラスに残るためです。
- **推奨 8（逆方向の受け渡し）は見送り**: werift の API 引数を DOM 型にすると、`uuid` や broadcast source などの内部を保証しない型になります。DOM 型の値は `instanceof` で絞り込む方針を guide に書きました。
- **推奨 9（`integration/werift-mediasoup-interop`）**: submodule のため、この変更には含めていません。ローカルでの確認結果はチケット第 6 節にあります。

## 5. レビュアーが確認すべき点・リスク

- **公開 API の変更（changelog に Breaking として記載）**: `id` が `string` 必須、`getTrackById()` が `null` を返す、`MediaStream` の継承元が `DomEventTarget` に変わる、`MediaStreamTrack` が型引数を持つ、`"ended"` listener の例外が `stop()` に伝わらなくなる。
- **意図的な非互換**: `stop()` で `"ended"` を発火します（DOM は発火しません）。`event.target` は設定せず、capture / bubble も扱いません。
- **未確認の仕様**: ended の track に対する `applyConstraints()` の仕様は全文を照合できておらず、通常どおり判定しています（チケット第 7 節）。
- **既存の `"ended"` の発火回数・順序**: `trackStop.ts` の `bindOwnTrackStop`、`stopAllTracks`、`clone()` の挙動が変わっていないかを確認してください。回帰テストは [packages/webrtc/tests/media/trackDomCompat.test.ts](review-diff:packages/webrtc/tests/media/trackDomCompat.test.ts) と [packages/webrtc/tests/nonstandard/polyfillCleanup.test.ts](review-diff:packages/webrtc/tests/nonstandard/polyfillCleanup.test.ts) にあります。
- ドキュメントは [docs/polyfill/guide.md](review-diff:docs/polyfill/guide.md)、[docs/polyfill/README.md](review-diff:docs/polyfill/README.md)、[changelog.md](review-diff:changelog.md) を更新しています。

## 6. テスト構成

- [packages/webrtc/tests/media/domEventTarget.test.ts:10](review-file:packages/webrtc/tests/media/domEventTarget.test.ts:10): ネイティブ `EventTarget` との差分テスト。全操作列を網羅し、Node と HTML 仕様が食い違う 2 点（ハンドラを `null` にした後の位置、`false` 返却での cancel）は別に検査します。
- [packages/webrtc/tests/media/trackDomCompat.test.ts](review-diff:packages/webrtc/tests/media/trackDomCompat.test.ts): `getSettings` / `applyConstraints` / `onended` などの実行時テスト。
- [packages/webrtc/tests/nonstandard/polyfillDomCompile/consumer.ts](review-diff:packages/webrtc/tests/nonstandard/polyfillDomCompile/consumer.ts)（`lib.dom`、`skipLibCheck: false`）と [packages/webrtc/tests/nonstandard/polyfillNodeCompile/consumer.ts](review-diff:packages/webrtc/tests/nonstandard/polyfillNodeCompile/consumer.ts)（DOM なし）: キャストなしの代入が通ることを確認する compile fixture。

## 7. 検証結果

このドキュメントの作成時点で、私はテスト、型検査、`npm run doc:check` を実行していません。以下は実行した確認ではありません。

- チケットの完了条件が求める検証: `cd packages/webrtc && npm test`、`npm run type`、`npm run test:small`、`npm run doc` と `npm run doc:check`。
- 実物の `mediasoup-client@3.22.0` を使う型検証は、チケット第 6 節によれば submodule 側でローカルに確認済みです。この値はチケット記載を引いたもので、私は再実行していません。

レビュアーは、上記コマンドの結果を最終確認してください。
