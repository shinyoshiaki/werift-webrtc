# mediasoup-client が追加設定なしで Node.js 上で動作するようにする

## 1. タスクの目的と背景

親チケットで追加された `werift/polyfill` は、`installPolyfill({ mediaRegister })` の実行によって `RTCPeerConnection`、`MediaStream`、`navigator.mediaDevices` などを werift 実装としてグローバルへ公開する。しかし、現状のまま Node.js で `mediasoup-client` を利用すると、WebRTC API が存在していても次の箇所で失敗する。

- Node 18 では通常 `navigator` 自体が存在せず、Node 21 以降では `navigator.userAgent` が `Node.js/<major>` になる。
- 現行の `installPolyfill()` は既存の `navigator` を維持して `mediaDevices` を追加するが、`userAgent` は補完しない。
- `mediasoup-client` v3 の引数なし `Device.factory()` / `new Device()` は `navigator.userAgent`（または `userAgentData`）から組み込み Handler を選択する。Node の User-Agent では Handler を選べず、`UnsupportedError: device not supported` になる。
- 呼び出し側で `{ handlerName: "Chrome111" }` や独自 `handlerFactory` を指定すれば回避できるが、ブラウザ向けコードのドロップイン利用という親チケットの目的に反する。

本タスクでは、polyfill のインストールだけで `mediasoup-client` が Chrome111 Handler を自動選択できるブラウザ識別面を追加し、既存 werift API で `Device.load()`、送受信 Transport、DataChannel の主要な制御フローが動くことを統合テストで保証する。

ここでいう「追加設定なし」は次の意味とする。

- 利用者は親チケットの契約どおり `installPolyfill({ mediaRegister })` を実行する。必須の `mediaRegister` は省略しない。
- `mediasoup-client` 側には `handlerName` / `handlerFactory` を渡さず、`Device.factory()` を呼べる。
- `navigator.userAgent` を利用者が手作業で書き換える必要がない。
- mediasoup サーバとのシグナリング、Router/Transport パラメーターの授受、実際に送信するメディア register の指定は引き続きアプリケーションの責務であり、「無設定」の対象外とする。

公式仕様・実装上の根拠:

- [mediasoup-client v3 API](https://mediasoup.org/documentation/v3/mediasoup-client/api/) は、ブラウザでは Handler 引数を省略し、自動検出する契約を示している。
- [mediasoup-client v3 Design](https://mediasoup.org/documentation/v3/mediasoup-client/design/) では、通常の Node.js 利用ではカスタム Handler が必要とされている。本タスクでは werift がブラウザ WebRTC 面を提供するため、既存 Chrome111 Handler をそのまま利用する。
- [`Device.ts`](https://github.com/versatica/mediasoup-client/blob/v3/src/Device.ts) は User-Agent から Handler を選び、Chromium 111 以上を `Chrome111` と判定する。
- [`Chrome111.ts`](https://github.com/versatica/mediasoup-client/blob/v3/src/handlers/Chrome111.ts) が利用する `RTCPeerConnection`、Unified Plan、sender/receiver、DataChannel の主要 API は、現在の親ブランチの werift 実装で既に提供されている。

## 2. 実装すべき具体的な機能や変更内容

### 2.1 Node 用ブラウザ識別情報のインストール

`packages/webrtc/src/polyfill/install.ts` から利用する内部ヘルパを `packages/webrtc/src/polyfill/browserIdentity.ts`（名称は実装時に同等の責務が分かれば変更可）へ追加する。

- `target.navigator.userAgent` が未定義、空文字、または `Node.js/<major>` 形式の場合に限り、Chromium 111 以上として判定される固定 User-Agent を own property として定義する。
- User-Agent は `mediasoup-client` が `Chrome111` Handler を選べる最小の安定した値に固定し、実行中 Node のバージョンから Chrome バージョンを生成しない。例:

  ```text
  Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36
  ```

- 既に Chrome / Firefox / Safari 等の非 Node User-Agent がある場合は上書きしない。実ブラウザや利用者が明示した sandbox の識別情報を破壊しない。
- Node 21+ の既存 `navigator` オブジェクトは置換せず、`userAgent` と `mediaDevices` を同じオブジェクト上へ定義する。
- `target` が指定された場合は `globalThis` ではなく `target.navigator` に適用する。WPT sandbox でも同じインストーラー契約を維持する。
- `existingMediaDevices: "noop"` は親チケットどおり `mediaDevices` だけを対象にする。User-Agent の補完は他の WebRTC グローバルと同様に実行する。
- `navigator.userAgentData` や `navigator.product` は本タスクでは偽装しない。調査した `mediasoup-client` v3 の Chrome111 判定は User-Agent だけで成立し、変更するグローバル面を最小化できる。
- `mediasoup-client` を werift の runtime dependency に追加したり、polyfill 本体から import したりしない。互換性は標準的なブラウザ面を介して実現する。

### 2.2 原状復帰と失敗時ロールバック

現在の `snapshotNavigator()` / `restoreNavigator()` は `navigator` と `mediaDevices` の descriptor を保存している。これを `userAgent` にも拡張する。

- インストール前の `userAgent` が own property なら、value/getter/setter、enumerable、writable、configurable を含む元 descriptor を保存する。
- 元が prototype 由来または未定義なら、アンインストール時に polyfill が追加した own property を削除し、元の参照結果へ戻す。
- User-Agent 定義後に別のグローバル定義が失敗した場合も、catch 内のロールバックで `navigator` / `mediaDevices` / `userAgent` をすべて復元する。
- 二重アンインストールや、アンインストール前に利用者が同じ property を変更した場合の扱いは、現在の descriptor 復元方針に合わせる。少なくとも返却された uninstall を 1 回呼ぶ標準経路で完全に元へ戻ることを保証する。
- non-configurable な既存 Node User-Agent を安全に差し替えられない場合は、部分的にグローバルを残さずインストールを失敗させる。例外を握りつぶして mediasoup の `UnsupportedError` まで遅延させない。

### 2.3 TypeScript のグローバル型

`packages/webrtc/src/polyfill/index.ts` の `declare global` に、インストール後に保証される `Navigator.userAgent: string` を追加する。

- werift の公開型から `mediasoup-client` 固有型は露出しない。
- `lib: ["esnext"]` の Node 向け TypeScript プロジェクトで、先に `werift/polyfill` を import した後に `mediasoup-client` の `Device` を利用するスモークを型検査する。
- DOM lib を含む場合も同じ `string` 型で declaration merging できるようにし、独自の別名 `Navigator` 型を公開しない。

### 2.4 mediasoup-client 統合フロー

次の利用形を正式な互換例とする。

```ts
import { Device } from "mediasoup-client";
import {
  createCallbackRegister,
  installPolyfill,
} from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [
    createCallbackRegister({
      mimeType: "audio/opus",
      kinds: ["audio"],
      async createTracks() {
        return [createAudioTrack()];
      },
    }),
  ],
});

const device = await Device.factory(); // handlerName / handlerFactory は不要
await device.load({ routerRtpCapabilities });
```

互換対象は `mediasoup-client` v3 の Chrome111 Handler とし、少なくとも以下を統合テストで通す。

1. `detectDevice()` が `"Chrome111"` を返し、引数なし `Device.factory()` が成功する。
2. `Device.load({ routerRtpCapabilities })` が send/recv RTP capabilities を生成し、audio/video の `canProduce()` が期待どおりになる。
3. send Transport へ polyfill の `getUserMedia()` で得た werift `MediaStreamTrack` を渡し、`transport.produce()` が SDP offer/answer と `connect` / `produce` callback を完了する。
4. recv Transport の `transport.consume()` が成功し、返却 track が werift の `MediaStreamTrack` で、`readyState` と `writeRtp` / `onReceiveRtp` を維持する。
5. SCTP パラメーター付き send Transport の `transport.produceData()` が成功し、werift `RTCDataChannel` を保持する DataProducer を返す。
6. Transport の close と polyfill の uninstall 後に open handle や未処理 rejection を残さない。

実 mediasoup サーバへの ICE/DTLS 接続は既存の WebRTC 相互接続能力の範囲であり、この子タスクの必須 E2E には含めない。ここでは `mediasoup-client` の Chrome111 Handler が行う capability 抽出、SDP 操作、sender/receiver/DataChannel 操作を実際の werift クラスで通す。統合テスト中に不足 API が判明した場合は、mediasoup 専用ラッパではなく対応する werift クラスのブラウザ互換 API を根本修正する。

### 2.5 テスト、依存関係、ドキュメント

- 通常 CI は Node 18 であるため、再現可能な統合 fixture は Node 18 対応かつ Chrome111 Handler / `Device.factory()` を持つ `mediasoup-client@3.16.4` に固定する。`^` は付けず、将来の engine 要件変更や Handler 差分で CI が無関係に壊れないようにする。
- 調査時点の `mediasoup-client@3.22.0`（Node 22+）でも、User-Agent を補完した現行 werift により `Device.factory()`、`load()`、audio Producer、audio Consumer、DataProducer の制御フローが通ることを確認済み。公開契約は特定パッチ版の内部実装ではなく v3 Chrome111 Handler が利用するブラウザ面に置く。
- 外部利用に近いスモークは `import-test/mediasoup.mjs` と共有 Arrange helper に置き、ビルド済み `werift-dev/polyfill` を import して実行する。`import-test/package.json` と lockfile にテスト用依存を追加する。
- descriptor 単体テストは `packages/webrtc/tests/nonstandard/polyfill.test.ts` に追加する。mediasoup の繰り返し setup は `packages/webrtc/tests/nonstandard/mediasoupClientTestUtils.ts` など 1 ファイルへ集約する。
- 新規テストは Arrange / Act / Assert に分け、Act / Assert の操作意図と検証点に日本語コメントを付ける。
- `README.md`、`website/docs/doc1.md`、`website/i18n/ja/docusaurus-plugin-content-docs/doc1.md` に上記の最小例を追加し、「追加設定なし」が mediasoup Handler 選択を指し、シグナリングと `mediaRegister` は必要であることを明記する。
- User-Agent 補完は Node 固有の互換処理であり、実ブラウザの User-Agent は維持すること、uninstall で元に戻ることをドキュメントに記載する。

## 3. 技術的な実装アプローチの調査結果

### 現行コードの状態

- `packages/webrtc/src/polyfill/install.ts` は WebRTC コンストラクタと `navigator.mediaDevices` を注入し、uninstall 用 descriptor snapshot も既に持つ。新規インストーラーを作る必要はなく、このライフサイクルへ `userAgent` を追加するのが最小変更となる。
- `RTCPeerConnection` は `addTransceiver`、`createOffer` / `createAnswer`、`setLocalDescription` / `setRemoteDescription`、`getConfiguration` / `setConfiguration`、EventTarget 互換 listener、sender/receiver stats、SCTP を既に持つ。
- `RTCRtpSender` は `replaceTrack`、`getParameters`、`setParameters` を持ち、`MediaStreamTrack` は `readyState`、`enabled`、`stop`、`writeRtp` を持つ。Chrome111 Handler が基本送受信で利用する面は揃っている。
- `MediaStream`、`RTCSessionDescription`、`RTCTrackEvent` など、親チケットで補われた互換面も mediasoup の SDP/track フローにそのまま利用できる。

### 再現結果

現行ブランチ、Node 24、`mediasoup-client@3.22.0` で次を確認した。

| 条件 | 結果 |
| --- | --- |
| `installPolyfill({ mediaRegister: [] })` のみ | `navigator.userAgent === "Node.js/24"`、`detectDevice() === undefined`、`Device.factory()` は `UnsupportedError` |
| 上記に Chromium 111 User-Agent を一時追加 | `detectDevice() === "Chrome111"`、引数なし `Device.factory()` 成功 |
| fake Router capabilities で `device.load()` | audio/video capabilities の生成に成功 |
| fake Transport parameters で audio `produce()` | `connect` / `produce` callback と SDP 交渉に成功 |
| audio `consume()` | live な werift track の取得に成功 |
| `produceData()` | negotiated DataChannel の作成に成功 |

この結果から、確認した主要フローの未解決阻害点は WebRTC API 本体ではなく Handler 自動検出用 User-Agent である。よって初手でカスタム mediasoup Handler を追加する必要はない。

### 実装順序

1. User-Agent の条件判定、descriptor snapshot、install/restore を小さな内部ヘルパとして実装する。
2. `installPolyfill()` の navigator 構築後にヘルパを適用し、例外時の既存ロールバックへ統合する。
3. Node UA、空 target、既存ブラウザ UA、`existingMediaDevices` 3 モード、uninstall、途中失敗の単体テストを追加する。
4. ビルド済み polyfill と pinned `mediasoup-client` を使う外部統合スモークを追加する。
5. 統合スモークで不足が出た WebRTC API だけを既存クラスへ追加し、mediasoup 固有分岐をコアへ持ち込まない。
6. README と英日サイト文書を更新し、package test、type、import-test を実行する。

## 4. 考慮すべき制約や注意点

- polyfill は opt-in のままにする。`werift` の通常 import だけで User-Agent やグローバルを変更してはならない。
- 「無設定」は `mediasoup-client` の Handler 指定が不要という意味であり、親チケットの必須 `mediaRegister`、mediasoup サーバのシグナリング、Transport event callback まで不要にするものではない。
- 固定 User-Agent は werift が完全な Chromium であると一般保証するものではない。値は Chrome111 Handler の feature contract を選択する互換識別子として文書化する。
- 実ブラウザや非 Node の既存 User-Agent を上書きしない。ブラウザで `installPolyfill()` を誤実行した場合の影響を増やさない。
- Node 21+ の `navigator` は accessor 経由で提供され、`userAgent` は prototype getter である。グローバル `navigator` の代入ではなく、既存オブジェクトへの own property 定義と descriptor 復元を使う。
- WPT sandbox は同じ `installPolyfill({ target })` を利用する。User-Agent の追加で WPT の feature detection が変わる可能性があるため、許可リスト WPT も回帰確認する。ただし WPT runner 専用の strict shim を polyfill 本体へ移さない。
- `existingMediaDevices: "throw"` は変更前に判定される現在の atomicity を維持し、エラー時に User-Agent だけが残らないようにする。
- `mediasoup-client` は本番依存にしない。追加するのはテスト用の固定バージョンのみとし、werift の配布サイズや利用者の依存グラフへ含めない。
- リポジトリの通常 CI は Node 18、調査時点の `mediasoup-client@3.22.0` は Node 22+ を要求する。通常 CI fixture を `3.16.4` に固定する理由をコメントに残し、最新版へ更新するときは Node matrix とセットで見直す。
- mediasoup の fake parameter オブジェクトは freeze されている版がある。Chrome111 Handler は DTLS role を更新するため、テストでは `structuredClone()` した値を Transport へ渡す。
- 実 mediasoup server、codec encode/decode、OS カメラ/マイク capture は対象外。RTP 実データの供給は親チケットの register / `writeRtp` 契約を利用する。
- テスト用 Transport は必ず close し、polyfill は `finally` で uninstall する。ICE、DTLS、SCTP、タイマーの open handle を残さない。
- 公開 API や protocol behavior に不足が見つかった場合は、`packages/webrtc/AGENTS.md` に従い package-local type/test を先に実行し、失敗を握りつぶす互換 shim は追加しない。

## 5. 完了条件

- [ ] `installPolyfill({ mediaRegister })` 後、Node 18 の空 navigator と Node 21+ の `Node.js/<major>` User-Agent の双方で Chromium 111 互換 User-Agent が得られる
- [ ] `target` 指定時は `target.navigator.userAgent` にだけ適用され、`globalThis.navigator` を誤って変更しない
- [ ] 既存の非 Node User-Agent は保持される
- [ ] Node 21+ の既存 `navigator` オブジェクトは置換されない
- [ ] `existingMediaDevices: "overwrite" | "throw" | "noop"` の既存契約を壊さず、`noop` 時も Handler 自動検出に必要な User-Agent は補完される
- [ ] インストール途中の失敗と uninstall の両方で、`navigator`、`mediaDevices`、`userAgent` の descriptor がインストール前と一致する状態へ戻る
- [ ] `werift/polyfill` のグローバル型から `navigator.userAgent` を `string` として参照でき、mediasoup-client 利用例が Node 向け TypeScript 設定で型検査を通る
- [ ] `mediasoup-client` へ `handlerName` / `handlerFactory` を渡さず、`detectDevice() === "Chrome111"` および `Device.factory()` 成功を確認できる
- [ ] `Device.load()` が成功し、audio/video の RTP capabilities と `canProduce()` を取得できる
- [ ] polyfill の `getUserMedia()` が返した werift track を `transport.produce()` に渡して Producer を作成できる
- [ ] `transport.consume()` が返す track が werift `MediaStreamTrack` であり、`readyState`、`writeRtp`、`onReceiveRtp` を利用できる
- [ ] `transport.produceData()` で werift `RTCDataChannel` を使う DataProducer を作成できる
- [ ] テスト終了後に未処理 rejection、タイマー、ICE/DTLS/SCTP の open handle が残らない
- [ ] `mediasoup-client` は固定バージョンの test/dev dependency に限定され、werift の runtime dependencies へ追加されていない
- [ ] User-Agent の install/保持/復元/rollback の単体テストと、ビルド済み `werift-dev/polyfill` を使う mediasoup-client import/integration smoke が追加されている
- [ ] 新規テストは Arrange / Act / Assert に分かれ、Act / Assert に適切な日本語コメントがあり、共通 Arrange は単一 helper ファイルへ集約されている
- [ ] README、英語サイト文書、日本語サイト文書に Handler 指定不要の例、引き続き必要な `mediaRegister` / シグナリング、User-Agent の条件付き補完と uninstall を記載している
- [ ] `cd packages/webrtc && npm run type` が成功する
- [ ] `cd packages/webrtc && npm test` が成功する
- [ ] `cd import-test && npm test` が成功する
- [ ] `npm run wpt --workspace packages/webrtc` が成功し、User-Agent 追加で許可リスト WPT に回帰がない
