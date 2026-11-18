---
ide:
  viewer: review-document
  version: 1
  title: "Firefox E2E を通るようにする: レビュー解説"
  dock: right
  baseCommit: 882c7c37bd915f37e26405f82faa7a82d2bbf005
---
# Firefox E2E を通るようにする: レビュー解説

## 1. 概要

`npm run firefox:record` で Firefox E2E が全件通るようになりました。全件失敗の主因は werift ではなく、vitest のテストページが `localhost`（Vite は `::1` で待ち受け）で配信されることで Firefox が ICE 候補を 1 つも集められないことでした。設定でページを IPv4（`127.0.0.1`）配信にして解消し、残る個別の失敗はテストの前提と、werift 本体の不具合として切り分けています。

- `packages/webrtc/src` は変更していません。差分は `e2e/`、`README.md`、チケットファイルと実行記録だけです。
- 修正後のクリーンなコミット `966ad2386` で全件の記録を 2 回取り、どちらも passed（62 passed / 0 failed / 9 skipped）です。

## 2. 修正前の問題と修正後の仕組み

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;line-height:1.5">
<div style="border:1px solid #d33;border-radius:8px;padding:10px">
<b style="color:#d33">Before: localhost 配信</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li>Vite が <code>localhost</code> = <code>::1</code> でテストページを配信</li>
<li>Firefox は権限なしのため「default address only」で収集</li>
<li>既定アドレスを<b>ページと同じ IPv6 側</b>で探す</li>
<li style="color:#d33">IPv6 既定経路なし → <code>failed to find default addresses</code></li>
<li style="color:#d33">候補 0 件 → <code>iceConnectionState: failed</code></li>
<li style="color:#d33">werift は <code>checking</code> のまま、全テスト timeout</li>
</ol>
</div>
<div style="border:1px solid #2a9d4b;border-radius:8px;padding:10px">
<b style="color:#2a9d4b">After: 127.0.0.1 配信</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li><code>test.api.host: "127.0.0.1"</code> でページを IPv4 配信</li>
<li>Firefox は同じく「default address only」で収集</li>
<li>既定アドレスを<b>IPv4 側</b>で探す</li>
<li style="color:#2a9d4b">default address を発見 → host 候補を収集</li>
<li style="color:#2a9d4b">ICE / DTLS / SCTP が成立</li>
<li style="color:#2a9d4b">datachannel / sendrecv / bundle/* が通る</li>
</ol>
</div>
</div>

凡例: 赤 = 問題の経路、緑 = 修正後の経路。同じ起点（vitest がテストページを配信する）から、配信先の IP ファミリだけが違います。

要点は次の 3 つです。

- 原因は `MOZ_LOG=nicer:5` で確認しています。Node の werift と Firefox の直接接続（`tools/firefoxBundleOnly.ts`）が成立していたのは、ページ読み込みが IPv4 だったためです。
- 修正は [e2e/vitest.firefox.config.mts:21](review-file:e2e/vitest.firefox.config.mts:21) の `api: { host: "127.0.0.1" }` です。変更の核は [e2e/vitest.firefox.config.mts:21](review-diff:e2e/vitest.firefox.config.mts:21) です。
- チケット §2.4 で疑った空文字 / `null` の candidate や `ws://localhost` は原因ではありませんでした。

## 3. 主要変更

### 3.1 設定の共通化

Chrome と Firefox の設定を [e2e/vitest.shared.mts:1](review-file:e2e/vitest.shared.mts:1) にまとめました（新規ファイル）。`include`（`*.spec.ts` を含む）、`exclude`、`fileParallelism: false`、`retry: 1`、`testTimeout` が両方に効きます。Firefox 設定はコメントアウトされていた `fileParallelism` が有効になりました。差分は [e2e/vitest.firefox.config.mts:1](review-diff:e2e/vitest.firefox.config.mts:1) と [e2e/vitest.config.mts:1](review-diff:e2e/vitest.config.mts:1) です。`browser-paths.js` を `require` で読む方式は残しています。`npm run firefox` からは `./tests` フィルタを外しました（[e2e/package.json:15](review-diff:e2e/package.json:15)）。

### 3.2 Firefox の user prefs

[e2e/vitest.firefox.config.mts:26](review-file:e2e/vitest.firefox.config.mts:26) 付近で 2 つの pref を足しています。

- `media.peerconnection.ice.obfuscate_host_addresses: false`: Chrome の `--disable-features=WebRtcHideLocalIpsWithMdns` に相当します。
- `media.peerconnection.ice.loopback: true`: e2e の TURN が `127.0.0.1` で待ち受けるためです。ないと TURN が error 701 になります。

### 3.3 スキップの仕組みと固定タグ

[e2e/tests/fixture.ts:16](review-file:e2e/tests/fixture.ts:16) に理由の定数（`firefoxKnownIssue` と `firefoxUnsupported`）、[e2e/tests/fixture.ts:48](review-file:e2e/tests/fixture.ts:48) に `itSkipOnFirefox(reason)` を置きました。Firefox では `it.skip("<理由> | <名前>")` になり、記録に理由が残ります。テストを定義しないだけの分岐（`reuse` / `removeTrack`）は外し、Firefox でも通ります。

| 種別 | タグ | 対象 | 参照 |
| --- | --- | --- | --- |
| werift 本体の不具合 | `[firefox-known:ice-tcp-active-only]` | `iceTcp` | サブタスク `8b7c8e4a` |
| werift 本体の不具合 | `[firefox-known:vp8-picture-id-loop]` | `vp8Playback` file | `f90a2878` |
| werift 本体の不具合 | `[firefox-known:simulcast-ssrc-track]` | `simulcast_rtx_answer` | `be690c2e` |
| ブラウザ非対応 | `[firefox-unsupported:h264]` | `codecRtp` h264 | なし |
| ブラウザ非対応 | `[firefox-unsupported:encoded-streams]` | `red` | なし |
| ブラウザ非対応 | `[firefox-unsupported:turns-ip-literal]` | `turnRelay` tls | なし |

### 3.4 テストの前提を直したもの

- [e2e/tests/nativeCandidateQueue.ts:1](review-diff:e2e/tests/nativeCandidateQueue.ts:1): ICE restart 中、werift が新しい generation の候補を、ブラウザが remote description を適用する前に trickle します。Firefox は仕様どおり `Unknown ufrag` で拒否するため、`usernameFragment` が remote description に入るまで候補を保留します。
- [e2e/tests/fixture.ts:765](review-file:e2e/tests/fixture.ts:765) `keepSendResolution`: 録画テストで `degradationPreference: "maintain-resolution"` を指定します。帯域推定のフィードバックがないと Firefox は 640x480 を 320x240 で送るためです。
- [e2e/tests/fixture.ts:1196](review-file:e2e/tests/fixture.ts:1196) `decodeAudioFile`: Chrome 独自の `webkitAudioDecodedByteCount` を使わず、全ブラウザで Web Audio により音声ファイル全体をデコードして確認します（レビュー指摘で追加）。
- [e2e/tests/fixture.ts:114](review-file:e2e/tests/fixture.ts:114) `waitAudioPlay`: 音声出力デバイスのない環境で Firefox の `AudioContext.resume()` が解決しないため、timeout 内で必ず終わるようにしました。
- [e2e/tests/mediachannel/codecRtp.test.ts:127](review-file:e2e/tests/mediachannel/codecRtp.test.ts:127) `requireMultiPacket`: VP9 は multi-packet のフレームが出るまで待ちます。
- `simulcast_rtx_answer`: `a=ssrc-group:FID` が無いことの確認は Firefox 以外に限定しました。

### 3.5 ドキュメントと実行記録

- [e2e/AGENTS.md:1](review-file:e2e/AGENTS.md:1) を新規作成しました（Firefox の実行手順、スキップ方針）。
- [README.md:32](review-diff:README.md:32) と [README.md:183](review-diff:README.md:183) の「Firefox test runner」の記述を実態に合わせました。
- `e2e/firefox-runs/` に記録 5 件を追加しています。修正前の比較用（`846ab47d1`）、`40fdd5d61` の 2 回、`966ad2386` の 2 回です。

## 4. 判断理由

- 設定を共通化し、Firefox 専用部分だけを残しました。Chrome の挙動は変えない方針です。`vitest.firefox.record.config.mts` は `mergeConfig` で Firefox 設定を継承するため、この修正が record 経路にも反映されます。
- 採用しなかった代替案: Firefox を CI に入れる案は、ユーザー指示（`03a719478`）で取り下げています。ハンドラ側で SDP を書き換えて回避する案も、「werift の挙動を E2E のために変えない」方針で採りませんでした。
- 親チケット #269 が存在しないため、サブタスクは本チケットの下に作っています。
- `ef1c086e`（ICE restart）はスキップが不要でした。`ice_restart_node_trigger` は通っており、`[firefox-known:ice-restart]` は使っていません。

## 5. レビュアーが確認すべき点・リスク

- 影響範囲は `e2e/` と `README.md` に限られます。`packages/webrtc/src` と公開 API は変わりません。
- Chrome 設定も `vitest.shared.mts` 経由に変わっています。差分は [e2e/vitest.config.mts:1](review-diff:e2e/vitest.config.mts:1) で確認できます。設定値は同じですが、Chrome の全件回帰は 71 件 passed で確認しています。
- `127.0.0.1` 配信は Firefox の挙動に依存した回避です。IPv6 の既定経路がある環境では不要ですが、無害です。
- `keepSendResolution` や Web Audio の確認はテストの確認方法を変えています。Chrome でも同じ確認が通ることを見てください。
- 9 件のスキップは固定タグ付きです。werift 側の修正後は `grep -rn "firefox-known:<name>" e2e/tests` で外せます。
- 記録は `retry: 1` の範囲で安定していますが、環境依存（音声出力、IPv6 経路）のテストは別環境で再確認していません。

## 6. 検証結果

チケット §7.4 / §7.5 と `e2e/firefox-runs/` の記録 JSON を読んで記載しています。この文書の作成にあたって、テストは再実行していません。

| 検証 | 結果 |
| --- | --- |
| Firefox 全件（`966ad2386`、`-dirty` なし、`vitestArgs: []`）2 回 | どちらも `outcome: completed` / `result: passed`（記録 `20261115T124612Z-966ad2386.json` と `20261115T124809Z-966ad2386.json`）。チケットによると 62 passed / 0 failed / 9 skipped、`moduleErrors` と `unfinished` は空 |
| 修正前のコミット `40fdd5d61` の記録 2 回 | チケットによると同じ結果 |
| 修正前 HEAD `846ab47d1`（datachannel のみ） | failed（比較用の記録 `20261115T085209Z-846ab47d1.json`） |
| Chrome `npm run e2e` | チケットによると 25 files / 71 tests passed（修正後、`966ad2386` の 2 回） |
| `cd e2e && npm run type` / `npm run test:tools` | チケットによると通過（12 件） |
| `npm run format` | チケットによると実行済み |
