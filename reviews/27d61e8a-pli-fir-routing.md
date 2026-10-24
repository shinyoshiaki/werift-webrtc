---
ide:
  viewer: review-document
  version: 1
  title: "PLI/FIR 配送修正のレビュー解説"
  dock: right
  baseCommit: 8b2366c00837f5b53519a49b8e54ed46bbdc326d
---
# RTCP PLI/FIR を media SSRC で配送する修正のレビュー解説

## 1. 概要

キーフレーム要求（PLI / FIR）が、**要求の送信元 SSRC ではなく、要求の対象メディアの SSRC** で配送されるようにしました。あわせて、Sender が FIR を受けたことをアプリが知れるよう、`onFullIntraRequest`、`onKeyFrameRequest`、`firCount` の集計を追加しました。

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>PLI/FIR は <code>senderSsrc</code> を先に引く。sendrecv では自分の Receiver に誤配送され、<code>onPictureLossIndication</code> が発火しない。FIR は Sender に届いても通知手段がない。
  </div>
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>PLI は <code>mediaSsrc</code> のみ。FIR は FCI の各 <code>ssrc</code> で配送し重複は 1 回にまとめる。Sender は FIR を数え、通知する。
  </div>
</div>

## 2. 配送ロジックの変更（Router）

[packages/webrtc/src/media/router.ts:397](review-file:packages/webrtc/src/media/router.ts:397) で PLI を `mediaSsrc` のみで引くようにしました。
差分は [packages/webrtc/src/media/router.ts:397](review-diff:packages/webrtc/src/media/router.ts:397) です。

[packages/webrtc/src/media/router.ts:401](review-file:packages/webrtc/src/media/router.ts:401) で FIR を FCI エントリの `ssrc` ごとに引き、`Set` で重複を除いています。

<style>
  .rt-tabs button { border: 1px solid var(--review-border); background: var(--review-surface); color: var(--review-fg); padding: 2px 10px; cursor: pointer; }
  .rt-tabs button[aria-selected="true"] { border-color: var(--review-accent); color: var(--review-accent); }
  .rt-tabs [role="tabpanel"] { padding: 10px 0; }
  .rt-tabs table { border-collapse: collapse; width: 100%; font-size: 13px; }
  .rt-tabs td, .rt-tabs th { border: 1px solid var(--review-border); padding: 4px 8px; text-align: left; }
</style>

<div class="rt-tabs">
  <button role="tab" aria-selected="true" data-panel="pli">PLI (FMT=1)</button>
  <button role="tab" aria-selected="false" data-panel="fir">FIR (FMT=4)</button>
  <button role="tab" aria-selected="false" data-panel="other">REMB / その他</button>
  <div role="tabpanel" data-panel="pli">
    <table>
      <tr><th></th><th>Before</th><th>After</th></tr>
      <tr><td>引くキー</td><td>senderSsrc → なければ mediaSsrc</td><td>mediaSsrc のみ</td></tr>
      <tr><td>mediaSsrc が未登録</td><td>senderSsrc 側へ誤配送しうる</td><td>配送しない</td></tr>
      <tr><td>根拠</td><td>-</td><td>RFC 4585 §6.1</td></tr>
    </table>
  </div>
  <div role="tabpanel" data-panel="fir" hidden>
    <table>
      <tr><th></th><th>Before</th><th>After</th></tr>
      <tr><td>引くキー</td><td>senderSsrc → mediaSsrc（Chrome は 0）</td><td>FCI の <code>fir[].ssrc</code> 各エントリ</td></tr>
      <tr><td>複数エントリ</td><td>考慮なし</td><td>同じ recipient には 1 回だけ配送</td></tr>
      <tr><td>fir[] が空</td><td>-</td><td>mediaSsrc が 0 以外のときのみ fallback</td></tr>
      <tr><td>根拠</td><td>-</td><td>RFC 5104 §4.3.1</td></tr>
    </table>
  </div>
  <div role="tabpanel" data-panel="other" hidden>
    <table>
      <tr><th>種別</th><th>挙動</th></tr>
      <tr><td>REMB</td><td>従来どおり <code>ssrcFeedbacks[0]</code> で配送（変更なし）</td></tr>
      <tr><td>未知 FMT（SLI, RPSI など）</td><td>配送しない。<code>feedback</code> が未パースの場合も throw しない</td></tr>
    </table>
  </div>
</div>

<script>
  document.querySelectorAll(".rt-tabs [role=tab]").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".rt-tabs [role=tab]").forEach((t) => t.setAttribute("aria-selected", String(t === tab)));
      document.querySelectorAll(".rt-tabs [role=tabpanel]").forEach((p) => { p.hidden = p.dataset.panel !== tab.dataset.panel; });
    });
  });
</script>

### なぜ誤配送が起きていたか（sendrecv video の例）

<svg viewBox="0 0 640 210" width="100%" role="img" aria-label="PLI の誤配送と修正後の配送">
  <g fill="none" stroke="var(--review-border)" stroke-width="1.5">
    <rect x="10" y="20" width="170" height="70" rx="8"/>
    <rect x="460" y="20" width="170" height="70" rx="8"/>
    <rect x="250" y="120" width="140" height="40" rx="6" stroke="var(--review-danger)"/>
    <rect x="250" y="20" width="140" height="40" rx="6" stroke="var(--review-success)"/>
  </g>
  <g fill="var(--review-fg)" font-size="13" text-anchor="middle">
    <text x="95" y="48">pc2 Receiver</text>
    <text x="95" y="68" font-size="11" fill="var(--review-muted)">PLI を送る</text>
    <text x="545" y="48">pc1 router</text>
    <text x="545" y="68" font-size="11" fill="var(--review-muted)">ssrcTable で配送先を決める</text>
    <text x="320" y="45">pc1 Sender（mediaSsrc）</text>
    <text x="320" y="145">pc1 Receiver（senderSsrc）</text>
  </g>
  <g stroke="var(--review-success)" stroke-width="2" fill="none"><line x1="180" y1="40" x2="250" y2="40"/><line x1="460" y1="40" x2="390" y2="40"/></g>
  <g stroke="var(--review-danger)" stroke-width="2" stroke-dasharray="5 4" fill="none"><line x1="545" y1="90" x2="545" y2="140"/><line x1="545" y1="140" x2="390" y2="140"/></g>
  <g font-size="12" text-anchor="middle"><text x="320" y="195" fill="var(--review-danger)">Before: senderSsrc が自分の Receiver に当たり、PLI は handleRtcpPacket で無視される</text><text x="320" y="10" fill="var(--review-success)">After: mediaSsrc で Sender に届く</text></g>
</svg>

## 3. Sender 側の FIR 処理と統合イベント

[packages/webrtc/src/media/rtpSender.ts:892](review-file:packages/webrtc/src/media/rtpSender.ts:892) で FIR を処理します。差分は [packages/webrtc/src/media/rtpSender.ts:892](review-diff:packages/webrtc/src/media/rtpSender.ts:892) です。

<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>1. 自分宛を抽出</strong><br>fir[] から <code>ssrc === this.ssrc</code> を選ぶ。0 件なら何もしない</div>
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>2. firCount</strong><br>自分宛エントリ数を加算（再送も数える）</div>
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>3. 再送判定</strong><br>送信元 <code>senderSsrc</code> ごとの前回 Seq nr と比較</div>
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-accent);border-radius:6px"><strong>4. 発火</strong><br>新しい Seq nr のときだけ <code>onFullIntraRequest</code> と <code>onKeyFrameRequest("fir")</code></div>
</div>

| イベント | 型 | 発火条件 |
| --- | --- | --- |
| `onPictureLossIndication`（既存） | `Event<[]>` | PLI を受けるたび |
| `onFullIntraRequest`（新規） | `Event<[FullIntraRequest]>` | 自分宛かつ新しい Seq nr の FIR |
| `onKeyFrameRequest`（新規） | `Event<["pli" \| "fir"]>` | PLI ごと、および再送でない FIR |

- `onPictureLossIndication` / `pliCount` の挙動は変えていません。FIR を PLI のイベントに流すと既存購読者が名前と違う種類のパケットで動き出すため、分離を維持しました（ユーザー判断で統合イベントを追加）。
- `FullIntraRequest` は [packages/rtp/src/index.ts:8](review-file:packages/rtp/src/index.ts:8) から export し、利用者が型を参照できます。
- example は [examples/mediachannel/sendrecv/offer.ts:28](review-file:examples/mediachannel/sendrecv/offer.ts:28) で `onKeyFrameRequest` の 1 購読に移行しました。差分は [examples/mediachannel/sendrecv/offer.ts](review-diff:examples/mediachannel/sendrecv/offer.ts) です。

## 4. 判断理由

- **PLI は `senderSsrc` へフォールバックしない**: フォールバックがあると、まさに今回の誤配送が再発するためです。
- **FIR の common header の media SSRC は使わない**: RFC 5104 で 0 と定められ、libwebrtc も 0 を送ります。
- **`firCount` は再送も数える**: W3C stats の定義と libwebrtc の挙動に合わせました。通知だけを Seq nr で重複除去します。
- **`onKeyFrameRequest` を追加**: PLI と FIR のどちらでも行う処理は結局キーフレーム要求だけ、というユーザーの指摘によります。既存イベントは変えず追加のみです。

## 5. リスク・互換性

- **挙動変更**: `mediaSsrc` が未登録の PLI は、`senderSsrc` 側にも配送されなくなります。これは意図した変更で、changelog に記載しました。
- **挙動変更**: 未知 FMT の PSFB は配送されなくなります。以前は `feedback` が無い場合に throw しうる経路でした。
- **API は追加のみ**: 既存イベントと stats の名前は変更していません。
- **未移行の example**: [examples/certificate/offer.ts](review-file:examples/certificate/offer.ts) と [examples/mediachannel/rtx/offer.ts](review-file:examples/mediachannel/rtx/offer.ts) は `onPictureLossIndication` のままです。動作は変わりませんが、FIR には反応しません。

## 6. テスト

| 対象 | ファイル | 内容 |
| --- | --- | --- |
| Router | [packages/webrtc/tests/media/router.test.ts:100](review-file:packages/webrtc/tests/media/router.test.ts:100) | PLI の media SSRC 配送、未知 SSRC、FIR の FCI 配送・重複除去・fallback、REMB 維持、未知 FMT |
| Sender | [packages/webrtc/tests/media/rtpSender.test.ts:1256](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1256) | `firCount`、再送の扱い、他 SSRC 宛の FIR、`onKeyFrameRequest` の発火順 |
| 結合 | [packages/webrtc/tests/integrate/mediaChannel.test.ts:167](review-file:packages/webrtc/tests/integrate/mediaChannel.test.ts:167) | sendrecv video で PLI が相手 Sender に届き、Receiver に誤配送されない |

## 7. 検証結果

| 項目 | 結果 | 備考 |
| --- | --- | --- |
| 上記 3 ファイルの vitest（この文書作成時に再実行） | 成功 | 3 ファイル・57 テスト |
| `packages/webrtc` の `npm run type`、`tests/media` | 成功 | 直前の作業で実施（115 テスト） |
| `examples/e2e` の `npm run type` | 成功 | 直前の作業で実施 |
| 自動レビュー時の全テスト | 成功 | WebRTC 801、RTP 210、Chromium カタログ 65。ただし `onKeyFrameRequest` 追加前の結果 |

**未確認**: `onKeyFrameRequest` 追加後の `npm run test:small`、WPT、Chromium の E2E カタログ（`npm run examples:e2e`）は実行していません。`npm run doc` では今回の変更と無関係な警告が 11 件出ています。
