## 1. タスクの目的と背景

`packages/webrtc` の W3C / WPT 互換性検証を、現在の「本家WPTを手でVitestへ移植したテスト」から、「本家 `web-platform-tests/wpt` をサブモジュールとして固定し、その実ファイルをNode.js上で実行する方式」へ移行する。

現状は [packages/webrtc/tests/wpt/addTrack.test.ts](/workspace/packages/webrtc/tests/wpt/addTrack.test.ts:1) のように、本家WPTへのURLコメントを残しつつローカル実装へ移植している。`packages/webrtc/tests/wpt` は合計 5 ファイル、約 1,190 行、43 active tests + 1 skipped test で、本家との差分追従が手作業になっている。

WPT本家の `webrtc/` には `RTCPeerConnection-addTrack.https.html`、`RTCPeerConnection-onnegotiationneeded.html`、`RTCPeerConnection-ontrack.https.html`、`RTCPeerConnection-removeTrack.https.html` など現在の移植元に相当するテストが存在する。またWPT標準の `resources/testharness.js` は低レベルWeb APIテスト用の非同期対応ハーネスとして提供されている。

一部の本家WPTは `navigator.mediaDevices.getUserMedia()` で取得したローカルaudio/video trackを `RTCPeerConnection` に追加し、実際にRTPが流れることを前提にしている。Node.js上ではブラウザのカメラ・マイクを使えないため、`packages/webrtc/src/nonstandard` の互換APIを拡張し、外部プロセスや実デバイスなしで固定dummy RTPを送出できるようにする。

## 2. 実装すべき具体的な変更内容

### サブモジュール化

- 既存の [packages/webrtc/tests/wpt](/workspace/packages/webrtc/tests/wpt/addTrack.test.ts:1) 配下の手移植WPTテストを削除する。
- `web-platform-tests/wpt` をSSH形式でサブモジュール追加する。
  - 推奨パス: `third_party/wpt`
  - URL: `git@github.com:web-platform-tests/wpt.git`
  - `.gitmodules` に記録し、特定コミットへ固定する。
- README / AGENTS.md / CI手順に `git submodule update --init --recursive` を追記する。

### Node.js WPT実行基盤

- `packages/webrtc` にWPT実行用の基盤を追加する。
  - 例: `packages/webrtc/tools/wpt-runner/`
  - 例: `packages/webrtc/wpt/allowlist.json`
  - 例: `packages/webrtc/wpt/baseline.json`
- runner は本家WPT HTMLを読み取り、以下を順に実行する。
  - `/resources/testharness.js`
  - 必要な helper JS: `webrtc/RTCPeerConnection-helper.js` など
  - inline `<script>` のテスト本体
- `globalThis` に `packages/webrtc/src` の公開APIを注入する。
  - `RTCPeerConnection`
  - `RTCDataChannel`
  - `MediaStream`
  - `MediaStreamTrack`
  - `RTCSessionDescription`
  - `RTCIceCandidate`
  - 必要に応じて `RTCRtpSender`, `RTCRtpReceiver`, `RTCRtpTransceiver`
- WPT helper 側で使われる接続補助、DataChannelペア生成、イベント待機は本家 helper に既に含まれているため、可能な限り本家をそのまま使う。

### getUserMedia互換dummy media source

- [packages/webrtc/src/nonstandard/navigator.ts](/workspace/packages/webrtc/src/nonstandard/navigator.ts:1) / [packages/webrtc/src/nonstandard/userMedia.ts](/workspace/packages/webrtc/src/nonstandard/userMedia.ts:1) を拡張し、WPT runnerから `navigator.mediaDevices.getUserMedia()` と `navigator.mediaDevices.getDisplayMedia()` を利用できるようにする。
- 現在の `MediaDevices.getUserMedia()` は、constructorに渡された既存trackのRTPを複製する用途が中心で、単体ではメディアを生成しない。WPT用には `constraints.audio` / `constraints.video` に応じて `MediaStreamTrack` を作成し、dummy RTP送出を自動開始するモードを追加する。
- dummy audio:
  - codecはOpus想定。
  - RTP clock rateは48,000Hz。
  - 20ms周期で1 packetを送る。
  - RTP timestampはpacketごとに960進める。
  - payloadは固定のdummy Opus RTP payloadを使う。実デコード品質ではなく、WebRTC送受信経路・stats・track eventが進むことを目的にする。
- dummy video:
  - codecはVP8想定。
  - RTP clock rateは90,000Hz。
  - 既定30fpsの場合、約33.33ms周期で1 frame / 1 RTP packetを送る。
  - RTP timestampはframeごとに3,000進める。
  - keyframe周期は1秒。30fpsなら30 frameごとにkeyframeを送る。
  - keyframeとdelta frameを区別できる固定VP8 payloadを用意する。WPTで必要な範囲では、実映像品質よりもRTP/VP8 packetとしての最低限の妥当性、timestamp、sequence number、marker bit、keyframe周期を優先する。
- sequence number / timestamp / SSRC はtrack生成時に初期化し、`MediaStreamTrack.writeRtp()` に `RtpPacket` として渡す。送信時のpayload typeは既存の `RTCRtpSender.prepareSend()` によりnegotiated codecへ上書きされる前提にする。
- `track.stop()`、`MediaStreamTrack` の終了、またはrunnerのtest teardownでtimerを確実に停止し、WPT実行後にopen handleを残さない。
- 既存のファイル再生用 `getUserMedia({ path })` / UDP入力用途は壊さず、WPT向けdummy sourceは明示オプションまたは `Navigator` / `MediaDevices` の構成で有効化する。

### 実行対象の選択機構

- allowlist で「実行するWPTファイル」と、必要なら「実行するsubtest名」を明示する。
- 最初はNode.js上で実行可能性が高く、既存ローカルWPT移植と重なるものから始める。

初期対象候補:

| 優先 | WPTファイル | 理由 |
| --- | --- | --- |
| P0 | `webrtc/RTCPeerConnection-removeTrack.https.html` | 既存移植あり。DOM依存が少ない |
| P0 | `webrtc/RTCPeerConnection-ontrack.https.html` | 既存移植あり。SDP / track event互換性を検証できる |
| P0 | `webrtc/RTCPeerConnection-onnegotiationneeded.html` | 既存移植あり。イベント順序の互換性確認に重要 |
| P0 | `webrtc/RTCPeerConnection-canTrickleIceCandidates.html` | 現README互換メモの対象。Nodeで実行しやすい |
| P0 | `webrtc/RTCPeerConnection-addIceCandidate.html` | 現README互換メモの対象。重要API |
| P0 | `webrtc/RTCPeerConnection-setLocalDescription-parameterless.https.html` | W3C互換の中心 |
| P0 | `webrtc/RTCPeerConnection-setLocalDescription-rollback.html` | rollback互換性 |
| P0 | `webrtc/RTCPeerConnection-setRemoteDescription-rollback.html` | rollback互換性 |
| P0 | `webrtc/RTCPeerConnection-addTrack.https.html` | 既存移植あり。dummy `getUserMedia` 対応により本家WPTでの実行対象に含める |
| P1 | `webrtc/RTCPeerConnection-track-stats.https.html` などgetUserMedia利用テスト | dummy audio/video RTP sourceでstats・送受信経路を段階的に検証できる |
| P1 | `webrtc/RTCPeerConnection-createDataChannel.html` | DataChannel API互換性 |
| P1 | `webrtc/RTCConfiguration-*.html` | `getConfiguration` / `setConfiguration` 互換性 |
| P2 | `webrtc/RTCDataChannel-send.html`, `RTCDataChannel-close.html` | 実接続・SCTP挙動まで広がるため段階導入 |
| P2 | `webrtc/RTCPeerConnection-getStats*.https.html` | stats仕様差分が大きく、baseline管理が必要 |

### npm scripts

[packages/webrtc/package.json](/workspace/packages/webrtc/package.json:35) に追加する想定:

```json
{
  "scripts": {
    "wpt:list": "tsx tools/wpt-runner/list.ts",
    "wpt": "tsx tools/wpt-runner/run.ts",
    "wpt:coverage": "vitest run --coverage --config vitest.wpt.config.mts"
  }
}
```

必要ならroot [package.json](/workspace/package.json:22) にも workspace 経由のショートカットを追加する。

### カバレッジ計測と改善基盤

現状、[packages/webrtc/vitest.config.mts](/workspace/packages/webrtc/vitest.config.mts:3) には coverage 設定がなく、`@vitest/coverage-v8` も未導入。したがってこのタスクで以下を追加する。

- `@vitest/coverage-v8` をdevDependencyへ追加。
- `packages/webrtc/vitest.wpt.config.mts` を追加。
- coverage対象を `packages/webrtc/src/**/*.ts` に限定。
- 出力:
  - `coverage/webrtc-wpt/coverage-summary.json`
  - `coverage/webrtc-wpt/lcov.info`
  - `coverage/webrtc-wpt/html`
- 初回実行結果を `packages/webrtc/wpt/coverage-baseline.json` として保存。
- CIでは「baselineより下がったら失敗」にする ratchet 方式を採用する。初回から高い閾値でfailさせるより、継続改善に向いている。

## 3. 技術的な実装アプローチ調査まとめ

- 既存テスト基盤はVitest。`packages/webrtc` は `vitest run ./tests` のみを持ち、WPT専用runnerやcoverage scriptはない。
- `packages/webrtc` の公開APIは [packages/webrtc/src/index.ts](/workspace/packages/webrtc/src/index.ts:1) から広くexportされており、Node VMのsandboxへ注入しやすい。
- ただし [packages/webrtc/src/helper.ts](/workspace/packages/webrtc/src/helper.ts:36) の `EventTarget` は `node:events` ベースの簡易実装で、ブラウザの `EventTarget` / `Event` と完全互換ではない。WPT実行により、ここは実装修正が必要になる可能性が高い。
- [packages/webrtc/src/nonstandard/navigator.ts](/workspace/packages/webrtc/src/nonstandard/navigator.ts:27) の `getUserMedia()` は現在、渡された既存trackのRTPを複製するだけなので、WPT runnerで単独利用するにはdummy RTP generatorが必要。
- [packages/webrtc/src/media/track.ts](/workspace/packages/webrtc/src/media/track.ts:51) の `MediaStreamTrack.writeRtp()` は `RtpPacket` / `Buffer` を受け取り `onReceiveRtp` を発火するため、dummy sourceはここへ周期的に `RtpPacket` を投入すれば既存の `RTCRtpSender` 経路に接続できる。
- [packages/webrtc/src/media/rtpSender.ts](/workspace/packages/webrtc/src/media/rtpSender.ts:335) は送信時にSSRC / payload typeをnegotiated codecへ差し替えるため、dummy RTP側はclock、timestamp、sequence number、marker、payloadの妥当性に集中できる。
- WPTはHTML + scriptタグ構成なので、runnerはHTMLを解析し、script src / inline scriptを順序通り評価する必要がある。
- `testharnessreport.js`, `testdriver.js`, `testdriver-vendor.js` はNode runnerでは基本的にstubまたは無視し、結果収集は `testharness.js` の callback から行う方針が妥当。
- `navigator.mediaDevices` はdummy source付きで初期対応する。`document`, `window` の最小shimはrunnerで提供し、`AudioContext`, `HTMLCanvasElement`, `Blob`, `FileReader`, `Worker` に強く依存するWPTは初期対象から外すか、明示stubを用意して別フェーズにする。

## 4. 制約・注意点

- SSHサブモジュールはCI環境でGitHub SSHアクセスが必要。CIがHTTPS checkout前提の場合、deploy key / known_hosts / checkout設定の調整が必要。
- WPTは巨大なリポジトリなので、CIでのsubmodule取得時間に注意する。固定コミット、キャッシュ、必要なら shallow submodule を検討する。
- WPT本家テストを改変してはいけない。差分は runner、shim、allowlist、baseline 側で管理する。
- WPTが失敗した場合、原則としてテストを緩めず `packages/webrtc` の実装を修正する。ただしNode非対応Web APIが原因のものは allowlist から除外し、理由を記録する。
- dummy media sourceはWPT実行のための非標準互換APIであり、実デバイス・実エンコーダ・画質/音質の再現を目的にしない。WebRTCの送受信フロー、イベント、stats、タイミング検証に必要な最低限のRTPを安定して供給することを目的にする。
- RTP送出timerはテストの再現性を優先し、clock driftが大きくならないように次回送出時刻または累積timestampを基準に制御する。テスト終了時のtimer破棄を必須にする。
- VP8 keyframe / delta frame payloadは、既存のdepacketizerや受信側処理でkeyframe判定できる最低限の形式を保つ。後続で実デコードが必要になった場合は、固定の小さな有効VP8 frame fixtureへ差し替えられる構成にする。
- 現READMEには `close()` がW3Cでは同期 `undefined` だが現状はasyncのまま、という互換差分が記載されている。該当WPTは失敗が予想されるため、expected-failとして管理するか、別タスクでAPI互換修正する。
- テスト変更時はAGENTSのルール通り、Arrange / Act / Assert と日本語コメントの方針を守る。ただし本家WPTファイル自体は編集しない。

## 5. 完了条件

- `.gitmodules` に `third_party/wpt` が追加され、URLが `git@github.com:web-platform-tests/wpt.git` になっている。
- 既存の手移植WPTテスト `packages/webrtc/tests/wpt/*.test.ts` が削除されている。
- `npm run wpt:list --workspace packages/webrtc` で実行対象WPT一覧とskip理由が表示できる。
- `npm run wpt --workspace packages/webrtc` で allowlist の本家WPTだけがNode.js上で実行される。
- `packages/webrtc/src` のAPI注入で、初期P0対象が実行され、pass/fail/skip結果が機械可読JSONで出力される。
- WPT runner上の `navigator.mediaDevices.getUserMedia({ audio: true })` / `{ video: true }` / `{ audio: true, video: true }` が `MediaStream` を返し、各trackからdummy Opus / VP8 RTPが正しいclock incrementと周期で送出される。
- dummy video RTPは1秒周期のkeyframeとdelta frameを送出し、sequence number、timestamp、marker bitが連続する。
- `getUserMedia` を使う初期対象WPTが、実デバイス・GStreamer・外部メディアファイルなしで実行できる。
- WPT実行後にdummy RTP送出timer、UDP socket、外部processなどのopen handleが残らない。
- `npm run wpt:coverage --workspace packages/webrtc` でWPT実行時のcoverageが生成される。
- 初回coverage baselineが保存され、以後coverage低下を検出できる。
- README / AGENTS.md / package scripts が新しい実行方式に更新されている。
- `npm run type --workspace packages/webrtc` と、追加したWPT runnerの対象テストがCIで通る。
