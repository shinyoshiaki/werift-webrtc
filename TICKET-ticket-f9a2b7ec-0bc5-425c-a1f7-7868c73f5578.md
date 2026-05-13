TICKET-ticket-708e199a-62e5-4fd4-b5c4-ff16ed2de477.md の続き。同様の注意点を踏まえてWPTのテストケースの成功率をさらに向上させる

## 対応対象

- 優先改善対象: `webrtc/RTCPeerConnection-addIceCandidate.html`
- 実装変更箇所:
  - `packages/webrtc/src/peerConnection.ts`
  - `packages/webrtc/src/secureTransportManager.ts`
  - `packages/webrtc/src/transport/ice.ts`
  - `packages/webrtc/tests/integrate/peerConnection.test.ts`
  - `packages/webrtc/README.md`

## 改善内容

- `addIceCandidate()` で `remoteDescription` を基準に `sdpMid` / `sdpMLineIndex` / `usernameFragment` を検証する
- candidate の追加先 m-section を正しく特定し、`remoteDescription` の該当 media section に反映する
- end-of-candidates を対象 m-section に反映する
- JSON 入力時の `candidate:` prefix を正規化する
- WPT 相当の回帰テストを `packages/webrtc/tests/integrate/peerConnection.test.ts` に追加する

## WPT before / after

`WPT_TARGET_FILTER='RTCPeerConnection-addIceCandidate.html' npm run wpt --workspace packages/webrtc`

| Variant | Before | After |
| --- | --- | --- |
| `(default)` | 13 PASS / 23 FAIL | 36 PASS / 0 FAIL |
| `?rest` | 12 PASS / 22 FAIL | 34 PASS / 0 FAIL |

## 確認コマンド

- `npm run type --workspace packages/webrtc`
- `cd packages/webrtc && npx vitest run tests/integrate/peerConnection.test.ts tests/integrate/trickle.test.ts tests/datachannel/close.test.ts`
- `WPT_TARGET_FILTER='RTCPeerConnection-addIceCandidate.html' npm run wpt --workspace packages/webrtc`
- `npm run ci`
