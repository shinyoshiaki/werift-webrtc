---
ide:
  viewer: review-document
  version: 1
  title: "icecandidateerror 通知（#812）レビュー解説"
  dock: right
  baseCommit: 10cf5016e6710383a58a8d6f3f1cb0493ff7eac3
---
# STUN/TURN 到達失敗を `icecandidateerror` で通知する（#812）レビュー解説

## 1. 概要

`RTCPeerConnection` は `onicecandidateerror` 属性を持っていましたが、イベントを発火するコードがありませんでした。TURN の認証誤り、DNS 名の誤り、UDP の遮断で relay / srflx 候補が出なくても、アプリは理由を知る方法がありませんでした。

この変更で、gathering 中に失敗した STUN / TURN サーバーの URL ごとに `RTCPeerConnectionIceErrorEvent`（`url` / `errorCode` / `errorText` / `address` / `port`）を発火します。経路は `addEventListener("icecandidateerror")`、`onicecandidateerror`、`pc.onIceCandidateError` の 3 つで、同じイベントオブジェクトが届きます。

構成は二層です。ICE 層（`werift-ice`）が失敗を分類して通知し、`werift` の `RTCPeerConnection` が URL 単位に集約して、W3C / DOM 仕様どおりに配送します。候補の出る順序、end-of-candidates、`iceGatheringState` の遷移は変えていません（例外は 5 章のリスクに書いた 1 点）。

- 対象差分: ベースブランチ（merge-base `41773f4dc`）から HEAD まで。この文書を除くと、コードは前回の解説作成時（`d418e57d9`）から変わっていません。
- レビュー状態: `ticket.reviewStatus` は `approved` です（レビュー反復 3 / 5 回目で承認）。
- 決定事項の正本はチケット [docs/tickets/TICKET-ticket-15b88df2-3517-4b93-bcd6-9dd7d2ce844a.md](review-file:docs/tickets/TICKET-ticket-15b88df2-3517-4b93-bcd6-9dd7d2ce844a.md) の 3.7 節と 8 章です。

## 2. 修正前の問題

STUN の問い合わせは `serverReflexiveCandidate()` が失敗をすべて `catch` して `undefined` を返し、TURN の割り当ては `getCandidatePromises` の `.catch(log)` で終わっていました。失敗の理由（タイムアウト、DNS、401、接続失敗）は debug ログにしか残らず、`onicecandidateerror` を発火する処理はどこにもありませんでした。アプリが見られるのは「候補が出なかった」という結果だけでした。

## 3. 修正後の仕組み

### 3.1 失敗が通知されるまでの流れ

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-family:var(--review-font);font-size:12px;color:var(--review-fg)">
<div style="border:1px solid var(--review-border);border-top:4px solid var(--review-danger);border-radius:8px;padding:10px;background:var(--review-surface)">
<b style="color:var(--review-danger)">Before</b>
<svg viewBox="0 0 300 300" width="100%" role="img" aria-label="Before: 失敗は ICE 層で捨てられる">
<g fill="none" stroke="var(--review-border)"><rect x="10" y="10" width="280" height="38" rx="6"/><rect x="10" y="74" width="280" height="38" rx="6"/></g>
<g fill="none" stroke="var(--review-danger)"><rect x="10" y="138" width="280" height="38" rx="6"/><rect x="10" y="202" width="280" height="38" rx="6"/><rect x="10" y="252" width="280" height="38" rx="6" stroke-dasharray="4 3"/></g>
<g stroke="var(--review-muted)"><line x1="150" y1="48" x2="150" y2="74"/></g>
<g stroke="var(--review-danger)"><line x1="150" y1="112" x2="150" y2="138"/><line x1="150" y1="176" x2="150" y2="202"/><line x1="150" y1="240" x2="150" y2="252"/></g>
<g fill="var(--review-fg)" font-size="12"><text x="20" y="34">Connection.gatherCandidates()</text><text x="20" y="98">serverReflexiveCandidate() / TURN 割り当て</text><text x="20" y="162">catch → undefined / log（理由を捨てる）</text><text x="20" y="226">RTCIceGatherer: 候補が出ないだけ</text><text x="20" y="276" fill="var(--review-danger)">onicecandidateerror: 発火しない</text></g>
</svg></div>
<div style="border:1px solid var(--review-border);border-top:4px solid var(--review-success);border-radius:8px;padding:10px;background:var(--review-surface)">
<b style="color:var(--review-success)">After</b>
<svg viewBox="0 0 300 300" width="100%" role="img" aria-label="After: 分類して URL 単位で配送">
<g fill="none" stroke="var(--review-border)"><rect x="10" y="10" width="280" height="38" rx="6"/></g>
<g fill="none" stroke="var(--review-success)"><rect x="10" y="74" width="280" height="38" rx="6"/><rect x="10" y="138" width="280" height="38" rx="6"/><rect x="10" y="202" width="280" height="38" rx="6"/><rect x="10" y="252" width="280" height="38" rx="6"/></g>
<g stroke="var(--review-muted)"><line x1="150" y1="48" x2="150" y2="74"/></g>
<g stroke="var(--review-success)"><line x1="150" y1="112" x2="150" y2="138"/><line x1="150" y1="176" x2="150" y2="202"/><line x1="150" y1="240" x2="150" y2="252"/></g>
<g fill="var(--review-fg)" font-size="12"><text x="20" y="34">Connection.gatherCandidates()</text><text x="20" y="98">queryServerReflexiveCandidate()（reject）</text><text x="20" y="162">classifyGatherError → 300-699 / 701</text><text x="20" y="226">onIceCandidateError / onIceServerReached</text><text x="20" y="276" fill="var(--review-success)">RTCPeerConnection: URL ごとに配送</text></g>
</svg></div>
</div>

<div style="font-family:var(--review-font);font-size:12px;color:var(--review-muted);margin-top:6px">凡例: 赤枠は理由が失われる経路、緑枠は今回追加した経路、灰枠は変わらない部分。左右とも同じ gathering の起点から描いています。</div>

修正前は ICE 層で失敗理由が捨てられていました。修正後は失敗を分類して ICE 層から通知し、`RTCPeerConnection` が URL 単位でまとめて配送します。分類は [packages/ice/src/candidateError.ts:270](review-file:packages/ice/src/candidateError.ts:270)、ICE 層の通知の入口は [packages/ice/src/ice.ts:1151](review-file:packages/ice/src/ice.ts:1151)、配送は [packages/webrtc/src/peerConnection.ts:587](review-file:packages/webrtc/src/peerConnection.ts:587) です。

### 3.2 701（サーバー未到達）の判定

レビューの往復の大半はこの判定の粒度でした。W3C は 701 を「どの host candidate からもサーバーに届かないとき、gathering 中に URL ごとに 1 回」と定めています。下の図は、同じ入力（`bundlePolicy: "disable"` の 2 transport、IPv4 と IPv6 のソケット、応答しない STUN サーバー 1 つ）での判定を比べたものです。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-family:var(--review-font);font-size:12px;color:var(--review-fg)">
<div style="border:1px solid var(--review-border);border-top:4px solid var(--review-danger);border-radius:8px;padding:10px;background:var(--review-surface)">
<b style="color:var(--review-danger)">Before（失敗のたびに即時判定）</b>
<svg viewBox="0 0 300 250" width="100%" role="img" aria-label="Before: ソケットや transport ごとに 701 が出る、または止まる">
<g fill="none" stroke="var(--review-border)"><rect x="10" y="10" width="130" height="34" rx="6"/><rect x="160" y="10" width="130" height="34" rx="6"/></g>
<g fill="var(--review-fg)" font-size="11"><text x="20" y="31">transport A: IPv4 失敗</text><text x="170" y="31">transport B: IPv4 失敗</text></g>
<g stroke="var(--review-danger)"><line x1="75" y1="44" x2="75" y2="80"/><line x1="225" y1="44" x2="225" y2="80"/></g>
<g fill="none" stroke="var(--review-danger)"><rect x="10" y="80" width="130" height="34" rx="6"/><rect x="160" y="80" width="130" height="34" rx="6"/></g>
<g fill="var(--review-danger)" font-size="11"><text x="20" y="101">701 を即時に発火</text><text x="170" y="101">同じ URL の 701 を再発火</text></g>
<g fill="none" stroke="var(--review-danger)" stroke-dasharray="4 3"><rect x="10" y="140" width="280" height="40" rx="6"/></g>
<g fill="var(--review-fg)" font-size="11"><text x="20" y="157">IPv6 ソケットは問い合わせないのに待ち数に入る</text><text x="20" y="173" fill="var(--review-danger)">→ 待ちが残り、701 が出ないことがある</text></g>
<g fill="none" stroke="var(--review-danger)" stroke-dasharray="4 3"><rect x="10" y="196" width="280" height="40" rx="6"/></g>
<g fill="var(--review-fg)" font-size="11"><text x="20" y="213">別のソケットが届いていても考慮しない</text><text x="20" y="229" fill="var(--review-danger)">→ 到達できるサーバーに 701 を誤報</text></g>
</svg></div>
<div style="border:1px solid var(--review-border);border-top:4px solid var(--review-success);border-radius:8px;padding:10px;background:var(--review-surface)">
<b style="color:var(--review-success)">After（記録して gathering 終了時に 1 回判定）</b>
<svg viewBox="0 0 300 250" width="100%" role="img" aria-label="After: 記録して gathering を抜ける直前に URL ごとに 1 回判定">
<g fill="none" stroke="var(--review-border)"><rect x="10" y="10" width="130" height="34" rx="6"/><rect x="160" y="10" width="130" height="34" rx="6"/></g>
<g fill="var(--review-fg)" font-size="11"><text x="20" y="31">transport A: IPv4 失敗</text><text x="170" y="31">transport B: IPv4 失敗</text></g>
<g stroke="var(--review-success)"><line x1="75" y1="44" x2="75" y2="80"/><line x1="225" y1="44" x2="225" y2="80"/></g>
<g fill="none" stroke="var(--review-success)"><rect x="10" y="80" width="280" height="40" rx="6"/></g>
<g fill="var(--review-fg)" font-size="11"><text x="20" y="97">ICE 層: 全ソケットの経路が確定したら 701 を 1 件</text><text x="20" y="113">IPv6・開けなかったソケットは「試していない」で確定</text></g>
<g stroke="var(--review-success)"><line x1="150" y1="120" x2="150" y2="140"/></g>
<g fill="none" stroke="var(--review-success)"><rect x="10" y="140" width="280" height="40" rx="6"/></g>
<g fill="var(--review-fg)" font-size="11"><text x="20" y="157">gatheringServerOutcomes に URL ごとに記録</text><text x="20" y="173">（到達した transport / 届かなかった transport）</text></g>
<g stroke="var(--review-success)"><line x1="150" y1="180" x2="150" y2="196"/></g>
<g fill="none" stroke="var(--review-success)"><rect x="10" y="196" width="280" height="40" rx="6"/></g>
<g fill="var(--review-fg)" font-size="11"><text x="20" y="213">"gathering" を抜ける直前に judgeUnreachableServers</text><text x="20" y="229" fill="var(--review-success)">→ 誰も届かなかった URL に 701 を 1 件</text></g>
</svg></div>
</div>

<div style="font-family:var(--review-font);font-size:12px;color:var(--review-muted);margin-top:6px">凡例: 赤は誤報・重複・欠落が起きる箇所、緑は今回の判定、点線は起こりうる不具合。左右とも同じ入力から描いています。</div>

下のステップ送りでは、同じ状況を 1 段階ずつ進め、各段階で修正前と修正後の状態を並べています。状況は、2 つの transport のうち A が先に失敗し、B は結果を出す前に閉じられる、というものです。

<style>
.ice701-steps{font-family:var(--review-font);font-size:12px;color:var(--review-fg);border:1px solid var(--review-border);border-radius:8px;padding:10px;background:var(--review-surface)}
.ice701-steps .bar{display:flex;gap:8px;align-items:center;margin-bottom:8px}
.ice701-steps button{border:1px solid var(--review-border);background:var(--review-bg);color:var(--review-fg);padding:2px 10px;border-radius:4px;cursor:pointer}
.ice701-steps .cols{display:grid;grid-template-columns:1fr 1fr;gap:10px}
.ice701-steps .col{border:1px solid var(--review-border);border-radius:6px;padding:8px;min-height:84px}
.ice701-steps .col.before{border-top:3px solid var(--review-danger)}
.ice701-steps .col.after{border-top:3px solid var(--review-success)}
.ice701-steps .bad{color:var(--review-danger);font-weight:bold}
.ice701-steps .good{color:var(--review-success);font-weight:bold}
.ice701-steps .muted{color:var(--review-muted)}
.ice701-steps code{font-family:var(--review-mono)}
</style>
<div class="ice701-steps" id="ice701-steps">
<div class="bar"><button type="button" id="ice701-prev">前へ</button><button type="button" id="ice701-next">次へ</button><span id="ice701-label"></span></div>
<div class="cols"><div class="col before"><b>Before</b><div id="ice701-before"></div></div><div class="col after"><b>After</b><div id="ice701-after"></div></div></div>
</div>
<script>
(function(){
  var steps=[
    {t:"1/5 iceGatheringState が gathering に入る",b:"記録なし。失敗が届くたびに判定する。",a:"<code>gatheringServerOutcomes</code> を空にして記録を始める。"},
    {t:"2/5 transport A が 701（IPv4 ソケットはすべて届かない）",b:"A の失敗の時点で判定。B は未確定なので、<span class='bad'>701 を保留</span>する。",a:"URL の「届かなかった transport」に A を記録する。<span class='muted'>まだ発火しない。</span>"},
    {t:"3/5 transport B が結果を出す前に閉じられる",b:"B の記録は残らないが、<span class='bad'>再判定されない</span>。",a:"B は判定対象から外れる（closed）。gathering は B の分も <code>complete</code> で終わる。"},
    {t:"4/5 iceGatheringState が gathering を抜ける直前",b:"何も起きない。",a:"<code>judgeUnreachableServers</code> を 1 回だけ実行する。残っている A は届かず、到達の記録もない。"},
    {t:"5/5 結果",b:"<span class='bad'>701 は発火しない</span>（アプリは障害を知れない）。",a:"<span class='good'>URL に 701 を 1 件発火</span>する。ハンドラー内の <code>iceGatheringState</code> は <code>gathering</code>。その後で <code>complete</code> を通知する。"}
  ];
  var i=0;
  var label=document.getElementById("ice701-label"),before=document.getElementById("ice701-before"),after=document.getElementById("ice701-after");
  function render(){label.textContent=steps[i].t;before.innerHTML=steps[i].b;after.innerHTML=steps[i].a;}
  document.getElementById("ice701-prev").addEventListener("click",function(){i=Math.max(0,i-1);render();});
  document.getElementById("ice701-next").addEventListener("click",function(){i=Math.min(steps.length-1,i+1);render();});
  render();
})();
</script>

この流れは、[packages/webrtc/tests/transport/iceCandidateError.test.ts](review-file:packages/webrtc/tests/transport/iceCandidateError.test.ts) の「gathering 中に結果を出さずに抜けた transport は、他の transport の 701 を妨げない」で確認しています。修正前のコードでは、このテストは失敗します。

ICE 層は、サーバーごとに「経路（再利用ソケット、新しいソケット、wildcard ソケット）」を設定時に数え、各経路が必ず 1 回ずつ確定させます。問い合わせない経路は「試していない」として確定し、判定を止めません。新しいソケットの経路は、ソケットが開く前に登録します（[packages/ice/src/ice.ts:1940](review-file:packages/ice/src/ice.ts:1940)）。経路の登録と確定は [packages/ice/src/ice.ts:1703](review-file:packages/ice/src/ice.ts:1703) の `settlingStunServers` で、全経路が終わっても待ちが残ったサーバーは [packages/ice/src/ice.ts:1725](review-file:packages/ice/src/ice.ts:1725) の保険で判定します。

`RTCPeerConnection` は、URL ごとに「到達した transport」と「試して届かなかった transport」を [packages/webrtc/src/peerConnection.ts:196](review-file:packages/webrtc/src/peerConnection.ts:196) に記録するだけです。`iceGatheringState` が `"gathering"` を抜ける直前に [packages/webrtc/src/peerConnection.ts:543](review-file:packages/webrtc/src/peerConnection.ts:543) で 1 回だけ判定します。判定に使うのは、その時点で使われている transport と、記録したときと同じ ICE 世代の記録だけです。途中で閉じた transport、URL を試さなかった transport、ICE restart で置き換えられた世代は判定に影響しません。

## 4. 主要変更

### 4.1 失敗の分類と errorText（`packages/ice`）

- [packages/ice/src/candidateError.ts:270](review-diff:packages/ice/src/candidateError.ts:270) `classifyGatherError()`: サーバーの error 応答は 300-699 のコード、届かなかった失敗（DNS、タイムアウト、接続失敗、ソケットエラー）は 701 です。
- [packages/ice/src/candidateError.ts:241](review-diff:packages/ice/src/candidateError.ts:241) `isServerAnswer()`: ERROR-CODE のないエラー応答、MESSAGE-INTEGRITY 不一致、XOR-MAPPED-ADDRESS のない成功応答は「到達した」とします。701 にせず、通知もしません。
- [packages/ice/src/candidateError.ts:200](review-diff:packages/ice/src/candidateError.ts:200) `gatherErrorReasonText()`: サーバーの理由句をそのまま使い、TURN の username / password と、応答の USERNAME / REALM / NONCE を `***` に置き換えます。制御文字を除き、127 文字で切ります。
- [packages/ice/src/ice.ts:1179](review-diff:packages/ice/src/ice.ts:1179) `emitServerReached()`: サーバーが応答したことを `onIceServerReached` で知らせます。webrtc 層の 701 判定に使います。
- [packages/ice/src/ice.ts:2152](review-diff:packages/ice/src/ice.ts:2152) TURN の UDP 割り当てと TCP フォールバックは 1 つの失敗として扱います。どちらかで応答があれば 701 にしません。
- [packages/ice/src/iceBase.ts:591](review-diff:packages/ice/src/iceBase.ts:591) `queryServerReflexiveCandidate()` は理由付きで reject します。既存の `serverReflexiveCandidate()` は従来どおり `undefined` を返します。

### 4.2 集約と配送（`packages/webrtc`）

- [packages/webrtc/src/transport/ice.ts:1142](review-diff:packages/webrtc/src/transport/ice.ts:1142) `iceCandidateErrorDetails()`: URL ごとにイベントの中身を作ります。TURN と `iceTransportPolicy: "relay"` では `address` も `port` も `null` です（[packages/webrtc/src/transport/ice.ts:1150](review-diff:packages/webrtc/src/transport/ice.ts:1150)）。
- [packages/webrtc/src/peerConnection.ts:500](review-diff:packages/webrtc/src/peerConnection.ts:500) 701 の配送中は、`iceGatheringState` が `"gathering"` を返します。`"complete"` は、その後の `icegatheringstatechange` から見えます。
- [packages/webrtc/src/peerConnection.ts:587](review-diff:packages/webrtc/src/peerConnection.ts:587) `dispatchIceCandidateError()`: 配送の順は `pc.onIceCandidateError`、`onicecandidateerror`、リスナーです。DOM の配送に合わせています。
  - `target` / `currentTarget` / `eventPhase` を設定し、`isTrusted` は `true` です（[packages/webrtc/src/peerConnection.ts:610](review-diff:packages/webrtc/src/peerConnection.ts:610)）。
  - `stopImmediatePropagation()` は、`pc.onIceCandidateError` の購読者の間でも後続を止めます（[packages/webrtc/src/peerConnection.ts:635](review-diff:packages/webrtc/src/peerConnection.ts:635)）。
  - 配送中に削除されたリスナーは呼びません。配送中に追加されたリスナーは次のイベントから呼ばれます。
  - ハンドラが throw しても、他のハンドラには届きます。
  - ハンドラが `close()` したら、残りの 701 も `icegatheringstatechange` も出しません。
- [packages/webrtc/src/transport/ice.ts:1070](review-diff:packages/webrtc/src/transport/ice.ts:1070) gathering 中に閉じた transport は、`"gathering"` に留まらず `"complete"` で終わります。こうしないと集約状態が終わらず、701 の判定もされませんでした。

### 4.3 公開 API・WPT・ドキュメント

- [packages/webrtc/src/api/peerConnectionEvents.ts:102](review-diff:packages/webrtc/src/api/peerConnectionEvents.ts:102) `RTCPeerConnectionIceErrorEvent`: 標準の `Event` を継承します。`werift/polyfill` でグローバルにも登録します。
- [packages/common/src/event.ts:83](review-diff:packages/common/src/event.ts:83) `Event.executeUntil()`: 購読者ごとに停止を確認し、例外は `onError` に渡して続けます。他の `Event` 利用箇所の挙動は変えません。
- [packages/webrtc/tools/wpt-runner/runner.ts:706](review-diff:packages/webrtc/tools/wpt-runner/runner.ts:706) WPT ランナーのラッパーで、`port` が `null` のときだけ `0` を見せます。ブラウザーに既定 STUN がないことに合わせ、`iceUseDefaultStunServer: false` で接続を作ります。
- [packages/webrtc/wpt/allowlist.json:23](review-diff:packages/webrtc/wpt/allowlist.json:23) に `RTCPeerConnection-onicecandidateerror.https.html` の 2 サブテストを追加しました。`baseline.json` も更新しています。
- [changelog.md](review-diff:changelog.md)、[packages/webrtc/README.md](review-diff:packages/webrtc/README.md)、生成 doc（`npm run doc`）を更新しました。

### 4.4 テスト

- ICE 層: [packages/ice/tests/ice/candidate-error.test.ts](review-file:packages/ice/tests/ice/candidate-error.test.ts)。共通の Arrange は [packages/ice/tests/ice/candidateErrorUtils.ts](review-file:packages/ice/tests/ice/candidateErrorUtils.ts) にあります。
  - DNS とタイムアウトの競合は注入で制御します。失敗をすぐ返す場合は [packages/ice/tests/ice/candidateErrorUtils.ts:218](review-file:packages/ice/tests/ice/candidateErrorUtils.ts:218)、返らない場合は [packages/ice/tests/ice/candidateErrorUtils.ts:234](review-file:packages/ice/tests/ice/candidateErrorUtils.ts:234) を使います。
  - IPv6 のソケットや開けなかったソケットがある場合も確認しています（[packages/ice/tests/ice/candidateErrorUtils.ts:208](review-file:packages/ice/tests/ice/candidateErrorUtils.ts:208)）。
- webrtc 層: [packages/webrtc/tests/transport/iceCandidateError.test.ts](review-file:packages/webrtc/tests/transport/iceCandidateError.test.ts)。複数 transport、途中参加・途中離脱、ICE restart、close、DOM の配送を確認します。
- common: [packages/common/tests/event.test.ts](review-file:packages/common/tests/event.test.ts) に `executeUntil` のテストを追加しました。

## 5. 判断理由

| 判断 | 理由 |
| --- | --- |
| 701 は記録して gathering 終了時に 1 回だけ判定する | W3C は 701 を「どの host candidate も届かないとき、URL ごとに 1 回」と定めています。失敗が届くたびに判定する方式は、粒度を広げるたびに新しい穴（重複、誤報、通知の欠落）を生みました。 |
| 300-699 は即時・ソケット単位で発火する | サーバーが応答しているので、そのソケットについて確定した事実です。 |
| 応答はあったが STUN エラーコードがない場合は通知しない | 到達しているので 701 は誤りです。報告できるエラーコードもありません。 |
| `port` は仕様どおり `null`、WPT だけ `0` | 上流 WPT は Chrome の `port: 0` を前提にした非規範的な書き方です。WPT 専用の挙動はランナーに閉じ込めます（AGENTS.md Do 5）。チケット決定 6 で押し返す方針を取りましたが通らず、ユーザーの承認を得て仕様側に改訂しました。 |
| `errorText` はサーバーの理由句を伏せ字付きで渡す | 仕様はサーバーの理由テキストを求めます。固定文言にすると診断情報（例: `Missing fingerprint`）が失われます。既知の資格情報だけを伏せることで、診断情報と資格情報の保護を両立させました。 |
| `serverReflexiveCandidate()` は変えず、reject する関数を別に追加する | 既存の呼び出し元の互換性を保つためです。 |
| 既定 STUN の失敗は合成 URL `stun:stun.l.google.com:19302` で通知する | 設定にない werift 独自のサーバーも、アプリから失敗が見えるようにするためです。 |

## 6. リスク・確認してほしい点

- **公開 API が増えます。**
  - `werift`: `RTCPeerConnectionIceErrorEvent`、`canonicalIceServerUrl()`、`parseIceServers()` の戻り値の追加分です。
  - `werift-ice`: `onIceCandidateError` / `onIceServerReached`、`queryServerReflexiveCandidate()`、`isServerAnswer()`、`gatherErrorReasonText()` などです。
  - `werift-common`: `Event.executeUntil()` です。
  - `onicecandidateerror` の型が `any` から `RTCPeerConnectionIceErrorEvent` に変わるため、型を緩く扱っていた利用側で型エラーが出る可能性があります。
- **既存の挙動が 1 つ変わります。** gathering 中に閉じた ICE transport は `"complete"` で終わります（4.2 節）。
- **701 の通知は gathering の終了まで遅れます。** `stunGatherTimeout` と TURN の接続タイムアウトがあるので、gathering は必ず終わります。
- **未対応の可能性: バックグラウンドで続く問い合わせ。** develop から取り込んだ実装では、既定経路でないソケットの問い合わせをバックグラウンドで続けます。gathering が先に終わると、その 701 は `RTCPeerConnection` の判定に間に合わない可能性があります。複数インターフェースの環境が必要なため、再現・対応はしていません。
- **既存の不安定なテスト。**
  - `packages/webrtc/tests/transport/dtlsAlert.test.ts` の「handshake 中の stop()」は、develop でもファイル単位の実行で 8 回中 2 回失敗しました。この変更とは無関係と判断しています。
  - TURN close の leak テスト（`negotiationLeakProperty.test.ts` の「closing 5 after a TURN gathering started」、`GetAddrInfoReqWrap +1`）は、今回の検証で 1 回再現しました。
  - 原因は、develop から取り込んだ既定経路の probe（[packages/ice/src/internal/defaultRoute.ts:66](review-file:packages/ice/src/internal/defaultRoute.ts:66)）と見ています。relay のみの peer でも、既定 STUN `stun.l.google.com` の名前を IPv4 / IPv6 で解決します。`close()` は解決中の lookup を取り消せません。全体実行で libuv のスレッドプールが混むと、lookup が leak 判定の 2 秒を超えて残ります。
  - 単独では lookup は約 6 ms で終わり、テストも通ります。この変更は probe にも relay のみの経路にも手を入れていません。
  - 対応案は、relay のみの gathering では probe を省く（STUN を使わないため）ことですが、今回は実施していません。
- **差分の大部分は生成 doc です。** 手で読むべきなのは `packages/ice/src`、`packages/webrtc/src`、`packages/common/src/event.ts`、`packages/webrtc/tools/wpt-runner/runner.ts` です。

## 7. 検証結果

この解説の更新時（HEAD `10cf5016e`。コードは `d418e57d9` と同じ）に、次を実行しました。

| 対象 | 結果 |
| --- | --- |
| `npm run type` | 成功（エラーなし） |
| `packages/common` の全テスト | 77 件すべて成功 |
| `packages/ice` の全テスト | 498 件成功、5 件スキップ |
| `packages/webrtc` の全テスト | 1874 件成功、1 件失敗、5 件スキップ。失敗は 6 章の TURN close leak（`GetAddrInfoReqWrap +1`） |

この更新では実行していないもの（直前のレビュー対応で実行した結果です）:

- `npm run wpt`: 終了コード 0、回帰なし。`RTCPeerConnection-onicecandidateerror` は 2/2、`RTCPeerConnectionIceErrorEvent` は 1/1 で成功しました。
- `npm run test:small`: 2 回とも終了コード 0 でした。
- `npm run wpt:coverage`: 回帰なしでした。

ブラウザーとの相互接続試験は実施していません。
