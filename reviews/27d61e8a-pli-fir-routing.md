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
      <tr><td>mediaSsrc が未登録</td><td>senderSsrc 側へ誤配送しうる</td><td>compatible（既定）: RTX SSRC の持ち主 → 唯一の video Sender／strict: 配送しない（§4）</td></tr>
      <tr><td>根拠</td><td>-</td><td>RFC 4585 §6.1</td></tr>
    </table>
  </div>
  <div role="tabpanel" data-panel="fir" hidden>
    <table>
      <tr><th></th><th>Before</th><th>After</th></tr>
      <tr><td>引くキー</td><td>senderSsrc → mediaSsrc（Chrome は 0）</td><td>FCI の <code>fir[].ssrc</code> 各エントリ</td></tr>
      <tr><td>複数エントリ</td><td>考慮なし</td><td>同じ recipient には 1 回だけ配送</td></tr>
      <tr><td>エントリの ssrc が未登録</td><td>-</td><td>PLI と同じ解決（compatible / strict）。Sender には解決済みのエントリを渡す</td></tr>
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

- **FIR の common header の media SSRC は使わない**: RFC 5104 で 0 と定められ、libwebrtc も 0 を送ります。
- **`firCount` は再送も数える**: W3C stats の定義と libwebrtc の挙動に合わせました。通知だけを Seq nr で重複除去します。
- **`onKeyFrameRequest` を追加**: PLI と FIR のどちらでも行う処理は結局キーフレーム要求だけ、というユーザーの指摘によります。既存イベントは変えず追加のみです。

### 4.1 「senderSsrc へフォールバック」案を採らない理由

レビューで「`mediaSsrc` → なければ `senderSsrc`」をデフォルトにし、RFC 準拠をオプションにする案が出ました。キーフレーム要求に最大限応える、という狙いは採用しました（§4.2）。ただし、`senderSsrc` を引く方法では狙いを達成できません。

| 観点 | 内容 |
| --- | --- |
| `senderSsrc` の意味 | 要求を**送ってきた相手**の SSRC（RFC 4585 §6.1）。自分の Sender の SSRC は自分で乱数で決めるため、ここに一致しない |
| 実測 | werift 同士の sendrecv video で、相手 PLI の `senderSsrc` を自分の `ssrcTable` で引くと `RTCRtpReceiver` に当たった |
| 結果 | Receiver は PSFB を処理しないので、キーフレームは出ない。Receiver の `onRtcp` に PSFB が流れるだけ |
| SFU / relay | `senderSsrc` が別 endpoint の stream に当たり、無関係な相手に要求が届く。下流の relay が monkey-patch で避けていた誤配送そのもの |

つまり、このフォールバックで救える要求はほぼなく、今回直した誤配送がデフォルトで戻ります。

### 4.2 代わりに入れたもの: `keyFrameRequestRouting`

`mediaSsrc`（FIR では FCI エントリの `ssrc`）が引けない現実的なケースは、SSRC 0、RTX の SSRC、再ネゴシエーション後の古い SSRC です。これらを、要求先の SSRC から**自分の Sender への対応付け**で救います。

[packages/webrtc/src/media/router.ts](review-file:packages/webrtc/src/media/router.ts) の `keyFrameRequestTarget` が解決します。設定は `RTCPeerConnection` の `keyFrameRequestRouting` です（[packages/webrtc/src/api/peerConfig.ts](review-file:packages/webrtc/src/api/peerConfig.ts)）。

| 対象 SSRC | `"compatible"`（既定） | `"strict"` |
| --- | --- | --- |
| `ssrcTable` に登録済み | そのまま配送 | そのまま配送 |
| ある Sender の RTX SSRC | その Sender | 配送しない |
| 上記以外で、video Sender が 1 つだけ | その Sender | 配送しない |
| 上記以外（video Sender が 0 または複数） | 配送しない | 配送しない |
| `senderSsrc` | 使わない | 使わない |

- **複数 video Sender では推測しない**: SFU / relay のように Sender が複数あると、どれ宛か決められないためです。誤った相手へ送るより、配送しない方を選びました。
- **FIR**: Router が解決したエントリを `handleRtcpPacket(packet, entries)` で Sender に渡します。これで RTX SSRC 宛や未登録 SSRC 宛のエントリも `firCount` と `onFullIntraRequest` / `onKeyFrameRequest` に反映されます。引数が無いとき（直接呼び出し）は、従来どおり自分の SSRC 宛のエントリだけを扱います。
- **設定の変更**: `setConfiguration` でいつでも切り替えられます。未知の値は `TypeError` です。

## 5. リスク・互換性

- **挙動変更**: `mediaSsrc` が未登録の PLI は、`senderSsrc` 側にも配送されなくなります。これは意図した変更で、changelog に記載しました。
- **既定の救済（`"compatible"`）**: 未登録 SSRC 宛の PLI / FIR が、RTX の持ち主か唯一の video Sender に届きます。余分なキーフレームが出る可能性はありますが、要求に応えない場合よりも影響は小さいと判断しました。RFC どおりにしたい場合は `"strict"` を指定します。
- **チケットとの差分**: チケット §2.1 は「`mediaSsrc` が無ければ配送しない」です。既定の `"compatible"` はレビューでの指示に基づく拡張で、`"strict"` がチケットどおりの挙動です。
- **挙動変更**: 未知 FMT の PSFB は配送されなくなります。以前は `feedback` が無い場合に throw しうる経路でした。
- **API は追加のみ**: 既存イベントと stats の名前は変更していません。
- **未移行の example**: [examples/certificate/offer.ts](review-file:examples/certificate/offer.ts) と [examples/mediachannel/rtx/offer.ts](review-file:examples/mediachannel/rtx/offer.ts) は `onPictureLossIndication` のままです。動作は変わりませんが、FIR には反応しません。

## 6. テスト

| 対象 | ファイル | 内容 |
| --- | --- | --- |
| Router | [packages/webrtc/tests/media/router.test.ts:100](review-file:packages/webrtc/tests/media/router.test.ts:100) | PLI の media SSRC 配送、未知 SSRC、FIR の FCI 配送・重複除去・fallback、REMB 維持、未知 FMT |
| Sender | [packages/webrtc/tests/media/rtpSender.test.ts:1256](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1256) | `firCount`、再送の扱い、他 SSRC 宛の FIR、`onKeyFrameRequest` の発火順 |
| 結合 | [packages/webrtc/tests/integrate/mediaChannel.test.ts:167](review-file:packages/webrtc/tests/integrate/mediaChannel.test.ts:167) | sendrecv video で PLI が相手 Sender に届き、Receiver に誤配送されない |
| Router（救済） | [packages/webrtc/tests/media/router.test.ts](review-file:packages/webrtc/tests/media/router.test.ts) | compatible: RTX SSRC 宛 PLI、唯一の video Sender への PLI、FIR エントリの解決と `firCount`／strict: 未登録 SSRC は配送しない／複数 video Sender では配送しない |
| 結合（救済） | [packages/webrtc/tests/integrate/mediaChannel.test.ts](review-file:packages/webrtc/tests/integrate/mediaChannel.test.ts) | werift 同士で media SSRC 0 の PLI が既定で届き、strict では届かない。未知のモードは `TypeError` |

## 7. 検証結果

| 項目 | 結果 | 備考 |
| --- | --- | --- |
| `packages/webrtc` の `npm test`（`keyFrameRequestRouting` 追加後） | 成功 | 56 ファイル・834 テスト成功（3 件 skip） |
| ルートの `npm run type` | 成功 | `keyFrameRequestRouting` 追加後 |
| ミューテーション確認 | 検出 | strict 判定を外す・唯一の video Sender への解決を外す、の 2 通りで追加テストが失敗することを確認し、元に戻した |
| `npm run doc` | 成功 | `PeerConfig`・`RtpRouter`・`RTCRtpSender` などを再生成。警告は今回の変更と無関係なもののみ |
| 自動レビュー時の全テスト | 成功 | WebRTC 801、RTP 210、Chromium カタログ 65。`onKeyFrameRequest` 追加前の結果 |

**未確認**: `npm run test:small`（rtp など他パッケージ）、WPT、Chromium の E2E カタログ（`npm run examples:e2e`）、`npm run e2e` は、`onKeyFrameRequest` / `keyFrameRequestRouting` の追加後に実行していません。Chrome などが未登録 SSRC 宛の PLI / FIR を実際にどの程度送るかも調べていません。
