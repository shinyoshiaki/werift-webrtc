---
ide:
  viewer: review-document
  version: 1
  title: "SCTP キュー O(N²) 解消のレビュー解説"
  dock: right
  baseCommit: 792fa4e65e7866a5f85fba514815a147fba9dde0
---
# SCTP キュー O(N²) 解消のレビュー解説

## 1. 概要

DataChannel で大量のメッセージを一気に `send()` すると、時間が件数の **2乗** で伸び、イベントループが数秒止まって ICE consent を失う問題を直しました。

結論: 主因は `Array.shift()` ではなく **`SCTP.send()` の待ち方**でした。キューの置換だけの試作では N=2000 で 13.7 s（元 12.0 s）とほぼ改善せず、待ち方の変更が効いています。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>N 件の send() が全員 <code>flush</code> イベントを待つ<br>→ 1回の transmit で N 人を起こし、各自 O(N) で解除<br><strong>合計 O(N²)</strong>
  </div>
  <div style="flex:1;min-width:220px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>各 send() は「自分の最後のチャンクが送られた時」だけ解決<br>待ち行列の先頭だけを O(1) で解決<br><strong>合計 O(N)</strong>
  </div>
</div>

## 2. 計測結果（1 KB メッセージ、in-memory SCTP ペア）

<style>
  .bm-row{display:flex;align-items:center;gap:8px;margin:4px 0;font-size:13px;color:var(--review-fg)}
  .bm-label{width:150px;color:var(--review-muted)}
  .bm-track{flex:1;background:var(--review-surface);border:1px solid var(--review-border);border-radius:4px;height:16px}
  .bm-bar{height:100%;border-radius:3px}
  .bm-val{width:90px;text-align:right}
</style>
<div id="bm-chart">
  <div class="bm-row"><span class="bm-label">N=1,000 Before</span><div class="bm-track"><div class="bm-bar" style="width:0.55%;min-width:2px;background:var(--review-danger)"></div></div><span class="bm-val">1.4 s</span></div>
  <div class="bm-row"><span class="bm-label">N=1,000 After</span><div class="bm-track"><div class="bm-bar" style="width:0.1%;min-width:2px;background:var(--review-success)"></div></div><span class="bm-val">24 ms</span></div>
  <div class="bm-row"><span class="bm-label">N=2,000 Before</span><div class="bm-track"><div class="bm-bar" style="width:4.7%;background:var(--review-danger)"></div></div><span class="bm-val">12.0 s</span></div>
  <div class="bm-row"><span class="bm-label">N=5,000 Before</span><div class="bm-track"><div class="bm-bar" style="width:100%;background:var(--review-danger)"></div></div><span class="bm-val">256.7 s</span></div>
  <div class="bm-row"><span class="bm-label">N=5,000 After</span><div class="bm-track"><div class="bm-bar" style="width:0.1%;min-width:2px;background:var(--review-success)"></div></div><span class="bm-val">108 ms</span></div>
  <div class="bm-row"><span class="bm-label">N=20,000 After</span><div class="bm-track"><div class="bm-bar" style="width:0.16%;min-width:2px;background:var(--review-success)"></div></div><span class="bm-val">414 ms</span></div>
</div>

(棒は 256.7 s を 100% とした相対長。After は幅が極小のため最小幅で描画)

| N | Before: 時間 / 最大イベントループ停止 | After: 時間 / 最大停止 |
|---|---|---|
| 1,000 | 1.4 s / 656 ms | 24 ms / 1 ms |
| 2,000 | 12.0 s / 6.8 s | – |
| 5,000 | 256.7 s / 69.0 s | 108 ms / 19 ms |
| 20,000 | – | 414 ms / 15 ms |

Before は revision 07550100 を別 worktree で計測した値です。ベンチ: [packages/sctp/tests/bench/burstTransfer.ts](review-file:packages/sctp/tests/bench/burstTransfer.ts)（vitest 対象外）。

## 3. 主要変更

### 3.1 `FifoQueue`（common）

配列 + 先頭インデックス + 遅延コンパクションで `shift()` を償却 O(1) にしました。走査中に要素が shift されても壊れません。

[packages/common/src/queue.ts:9](review-file:packages/common/src/queue.ts:9) クラス本体、[packages/common/src/queue.ts:31](review-diff:packages/common/src/queue.ts:31) `shift()`、[packages/common/src/queue.ts:123](review-file:packages/common/src/queue.ts:123) `compact()`。`werift-common` から export、`werift-sctp` から再 export しています（[packages/sctp/src/index.ts](review-diff:packages/sctp/src/index.ts)）。

### 3.2 SCTP `send()` の完了待ち（sctp）

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:260px;padding:8px 12px;border:1px solid var(--review-border);border-radius:6px">
    <strong>send() の流れ（After）</strong>
    <ol style="margin:6px 0 0 18px;padding:0">
      <li>チャンクを <code>outboundQueue</code> へ push</li>
      <li>最後のチャンクを <code>sendWaiters</code> に登録</li>
      <li><code>transmit()</code> が outbound → sent へ移すたび、先頭 waiter だけ確認して resolve</li>
      <li>association が close したら残り waiter を全部 resolve</li>
    </ol>
  </div>
</div>

- 待ち登録: [packages/sctp/src/sctp.ts:933](review-diff:packages/sctp/src/sctp.ts:933)
- O(1) 解決: [packages/sctp/src/sctp.ts:947](review-diff:packages/sctp/src/sctp.ts:947)（送信側は [:1041](review-diff:packages/sctp/src/sctp.ts:1041)）
- close 時の解放: [packages/sctp/src/sctp.ts:954](review-diff:packages/sctp/src/sctp.ts:954)（呼び出しは [:1470](review-file:packages/sctp/src/sctp.ts:1470)）
- `sentQueue` / `outboundQueue` を `FifoQueue` 化: [packages/sctp/src/sctp.ts:174](review-diff:packages/sctp/src/sctp.ts:174)

輻輳制御・再送・abandon のロジックは変更していません。

### 3.3 DataChannel 層（webrtc）

[packages/webrtc/src/transport/sctp.ts:298](review-diff:packages/webrtc/src/transport/sctp.ts:298) `dataChannelFlush()` は、キュー内の全メッセージを **1回の同期ループ**で SCTP に渡します（`send()` ごとに並行ループを起こさない）。`bufferedAmount` はメッセージ単位で減るので、バースト中も `bufferedamountlow` が発火します。

### 3.4 stop() / 再接続の扱い（レビュー指摘への対応）

<div id="stop-tabs" class="stp">
<style>
  .stp button{border:1px solid var(--review-border);background:var(--review-surface);color:var(--review-fg);padding:2px 10px;cursor:pointer}
  .stp button[aria-selected="true"]{border-color:var(--review-accent);color:var(--review-accent)}
  .stp [role=tabpanel]{padding:8px 0;color:var(--review-fg);font-size:13px}
</style>
<button role="tab" aria-selected="true" data-p="a">stop() 時</button>
<button role="tab" aria-selected="false" data-p="b">再接続後の flush</button>
<div role="tabpanel" data-p="a">未送信のユーザーメッセージは破棄し <code>bufferedAmount</code> から減算。DATA_CHANNEL_OPEN は<strong>生きているチャネルのものだけ</strong>残す（rollback で残るチャネルを開けるため）。古い ACK は破棄。</div>
<div role="tabpanel" data-p="b" hidden>キューに残った項目のチャネルが <code>closed</code>/<code>closing</code> なら送らず破棄（ユーザーメッセージ分は <code>bufferedAmount</code> 減算）。閉じたチャネルの OPEN が相手に届いて不要なチャネルが開く事故を防ぐ。</div>
<script>
document.querySelectorAll("#stop-tabs [role=tab]").forEach(function(t){t.addEventListener("click",function(){
document.querySelectorAll("#stop-tabs [role=tab]").forEach(function(x){x.setAttribute("aria-selected",String(x===t))});
document.querySelectorAll("#stop-tabs [role=tabpanel]").forEach(function(p){p.hidden=p.dataset.p!==t.dataset.p});});});
</script>
</div>

- [packages/webrtc/src/transport/sctp.ts:421](review-diff:packages/webrtc/src/transport/sctp.ts:421) `stop()`、[:433](review-file:packages/webrtc/src/transport/sctp.ts:433) `discardUnsentMessages()`
- [packages/webrtc/src/transport/sctp.ts:320](review-file:packages/webrtc/src/transport/sctp.ts:320) flush 時のガード

## 4. 判断理由

- **待ち方を直した**: 計測で支配項が `flush` waiter の全員起床と判明したため。キュー置換だけでは効果がない（13.7 s vs 12.0 s）。
- **`outboundQueue` は互換層なしの破壊的変更**: 配列互換を残すと O(N) 操作が紛れ込むため。[changelog.md](review-diff:changelog.md) の Unreleased に移行手順を記載。
- **stop() で DataChannel キューを丸ごと消さない**: 全消去すると negotiation の rollback テスト（DataChannel が残る）が壊れるため、OPEN のみ条件付きで残す。

## 5. リスク・注意点

- `SCTP.outboundQueue` の型変更は **breaking**（外部が配列として触っていると壊れる）。
- close 時に未送信分が `bufferedAmount` から引かれる挙動に変わった（従来は `send()` が解決せず残り続けた）。
- 時間比テストは環境差で揺れ得る。[packages/common/tests/queue.test.ts:68](review-file:packages/common/tests/queue.test.ts:68) は 5 回の最小値・16倍サイズ差・閾値 64（線形≈16、二次≈256）に変更済み。SCTP 側の比テストも同系統なので CI で揺れた場合は注意。
- 再接続後に association が確立してからの「別メッセージ送信」までは網羅していない（確立後の OPEN 非送信は検証済み）。

## 6. テスト

| 対象 | 内容 |
|---|---|
| [packages/common/tests/queue.test.ts](review-file:packages/common/tests/queue.test.ts) | 順序、コンパクション後の index、走査中 shift、線形性 |
| [packages/sctp/tests/burst.test.ts:14](review-file:packages/sctp/tests/burst.test.ts:14) | 断片化メッセージの順序保持、N vs 4N 時間比、イベントループ stall、パケットロス（[:66](review-file:packages/sctp/tests/burst.test.ts:66)）、個別解決（[:88](review-file:packages/sctp/tests/burst.test.ts:88)）、stop 時に settle（[:113](review-file:packages/sctp/tests/burst.test.ts:113)） |
| [packages/webrtc/tests/datachannel/burst.test.ts:10](review-file:packages/webrtc/tests/datachannel/burst.test.ts:10) | 20 MB バースト、`bufferedAmount`→0、`bufferedamountlow`、接続維持 |
| [packages/webrtc/tests/transport/sctp.test.ts:19](review-file:packages/webrtc/tests/transport/sctp.test.ts:19) / [:52](review-file:packages/webrtc/tests/transport/sctp.test.ts:52) | stop で破棄・`bufferedAmount` 解放、再接続で closed チャネルを通知しない |

## 7. 検証結果（これまでの報告ベース）

- `npm run type`、`npm run test:small`、WPT（`REGRESSION 0`）は初回実装時に成功。common 33 件、SCTP 59 件成功。
- WebRTC 全体: 793 件成功・3 skip。失敗は変更外の `negotiationTransactionCoverageTransport.test.ts` の空スイート2件のみで、変更前 07550100 でも発生。
- 直近の修正（時間比テスト）後は common/SCTP のみ再実行。WebRTC 全体・WPT・フル E2E・`npm run memleak` は **再実行/実施していません**。
- この文書作成にあたり、コードの再実行は行っていません（文書のみの変更）。
- 補足: 現 HEAD の `git diff 07550100..HEAD` では、上記の空スイート定義（`describeCases(..., () => {})` のループ）は既に削除されています。HEAD 上で失敗が解消しているかは今回確認していません。
