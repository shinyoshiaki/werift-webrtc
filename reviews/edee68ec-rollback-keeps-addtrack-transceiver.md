---
ide:
  viewer: review-document
  version: 1
  title: "#817 rollback で addTrack 済み transceiver を保持する"
  dock: right
  baseCommit: b13ce9e046ebd8c1548abb0f6e9b30b7b012d62b
---
# #817 remote rollback で addTrack 済み transceiver が消える問題の修正

## 概要

`addTrack()` で取得した transceiver に `replaceTrack(null)` や `removeTrack()` を呼んだあと remote offer を rollback すると、transceiver が除去・stop されていました。W3C の rollback 手順は「`addTrack()` が一度も触れていない remote 生成 transceiver」だけを除去します。そこで「`addTrack()` で取得済み」を `sender.track` の現在値とは別の持続フラグとして記録し、保持判定に使うよう変更しました。あわせて、`addTrack()` が新規作成した transceiver が DTLS transport なしで作られ、rollback で `TypeError` になる関連不具合も直しています。

## 修正前後の流れ

<div style="display:flex;gap:16px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:300px;border:2px solid #d33;border-radius:8px;padding:10px">
<b style="color:#d33">Before</b>
<ol>
<li>b.setRemoteDescription(offer) → transceiver を <code>remoteCreated</code> に登録</li>
<li>b.addTrack(track)</li>
<li>sender.replaceTrack(null) / removeTrack()</li>
<li>rollback → <code>heldByApplication = !!sender.track</code> = <b style="color:#d33">false</b></li>
<li><b style="color:#d33">removeRemoteTransceiver() で除去・stopped</b></li>
</ol>
</div>
<div style="flex:1;min-width:300px;border:2px solid #2a7;border-radius:8px;padding:10px">
<b style="color:#2a7">After</b>
<ol>
<li>b.setRemoteDescription(offer) → transceiver を <code>remoteCreated</code> に登録</li>
<li>b.addTrack(track) → <b style="color:#2a7">noteApplicationAddTrack()</b> で記録</li>
<li>sender.replaceTrack(null) / removeTrack()（記録は消えない）</li>
<li>rollback → <code>isAttachedByAddTrack || !!sender.track</code> = <b style="color:#2a7">true</b></li>
<li><b style="color:#2a7">同一 object を保持、作成時状態へ戻し MID を外す</b></li>
</ol>
</div>
</div>

Before は現在の track の有無だけで判定するため、アプリ操作の履歴が失われます。After は履歴を別フラグで持ちます。

## 主要変更

- 持続フラグ: [packages/webrtc/src/negotiation/internalState.ts:56](review-file:packages/webrtc/src/negotiation/internalState.ts:56) に WeakSet を追加しました。変更の核は [internalState.ts](review-diff:packages/webrtc/src/negotiation/internalState.ts) です。`RTCRtpTransceiver` の公開フィールドを増やさないため、生成 docs は変わりません。既存の `noteApplicationStop` と同じ置き場所です。rollback の snapshot / restore の対象外なので、rollback を越えて残ります。
- 保持判定: [packages/webrtc/src/media/rtpTransceiver.ts:263](review-file:packages/webrtc/src/media/rtpTransceiver.ts:263) の `heldByApplication` を `isAttachedByAddTrack(this) || !!this.sender.track` にしました。差分は [rtpTransceiver.ts](review-diff:packages/webrtc/src/media/rtpTransceiver.ts) です。`!!sender.track` を残したので、`replaceTrack(track)` だけで保持される werift 独自の挙動は変わりません。stop、direction、codec preferences だけでは保持しません。
- 記録箇所: [packages/webrtc/src/transceiverManager.ts:527](review-file:packages/webrtc/src/transceiverManager.ts:527) の `addTrack()` で、再利用 2 分岐と新規作成の 3 箇所に `noteApplicationAddTrack` を入れました。差分は [transceiverManager.ts](review-diff:packages/webrtc/src/transceiverManager.ts) です。
- 関連修正（transport）: `addTrack()` が新規 transceiver を作るとき、DTLS transport を作成時に渡すようにしました（[peerConnection.ts:1931](review-file:packages/webrtc/src/peerConnection.ts:1931)、[差分](review-diff:packages/webrtc/src/peerConnection.ts)）。codec 検証は `assertTrackCodecsSupported` に切り出し、transport を作る前に実行します。検証失敗時に transport が残らないようにするためです。
- TSDoc、[changelog.md](review-diff:changelog.md)、[negotiationTransaction.ts](review-diff:packages/webrtc/src/negotiationTransaction.ts) の表を新しい規則に合わせました。
- テスト・WPT: [scenes.ts](review-diff:packages/webrtc/tests/pbt/model/scenes.ts) に #817 の scene（replaceTrack / removeTrack の 2 種）と transport の scene を追加しました。[generator.ts](review-diff:packages/webrtc/tests/pbt/model/generator.ts) にはステップを追加し、[codecResolution.test.ts](review-diff:packages/webrtc/tests/media/codecResolution.test.ts) には transport の漏れがないことを確認するテストを追加しました。WPT `?rest` の "rollback of a remote offer should keep a transceiver without tracks" は [allowlist.json](review-diff:packages/webrtc/wpt/allowlist.json) と [baseline.json](review-diff:packages/webrtc/wpt/baseline.json) に加えました。

## 判断理由

- remote 起源の識別には既存の `NegotiationTransaction.resources.remoteCreated` をそのまま使い、新しいフラグは作りませんでした。replacement offer や checkpoint の差分集合と同じ集合なので、判定がずれません。
- `RTCRtpTransceiver` に private フィールドを置く案もありましたが、公開クラスで docs 生成の対象になることと、rollback を越えて残るアプリ操作の記録を internalState にまとめられることから、WeakSet を採用しました。
- `replaceTrack(track)` だけで保持する挙動（WPT `?interop-2026` は「除去」を期待）は、このチケットの範囲外として互換のため残しました。

## レビュアーが確認すべき点・リスク

- `heldByApplication` が OR 条件なので、`replaceTrack(track)` のみのケースは仕様より保持側に寄ったままです。意図した据え置きかを確認してください。
- transport の関連修正はチケット本文の「実装する変更」には含まれていません。差分の `peerConnection.ts` と `transceiverManager.ts` の変更が、チケット範囲として許容できるか確認してください。PBT の seed 25 で見つかった、develop にもある不具合です。
- `removeTrack()` 後に保持された transceiver は MID を外した作成時状態に戻ります。stop と sender は失効しません。
- 公開 API と生成 docs に変更はありません。
- 保持された transceiver の `receiver.transport` が null にならない点は、WPT の別サブテストが要求しますが、チケットで範囲外としています。

## 検証結果

このドキュメント作成担当は、テストやビルドを実行していません。以下はチケットが定める検証項目で、実行結果はこの作業では確認していません。

- `cd packages/webrtc && npm run type && npm test`
- `npm run pbt:deep`
- `npm run wpt`
- `tools/negotiation-diff`（develop との差分数 0）
- `npm run format`

差分で確認できたのは、追加テスト（scene、単体テスト）と WPT の baseline 更新が入っていることまでです。
