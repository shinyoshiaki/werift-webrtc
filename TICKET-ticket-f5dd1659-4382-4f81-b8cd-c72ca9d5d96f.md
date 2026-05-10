## 1. 目的と背景

`packages/webrtc` の `RTCPeerConnection` を W3C WebRTC API に近づけ、ブラウザ実装を前提にした既存コードを `werift` でも扱いやすくする。現状 README にも “API compatible with browser RTCPeerConnection” が未達として残っており、`RTCPeerConnection` が公開 API の中心であるため、互換性改善の効果が大きい。

調査対象の主ファイルは [peerConnection.ts](/workspace/packages/webrtc/src/peerConnection.ts:58)、状態管理は [sdpManager.ts](/workspace/packages/webrtc/src/sdpManager.ts:16)、イベント基盤は [helper.ts](/workspace/packages/webrtc/src/helper.ts:27)。

## 2. 実装すべき具体的な変更

### 優先度高: 低リスクな API 互換

- `currentLocalDescription`
- `pendingLocalDescription`
- `currentRemoteDescription`
- `pendingRemoteDescription`
- `canTrickleIceCandidates`
- `sctp`

上記 getter を `RTCPeerConnection` に追加する。`sdpManager` には current/pending の内部状態が既にあるため、公開 getter の追加で対応可能。

`canTrickleIceCandidates` は `setRemoteDescription` 完了前は `null`、完了後は remote SDP の `a=ice-options:trickle` 有無から算出する。

`RTCIceServer.urls` は W3C では `string | string[]` なので、現在の `string` 限定を拡張し、`parseIceServers` 側で配列を処理する。

標準イベント名の発火を補完する。

- `signalingstatechange`
- `iceconnectionstatechange`
- `icegatheringstatechange`
- `connectionstatechange`
- `negotiationneeded`
- `icecandidate`
- `track`
- `datachannel`

現状は一部で `onxxx` と `emit()` が不一致。特に `signalingstatechange`、`iceconnectionstatechange`、`icegatheringstatechange` は標準 `addEventListener` 利用時に取りこぼす可能性がある。

### 優先度中: シグナリング互換

`setLocalDescription` の型と挙動を W3C に寄せる。

- `description` 省略時の implicit offer/answer は既にあるため維持
- `RTCLocalSessionDescriptionInit` として `type` 省略、`sdp` 空文字、`pranswer`、`rollback` を扱う
- 戻り値を実用上 W3C 互換の `Promise<void>` に寄せるか、既存互換維持のため段階的に型調整する

`setRemoteDescription` は現在 `pranswer` と `rollback` を拒否しているため、状態遷移と current/pending description 更新を追加する。

`addIceCandidate` は W3C では引数省略または `{ candidate: "" }` が end-of-candidates を表すため、`optional RTCIceCandidateInit candidate = {}` に近い扱いを追加する。

### 優先度中: `RTCConfiguration` 互換

現在の `PeerConfig` は werift 独自項目を多く含むため、標準 `RTCConfiguration` と互換的に受け取れる型を追加する。

対応候補:

- `iceServers`
- `iceTransportPolicy`
- `bundlePolicy`
- `rtcpMuxPolicy: "require"` の受け入れ
- `iceCandidatePoolSize` の受け入れ。実装しない場合も `0` は許容し、非 0 は no-op か明示エラー方針を決める
- `certificates` は既存 `dtls.keys` / `RTCCertificate` 実装と接続する

`getConfiguration()` は内部 `config` オブジェクトそのものではなく、標準項目を含むコピーを返すようにする。`setConfiguration()` は W3C の変更不可項目、特に `bundlePolicy`、`rtcpMuxPolicy`、`certificates`、setLocalDescription 後の `iceCandidatePoolSize` 変更制限を検証する。

### 優先度低: オプション/レガシー API

W3C の legacy callback overloads は任意対応でよい。`addStream`、`removeStream`、`createDTMFSender` は obsolete 扱いなので、今回の中心から外す。

`RTCPeerConnection.generateCertificate()` は W3C では明示的証明書管理 API だが optional。既存の `RTCDtlsTransport.SetupCertificate()` と `RTCCertificate` があるため、余力があれば静的 API と `RTCConfiguration.certificates` に接続する。

## 3. 技術的な実装アプローチ

W3C の現在の `RTCPeerConnection` IDL では、`createOffer/createAnswer/setLocalDescription/setRemoteDescription/addIceCandidate`、current/pending description、`canTrickleIceCandidates`、`restartIce/getConfiguration/setConfiguration/close` が定義されている。`RTCConfiguration` は `iceServers`、`iceTransportPolicy`、`bundlePolicy`、`rtcpMuxPolicy`、`certificates`、`iceCandidatePoolSize` を持つ。

実装は段階的に進めるのが安全。

1. `peerConnection.ts` に標準 getter と event emit を追加する。
2. `sdpManager.ts` の current/pending 管理を `pranswer` / `rollback` 対応に拡張する。
3. `PeerConfig` を壊さず、標準 `RTCConfiguration` 入力を受けられる型・変換層を追加する。
4. `parseIceServers` を `urls: string | string[]` に対応させる。
5. WPT 由来の既存テスト群 `packages/webrtc/tests/wpt` に互換テストを追加する。

## 4. 制約と注意点

- `werift` は Node.js 向け pure TypeScript 実装なので、ブラウザ DOM API との完全一致よりも実用互換を優先する。
- 既存ユーザー向けの `PeerConfig` 独自項目は維持する。標準 API 追加で既存設定を壊さない。
- `close()` は W3C では同期 `undefined` だが、現状は `async close()`。戻り値変更は破壊的なので、互換方針を明示して段階対応する。
- テスト追加時はリポジトリ指示に従い Arrange / Act / Assert を分け、Act / Assert には日本語コメントを入れる。
- W3C の identity provider 系や obsolete API は、現在の互換性改善の本筋から外す。

## 5. 完了条件

- W3C の主要 `RTCPeerConnection` 属性・メソッドとの差分表がコードコメントまたは PR 説明で整理されている。
- `currentLocalDescription`、`pendingLocalDescription`、`currentRemoteDescription`、`pendingRemoteDescription`、`canTrickleIceCandidates`、`sctp` が公開 API として利用できる。
- `setLocalDescription` / `setRemoteDescription` / `addIceCandidate` が W3C の主要入力形式に対応する。
- `RTCConfiguration` 互換の入力、`RTCIceServer.urls` 配列、標準イベント発火がテストされている。
- `cd packages/webrtc && npm run type && npm test` が通る。
- 公開 API 変更に合わせて `doc` または website API docs の再生成方針が確認されている。

参考: W3C WebRTC `RTCPeerConnection` IDL と属性定義、`RTCConfiguration` 定義、DataChannel 拡張、および MDN の API 一覧を確認済み。  
https://www.w3.org/TR/webrtc/  
https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection