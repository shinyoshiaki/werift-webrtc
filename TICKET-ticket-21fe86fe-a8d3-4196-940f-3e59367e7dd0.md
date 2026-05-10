## 1. タスクの目的と背景

`packages/webrtc` の W3C / WPT 互換性検証を、現在の「本家WPTを手でVitestへ移植したテスト」から、「本家 `web-platform-tests/wpt` をサブモジュールとして固定し、その実ファイルをNode.js上で実行する方式」へ移行する。

現状は [packages/webrtc/tests/wpt/addTrack.test.ts](/workspace/packages/webrtc/tests/wpt/addTrack.test.ts:1) のように、本家WPTへのURLコメントを残しつつローカル実装へ移植している。`packages/webrtc/tests/wpt` は合計 5 ファイル、約 1,190 行、43 active tests + 1 skipped test で、本家との差分追従が手作業になっている。

WPT本家の `webrtc/` には `RTCPeerConnection-addTrack.https.html`、`RTCPeerConnection-onnegotiationneeded.html`、`RTCPeerConnection-ontrack.https.html`、`RTCPeerConnection-removeTrack.https.html` など現在の移植元に相当するテストが存在する。またWPT標準の `resources/testharness.js` は低レベルWeb APIテスト用の非同期対応ハーネスとして提供されている。

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
| P1 | `webrtc/RTCPeerConnection-addTrack.https.html` | 既存移植あり。ただし一部 `getUserMedia` / permission helper 対応が必要 |
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
- WPTはHTML + scriptタグ構成なので、runnerはHTMLを解析し、script src / inline scriptを順序通り評価する必要がある。
- `testharnessreport.js`, `testdriver.js`, `testdriver-vendor.js` はNode runnerでは基本的にstubまたは無視し、結果収集は `testharness.js` の callback から行う方針が妥当。
- `document`, `window`, `navigator.mediaDevices`, `AudioContext`, `HTMLCanvasElement`, `Blob`, `FileReader`, `Worker` に依存するWPTは初期対象から外すか、明示stubを用意して別フェーズにする。

## 4. 制約・注意点

- SSHサブモジュールはCI環境でGitHub SSHアクセスが必要。CIがHTTPS checkout前提の場合、deploy key / known_hosts / checkout設定の調整が必要。
- WPTは巨大なリポジトリなので、CIでのsubmodule取得時間に注意する。固定コミット、キャッシュ、必要なら shallow submodule を検討する。
- WPT本家テストを改変してはいけない。差分は runner、shim、allowlist、baseline 側で管理する。
- WPTが失敗した場合、原則としてテストを緩めず `packages/webrtc` の実装を修正する。ただしNode非対応Web APIが原因のものは allowlist から除外し、理由を記録する。
- 現READMEには `close()` がW3Cでは同期 `undefined` だが現状はasyncのまま、という互換差分が記載されている。該当WPTは失敗が予想されるため、expected-failとして管理するか、別タスクでAPI互換修正する。
- テスト変更時はAGENTSのルール通り、Arrange / Act / Assert と日本語コメントの方針を守る。ただし本家WPTファイル自体は編集しない。

## 5. 完了条件

- `.gitmodules` に `third_party/wpt` が追加され、URLが `git@github.com:web-platform-tests/wpt.git` になっている。
- 既存の手移植WPTテスト `packages/webrtc/tests/wpt/*.test.ts` が削除されている。
- `npm run wpt:list --workspace packages/webrtc` で実行対象WPT一覧とskip理由が表示できる。
- `npm run wpt --workspace packages/webrtc` で allowlist の本家WPTだけがNode.js上で実行される。
- `packages/webrtc/src` のAPI注入で、初期P0対象が実行され、pass/fail/skip結果が機械可読JSONで出力される。
- `npm run wpt:coverage --workspace packages/webrtc` でWPT実行時のcoverageが生成される。
- 初回coverage baselineが保存され、以後coverage低下を検出できる。
- README / AGENTS.md / package scripts が新しい実行方式に更新されている。
- `npm run type --workspace packages/webrtc` と、追加したWPT runnerの対象テストがCIで通る。