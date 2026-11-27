---
ide:
  viewer: review-document
  version: 1
  title: "レビュー解説: 接続確認中の再交渉で ICE ロールが決め直される不具合の修正"
  dock: right
  baseCommit: 576dcc7f29ea69b8391df7697ad21036738aaf0d
---
# レビュー解説: 接続確認の途中の再交渉で ICE ロールが決め直される不具合の修正

## 1. 概要

`Connection.iceControlling` setter は、その generation の接続確認（checks）が始まった後は offer/answer によるロール指定を無視するようになりました。以前に無視したのは pair の選択後だけでした。そのため、checks の途中に ICE restart のない再交渉が入るとロールが付け替わり、どちらの peer も nominate せず、model property の seed 275 が「the transport did not settle」で失敗することがありました。

実行されるコードの変更は、[packages/ice/src/ice.ts:662](review-diff:packages/ice/src/ice.ts:commit:576dcc7f2:662) の条件 1 行です。残りはコメント、テストとその共通 Arrange、既知 flake の記述、changelog、チケットの作業記録です。

## 2. 修正前の問題と修正後の流れ

次の図は、同じ操作を修正前後で比べたものです。a は初回の offerer、b は初回の answerer です。操作は、初回の checks 中に b が ICE restart なしで再 offer し、a が answer する流れです。

<style>
.rl73 { font-family: var(--review-font); color: var(--review-fg); font-size: 13px; }
.rl73 .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
.rl73 .col { display: flex; flex-direction: column; gap: 4px; }
.rl73 .box { border: 1px solid var(--review-border); border-radius: 6px; padding: 6px 10px; background: var(--review-surface); min-height: 54px; }
.rl73 .bad { border: 2px solid var(--review-danger); }
.rl73 .good { border: 2px solid var(--review-success); }
.rl73 .arrow { text-align: center; color: var(--review-muted); line-height: 1; }
.rl73 code { font-family: var(--review-mono); }
.rl73 .legend { color: var(--review-muted); margin-top: 8px; }
</style>
<div class="rl73">
<div class="cols">
<div class="col">
<strong>Before</strong>
<div class="box">初回 offer / answer<br>a = controlling、b = controlled</div>
<div class="arrow">↓</div>
<div class="box"><code>connect()</code> → <code>checksBegun = true</code><br>nominate はまだ</div>
<div class="arrow">↓</div>
<div class="box bad">✕ b の <code>setLocalDescription(offer)</code><br><code>setLocalRole</code> → setter が b を controlling に変更（両者 controlling）</div>
<div class="arrow">↓</div>
<div class="box bad">✕ a の <code>setLocalDescription(answer)</code><br>setter が a を controlled に指定。role conflict の修復 <code>switchRole</code> とも重なり、ロールが入れ替わる</div>
<div class="arrow">↓</div>
<div class="box bad">✕ 誰も nominate しない状態が残る<br>ICE = <code>checking</code>、a の DTLS = <code>new</code></div>
</div>
<div class="col">
<strong>After</strong>
<div class="box">初回 offer / answer<br>a = controlling、b = controlled</div>
<div class="arrow">↓</div>
<div class="box"><code>connect()</code> → <code>checksBegun = true</code><br>nominate はまだ</div>
<div class="arrow">↓</div>
<div class="box good">✓ b の <code>setLocalDescription(offer)</code><br><code>checksBegun</code> なので setter は何もしない（b = controlled）</div>
<div class="arrow">↓</div>
<div class="box good">✓ a の <code>setLocalDescription(answer)</code><br>setter は何もしない（a = controlling）</div>
<div class="arrow">↓</div>
<div class="box good">✓ a が nominate し、両者が接続する</div>
</div>
</div>
<div class="legend">赤 ✕: 問題の経路 / 緑 ✓: 修正で変わった経路 / 枠なし: 変更なし。Before の後半 2 段は、チケットの計測記録を要約したもので、実際の順序はタイミングで変わる。</div>
</div>

ポイントは次の 3 点です。

- `SecureTransportManager.setLocalRole` は、`setLocalDescription` のたびに offer なら controlling、answer なら controlled を指定します。この呼び出し側は今回も同じで、指定を受け付けるかは ICE agent が決めます。呼び出し側の差分は [packages/webrtc/src/secureTransportManager.ts:679](review-diff:packages/webrtc/src/secureTransportManager.ts:commit:576dcc7f2:679) の TSDoc だけです。
- role conflict の修復で使う [packages/ice/src/ice.ts:2718](review-file:packages/ice/src/ice.ts:2718) の `switchRole` は、`applyIceControlling` の後に check list の並べ替えと nomination の再評価を行います。setter が呼ぶのは `applyIceControlling` だけです。checks が終わった後に setter でロールが変わると、nomination を再評価する契機がないことがあります。
- チケットに記録された失敗時の状態は、両 peer の host pair が succeeded で未 nominate、b が controlling、a が controlled というものです。

## 3. 主要変更

### ロールを固定する条件（核）

[packages/ice/src/ice.ts:662](review-diff:packages/ice/src/ice.ts:commit:576dcc7f2:662) で、早期 return の条件が `this.nominated` から `this.nominated || this.checksBegun` になりました。

次の図は、1 つの ICE generation の中で、setter がロール指定を受け付ける期間を比べたものです。

<style>
.rw73 { font-family: var(--review-font); color: var(--review-fg); font-size: 13px; }
.rw73 .row { display: grid; grid-template-columns: 60px 1fr 1fr 1fr; gap: 4px; margin-bottom: 4px; align-items: stretch; }
.rw73 .row > div { padding: 5px 8px; border: 1px solid var(--review-border); border-radius: 4px; }
.rw73 .head > div { border: none; color: var(--review-muted); font-family: var(--review-mono); }
.rw73 .ok { background: var(--review-surface); }
.rw73 .row > .bad { border: 2px solid var(--review-danger); }
.rw73 .row > .fix { border: 2px solid var(--review-success); }
.rw73 .cap { color: var(--review-muted); }
</style>
<div class="rw73">
<div class="row head"><div></div><div>restart 後〜connect() 前</div><div>connect() 後〜選択前</div><div>pair 選択後</div></div>
<div class="row"><div><strong>Before</strong></div><div class="ok">受け付ける</div><div class="bad">✕ 受け付ける</div><div class="ok">無視する</div></div>
<div class="row"><div><strong>After</strong></div><div class="ok">受け付ける</div><div class="fix">✓ 無視する</div><div class="ok">無視する</div></div>
<div class="cap">変わるのは中央の期間だけ。restart() / restartRemote() で左端の状態に戻る。switchRole はどの期間もロールを変えられる。</div>
</div>

`checksBegun` は [packages/ice/src/ice.ts:1885](review-file:packages/ice/src/ice.ts:1885) の `connect()` で true になります。[packages/ice/src/ice.ts:724](review-file:packages/ice/src/ice.ts:724) の `restart()` と [packages/ice/src/ice.ts:882](review-file:packages/ice/src/ice.ts:882) の `restartRemote()` で false に戻ります。`switchRole` は setter を通らないため、このガードの影響を受けません。

### 回帰テスト（ICE、negotiation case、model の 3 層）

1. ICE 単体: [packages/ice/tests/ice/ice.test.ts:1050](review-diff:packages/ice/tests/ice/ice.test.ts:commit:576dcc7f2:1050)。end-of-candidates を送らず、regular nomination の待ち時間中に setter を呼びます。ロールが変わらないことと、両者が同じ pair を選ぶことを確認します。
2. negotiation case: [packages/webrtc/tests/negotiation/cases/negotiationTransactionCoverageIce.test.ts:175](review-diff:packages/webrtc/tests/negotiation/cases/negotiationTransactionCoverageIce.test.ts:commit:576dcc7f2:175)。応答のない候補で checks を始めたままにし、b の再 offer と a の answer を適用します。その後に本来の候補を trickle して、接続とロールを確認します。
3. model の固定シーン: [packages/webrtc/tests/pbt/model/scenes.ts:790](review-diff:packages/webrtc/tests/pbt/model/scenes.ts:commit:576dcc7f2:790)。seed 275 の縮小後の 8 操作を固定しています。

ICE 単体テストの準備処理として、[packages/ice/tests/utils.ts:704](review-diff:packages/ice/tests/utils.ts:commit:576dcc7f2:704) で `createConnectedPair` から `startConnectingPair` を切り出しています。既定の `endOfCandidates: true` では、従来と同じ `inviteAccept` の経路を通ります。

### 記述の更新

- [packages/webrtc/tests/pbt/leak/negotiationLeakProperty.test.ts:69](review-diff:packages/webrtc/tests/pbt/leak/negotiationLeakProperty.test.ts:commit:576dcc7f2:69): 既知 flake から model seed 275 を外し、原因を記載しました。leak seed 57 は残しています。
- [changelog.md:46](review-diff:changelog.md:commit:576dcc7f2:46): Bug Fixes に追記しました。
- [チケットの作業記録](review-file:docs/tickets/TICKET-ticket-73c1d63d-d42f-489c-98e6-788096b8a08d.md:29): 再現手順、原因、検証結果を記録しています。

## 4. 判断理由

- **ICE agent 側で固定する**: 変更前の setter にも「pair 選択後は無視する」判定がありました。今回はその固定の開始点を checks の開始まで早めています。RFC 8445 §6.1.1 は、決まったロールをセッションの間維持すると定めています。この形なら `werift-ice` を直接使う場合にも同じ規則が適用されます。
- **テストの判定や時間予算は緩めない**: チケットの制約です。今回の差分では、原因を実装側で直しています。
- **leak seed 57 は別扱い**: 症状は、DTLS が connected のまま SCTP の handshake が進まないというものです。チケットでは ICE ロールとは別の原因と判断しています。HEAD での単独再生は 3/3 成功と記録されていますが、原因が解消した根拠にはなりません。

呼び出し側（`setLocalRole`）で抑止する案との比較は、差分とチケットに記録がありません。

## 5. レビュアーが確認すべき点・リスク

### 再現の根拠の強さ

- 現在の generator では、seed 275 から作られる操作列が当時と変わっています。そのため、`pbt:deep` で seed 275 が成功しても、当時の操作列を再生したことにはなりません。当時の流れは固定シーンで再生します。
- 旧 revision `1e89ac22b` の 16 並列再生では、縮小シーンが 48 回中 9 回失敗しました。このときのメッセージは「channel dc0 did not open on both peers」で、チケット表題の「the transport did not settle」とは違います。全 10 操作は 24 回中 4 回の失敗です。ガードだけを入れると 48/48 と 24/24 が成功しました。
- 修正前の HEAD では、縮小シーンが 48/48 成功しています。ICE の regular nomination の取り込み（`de54f7ce2`）で失敗する時間帯が狭まった、というのがチケットの説明です。したがって model の固定シーンだけでは、HEAD 上で修正の有無を区別できると言えません。
- 区別の根拠は、ICE 単体テスト（修正前はロールの assert を外しても接続がタイムアウト）と negotiation case（修正を外すと失敗）です。どちらもチケットの記録で、この解説の作成時には修正を外した実行をしていません。

### 挙動の互換性

- 公開 API の型や名前は変わりません。一方、`werift-ice` の利用者が `connect()` の後に `iceControlling` へ代入すると、nominate 前でも無視されます。エラーは出ません。
- 固定が始まるのは `connect()` からです。それより前の代入は従来どおり反映されます。
- checks が始まった後は、ICE restart（`restart()` / `restartRemote()`）まで固定が続きます。
- setter を通る指定には、offer/answer 以外に ICE-lite 向けの controlling 強制もあります。該当箇所は `setLocalRole` の `remoteIsLite` 分岐と、[packages/webrtc/src/negotiation/remoteMediaApplication.ts:547](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:547) です。これらも checks の開始後は無視されます。通常、相手が lite かどうかは最初の remote description で分かります。ただし、**checks の開始後に初めて lite だと分かる場合**に固有のテストは、今回の差分にはありません。この場合を想定する必要があるかを確認してください。

## 6. 検証結果

### この解説の作成時に実行したもの（HEAD `576dcc7f2`）

追加された回帰テストだけを名前で絞って実行しました。

| テスト | 結果 |
| --- | --- |
| ICE: `keeps the roles of the checks in progress` | 1 passed |
| negotiation case: `keeps the ICE roles of checks` | 1 passed |
| model 固定シーン: `keep the ICE roles` | 1 passed |

全テスト、型検査、`pbt:deep`、相互接続テストは再実行していません。

### チケットの作業記録（`892bc48a8` + 当時の未コミット差分。今回は再実行していない）

| 対象 | 結果 |
| --- | --- |
| `packages/ice`: `npm run type` / `npm test` | 成功 / 2405 passed |
| `packages/webrtc`: `npm run type` / `npm test` | 成功 / 3336 passed |
| ルート: `npm run type` / `npm run test:small` | 実行済み |
| `pbt:deep --baseline`（develop `7a5227824`） | 0 confirmed。fuzz 306、scenario 2163、model 372 は成功。leak の heap seed 2 / 4 は develop と同じ形の pre-existing |
| `pbt:deep -- --suite model` 3 回（1 回は CPU 負荷 12 プロセス + `--jobs 24`） | 各 372/372 |
| `test:interop-develop` | 161/161 |

### 最終レビューの記録（今回は再実行していない）

承認コメントには、ICE と WebRTC の型検査と全テスト、ルート型検査、ICE の deep PBT、develop との相互接続の成功が記されています。baseline 付きの WebRTC deep PBT は 0 confirmed、model 単独の 2 回は各 372/372 成功です。次の 2 点も記されています。

- 旧 revision の再現率は、独立に再測定していません。
- 実行環境が sysbox かは確認できていません（コンテナ内で反復実行しています）。完了条件の「コンテナ環境で複数回」を判断するときの参考にしてください。
