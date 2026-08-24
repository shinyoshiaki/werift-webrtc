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
- `navigator.userAgent` を利用者が手作業で書き換える必要がない。既定値が要件に合わない場合は `installPolyfill()` の `userAgent` オプションで明示的に上書きできる。
- mediasoup サーバとのシグナリング、Router/Transport パラメーターの授受、実際に送信するメディア register の指定は引き続きアプリケーションの責務であり、「無設定」の対象外とする。

公式仕様・実装上の根拠:

- [mediasoup-client v3 API](https://mediasoup.org/documentation/v3/mediasoup-client/api/) は、ブラウザでは Handler 引数を省略し、自動検出する契約を示している。
- [mediasoup-client v3 Design](https://mediasoup.org/documentation/v3/mediasoup-client/design/) では、通常の Node.js 利用ではカスタム Handler が必要とされている。本タスクでは werift がブラウザ WebRTC 面を提供するため、既存 Chrome111 Handler をそのまま利用する。
- [`Device.ts`](https://github.com/versatica/mediasoup-client/blob/v3/src/Device.ts) は User-Agent から Handler を選び、Chromium 111 以上を `Chrome111` と判定する。
- [`Chrome111.ts`](https://github.com/versatica/mediasoup-client/blob/v3/src/handlers/Chrome111.ts) が利用する `RTCPeerConnection`、Unified Plan、sender/receiver、DataChannel の主要 API は、現在の親ブランチの werift 実装で既に提供されている。

## 2. 実装すべき具体的な機能や変更内容

### 2.1 Node 用ブラウザ識別情報のインストール

`packages/webrtc/src/polyfill/install.ts` から利用する内部ヘルパを `packages/webrtc/src/polyfill/browserIdentity.ts`（名称は実装時に同等の責務が分かれば変更可）へ追加する。

`InstallPolyfillOptions` に任意の `userAgent?: string` を追加する。

```ts
interface InstallPolyfillOptions {
  mediaRegister: MediaRegister[];
  existingMediaDevices?: "overwrite" | "throw" | "noop";
  target?: object;
  /** navigator.userAgent に設定する値。指定時は既存値より優先する */
  userAgent?: string;
}
```

User-Agent の決定優先順位を次で固定する。

| 条件 | 動作 |
| --- | --- |
| `userAgent` に空でない文字列を指定 | 既存値が Node / ブラウザ / 独自 sandbox のいずれでも、指定値で `target.navigator.userAgent` を上書きする |
| `userAgent` を省略し、既存値が未定義・空文字・`Node.js/<major>` | Chromium 111 互換の既定値を設定する |
| `userAgent` を省略し、既存値が非 Node の空でない文字列 | 既存値を保持する |

- `userAgent` を明示した場合は利用者の指定をそのまま尊重する。Chrome111 として検出できない値を指定した結果、`mediasoup-client` が `UnsupportedError` を返すことは利用者責任とし、polyfill 側で値を書き換え直さない。
- `userAgent` が文字列以外、空文字、または空白のみの場合は `TypeError` とし、WebRTC グローバルを一切変更する前に拒否する。`undefined` は省略扱いとする。

- `target.navigator.userAgent` が未定義、空文字、または `Node.js/<major>` 形式の場合に限り、Chromium 111 以上として判定される固定 User-Agent を own property として定義する。
- User-Agent は `mediasoup-client` が `Chrome111` Handler を選べる最小の安定した値に固定し、実行中 Node のバージョンから Chrome バージョンを生成しない。例:

  ```text
  Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/111.0.0.0 Safari/537.36
  ```

- `userAgent` オプションを省略した場合、既に Chrome / Firefox / Safari 等の非 Node User-Agent があれば上書きしない。実ブラウザや利用者が明示した sandbox の識別情報を暗黙に破壊しない。明示オプションを渡した場合だけ上書きを許可する。
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
- 明示 `userAgent` で既存ブラウザ User-Agent を上書きした場合も、uninstall 後は明示値ではなくインストール前の descriptor と値へ戻す。

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
  // 任意。省略時は Node で Chrome111 互換値が自動設定される。
  // userAgent: "Mozilla/5.0 ... Chrome/120.0.0.0 Safari/537.36",
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

上記の制御フロー試験は werift 本体で高速に実行する。一方、実 mediasoup worker への ICE/DTLS/SRTP/SCTP 接続と RTP/DataChannel の往復は、2.6 の独立プロジェクトで必須 E2E として実行する。統合テスト中に不足 API が判明した場合は、mediasoup 専用ラッパではなく対応する werift クラスのブラウザ互換 API を根本修正する。

### 2.5 テスト、依存関係、ドキュメント

- 通常 CI は Node 18 であるため、再現可能な統合 fixture は Node 18 対応かつ Chrome111 Handler / `Device.factory()` を持つ `mediasoup-client@3.16.4` に固定する。`^` は付けず、将来の engine 要件変更や Handler 差分で CI が無関係に壊れないようにする。
- 調査時点の `mediasoup-client@3.22.0`（Node 22+）でも、User-Agent を補完した現行 werift により `Device.factory()`、`load()`、audio Producer、audio Consumer、DataProducer の制御フローが通ることを確認済み。公開契約は特定パッチ版の内部実装ではなく v3 Chrome111 Handler が利用するブラウザ面に置く。
- 外部利用に近いスモークは `import-test/mediasoup.mjs` と共有 Arrange helper に置き、ビルド済み `werift-dev/polyfill` を import して実行する。`import-test/package.json` と lockfile にテスト用依存を追加する。
- descriptor 単体テストは `packages/webrtc/tests/nonstandard/polyfill.test.ts` に追加する。mediasoup の繰り返し setup は `packages/webrtc/tests/nonstandard/mediasoupClientTestUtils.ts` など 1 ファイルへ集約する。
- User-Agent の単体テストには、オプション省略時の Node UA 補完、既存ブラウザ UA の保持、明示 `userAgent` による上書き、空文字・非文字列の拒否、`target` への適用、uninstall/rollback による復元を含める。
- 新規テストは Arrange / Act / Assert に分け、Act / Assert の操作意図と検証点に日本語コメントを付ける。
- `README.md`、`website/docs/doc1.md`、`website/i18n/ja/docusaurus-plugin-content-docs/doc1.md` に上記の最小例を追加し、「追加設定なし」が mediasoup Handler 選択を指し、シグナリングと `mediaRegister` は必要であることを明記する。
- User-Agent 補完は Node 固有の互換処理であり、オプション省略時は実ブラウザの User-Agent を維持すること、明示 `userAgent` で上書きできること、uninstall で元に戻ることをドキュメントに記載する。

### 2.6 独立 mediasoup 相互接続プロジェクト

IDE CLI で独立プロジェクト `werift-mediasoup-interop` を作成し、公開 GitHub repository
[`shinyoshiaki/werift-mediasoup-interop`](https://github.com/shinyoshiaki/werift-mediasoup-interop) として管理する。
werift 本体には `integration/werift-mediasoup-interop` として Git submodule を追加する。

- 独立 checkout と submodule checkout の両方をサポートする。`WERIFT_REPO_ROOT` を最優先し、submodule 配置時は親 repository、IDE の標準配置では sibling の `werift-webrtc` を探索する。
- npm で公開済みの `werift` や本体の build output は使わず、解決した checkout の `packages/webrtc/src/polyfill/index.ts` を `tsx` で直接 import する。これにより開発中の変更を package publish/build 待ちなしで試験する。
- 各 E2E の Arrange で開発中の `installPolyfill({ mediaRegister, userAgent? })` を実行し、`finally` で uninstall する。`mediasoup-client` には `handlerName` / `handlerFactory` を渡さない。
- `mediasoup` と `mediasoup-client` は再現可能性のため exact version に固定する。native worker / esbuild の install script は確認した exact version のみ `allowScripts` で許可する。
- fixture は Node 22 以上を対象とし、最低 Node 22 / 24 の CI matrix を持つ。Node 18 互換は werift 本体の pinned `mediasoup-client@3.16.4` 制御フロースモークで維持する。
- 通常の PR 必須ジョブは pinned version で実行する。mediasoup / mediasoup-client 最新版との compatibility probe は定期ジョブとして追加し、失敗時に本体の必須 CI を即座に壊さず追跡 ticket を作れる出力を残す。

実 mediasoup worker を用いる E2E matrix は少なくとも次を含める。

| 領域 | 必須ケース |
| --- | --- |
| 起動・検出 | worker/router 起動、polyfill install、`detectDevice()`、引数なし `Device.factory()` / `load()`、uninstall 復元 |
| capability | Opus、VP8、H264 の交渉、audio/video `canProduce()`、未対応 codec / 不正 parameter の拒否 |
| transport | send/recv WebRtcTransport の ICE/DTLS 接続、ICE restart、接続状態遷移、server/client 双方起点の close と失敗伝播 |
| audio | synthetic Opus RTP の produce/consume と sequence/timestamp/SSRC 検証、pause/resume、replaceTrack、producer/consumer close |
| video | synthetic VP8/H264 RTP の produce/consume、simulcast、preferred layer、key-frame request、track replacement |
| data | reliable/unreliable、ordered/unordered の DataProducer/DataConsumer、label/protocol、双方向 message、close |
| 多重化 | 複数 transport / producer / consumer、audio+video+data 同時接続、独立した pause/close が他 stream を壊さないこと |
| lifecycle | worker/transport/client の各終了順、失敗後の再作成、未処理 rejection・子 process・socket・timer の open handle が残らないこと |

- カメラ、マイク、codec encoder/decoder の OS 依存試験は含めない。決定的な synthetic RTP source/sink を使い、実パケットが mediasoup Router を通って相手側の werift track へ届くことを header と payload marker で検証する。
- 共有 Arrange は `test/helpers` に集約する。worker/router、WebRtcTransport、signaling callback、synthetic RTP、resource cleanup を別責務の helper に分け、ケース間で setup を複製しない。
- 実 E2E は loopback UDP/TCP port を OS に割り当てさせ、固定 port の競合を避ける。Linux/macOS の差を吸収し、Native Windows は対象外とする。
- submodule 更新を伴う werift 側 PR と、fixture repository 側 PR/commit の対応関係をチケットに記録する。CI は `git submodule update --init --recursive` 後に `npm ci`、`npm run type`、`npm test` を実行する。

## 3. 技術的な実装アプローチの調査結果

### 現行コードの状態

- `packages/webrtc/src/polyfill/install.ts` は WebRTC コンストラクタと `navigator.mediaDevices` を注入し、uninstall 用 descriptor snapshot も既に持つ。新規インストーラーを作る必要はなく、このライフサイクルへ `userAgent` を追加するのが最小変更となる。
- `RTCPeerConnection` は `addTransceiver`、`createOffer` / `createAnswer`、`setLocalDescription` / `setRemoteDescription`、`getConfiguration` / `setConfiguration`、EventTarget 互換 listener、sender/receiver stats、SCTP を既に持つ。
- `RTCRtpSender` は `replaceTrack`、`getParameters`、`setParameters` を持ち、`MediaStreamTrack` は `readyState`、`enabled`、`stop`、`writeRtp` を持つ。Chrome111 Handler が基本送受信で利用する面は揃っている。
- `MediaStream`、`RTCSessionDescription`、`RTCTrackEvent` など、親チケットで補われた互換面も mediasoup の SDP/track フローにそのまま利用できる。
- IDE CLI で `/home/shin/code/werift-mediasoup-interop` に参照プロジェクトを作成済みで、公開 repository と submodule の初期 scaffold も作成済みである。
- scaffold の source resolver から現在の ticket worktree にある `packages/webrtc/src/polyfill/index.ts` を直接 import し、`installPolyfill` / `createCallbackRegister` を build なしで取得できることを確認した。
- `mediasoup@3.26.0` の native worker が Node 24 上で起動・終了できることを確認した。したがって実 E2E の次の調査点は worker 配布ではなく、Router/Transport signaling helper と synthetic RTP の実接続である。

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

1. `InstallPolyfillOptions.userAgent` の実行時検証と、明示値・自動値・既存値の優先順位判定を実装する。
2. User-Agent の descriptor snapshot、install/restore を小さな内部ヘルパとして実装する。
3. `installPolyfill()` の navigator 構築後にヘルパを適用し、例外時の既存ロールバックへ統合する。
4. Node UA、明示上書き、空 target、既存ブラウザ UA、`existingMediaDevices` 3 モード、uninstall、途中失敗の単体テストを追加する。
5. werift 本体ではビルド済み polyfill と pinned `mediasoup-client` を使う外部統合スモークを追加する。
6. 独立 fixture では werift TypeScript source を直接 import し、実 worker/router と send/recv transport の signaling helper を作る。
7. audio、video、data、ICE restart、lifecycle の順に実 E2E matrix を拡張し、不足が出た WebRTC API だけを既存クラスへ追加する。mediasoup 固有分岐をコアへ持ち込まない。
8. README と英日サイト文書を更新し、package test、type、import-test、submodule E2E を実行する。

## 4. 考慮すべき制約や注意点

- polyfill は opt-in のままにする。`werift` の通常 import だけで User-Agent やグローバルを変更してはならない。
- 「無設定」は `mediasoup-client` の Handler 指定が不要という意味であり、親チケットの必須 `mediaRegister`、mediasoup サーバのシグナリング、Transport event callback まで不要にするものではない。
- 固定 User-Agent は werift が完全な Chromium であると一般保証するものではない。値は Chrome111 Handler の feature contract を選択する互換識別子として文書化する。
- `userAgent` オプション省略時は、実ブラウザや非 Node の既存 User-Agent を上書きしない。明示オプションは意図的な上書きとして扱うため、ブラウザ判定を変える影響を README で警告する。
- Node 21+ の `navigator` は accessor 経由で提供され、`userAgent` は prototype getter である。グローバル `navigator` の代入ではなく、既存オブジェクトへの own property 定義と descriptor 復元を使う。
- WPT sandbox は同じ `installPolyfill({ target })` を利用する。User-Agent の追加で WPT の feature detection が変わる可能性があるため、許可リスト WPT も回帰確認する。ただし WPT runner 専用の strict shim を polyfill 本体へ移さない。
- `existingMediaDevices: "throw"` は変更前に判定される現在の atomicity を維持し、エラー時に User-Agent だけが残らないようにする。
- `userAgent` の型・空文字検証も副作用より前に行う。無効値でコンストラクタや `navigator.mediaDevices` だけがインストールされる状態を作らない。
- `mediasoup-client` は本番依存にしない。追加するのはテスト用の固定バージョンのみとし、werift の配布サイズや利用者の依存グラフへ含めない。
- リポジトリの通常 CI は Node 18、調査時点の `mediasoup-client@3.22.0` は Node 22+ を要求する。通常 CI fixture を `3.16.4` に固定する理由をコメントに残し、最新版へ更新するときは Node matrix とセットで見直す。
- mediasoup の fake parameter オブジェクトは freeze されている版がある。Chrome111 Handler は DTLS role を更新するため、テストでは `structuredClone()` した値を Transport へ渡す。
- 実 mediasoup worker/router/transport は独立 fixture の対象とする。対象外なのは外部ホストへの deploy、codec encode/decode、OS カメラ/マイク capture であり、RTP 実データの供給には親チケットの register / `writeRtp` 契約を利用する。
- submodule は公開 repository の commit SHA に固定する。werift 側だけ、または fixture 側だけの変更で CI が再現不能にならないよう、依存する変更は fixture を先に publish してから gitlink を更新する。
- `mediasoup` worker は native binary と UDP/TCP socket を使う。install script の許可を package 名だけで広く与えず exact version へ pin し、CI runner が loopback socket と child process を利用できることを前提条件にする。
- テスト用 Transport は必ず close し、polyfill は `finally` で uninstall する。ICE、DTLS、SCTP、タイマーの open handle を残さない。
- 公開 API や protocol behavior に不足が見つかった場合は、`packages/webrtc/AGENTS.md` に従い package-local type/test を先に実行し、失敗を握りつぶす互換 shim は追加しない。

## 5. 完了条件

- [ ] `installPolyfill({ mediaRegister })` 後、Node 18 の空 navigator と Node 21+ の `Node.js/<major>` User-Agent の双方で Chromium 111 互換 User-Agent が得られる
- [ ] `installPolyfill({ mediaRegister, userAgent })` で、Node UA、既存ブラウザ UA、sandbox の独自 UA を指定文字列へ明示的に上書きできる
- [ ] `userAgent` の省略または `undefined` は自動判定、空でない文字列は明示上書きとして扱われ、空文字・空白のみ・非文字列は副作用前に `TypeError` になる
- [ ] `target` 指定時は `target.navigator.userAgent` にだけ適用され、`globalThis.navigator` を誤って変更しない
- [ ] `userAgent` オプション省略時は既存の非 Node User-Agent が保持される
- [ ] Node 21+ の既存 `navigator` オブジェクトは置換されない
- [ ] `existingMediaDevices: "overwrite" | "throw" | "noop"` の既存契約を壊さず、`noop` 時も Handler 自動検出に必要な User-Agent は補完される
- [ ] 自動補完・明示上書きのどちらでも、インストール途中の失敗と uninstall 後に `navigator`、`mediaDevices`、`userAgent` の descriptor がインストール前と一致する状態へ戻る
- [ ] `werift/polyfill` のグローバル型から `navigator.userAgent` を `string` として参照でき、mediasoup-client 利用例が Node 向け TypeScript 設定で型検査を通る
- [ ] `mediasoup-client` へ `handlerName` / `handlerFactory` を渡さず、`detectDevice() === "Chrome111"` および `Device.factory()` 成功を確認できる
- [ ] `Device.load()` が成功し、audio/video の RTP capabilities と `canProduce()` を取得できる
- [ ] polyfill の `getUserMedia()` が返した werift track を `transport.produce()` に渡して Producer を作成できる
- [ ] `transport.consume()` が返す track が werift `MediaStreamTrack` であり、`readyState`、`writeRtp`、`onReceiveRtp` を利用できる
- [ ] `transport.produceData()` で werift `RTCDataChannel` を使う DataProducer を作成できる
- [ ] テスト終了後に未処理 rejection、タイマー、ICE/DTLS/SCTP の open handle が残らない
- [ ] `mediasoup-client` は固定バージョンの test/dev dependency に限定され、werift の runtime dependencies へ追加されていない
- [ ] User-Agent の自動 install・明示上書き・保持・入力検証・復元・rollback の単体テストと、ビルド済み `werift-dev/polyfill` を使う mediasoup-client import/integration smoke が追加されている
- [ ] 新規テストは Arrange / Act / Assert に分かれ、Act / Assert に適切な日本語コメントがあり、共通 Arrange は単一 helper ファイルへ集約されている
- [ ] README、英語サイト文書、日本語サイト文書に Handler 指定不要の例、引き続き必要な `mediaRegister` / シグナリング、User-Agent の条件付き補完・明示 `userAgent` オプション・uninstall を記載している
- [ ] `cd packages/webrtc && npm run type` が成功する
- [ ] `cd packages/webrtc && npm test` が成功する
- [ ] `cd import-test && npm test` が成功する
- [ ] `npm run wpt --workspace packages/webrtc` が成功し、User-Agent 追加で許可リスト WPT に回帰がない
- [x] IDE に `werift-mediasoup-interop` プロジェクトが作成され、`werift-webrtc` が参照プロジェクトとして登録されている
- [x] `shinyoshiaki/werift-mediasoup-interop` が公開 GitHub repository として作成され、初期 scaffold が `main` に push されている
- [x] werift に `integration/werift-mediasoup-interop` submodule が追加され、公開 repository の commit SHA を参照している
- [x] 独立 fixture が現在の werift TypeScript source から polyfill entrypoint を直接 import でき、`npm run type` と source-import test が成功する
- [x] pinned `mediasoup@3.26.0` worker が Node 24 で起動・終了できる
- [ ] 独立 fixture の各 E2E が開発中の `installPolyfill()` を実行し、`handlerName` / `handlerFactory` なしで実 mediasoup worker/router/transport と接続する
- [ ] Opus、VP8、H264 の produce/consume で synthetic RTP が実 Router を往復し、sequence/timestamp/SSRC/payload marker を検証できる
- [ ] simulcast/layer、pause/resume、replaceTrack、ICE restart、server/client 双方起点 close の E2E が成功する
- [ ] reliable/unreliable、ordered/unordered DataChannel の双方向 E2E と close が成功する
- [ ] audio+video+data の同時多重化および複数 transport/client の独立性を検証する E2E が成功する
- [ ] 全 E2E 後に worker child process、socket、timer、未処理 rejection が残らず、Node process が自然終了する
- [ ] fixture の Node 22 / 24 pinned-version CI と、最新版 compatibility 定期 probe が追加されている
- [ ] werift CI が submodule を recursive checkout し、`integration/werift-mediasoup-interop` の `npm ci`、`npm run type`、`npm test` を実行する
