## 1. タスクの目的と背景

`packages/webrtc` には upstream WPT を Node.js 上で走らせる専用ランナーがあり、結果は JSON/Markdown レポートに保存されます。  
今回のタスクの本質は、**「部分的に通っている WPT ファイル」を起点に、実装側の WebRTC 互換性を高めて PASS 数を増やす**ことです。

背景として、コードベースにはすでに以下があります。

- `npm run wpt:list --workspace packages/webrtc` で **214 個の WPT target** を列挙
- `npm run wpt --workspace packages/webrtc` で実行し、`coverage/webrtc-wpt/results.{json,md}` を出力
- `formatMarkdownReport()` が **“Files with at least one passing subtest”** を生成
- `wpt/allowlist.json` に「既に狙っている互換性領域」と「まだ deferred な領域」が整理済み

つまり、**可視化基盤は既にあるので、主作業は runner 追加ではなく互換性改善そのもの**です。

## 2. 実装すべき具体的な機能や変更内容

### 必須の変更内容

1. **部分成功ファイルの一覧を継続的に使える状態にする**
   - 既存の `results.md` / `results.json` を正式な進捗ソースとして扱う
   - 実装変更前後で **file ごとの PASS 数差分**を比較する運用にする

2. **部分成功しているファイルから優先順位を付けて互換性改善する**
   - まずは **PASS が既にあるのに FAIL も多いファイル**を優先
   - 全件失敗ファイルより、**仕様との差分が狭い領域**のほうが PASS 数を伸ばしやすい

3. **改善対象ごとに実装層をまたいで修正する**
   - `RTCPeerConnection`
   - `TransceiverManager`
   - `SDPManager`
   - `SctpTransportManager` / `RTCDataChannel`
   - stats 関連クラス

### 優先度が高い改善候補

| 優先 | WPT file | 現状 | 主な失敗傾向 | 主な修正候補 |
| --- | --- | ---: | --- | --- |
| 1 | `webrtc/RTCPeerConnection-addTrack.https.html` | 11 PASS / 1 FAIL | `setRemoteDescription()` 進行中の transceiver 順序 | `peerConnection.ts`, `transceiverManager.ts` |
| 2 | `webrtc/RTCPeerConnection-transceivers.https.html` | 30 PASS / 14 FAIL | `ontrack` の `streams`、`mid` の `null/undefined`、m-section 紐付け | `peerConnection.ts`, `transceiverManager.ts` |
| 3 | `webrtc/RTCPeerConnection-addIceCandidate.html` | 12 PASS / 24 FAIL（`?rest` は 12/22） | `sdpMid`/`sdpMLineIndex` 検証、candidate 追加先 m-line 判定 | `peerConnection.ts`, `sdpManager.ts`, secure/ICE 経路 |
| 4 | `webrtc/RTCPeerConnection-setRemoteDescription-rollback.html` | 8 PASS / 14 FAIL（`?rest` は 8/12） | rollback 時の transceiver / transport / removetrack 後始末 | `peerConnection.ts`, `sdpManager.ts`, `transceiverManager.ts` |
| 5 | `webrtc/RTCPeerConnection-mandatory-getStats.https.html` | 4 PASS / 69 FAIL | 必須 stats 項目不足 | `peerConnection.ts`, stats 系、transport 系 |
| 6 | `webrtc/RTCPeerConnection-createDataChannel.html` | 1 PASS / 1 FAIL（default/`?rest`） | harness/cleanup と API 返却互換 | `peerConnection.ts`, `sctpManager.ts`, `dataChannel.ts` |

### 現状の代表的な「1件以上 PASS がある」ファイル

- `RTCPeerConnection-transceivers.https.html` — 30 PASS
- `RTCPeerConnection-addIceCandidate.html` — 12 PASS
- `RTCPeerConnection-addTrack.https.html` — 11 PASS
- `RTCPeerConnection-setRemoteDescription-rollback.html` — 8 PASS
- `RTCRtpSender-replaceTrack.https.html` — 6 PASS
- `RTCPeerConnection-setLocalDescription-parameterless.https.html` — 5 PASS
- `RTCPeerConnection-mandatory-getStats.https.html` — 4 PASS
- `RTCPeerConnection-createDataChannel.html` — 1 PASS

一方で、以下は既に fully pass しており、**PASS 数を増やす観点では優先度低**です。

- `RTCPeerConnection-constructor.html`
- `RTCDataChannelInit-maxPacketLifeTime-enforce-range.html`
- `RTCDataChannelInit-maxRetransmits-enforce-range.html`
- `RTCPeerConnection-removeTrack.https.html`
- `RTCPeerConnection-ontrack.https.html`

## 3. 技術的な実装アプローチを調査し結果を簡潔にまとめる

### 既存基盤の使い方

- 一覧確認: `npm run wpt:list --workspace packages/webrtc`
- 全体実行: `npm run wpt --workspace packages/webrtc`
- 結果確認: `coverage/webrtc-wpt/results.json`, `coverage/webrtc-wpt/results.md`
- 対象絞り込み: `WPT_TARGET_FILTER=... npm run wpt --workspace packages/webrtc`

### 実装アプローチ

1. **まず file 単位で絞って再現**
   - 例: `WPT_TARGET_FILTER='RTCPeerConnection-addTrack.https.html' npm run wpt --workspace packages/webrtc`
   - 1ファイルごとに失敗パターンを固定化してから実装修正する

2. **既存のローカル integration test と WPT の失敗内容を結びつける**
   - すでに `tests/integrate/peerConnection.test.ts` には WPT 寄りの互換性テストがある
   - `getStats.test.ts` もかなり厚いので、stats 系は既存テストを拡張しやすい

3. **小さく勝てる領域から先に取る**
   - 最初の ROI は `addTrack`, `transceivers`, `addIceCandidate`, `rollback`
   - `mandatory-getStats` は伸び幅は大きいが、実装面積も広い

4. **runner 側は基本そのままでよい**
   - `formatMarkdownReport()` がすでに部分成功ファイル一覧を出している
   - したがって task の主対象は **WPT runner 改修ではなく WebRTC 実装互換性の改善**

## 4. 考慮すべき制約や注意点

- `packages/webrtc` は public API なので、**WPT を通すためだけの破壊的変更**は避ける
- 既知の意図的差分がある
  - `bundlePolicy: "balanced"` は現在 `"max-compat"` に正規化
  - `close()` は互換性維持のため async のまま
- そのため、一部 WPT 失敗は **単純バグ修正ではなく互換性方針の見直し**が必要
- 既存規約上、広い `catch` で握りつぶす対応は不可
- WPT runner / compatibility allowlist / baseline を触る場合は `npm run wpt --workspace packages/webrtc`、coverage/baseline を触る場合は `npm run wpt:coverage --workspace packages/webrtc` も必要
- public API や互換性ノートを変える場合は `packages/webrtc/README.md` と関連説明の更新が必要

## 5. 完了条件

- `npm run wpt --workspace packages/webrtc` の結果で、**対象ファイルの PASS 数が実際に増えている**
- `coverage/webrtc-wpt/results.md` の **“Files with at least one passing subtest”** と失敗表で改善が確認できる
- 既存 baseline に対して **regression なし**
- 変更した互換性領域に対応する package-level test / type check が通る
- 変更が public API / 互換性仕様に影響する場合、README 等の説明が更新されている

**要するに、このタスクは「既存 runner で部分成功ファイルを可視化 → ROI の高い互換性ギャップを順に潰して PASS 数を増やす」タスクです。最初の実装対象は `addTrack`、`transceivers`、`addIceCandidate`、`setRemoteDescription(rollback)` が最も現実的です。**