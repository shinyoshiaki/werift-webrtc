# Playwright ブラウザ client と werift client の mediasoup 相互接続試験

## 1. タスクの目的と背景

親チケット（`66f91b2c-dfb7-4a14-94e0-43f302a605a6`）は、`installPolyfill({ mediaRegister })` だけで Node.js 上の `mediasoup-client` が Chrome111 Handler を自動選択し、実 mediasoup worker と ICE/DTLS/SRTP/SCTP でつながることを独立 fixture `integration/werift-mediasoup-interop` で保証する。

現行 fixture の `test/interop` は **werift polyfill 同士**（同一 Node プロセス内の 1 つまたは 2 つの `Device`）が Router を往復する試験である。`writeRtp` / `onReceiveRtp` と payload marker で決定的に検証できる一方、次が欠けている。

- 実 Chromium の `mediasoup-client`（ネイティブ `RTCPeerConnection`）が同じ Router に載ること
- ブラウザが符号化した Opus/VP8 RTP を werift consume track が受け取ること
- werift が送った RTP / DataChannel をブラウザ consume が受け取ること
- Chrome111 Handler が仮定するブラウザ面と、本物の Chrome が mediasoup 経由で見せる SDP / RTP / SCTP の差分

本タスクはサブモジュール fixture に **Playwright Chromium client ↔ 実 mediasoup worker/router ↔ werift polyfill client** の相互接続試験を追加する。失敗したらチケット本ファイルの調査ログを更新し、原因を mediasoup 専用ラッパではなく werift のブラウザ互換 API として根本修正する。

「問題があれば直す」対象は次に限る。

- werift の `RTCPeerConnection` / sender / receiver / DataChannel / ICE / DTLS / SRTP / SCTP の不足や非互換
- polyfill のグローバル面がブラウザ試験を壊す場合（ブラウザページへ polyfill を入れない契約は維持する）
- fixture のシグナリング helper・CI・Playwright 起動

対象外は、親チケットどおり OS カメラ/マイク、実 codec の画質評価、Firefox、Native Windows、外部ホストへの deploy である。

## 2. 実装すべき具体的な機能や変更内容

変更の主座は Git submodule `integration/werift-mediasoup-interop`（公開 repository [`shinyoshiaki/werift-mediasoup-interop`](https://github.com/shinyoshiaki/werift-mediasoup-interop)）である。werift 本体の修正が必要になった場合だけ `packages/webrtc` および下位プロトコル package を直す。mediasoup 固有分岐をコアへ持ち込まない。

### 2.1 現状との差分（何を足すか）

| 層 | 現行 `test/interop` | 本タスク |
| --- | --- | --- |
| client A | werift `installPolyfill` + 引数なし `Device.factory()` | 同じ（Node） |
| client B | 同じプロセスの別 `Device`、または同一 Device の send/recv Transport | Playwright Chromium 上の `mediasoup-client`（ネイティブ WebRTC） |
| メディア供給 | polyfill `getUserMedia` + `writeRtp` の synthetic / dummy RTP | ブラウザは `--use-fake-device-for-media-stream`。werift 送信は既存 dummy / `writeRtp` |
| 到達検証 | payload marker + `onReceiveRtp` の seq/ts/ssrc | 方向ごとに検証点を分ける（2.4） |
| ランナー | `tsx --test` / `test/interop` | 同じランナーに `test/browser` を追加。Chromium は `test:small` / `test:interop` に混ぜない |

ブラウザページでは `installPolyfill` を呼ばない。実 Chrome の User-Agent と Handler 自動検出を使う。werift 側だけ親チケットの契約どおり `handlerName` / `handlerFactory` を渡さない。

### 2.2 Playwright 起動とブラウザページ

`e2e/vitest.config.mts` および `e2e/ensure-browser.js` と同じ方針で Chromium を用意する。fixture に vitest browser mode は導入しない。既存の `node:test` + `tsx` から `playwright` の `chromium.launch()` を呼ぶ。

- devDependency の `playwright` は exact version に固定する。リポジトリ既存の `e2e` に合わせ `1.55.1` を第一候補とする（`^` は付けない）。
- ブラウザ取得は `npx playwright install chromium chromium-headless-shell`（`ensure-browser.js` 相当を fixture に置く）。`allowScripts` を package 名だけで広げない。
- 実行ファイルは `CHROME_BIN` / `GOOGLE_CHROME_BIN` / `/usr/bin/google-chrome` / `/usr/bin/chromium` があればそれを使い、無ければ Playwright 同梱 Chromium を使う。
- launch args は既存 e2e に合わせる。

  ```text
  --use-fake-ui-for-media-stream
  --use-fake-device-for-media-stream
  --ignore-certificate-errors
  --allow-insecure-localhost
  --disable-features=WebRtcHideLocalIpsWithMdns
  --force-webrtc-ip-handling-policy=default_public_interface_only
  ```

- headless で起動する。ページは `http://127.0.0.1:<ephemeral>/` の静的 HTML を開き、外部ネットは使わない。
- コンテナ（sysbox / GitHub Actions）で起動に失敗した場合のみ `--no-sandbox` と `--disable-dev-shm-usage` を追加する。最初から付けて e2e と条件を不用意にずらさない。失敗理由は 3.4 の調査ログへ書く。

ブラウザ側 `mediasoup-client` は pinned `3.22.0` を esbuild 等で 1 ファイルへ束ね、静的サーバから読む。werift の build output や npm 公開物は使わない。Node 側 werift は現行どおり `packages/webrtc/src/polyfill/index.ts` を `tsx` で直接 import する。

ページに載せる操作は `window` 上の小さな RPC（または `page.exposeFunction` で Node が受けて `page.evaluate` で返す）に限る。UI は検証用の `<video>` / `<canvas>` だけでよい。SPA フレームワークは追加しない。

### 2.3 シグナリングとセッション Arrange

mediasoup worker / router / server `WebRtcTransport` の所有権は **Node テストプロセス** に残す。ブラウザは client `Device` / `Transport` / Producer / Consumer だけを持つ。

共有 Arrange は `test/helpers` を複製せず、ブラウザ用を `test/browser/helpers` に集約する（lock / worker / server transport / cleanup は既存 `test/helpers` を再利用）。

最小セッション契約:

1. `acquireSharedRuntimeLock` のあと werift 側で `installPolyfill` → 引数なし `Device.factory()` → `device.load({ routerRtpCapabilities })`。
2. Playwright でページを開き、ブラウザでも引数なし `Device.factory()` → 同じ `routerRtpCapabilities` で `load()`。
3. 方向ごとに server `WebRtcTransport` を `listenInfos: 127.0.0.1` の UDP/TCP（既存 `arrangeServerWebRtcTransport`）で作り、client へ `structuredClone` した ICE/DTLS/SCTP パラメータを渡す。
4. ブラウザの `connect` / `produce` / `producedata` は Node の server transport へ中継する。既存 `wireConnect` / `wireProduce` / `wireProduceData` と同等の責務を、プロセス境界を越える形で実装する。
5. `finally` で browser context / browser、client/server transport、worker、polyfill uninstall、lock release を必ず行う。

werift 側 Transport の `additionalSettings`（`iceAdditionalHostAddresses: ["127.0.0.1"]`、IPv6 無効）は現行 helper を維持する。ブラウザ側は STUN を足さず loopback の host candidate でつなぐ。

### 2.4 必須テスト行列

`test/browser` に置き、Act / Assert に日本語コメントを付ける。Arrange の繰り返しは helper へ集約する。

| ID | 方向 | 検証 |
| --- | --- | --- |
| B1 | 起動 | ブラウザ `detectDevice()` が Chromium 系 Handler（少なくとも Chrome74 以上 / Chrome111）を返し、引数なし `Device.factory()` / `load()` が成功する。werift 側は `detectDevice() === "Chrome111"` |
| B2 | browser → werift audio | ブラウザ `getUserMedia({ audio: true })` で produce。werift consume track は `readyState === "live"` で、`onReceiveRtp` に 2 パケット以上届き seq/ts が変化し SSRC が安定する。payload marker は要求しない（Chrome 実エンコードのため） |
| B3 | werift → browser audio | werift は dummy Opus または既存 `writeRtp` で produce。ブラウザ Consumer track が live。一次検証は `RTCRtpReceiver.getStats()` の inbound-rtp `packetsReceived` 増加。デコード再生（Web Audio エネルギー）は取れれば追加 Assert、失敗してもデコード非対応として調査ログに残し packetsReceived を必須にする |
| B4 | browser → werift video VP8 | ブラウザ fake camera で produce。werift `onReceiveRtp` で seq/ts/ssrc を検証。H264 のブラウザ produce は対象外（fake device は通常 VP8） |
| B5 | werift → browser video VP8 | werift dummy VP8 または `writeRtp`。ブラウザは live track + `packetsReceived`。`waitVideoPlay`（e2e `fixture.ts` の canvas 差分）は dummy フレームがデコード不能な可能性が高いので必須にしない。通ったら追加 Assert |
| B6 | DataChannel 双方向 | reliable ordered で browser `produceData` → werift `consumeData`、および逆方向。文字列 payload が双方に届き、close が伝播する |
| B7 | 同時接続 | audio + data を同時に張り、片方の pause/close が他を壊さない |
| B8 | lifecycle | client-first / server-first close、browser context close、uninstall 後に worker 子プロセス・socket・timer・未処理 rejection を残さない |

既存 `test/interop` の simulcast / ICE restart / H264 marker 往復は **werift↔werift** のまま残す。本タスクでブラウザへ複製しない（ブラウザ H264 encode と dummy キーフレームのデコードは親チケットの対象外理由と同じ）。

### 2.5 失敗時の調査と修正ループ

試験が失敗したらテストを skip や timeout 延長で黙らせない。次の順で本ファイル **3.4 実装中の調査ログ** を更新してから直す。

1. 失敗ケース ID、例外文、client/server の ICE/DTLS/SCTP/`connectionState`（既存 `describeClientTransport` / `describeServerTransport` を流用）。
2. 切り分け: シグナリングパラメータ、ICE 候補、DTLS role、SRTP、RTP PT / header extension / RTX/NACK、SCTP stream、Chrome Handler の SDP 仮定、Playwright 起動。
3. 原因が werift API なら対応クラスを根本修正する。fixture に mediasoup 専用 shim を置いて通したことにしない。
4. 原因が dummy RTP の非デコードなら、必須 Assert を packetsReceived / `onReceiveRtp` に固定し、デコード再生は任意へ落とす（仕様変更として本ファイル 2.4 を更新する）。
5. fixture 側のテスト追加が先なら submodule repository に commit / PR し、通った SHA を werift の gitlink に更新する。werift 本体修正がある場合は本体 PR と fixture SHA の対応をチケットに残す。

### 2.6 スクリプト、CI、ドキュメント

`integration/werift-mediasoup-interop/package.json` の glob を明示分割する。現状 `npm test` は `test/**/*.test.ts` のため、`test/browser` を足すと Chromium 無しで壊れる。

| Script | 対象 |
| --- | --- |
| `test:small` | `test/small/**`（worker なし、変更しない） |
| `test:interop` | `test/interop/**`（worker あり、Chromium なし） |
| `test:browser` | `test/browser/**`（Playwright + worker） |
| `test` | `test:small` + `test:interop`（現行の必須範囲を維持） |
| `install:browsers` | `ensure-browser.js` |
| `type` | Node 用 tsconfig。ブラウザページは `tsconfig.browser.json` を足して `type` から両方見る |

CI:

- fixture `.github/workflows/ci.yml` と werift `.github/workflows/nodejs.yml` の `mediasoup-interop` ジョブに、`npm test` のあとに `npm run install:browsers` と `npm run test:browser` を足す。Node matrix は 22 / 24 のまま。
- 互換 probe（`compatibility.yml`）はブラウザを必須にしない。失敗しても本体必須 CI を壊さない契約を維持する。
- 通常 werift `build` ジョブ（Node 18）には Playwright mediasoup 試験を足さない。fixture は `engines.node >= 22`。

ドキュメント:

- fixture `README.md` と `AGENTS.md` に `test:browser`、Chromium 前提、fake media、検証点の違い（marker なし）を書く。
- 親リポジトリ root `AGENTS.md` の Validation は「`integration/werift-mediasoup-interop` に従う」ままでよい。fixture 側 Commands 表を更新する。

### 2.7 依存関係

- `playwright` は fixture の exact devDependency。werift 本体の runtime / 公開 API には追加しない。
- `mediasoup` / `mediasoup-client` の pin（`3.26.0` / `3.22.0`）は変えない。
- ブラウザバンドル用に esbuild 等が必要なら exact version にし、install script は確認した version だけ `allowScripts` する。
- `handlerName` / `handlerFactory` をテストから渡さない。

## 3. 技術的な実装アプローチの調査結果

### 3.1 現行 fixture

- `test/helpers/session.ts` の `InteropSession` は worker/router、polyfill、1 つの werift `Device`、send/recv Transport の配線を持つ。`createPeerDevice()` も同じ polyfill グローバル上の第二 `Device` であり、ブラウザではない。
- `test/helpers/transport.ts` は `127.0.0.1` の UDP/TCP listen と `structuredClone` したパラメータ渡し済み。ブラウザ client にも同じパラメータ形を使える。
- `test/helpers/lock.ts` はプロセス内の `navigator` と worker を直列化する。Playwright ページは別プロセスなのでブラウザ WebRTC とは競合しないが、Node 側 polyfill は引き続きロックが必要。
- `npm test` は `--test-concurrency=1 --test-isolation=process`。ブラウザ試験も同じにする。
- 親 CI の `mediasoup-interop` ジョブは submodule checkout 後に `npm ci` / `type` / `test:small` / `test` を Node 22/24 で実行する。Playwright インストールはまだ無い。

### 3.2 親リポジトリの Playwright 先例

- `e2e/` は `@vitest/browser` + Playwright Chromium。fake media と mDNS 無効化の args が本タスクの launch 基準。
- ブラウザ側メディア到達は `e2e/tests/fixture.ts` の `waitVideoPlay`（canvas 画素ハッシュの変化）。これは **Chrome がデコードできる映像** が前提。werift dummy VP8（`dummyMedia.ts` の 11 バイトキーフレーム）はデコーダが絵を出さない可能性が高い。
- `e2e/server` の media 試験は mediasoup を使わず、werift `RTCPeerConnection` 同士（またはループバック replaceTrack）である。mediasoup SFU 経路の Chrome↔werift は本 fixture が初出。
- `ensure-browser.js` は system Chrome または Playwright Chromium + headless shell の有無を見て install する。fixture へコピーしてパスだけ合わせる。

### 3.3 メディア検証が marker 試験と異なる理由

- ブラウザ produce の payload は Chrome の実 Opus/VP8 であり、`WERIFT-OPUS` のような marker は入らない。werift 受信側は `onReceiveRtp` のヘッダ変化で足りる。
- werift produce の dummy / synthetic RTP は Router を通っても Chrome がデコードする保証がない。必須条件は RTP がブラウザ inbound に届くこと（getStats）。再生はボーナス。
- DataChannel は codec を経由しないため、本行列の「相互接続できている」ことの最も決定的な証拠になる。B6 を欠かさない。
- 親チケット 2.6 が OS カメラと codec 試験を除外したのは、werift↔werift の決定的 RTP のためである。本タスクは fake device によるブラウザ符号化器を **RTP 到達の相手** として使うだけであり、画質やマイク権限は見ない。

### 3.4 実装中の調査ログ

（実装開始時は空。失敗したらケース ID・例外・切り分け・修正箇所を追記する。）

## 4. 考慮すべき制約や注意点

- ブラウザページに `werift/polyfill` を入れない。入れるとネイティブ `RTCPeerConnection` を上書きし、本タスクの意味が消える。
- Node 側は親チケットの「追加設定なし」を維持する。`handlerName` / `handlerFactory` 禁止。`mediaRegister` とシグナリングは必要。
- `test:small` から worker も Chromium も起動しない。
- `npm test` に `test/browser` を含めない。Chromium が無い開発者・現行 interop CI ステップを壊さない。必須化は `test:browser` を CI に明示追加することで行う。
- fake media フラグ無しの実カメラは使わない。CI と headless で権限ダイアログが出る。
- listen / ICE は loopback のみ。STUN/TURN は足さない。
- Native Windows は対象外。Linux（sysbox / GitHub `ubuntu-latest`）を第一対象、macOS は既存 fixture 方針どおり吸収できればよいが必須 matrix には入れない。
- 公開 API 不足は `packages/webrtc/AGENTS.md` に従い package-local の type/test を先に回す。失敗を握りつぶす互換 shim は追加しない。
- submodule は公開 repository の commit SHA に固定する。fixture を先に push してから werift gitlink を更新する。
- Playwright のブラウザダウンロードはネットワークとディスクを使う。CI に `install:browsers` を明示し、開発者向け README にも書く。
- `existingMediaDevices` や User-Agent 補完の契約は本タスクで変えない。ブラウザ試験が Node の `navigator.userAgent` を読みに来ないよう、ページは別 origin の別プロセスに隔離する。
- テスト終了後に Chromium プロセスが残ると CI が hang する。`ResourceBag` に `browser.close()` を必ず登録する。

## 5. 完了条件

- [ ] `test/browser` に Playwright Chromium client と werift polyfill client が同一 mediasoup Router を共有する Arrange がある
- [ ] ブラウザ側は `handlerName` / `handlerFactory` なしで `Device.factory()` が成功する
- [ ] werift 側は `installPolyfill({ mediaRegister })` と引数なし `Device.factory()` で `detectDevice() === "Chrome111"` になる
- [ ] B2: ブラウザ audio produce → werift consume で `onReceiveRtp` の seq/ts/ssrc 検証が通る
- [ ] B4: ブラウザ VP8 produce → werift consume で同様の RTP ヘッダ検証が通る
- [ ] B3/B5: werift produce → ブラウザ consume で inbound `packetsReceived` が増える
- [ ] B6: DataChannel の双方向メッセージと close が通る
- [ ] B7/B8: 同時接続の独立性と close / uninstall 後の open handle が残らない
- [ ] 失敗したケースは本ファイル 3.4 に記録し、原因を werift 既存クラスまたは fixture helper として修正している（skip や無関係な timeout 延長だけではない）
- [ ] 新規テストは Arrange / Act / Assert に分かれ、Act / Assert に日本語コメントがあり、ブラウザ用 Arrange は `test/browser/helpers` に集約されている
- [ ] `package.json` の `test` は Chromium 無しの small+interop のまま、`test:browser` と `install:browsers` が追加されている
- [ ] fixture CI と werift `mediasoup-interop` ジョブが Node 22/24 で `install:browsers` と `test:browser` を実行する
- [ ] fixture `README.md` と `AGENTS.md` が `test:browser` と検証方針を説明している
- [ ] `playwright` は fixture の exact devDependency に限定され、werift runtime 依存に入っていない
- [ ] `cd integration/werift-mediasoup-interop && npm run type` が成功する
- [ ] `cd integration/werift-mediasoup-interop && npm run test:small` が成功する
- [ ] `cd integration/werift-mediasoup-interop && npm run test:interop` が成功する
- [ ] `cd integration/werift-mediasoup-interop && npm run install:browsers && npm run test:browser` が成功する
- [ ] ブラウザ試験追加に伴う submodule SHA と、必要なら werift 本体修正の対応関係がチケットに残っている
