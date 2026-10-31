---
ide:
  viewer: review-document
  version: 1
  title: "[rtp][SRTP] NACK 再送 ROC 修正のレビュー解説"
  dock: right
  baseCommit: c32391aa206dd350b27df42d75c0e7685cce4920
---
# [rtp][SRTP] NACK 再送による ROC 誤更新の修正

## 概要

**結論: NACK 再送やネットワーク順不同で SRTP の ROC がずれ続ける問題を、RFC 3711 Appendix A の「パケットごとの ROC 推定」と「SSRC ごとの最高 index 確定」に分離して解消しています。**

旧実装は「直前に処理した seq」との ±100 比較で共有 ROC を直接増減していました。そのため、折り返し後の再送 1 個が後続パケット全体の ROC を +1 ずらし、受信側では認証失敗が連鎖しました。新実装では、各パケットが最高 index から自分の ROC を推定し、暗号処理後に「より新しいパケット」のときだけ最高 index を進めます。

<div style="display:flex;flex-wrap:wrap;gap:12px;margin:14px 0">
  <div style="flex:1 1 210px;padding:14px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;color:var(--review-muted)">修正の核</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-accent);margin-top:4px">estimate → cipher → commit</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px">推定は副作用なし。確定は単調増加のみ。</div>
  </div>
  <div style="flex:1 1 180px;padding:14px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;color:var(--review-muted)">本体コードの変更</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-fg);margin-top:4px">2 ファイル</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px">rtp の context.ts / srtp.ts のみ</div>
  </div>
  <div style="flex:1 1 200px;padding:14px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
    <div style="font-size:12px;color:var(--review-muted)">再現ケース</div>
    <div style="font-size:20px;font-weight:700;color:var(--review-success);margin-top:4px">A / B / C すべて解消</div>
    <div style="font-size:13px;color:var(--review-muted);margin-top:6px">送信 2 ケース + 受信 1 ケース</div>
  </div>
</div>

主な差分は [packages/rtp/src/srtp/context/context.ts](review-diff:packages/rtp/src/srtp/context/context.ts:commit:e88b8730) と [packages/rtp/src/srtp/context/srtp.ts](review-diff:packages/rtp/src/srtp/context/srtp.ts:commit:e88b8730) です。`packages/webrtc` の本体コードは変更せず、rtp 層の修正で NACK 再送と受信側の順不同の両方に効かせています。

## 1. 何が起きていたか

### 1.1 再現ケースの比較

| ケース | 経路 | 入力列（同一 SSRC） | 旧実装の結果 | 新実装の結果 |
| --- | --- | --- | --- | --- |
| A | 送信 | `65534, 65535, 0..151, 再送0, 152` | 再送 0 と 152 が **ROC=2**（正しくは 1）。以後 +1 ずれたまま | 再送 0 も 152 も **ROC=1**、最高 index は `(1, 152)` |
| B | 送信 | `65534, 65535, 0..99, 再送65535, 100` | 再送 65535 は ROC=0 だが、後続 100 以降が **ROC=0 のまま**（正しくは 1） | 再送は ROC=0、後続 100 は **ROC=1** |
| C | 受信 | `65534, 0..99, 遅延65535, 100..` | 遅延 65535 が `(0, 65535)` を確定し、後続 100.. が ROC=0 で認証失敗。状態が戻らず **受信不能が継続** | 遅延 65535 は ROC=0 で復号でき、最高 index は `(1, 99)` のまま。後続 100.. は ROC=1 で復号 |

### 1.2 ケース A: 折り返し後の seq 0 再送

旧実装では `seq === 0 && last > 100` で無条件に ROC を +1 していました。折り返し後の正しい ROC=1 の状態で seq 0 を再送すると、共有 ROC が 2 になり、その後の 152 も 2 のまま暗号化されます。

<div class="roc-timeline">
<style>
  .roc-timeline { margin: 14px 0; padding: 14px 16px; border: 1px solid var(--review-border); border-radius: 8px; background: var(--review-surface); font-size: 13px; }
  .roc-timeline h4 { margin: 0 0 10px; font-size: 13px; color: var(--review-fg); }
  .roc-timeline .row { display: flex; flex-wrap: wrap; align-items: flex-start; gap: 10px; margin: 8px 0; }
  .roc-timeline .name { flex: 0 0 76px; color: var(--review-muted); font-weight: 600; padding-top: 5px; }
  .roc-timeline .packets { display: flex; flex-wrap: wrap; gap: 6px; }
  .roc-timeline .pkt { min-width: 66px; padding: 5px 8px; border: 1px solid var(--review-border); border-radius: 6px; text-align: center; background: var(--review-bg); }
  .roc-timeline .pkt small { display: block; margin-top: 2px; font-size: 11px; color: var(--review-muted); }
  .roc-timeline .pkt.bad { border-color: var(--review-danger); }
  .roc-timeline .pkt.bad small { color: var(--review-danger); font-weight: 700; }
  .roc-timeline .pkt.good { border-color: var(--review-success); }
  .roc-timeline .pkt.good small { color: var(--review-success); font-weight: 700; }
  .roc-timeline .pkt.state { background: transparent; border-style: dashed; }
  .roc-timeline .note { margin: 4px 0 0 86px; color: var(--review-muted); font-size: 12px; }
  .roc-timeline .note.bad { color: var(--review-danger); }
  .roc-timeline .note.good { color: var(--review-success); }
</style>
  <h4>ケース A: 再送 0 の後も 152 が同じ ROC で送れるか</h4>
  <div class="row">
    <div class="name">旧実装</div>
    <div class="packets">
      <div class="pkt">65534<small>ROC 0</small></div>
      <div class="pkt">65535<small>ROC 0</small></div>
      <div class="pkt">0..151<small>ROC 1</small></div>
      <div class="pkt bad">再送 0<small>ROC 2 / 誤り</small></div>
      <div class="pkt bad">152<small>ROC 2 / 誤り</small></div>
      <div class="pkt state">保存状態<small>(2, 152)</small></div>
    </div>
  </div>
  <div class="note bad">seq 0 を見ただけで ROC++ したため、後続 152 まで 1 周ずれた。</div>
  <div class="row" style="margin-top:14px">
    <div class="name">新実装</div>
    <div class="packets">
      <div class="pkt">65534<small>ROC 0</small></div>
      <div class="pkt">65535<small>ROC 0</small></div>
      <div class="pkt">0..151<small>ROC 1</small></div>
      <div class="pkt good">再送 0<small>ROC 1 / 正しい</small></div>
      <div class="pkt good">152<small>ROC 1 / 正しい</small></div>
      <div class="pkt state">最高 index<small>(1, 152)</small></div>
    </div>
  </div>
  <div class="note good">再送 0 は「最高 index より古い」ので commit されず、152 は ROC=1 のまま。</div>
</div>

このケースは [context.test.ts:115](review-file:packages/rtp/tests/srtp/context/context.test.ts:115) のユニットテストと、[srtp.test.ts:259](review-file:packages/rtp/tests/srtp/context/srtp.test.ts:259) / [gcm.test.ts:314](review-file:packages/rtp/tests/srtp/cipher/gcm.test.ts:314) の実暗号テストで検証しています。

### 1.3 ケース C: 受信側の順不同

受信側では、遅延した 65535 が旧実装で「正しい ROC=0」として受理され、その `(0, 65535)` が共有状態にコミットされました。認証に失敗した後続パケットは状態を書き戻さない（#584 の性質）ため、誤った状態から抜け出せません。

<div class="roc-c">
<style>
  .roc-c { margin: 14px 0; padding: 14px 16px; border: 1px solid var(--review-border); border-radius: 8px; background: var(--review-surface); font-size: 13px; }
  .roc-c .step { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin: 8px 0; }
  .roc-c .tag { flex: 0 0 84px; color: var(--review-muted); font-weight: 600; }
  .roc-c .cell { padding: 5px 8px; border: 1px solid var(--review-border); border-radius: 6px; background: var(--review-bg); }
  .roc-c .cell small { display: block; font-size: 11px; color: var(--review-muted); }
  .roc-c .cell.bad { border-color: var(--review-danger); }
  .roc-c .cell.bad small { color: var(--review-danger); font-weight: 700; }
  .roc-c .cell.good { border-color: var(--review-success); }
  .roc-c .cell.good small { color: var(--review-success); font-weight: 700; }
  .roc-c .bar { width: 2px; height: 22px; background: var(--review-border); }
  .roc-c .legend { color: var(--review-muted); font-size: 12px; }
</style>
  <div class="step">
    <div class="tag">到着</div>
    <div class="cell">65534</div><div class="bar"></div>
    <div class="cell">0..99</div><div class="bar"></div>
    <div class="cell">遅延 65535</div><div class="bar"></div>
    <div class="cell">100..200</div>
  </div>
  <div class="step">
    <div class="tag">旧: パケット ROC</div>
    <div class="cell">0</div><div class="bar"></div>
    <div class="cell">1</div><div class="bar"></div>
    <div class="cell">0<small>復号は成功</small></div><div class="bar"></div>
    <div class="cell bad">0<small>認証失敗</small></div>
  </div>
  <div class="step">
    <div class="tag">旧: 保存状態</div>
    <div class="cell">(0, 65534)</div><div class="bar"></div>
    <div class="cell">(1, 99)</div><div class="bar"></div>
    <div class="cell bad">(0, 65535)<small>後退して固定</small></div><div class="bar"></div>
    <div class="cell bad">(0, 65535)<small>失敗は状態を戻さない</small></div>
  </div>
  <div style="border-top:1px dashed var(--review-border);margin:12px 0"></div>
  <div class="step">
    <div class="tag">新: パケット ROC</div>
    <div class="cell">0</div><div class="bar"></div>
    <div class="cell">1</div><div class="bar"></div>
    <div class="cell good">0<small>復号は成功</small></div><div class="bar"></div>
    <div class="cell good">1<small>認証成功</small></div>
  </div>
  <div class="step">
    <div class="tag">新: 最高 index</div>
    <div class="cell">(0, 65534)</div><div class="bar"></div>
    <div class="cell">(1, 99)</div><div class="bar"></div>
    <div class="cell good">(1, 99)<small>古いので commit しない</small></div><div class="bar"></div>
    <div class="cell good">(1, 200)</div>
  </div>
  <div class="legend">遅延パケットの復号 ROC は 0 のままで正しく、共有状態だけを後退させない点が修正の要点です。</div>
</div>

受信のケース C は [srtp.test.ts:317](review-file:packages/rtp/tests/srtp/context/srtp.test.ts:317) と [gcm.test.ts:372](review-file:packages/rtp/tests/srtp/cipher/gcm.test.ts:372) で検証しています。

## 2. 根本原因

旧実装は 1 つの `rolloverCounter` を「このパケットに使う ROC」と「最後に処理したパケットの ROC」の両方に使っていました。判定も、最高 index ではなく直前に処理した seq との ±100 比較です。

- `seq === 0` で直前が 100 より大きければ無条件に ROC を増やす
- 直前が 99 以下で seq が 65435 より大きければ ROC を減らす（#94 の負 ROC 対策）
- それ以外の順不同は補正しない
- 失敗した復号は状態を書き戻さないため、一度でも誤った状態をコミットすると抜けられない

<div style="display:flex;flex-wrap:wrap;gap:12px;margin:14px 0">
  <div style="flex:1 1 300px;padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:8px;background:var(--review-surface)">
    <div style="font-weight:700;color:var(--review-danger);font-size:13px">旧: 共有状態を直接更新</div>
    <pre style="margin:8px 0 0;padding:10px;overflow:auto;background:var(--review-bg);border-radius:6px;font-size:12px;line-height:1.5">if (seq === 0) {
  if (s.lastSequenceNumber &gt; 100) {
    s.rolloverCounter++;
  }
} else if (s.lastSequenceNumber &lt; 100 &amp;&amp;
           seq &gt; 65535 - 100) {
  s.rolloverCounter--;
}
s.lastSequenceNumber = seq;</pre>
  </div>
  <div style="flex:1 1 300px;padding:12px 14px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:8px;background:var(--review-surface)">
    <div style="font-weight:700;color:var(--review-success);font-size:13px">新: 推定と確定を分離</div>
    <pre style="margin:8px 0 0;padding:10px;overflow:auto;background:var(--review-bg);border-radius:6px;font-size:12px;line-height:1.5">const roc = estimate(seq, s);   // 状態を変えない
const enc = cipher(roc);         // このパケットの ROC
if (newerThanHighest(seq, roc)) {
  s.rolloverCounter = roc;       // 最高 index だけ進める
  s.lastSequenceNumber = seq;
}</pre>
  </div>
</div>

## 3. 修正内容

### 3.1 RFC 3711 Appendix A の推定

`SrtpSsrcState` の `rolloverCounter` / `lastSequenceNumber` は「これまで受理した最高 index（ROC, s_l）」だけを表すように意味を変更しました（[context.ts:269](review-file:packages/rtp/src/srtp/context/context.ts:269)）。

| 条件 | 推定する ROC |
| --- | --- |
| 未初期化 | `0` |
| `s_l < 0x8000` かつ `seq - s_l > 0x8000` | `ROC - 1`（前周） |
| `s_l < 0x8000` かつ上記以外 | `ROC` |
| `s_l >= 0x8000` かつ `s_l - 0x8000 > seq` | `ROC + 1`（次周） |
| `s_l >= 0x8000` かつ上記以外 | `ROC` |

推定は [context.ts:195](review-file:packages/rtp/src/srtp/context/context.ts:195) の `estimateRolloverCounter()` に閉じ込め、状態を書き換えません。判定本体は [context.ts:302](review-file:packages/rtp/src/srtp/context/context.ts:302) の `guessRolloverCounter()` です。前周（ROC=-1）は ROC=0 に丸め、[#94](https://github.com/shinyoshiaki/werift-webrtc/issues/94) の「負の ROC を cipher に渡さない」性質を維持します。

確定は [context.ts:211](review-file:packages/rtp/src/srtp/context/context.ts:211) の `commitPacketIndex()` です。拡張 index（`ROC * 65536 + seq`、48bit で `Number` の安全整数内）の差が `0 < delta <= 0x8000` のときだけ、最高 index を前に進めます。古いパケット、重複、丸めたパケットでは状態を変えません。

### 3.2 暗号処理の順序

<div class="roc-flow">
<style>
  .roc-flow { margin: 14px 0; padding: 14px 16px; border: 1px solid var(--review-border); border-radius: 8px; background: var(--review-surface); font-size: 13px; }
  .roc-flow .lane { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin: 10px 0; }
  .roc-flow .lane-title { flex: 0 0 58px; font-weight: 700; color: var(--review-muted); }
  .roc-flow .node { padding: 8px 11px; border: 1px solid var(--review-border); border-radius: 6px; background: var(--review-bg); }
  .roc-flow .node small { display: block; font-size: 11px; color: var(--review-muted); }
  .roc-flow .node.accent { border-color: var(--review-accent); }
  .roc-flow .node.good { border-color: var(--review-success); }
  .roc-flow .node.bad { border-color: var(--review-danger); }
  .roc-flow .arrow { color: var(--review-muted); font-weight: 700; }
  .roc-flow .branch { margin-left: 66px; color: var(--review-muted); font-size: 12px; }
</style>
  <div class="lane">
    <div class="lane-title">暗号化</div>
    <div class="node accent">estimate<small>副作用なし</small></div>
    <div class="arrow">→</div>
    <div class="node">cipher.encryptRtp<small>推定 ROC を使用</small></div>
    <div class="arrow">→</div>
    <div class="node good">commit<small>より新しい時だけ</small></div>
    <div class="arrow">→</div>
    <div class="node">最高 index<small>{ROC, s_l}</small></div>
  </div>
  <div class="lane">
    <div class="lane-title">復号</div>
    <div class="node accent">estimate<small>副作用なし</small></div>
    <div class="arrow">→</div>
    <div class="node">cipher.decryptRtp<small>認証・復号</small></div>
    <div class="arrow">→</div>
    <div class="node good">commit<small>成功時だけ</small></div>
    <div class="arrow">→</div>
    <div class="node">最高 index<small>失敗時は不変</small></div>
  </div>
  <div class="branch">認証失敗: パケットを破棄し、最高 index も未知 SSRC の状態も作らない（#584 を維持）。</div>
</div>

- 暗号化は「推定 → 暗号化 → 確定」の順です（[srtp.ts:17](review-file:packages/rtp/src/srtp/context/srtp.ts:17)）。
- 復号は「推定 → 復号 → 成功後に確定」です（[srtp.ts:26](review-file:packages/rtp/src/srtp/context/srtp.ts:26)）。未知の SSRC は復号成功後にだけ state を登録します（[srtp.ts:46](review-file:packages/rtp/src/srtp/context/srtp.ts:46)）。
- ROC 上限（`0xFFFFFFFF` の次周）は暗号化では `SrtpRolloverCounterOverflowError`、復号では `SrtpAuthenticationError` として拒否します（[srtp.ts:35](review-file:packages/rtp/src/srtp/context/srtp.ts:35)）。受信経路をクラッシュさせません。
- 既存 API の `updateRolloverCount()` は「推定して確定し、パケット ROC を返す」互換ラッパーとして残しました（[context.ts:237](review-file:packages/rtp/src/srtp/context/context.ts:237)）。`MaxROCDisorder` は削除しています。

`packages/webrtc` 本体は未変更です。NACK 再送は RTX なしなら元の SSRC/seq のまま `dtls.sendRtp()` に渡り（[rtpSender.ts:837](review-file:packages/webrtc/src/media/rtpSender.ts:837)）、rtp 層の修正がそのまま効きます。`RTP_HISTORY_SIZE = 128` は半周 32768 より小さいため、再送できる seq の推定 ROC は送信時の ROC と必ず一致します（[rtpSender.ts:89](review-file:packages/webrtc/src/media/rtpSender.ts:89)）。

## 4. テストと検証

### 4.1 共有 Arrange

- [packages/rtp/tests/utils.ts:766](review-file:packages/rtp/tests/utils.ts:766): プロファイル別の SRTP context、送受信ペア、seq 列の実行ヘルパー。
- [packages/rtp/tests/utils.ts:818](review-file:packages/rtp/tests/utils.ts:818): `estimate → commit` を順に流し、パケット ROC と最高 index を記録。
- [packages/rtp/tests/utils.ts:846](review-file:packages/rtp/tests/utils.ts:846): 実 SRTP で暗号化・復号するヘルパー。
- [packages/webrtc/tests/fixture.ts:127](review-file:packages/webrtc/tests/fixture.ts:127): 鍵を入れ替えた `SrtpSession` ペアによるループバック。`dtls.sendRtp` を実 SRTP に差し替えます。

### 4.2 テスト観点

| 観点 | テスト | 結果 |
| --- | --- | --- |
| A: 再送 0 と後続 152 が ROC=1 | [context.test.ts:115](review-file:packages/rtp/tests/srtp/context/context.test.ts:115) | 通過 |
| A: 次の折り返しが ROC=3 ではなく 2 | [context.test.ts:137](review-file:packages/rtp/tests/srtp/context/context.test.ts:137) | 通過 |
| B: 遅延 65535 は ROC=0、後続 100 は ROC=1 | [context.test.ts:158](review-file:packages/rtp/tests/srtp/context/context.test.ts:158) | 通過 |
| 順不同・重複で最高 index が後退しない | [context.test.ts:177](review-file:packages/rtp/tests/srtp/context/context.test.ts:177) | 通過 |
| 初回 seq が高い / 0 の場合 | [context.test.ts:192](review-file:packages/rtp/tests/srtp/context/context.test.ts:192) / [context.test.ts:207](review-file:packages/rtp/tests/srtp/context/context.test.ts:207) | 通過 |
| 3 回以上の折り返し | [context.test.ts:252](review-file:packages/rtp/tests/srtp/context/context.test.ts:252) | 通過 |
| 半周境界（0x8000 / 0x8001） | [context.test.ts:275](review-file:packages/rtp/tests/srtp/context/context.test.ts:275) | 通過 |
| ROC 上限の拒否 | [context.test.ts:322](review-file:packages/rtp/tests/srtp/context/context.test.ts:322) | 通過 |
| 互換ラッパー | [context.test.ts:341](review-file:packages/rtp/tests/srtp/context/context.test.ts:341) | 通過 |
| AES-CM: A / B / C | [srtp.test.ts:259](review-file:packages/rtp/tests/srtp/context/srtp.test.ts:259) / [srtp.test.ts:290](review-file:packages/rtp/tests/srtp/context/srtp.test.ts:290) / [srtp.test.ts:317](review-file:packages/rtp/tests/srtp/context/srtp.test.ts:317) | 通過 |
| AES-CM: 改ざん再送で状態不変 | [srtp.test.ts:351](review-file:packages/rtp/tests/srtp/context/srtp.test.ts:351) | 通過 |
| AES-GCM: A / B / C | [gcm.test.ts:314](review-file:packages/rtp/tests/srtp/cipher/gcm.test.ts:314) / [gcm.test.ts:345](review-file:packages/rtp/tests/srtp/cipher/gcm.test.ts:345) / [gcm.test.ts:372](review-file:packages/rtp/tests/srtp/cipher/gcm.test.ts:372) | 通過 |
| AES-GCM: 改ざん再送で状態不変 | [gcm.test.ts:406](review-file:packages/rtp/tests/srtp/cipher/gcm.test.ts:406) | 通過 |
| webrtc: RTX なし NACK 再送 + 後続 | [rtpSender.test.ts:1295](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1295) | 通過 |
| webrtc: RTX ありの退行なし | [rtpSender.test.ts:1322](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1322) | 通過 |
| RFC テストベクタの維持 | [srtp.test.ts:55](review-file:packages/rtp/tests/srtp/context/srtp.test.ts:55) | 通過 |

### 4.3 再実行した検証

今回のドキュメント作成時に、現在の HEAD（`c32391aa`）で再実行した結果です。

| コマンド | 範囲 | 結果 |
| --- | --- | --- |
| `cd packages/rtp && npm run type` | rtp の型検査 | 成功 |
| `cd packages/rtp && npm test` | rtp 全テスト | **389 件通過** |
| `cd packages/webrtc && npm run type` | webrtc の型検査 | 成功 |
| `cd packages/webrtc && npx vitest run tests/media/rtpSender.test.ts` | NACK 再送を含む sender テスト | **41 件通過** |
| `cd packages/rtp && npx vitest run tests/srtp/context/context.test.ts tests/srtp/context/srtp.test.ts tests/srtp/cipher/gcm.test.ts` | ROC 関連 3 ファイル | **52 件通過** |

<div style="margin:14px 0;padding:14px 16px;border:1px solid var(--review-border);border-radius:8px;background:var(--review-surface)">
  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
    <div style="font-weight:700;font-size:13px">テスト件数の比較</div>
    <div style="font-size:12px;color:var(--review-muted)">今回の再実行分 + 実装時報告分</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px">
    <div style="flex:0 0 160px;color:var(--review-muted)">rtp 全テスト</div>
    <div style="flex:1;height:14px;background:var(--review-bg);border-radius:3px;overflow:hidden"><div style="width:24.4%;height:100%;background:var(--review-accent)"></div></div>
    <div style="flex:0 0 52px;text-align:right;font-weight:700">389</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px">
    <div style="flex:0 0 160px;color:var(--review-muted)">ROC 関連 3 ファイル</div>
    <div style="flex:1;height:14px;background:var(--review-bg);border-radius:3px;overflow:hidden"><div style="width:3.3%;min-width:6px;height:100%;background:var(--review-accent)"></div></div>
    <div style="flex:0 0 52px;text-align:right;font-weight:700">52</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px">
    <div style="flex:0 0 160px;color:var(--review-muted)">rtpSender テスト</div>
    <div style="flex:1;height:14px;background:var(--review-bg);border-radius:3px;overflow:hidden"><div style="width:2.6%;min-width:6px;height:100%;background:var(--review-accent)"></div></div>
    <div style="flex:0 0 52px;text-align:right;font-weight:700">41</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px">
    <div style="flex:0 0 160px;color:var(--review-muted)">workspace `test:small`（実装時）</div>
    <div style="flex:1;height:14px;background:var(--review-bg);border-radius:3px;overflow:hidden"><div style="width:100%;height:100%;background:var(--review-muted)"></div></div>
    <div style="flex:0 0 52px;text-align:right;font-weight:700">1,596</div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;margin:7px 0;font-size:12px">
    <div style="flex:0 0 160px;color:var(--review-muted)">ブラウザ E2E（実装時）</div>
    <div style="flex:1;height:14px;background:var(--review-bg);border-radius:3px;overflow:hidden"><div style="width:3.9%;min-width:6px;height:100%;background:var(--review-muted)"></div></div>
    <div style="flex:0 0 52px;text-align:right;font-weight:700">63</div>
  </div>
  <div style="font-size:12px;color:var(--review-muted);margin-top:8px">灰色の 2 行は実装時の報告値で、今回の再実行ではありません。</div>
</div>

実装時の検証（引き継ぎ情報）では、`npm run test:small` が 1,596 件通過・既定 9 件スキップ、ブラウザ E2E が 63 件通過しています。既知の ROC を直接指定した追加検証でも、AES-CM と AES-GCM の各 6,304 パケット・5 回の折り返しを含む再送・欠落・順不同処理が通過し、ベースブランチでは元の不具合が再現したとの報告です。**これらは今回再実行していません。**

## 5. 挙動変更と互換性

| 項目 | 変更 | レビュー上の意味 |
| --- | --- | --- |
| `srtpSSRCStates[ssrc].rolloverCounter` | 「最後に処理したパケットの ROC」から「最高 index の ROC」へ | 外部から状態を読む利用者は値の意味が変わる。PR に明記が必要 |
| 半周を超える前方 seq ジャンプ | 前周の古いパケットとして解釈 | libsrtp の `srtp_index_guess` と同じ。werift の sender は seq を連続させるため通常は発生しない |
| ROC 上限超過 | 明示的な `SrtpRolloverCounterOverflowError` / 受信では `SrtpAuthenticationError` | `writeUInt32BE` の例外ではなく、再鍵化が必要な状態として扱える |
| `updateRolloverCount()` | deprecated の互換ラッパー | 既存呼び出しは壊れない。戻り値はパケット ROC |
| `MaxROCDisorder` | 削除 | ±100 ヒューリスティックの廃止に伴う |

維持した性質:

- **#94**: ROC=0 で前周と推定したパケットは 0 に丸め、cipher に負の ROC を渡さない。
- **#584**: 認証に失敗したパケットでは状態を進めない。未知の SSRC でも認証失敗時に state を作らない。

## 6. リスク・未確認事項

- **Android 実機は未検証**です。元報告は Android libwebrtc 受信側の `auth_fail` ですが、確認できている範囲はユニットテスト、実 SRTP ループバック、実装時の Chrome E2E までです。チケットの対象外とも明記されています。
- **受信側の初期化**は、最初に受信したパケットを ROC=0 として初期化します。送信側の最初の数パケットが折り返しをまたいで失われた場合の救済は RFC の制約上、対象外です。
- **SRTP replay window** の新規実装は対象外です。
- 実装時の検証で、未変更の ICE 再起動テスト 1 件が初回だけ 1 秒待機でタイムアウトし、単独再実行と最終スイートでは通過しています。今回の変更との関連は確認されていませんが、タイミング依存の可能性は残ります。


## 7. レビューの着眼点

1. **推定が純粋か**: `estimateRolloverCounter()` が state を書き換えず、RFC の分岐と丸め・上限を満たすか。[context.ts:195](review-file:packages/rtp/src/srtp/context/context.ts:195)
2. **確定が単調か**: `commitPacketIndex()` が「新しいパケットだけ」を最高 index にし、古い・重複・丸めを無視するか。[context.ts:211](review-file:packages/rtp/src/srtp/context/context.ts:211)
3. **復号のコミット位置**: 認証・復号の成功後にだけ commit しているか。失敗時に未知 SSRC の state を作らないか。[srtp.ts:26](review-file:packages/rtp/src/srtp/context/srtp.ts:26)
4. **受信経路のエラー変換**: ROC 上限を `SrtpAuthenticationError` に変換し、受信ループを壊さないか。[srtp.ts:35](review-file:packages/rtp/src/srtp/context/srtp.ts:35)
5. **実経路の再現**: RTX なし NACK 再送で、再送 0 と後続 121 が実 SRTP で復号できるか。[rtpSender.test.ts:1295](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1295)
6. **旧期待値の変更理由**: `0 → 65535 → 1` や `65530 → 0 → 65530` の期待値が新しい意味に合わせて説明されているか。[context.test.ts:207](review-file:packages/rtp/tests/srtp/context/context.test.ts:207) / [context.test.ts:230](review-file:packages/rtp/tests/srtp/context/context.test.ts:230)

## まとめ

旧実装は「処理順」が共有 ROC を動かす設計でした。新実装は「最高 index」を唯一の確定状態にし、各パケットの ROC を RFC 3711 Appendix A で推定します。これにより、NACK 再送・重複・順不同のどれが来ても、後続パケットの ROC はずれません。

今回の再実行では rtp の型検査と全 389 テスト、webrtc の型検査、rtpSender の 41 テスト、ROC 関連 3 ファイルの 52 テストが通過しました。実装時にはワークスペース全体の 1,596 テストとブラウザ E2E 63 件も通過しています。未確認は Android 実機です。
