---
ide:
  viewer: review-document
  version: 1
  title: "icecandidateerror 通知（#812）レビュー解説"
  dock: right
  baseCommit: d418e57d9caf84b95410bdeb5824c4275a2a8dd9
---
# STUN/TURN 到達失敗を `icecandidateerror` で通知する（#812）レビュー解説

## 1. 概要

`RTCPeerConnection` は `onicecandidateerror` を持っていましたが、イベントを発火するコードがなく、TURN の認証誤りや DNS 誤り、UDP 遮断で relay / srflx 候補が出なくても、アプリは理由を知れませんでした。この変更で、gathering 中に失敗した STUN/TURN サーバー URL ごとに `RTCPeerConnectionIceErrorEvent`（`url` / `errorCode` / `errorText` / `address` / `port`）を発火します。

変更は ICE 層（`werift-ice`）で失敗を分類して通知し、`werift` 側（`RTCPeerConnection`）で URL 単位に集約して W3C 仕様どおりの順序で発火する二層構成です。候補の出る順序、end-of-candidates、`iceGatheringState` の遷移は変えていません。

対象差分はベースブランチ（merge-base `41773f4dc`）から HEAD `d418e57d9` までです。レビュー反復は 3 回目で、最終承認済みです。

## 2. 修正前と修正後の流れ

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-family:sans-serif;font-size:12px">
<div style="border:1px solid #c0392b;border-radius:8px;padding:10px">
<b style="color:#c0392b">Before</b>
<svg viewBox="0 0 300 250" width="100%" role="img" aria-label="Before: 失敗は握りつぶされる">
<rect x="10" y="10" width="280" height="36" rx="6" fill="none" stroke="#888"/><text x="20" y="33" font-size="12" fill="currentColor">getCandidatePromises / queryReflexive</text>
<line x1="150" y1="46" x2="150" y2="70" stroke="#888"/>
<rect x="10" y="70" width="280" height="36" rx="6" fill="none" stroke="#888"/><text x="20" y="93" font-size="12" fill="currentColor">serverReflexiveCandidate() が undefined</text>
<line x1="150" y1="106" x2="150" y2="130" stroke="#c0392b"/>
<rect x="10" y="130" width="280" height="36" rx="6" fill="#c0392b22" stroke="#c0392b"/><text x="20" y="153" font-size="12" fill="currentColor">失敗・タイムアウトを区別せず破棄</text>
<line x1="150" y1="166" x2="150" y2="190" stroke="#c0392b"/>
<rect x="10" y="190" width="280" height="44" rx="6" fill="#c0392b22" stroke="#c0392b"/><text x="20" y="209" font-size="12" fill="currentColor">onicecandidateerror は未発火</text><text x="20" y="225" font-size="12" fill="currentColor">アプリは debug ログでしか原因を知れない</text>
</svg></div>
<div style="border:1px solid #27ae60;border-radius:8px;padding:10px">
<b style="color:#27ae60">After</b>
<svg viewBox="0 0 300 250" width="100%" role="img" aria-label="After: 分類して URL 単位で発火">
<rect x="10" y="10" width="280" height="36" rx="6" fill="none" stroke="#888"/><text x="20" y="33" font-size="12" fill="currentColor">queryServerReflexiveCandidate()（reject する）</text>
<line x1="150" y1="46" x2="150" y2="70" stroke="#888"/>
<rect x="10" y="70" width="280" height="36" rx="6" fill="#27ae6022" stroke="#27ae60"/><text x="20" y="93" font-size="12" fill="currentColor">classifyGatherError → 401 / 3xx-6xx / 701</text>
<line x1="150" y1="106" x2="150" y2="130" stroke="#27ae60"/>
<rect x="10" y="130" width="280" height="36" rx="6" fill="#27ae6022" stroke="#27ae60"/><text x="20" y="153" font-size="12" fill="currentColor">Connection.onIceCandidateError（ICE 層）</text>
<line x1="150" y1="166" x2="150" y2="190" stroke="#27ae60"/>
<rect x="10" y="190" width="280" height="44" rx="6" fill="#27ae6022" stroke="#27ae60"/><text x="20" y="209" font-size="12" fill="currentColor">RTCPeerConnection: URL 単位で集約し</text><text x="20" y="225" font-size="12" fill="currentColor">701 は gathering 終了直前に判定して発火</text>
</svg></div>
</div>

凡例: 赤は問題のある経路、緑は今回追加した経路です。修正前は失敗理由が ICE 層で捨てられていました。修正後は失敗を分類して ICE 層から通知し、`RTCPeerConnection` が URL 単位で集約して発火します。

## 3. 主要変更

### 3.1 失敗の分類（`packages/ice`）

[packages/ice/src/candidateError.ts:270](review-file:packages/ice/src/candidateError.ts:270) の `classifyGatherError()` が、失敗を STUN エラーコード（401 や 300 など）または 701（サーバー未到達。DNS、タイムアウト、接続失敗、ソケットエラー）に分類します。サーバーが応答した失敗（ERROR-CODE なしのエラー応答、MESSAGE-INTEGRITY 不一致、XOR-MAPPED-ADDRESS なしの成功応答）は [`isServerAnswer()`](review-file:packages/ice/src/candidateError.ts:241) で「到達した」と判定し、701 に数えません。

`errorText` は [`gatherErrorReasonText()`](review-file:packages/ice/src/candidateError.ts:200) が作ります。TURN の username / password と応答の USERNAME / REALM / NONCE を `***` に置換し、制御文字を除いて 127 文字で切ります。

[packages/ice/src/ice.ts:1148](review-diff:packages/ice/src/ice.ts:1148) の `emitCandidateError()` が通知の入口です。置き換えられた世代（ICE restart）や close 後の失敗は破棄し、リスナーが throw しても gathering は止めません。

[packages/ice/src/iceBase.ts:591](review-diff:packages/ice/src/iceBase.ts:591) の `queryServerReflexiveCandidate()` は失敗理由で reject します。既存の `serverReflexiveCandidate()` は従来どおり `undefined` を返し、reject しません。

### 3.2 URL 単位の集約と 701 の判定（`packages/webrtc`）

[packages/webrtc/src/transport/ice.ts:1024](review-diff:packages/webrtc/src/transport/ice.ts:1024) で ICE 層の通知を受けます。サーバーの error 応答（300-699）は即時に、ソケットごとに発火します。701 は W3C の「どの host candidate もサーバーに届かなかった」に合わせ、その場では発火しません。

[packages/webrtc/src/peerConnection.ts:552](review-diff:packages/webrtc/src/peerConnection.ts:552) の `judgeUnreachableServers()` が、`iceGatheringState` が `"gathering"` を抜ける直前に 1 回だけ判定します。`bundlePolicy: "disable"` で複数の ICE transport があっても、全 transport が到達できなかった URL だけを 1 URL 1 回発火します。

発火は [packages/webrtc/src/peerConnection.ts:580](review-file:packages/webrtc/src/peerConnection.ts:580) で行い、順序は `pc.onIceCandidateError`、`onicecandidateerror`、`addEventListener` のリスナーです。3 経路に同一のイベントオブジェクトを渡します。

### 3.3 イベント型と公開 API

[packages/webrtc/src/api/peerConnectionEvents.ts:102](review-diff:packages/webrtc/src/api/peerConnectionEvents.ts:102) に `RTCPeerConnectionIceErrorEvent` を追加しました。`werift/polyfill` でグローバルにも登録します。`stopImmediatePropagation()` を `pc.onIceCandidateError` の購読者間でも効かせるため、[packages/common/src/event.ts:83](review-diff:packages/common/src/event.ts:83) に `Event.executeUntil()` を追加しました。

### 3.4 テスト・WPT・ドキュメント

- テスト: [packages/ice/tests/ice/candidate-error.test.ts](review-file:packages/ice/tests/ice/candidate-error.test.ts)、[packages/webrtc/tests/transport/iceCandidateError.test.ts](review-file:packages/webrtc/tests/transport/iceCandidateError.test.ts)、[packages/common/tests/event.test.ts](review-file:packages/common/tests/event.test.ts) を追加・拡張しました。Arrange の共通部分は `candidateErrorUtils.ts` と `iceCandidateErrorUtils.ts` に置きました。
- WPT: [packages/webrtc/wpt/allowlist.json:23](review-diff:packages/webrtc/wpt/allowlist.json:23) に `RTCPeerConnection-onicecandidateerror.https.html` の 2 サブテストを追加し、`baseline.json` も更新しました。
- 文書: [changelog.md](review-diff:changelog.md)、[packages/webrtc/README.md](review-diff:packages/webrtc/README.md)、生成 doc（`npm run doc` の出力）を更新しました。

## 4. 判断理由

| 判断 | 理由 |
| --- | --- |
| 701 を gathering 終了時にまとめて判定する | W3C は 701 を「どの host candidate もサーバーに届かなかった」場合と定めます。ソケット単位で即時発火すると、別ソケットで到達した URL に誤報を出します。 |
| 300-699 は即時・ソケット単位で発火する | サーバーが応答したので、そのソケット単位の事実として確定します。 |
| TURN の UDP 割り当てと TCP フォールバックを 1 失敗にする | アプリ視点では 1 つの URL の失敗です。サーバーのエラーコードを 701 より優先します。 |
| `serverReflexiveCandidate()` を変えず、reject する `queryServerReflexiveCandidate()` を別に追加した | 既存の呼び出し元の互換性を保ちます。 |
| `errorText` で認証情報をマスクする | 応答テキストには USERNAME / REALM / NONCE が入りえ、アプリのログに流れるためです。 |
| `null` port を 0 に変えるのは WPT ランナー側に限る | 上流 WPT は Chrome 互換の `port: 0` を期待しますが、既定の API は W3C の「null address は null port」に従います。AGENTS.md の WPT 方針にも沿います。 |

## 5. レビュアーが確認すべき点・リスク

- 公開 API が増えます。`RTCPeerConnectionIceErrorEvent`、`canonicalIceServerUrl()`、`parseIceServers()` の戻り値（`stunServerUrls`、TURN の `urls`）、ICE 層の `onIceCandidateError` / `onIceServerReached`、`IceCandidateErrorCode`、`MissingMappedAddressError` です。`onicecandidateerror` の型も `any` から `RTCPeerConnectionIceErrorEvent` に変わるため、型を `any` として扱っていた利用側のコードで型エラーが出る可能性があります。
- 挙動変更が 1 つあります。gathering 中に停止した ICE transport が `"gathering"` に留まらず `"complete"` になります。
- 701 の発火中は `iceGatheringState` がまだ `"gathering"` です。701 のハンドラが `close()` すると、以降の 701 と `icegatheringstatechange` は出ません。[packages/webrtc/src/peerConnection.ts:443](review-file:packages/webrtc/src/peerConnection.ts:443) 付近の順序を確認してください。
- 組み込みの既定 STUN サーバーは設定に URL がないため、合成 URL `stun:stun.l.google.com:19302` で報告します。
- 差分は 91 ファイルです。うち大半は生成 doc で、手で読むべきなのは `packages/ice/src`、`packages/webrtc/src`、`packages/common/src/event.ts` です。

## 6. 検証結果

この解説の作成では、テストや型チェックを実行していません。以下は差分とチケット・changelog の記述から読み取った内容で、今回の実行結果ではありません。

- 差分にはユニットテスト（ice / webrtc / common）と WPT の allowlist / baseline 更新が含まれます。
- 今回の作成時に `npm run type`、`npm run test:small`、`npm run wpt` は実行していません。最終承認時点の CI 結果はレビュー側の記録を参照してください。
