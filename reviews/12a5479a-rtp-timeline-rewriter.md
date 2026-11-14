---
ide:
  viewer: review-document
  version: 1
  title: "RtpTimelineRewriter: 上流差し替え時の RTP タイムライン連続化"
  dock: right
  baseCommit: 7f8ab1f6ead124ab11fa7b105403325270d2a97e
---
# RtpTimelineRewriter: 上流を差し替えても下流の RTP タイムラインを連続させる

## 1. 概要

werift-rtp に公開クラス `RtpTimelineRewriter` を追加しました。上流 RTP ソース（例: 30 分ごとに作り直す上流 WebRTC 接続）が変わっても、下流の RTP / SRTP セッションが見る seq / timestamp を途切れさせません（dgreif/ring#1816 の用途）。

これまで連続化のコアは `RtpContinuity` にありましたが、ソース切替の検出、timestamp step の決定、旧ソースの遅延パケットの破棄、共有パケットの clone は呼び出し側の責任でした。そのため `RTCRtpSender` を通さないアプリ（`SrtpSession` で直接送る構成など）は使いにくい状態でした。新クラスはこれらを `RtpContinuity` の上にまとめ、`werift-rtp` と `werift` の両方から import できます。`RTCRtpSender` の送信経路の挙動は変えていません。

- 実装: [packages/rtp/src/rtp/timelineRewriter.ts:1](review-file:packages/rtp/src/rtp/timelineRewriter.ts:1)
- 差分: [packages/rtp/src/rtp/timelineRewriter.ts](review-diff:packages/rtp/src/rtp/timelineRewriter.ts)

## 2. 修正前の問題と修正後の仕組み

<div style="display:flex;gap:16px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:300px;border:1px solid #c0392b;border-radius:8px;padding:12px">
<b style="color:#c0392b">Before: 呼び出し側が全部やる</b>
<ol style="margin:8px 0 0 18px;padding:0;line-height:1.7">
<li>上流を作り直す</li>
<li>アプリが切替を検出して <code>RtpContinuity.schedule(step)</code> を呼ぶ</li>
<li>step を自前で決める（既定 1）</li>
<li><code>header</code> を直接書き換えるので自前で <code>clone()</code></li>
<li style="color:#c0392b">旧ソースの遅延パケットが新 offset で写像され、出力 seq が衝突・後退</li>
<li style="color:#c0392b">新ソース内の古いパケットが旧出力以下になり、SRTP replay 扱い</li>
</ol>
</div>
<div style="flex:1;min-width:300px;border:1px solid #1e8449;border-radius:8px;padding:12px">
<b style="color:#1e8449">After: <code>rewrite(packet, { source })</code> 1 回</b>
<ol style="margin:8px 0 0 18px;padding:0;line-height:1.7">
<li>上流を作り直す（<code>source</code> キーを変える）</li>
<li style="color:#1e8449">source / SSRC の変化を自動検出して切替を予約</li>
<li style="color:#1e8449">step は number / lastDelta / wallClock / auto で決定</li>
<li style="color:#1e8449">既定で <code>clone()</code>（<code>inPlace</code> で無効化可）</li>
<li style="color:#1e8449">旧ソースの遅延パケットは <code>staleSource</code> で破棄</li>
<li style="color:#1e8449">新ソースの先頭より古いパケットは <code>beforeSourceStart</code> で破棄</li>
</ol>
</div>
</div>

<p style="font-size:12px;color:#666;font-family:sans-serif">赤は修正前に呼び出し側の責任で、壊れうる箇所。緑は新クラスが肩代わりする箇所。</p>

同じソース内では output = input + offset なので、reorder と欠落の相対関係は保たれます。ring#1816 の「前パケットとの差分を積み上げる」方式は reorder で出力が飛ぶため採っていません。

## 3. 主要変更

### 3.1 新クラス `RtpTimelineRewriter`

- 切替の検出と予約: [packages/rtp/src/rtp/timelineRewriter.ts:225](review-file:packages/rtp/src/rtp/timelineRewriter.ts:225) の `rewrite()` が `source` キー変化と入力 SSRC 変化（`switchOnSsrcChange`、既定 true）を検出します。明示 API は `switchSource()` です。
- 旧ソースの破棄: `RetiredSources` が廃止済みの source / SSRC を保持します。エントリは追い出さないため、非常に古いパケットを新ソースと誤認して現在のソースを廃止することがありません。オブジェクトキーは WeakMap、プリミティブは Map です。
- 新ソース先頭より古いパケットの破棄: 16bit 符号付き差分を wrap 越しに追跡し、負なら `beforeSourceStart` で破棄します。第 1 ソースには適用しません。
- timestamp step: 数値、`"lastDelta"`、`"wallClock"`、`"auto"`（`clockRate` があれば wallClock、なければ lastDelta）。どの方式も最低 1 進みます。wallClock の時刻基準は「最大 timestamp を持つパケットの到着時刻」で、padding や遅延パケットでは動かしません。音声と映像を同時に切り替えたときの経過時間をそろえるためです。
- padding-only パケットは media と同じ seq 空間で写像します（落とすと seq に穴が空くため）。ただし `lastDelta` の増分には数えません。RTX は別 SSRC・別 seq 空間なので、同じインスタンスに渡さない前提を TSDoc に明記しています。
- 補助 API: `sequenceNumber` / `timestamp` / `mapTimestamp()`（上流 SR の書き換え用）、`onSourceSwitch`、`onDrop`。

### 3.2 `RtpContinuity.schedule` の拡張

[packages/rtp/src/rtp/continuity.ts:37](review-file:packages/rtp/src/rtp/continuity.ts:37) に、省略可能な第 2 引数 `from` を足しました（[差分](review-diff:packages/rtp/src/rtp/continuity.ts:37)）。

- 理由: 直前に assign された出力が reorder した古いパケットだと、「最後の出力 + 1」が最大出力より小さくなり、切替後に出力 seq が後退しうるためです。新クラスは「これまでの最大出力」を `from` で渡します。
- `from` を省略したときの挙動は従来どおりです。`RTCRtpSender` と既存テストの約束は変わりません。

### 3.3 RTCRtpSender 経路の導線（TSDoc のみ）

[packages/webrtc/src/media/rtpSender.ts:724](review-file:packages/webrtc/src/media/rtpSender.ts:724) の `replaceRTP` と [packages/webrtc/src/media/track.ts:211](review-file:packages/webrtc/src/media/track.ts:211) の `notifySourceChanged` に、「werift の送信経路ではこちら、`RTCRtpSender` を使わないなら `RtpTimelineRewriter`」という説明を追記しました。`header` 引数が offset 計算に使われない点も書いています。コードの挙動は変えていません。

### 3.4 テスト・example・ドキュメント

- テスト: [packages/rtp/tests/rtp/timelineRewriter.test.ts:1](review-file:packages/rtp/tests/rtp/timelineRewriter.test.ts:1)（19 件）。共通の Arrange は [packages/rtp/tests/rtp/rtpTestUtils.ts](review-diff:packages/rtp/tests/rtp/rtpTestUtils.ts) に集めています。ring#1816 のシナリオの再現（40000/90000, 40001/93000 → 100/5000, 101/8000 → 出力 40002/96000 付近）、wrap、複数回切替、`SrtpSession` の encrypt → decrypt が含まれます。
- example: [examples/mediachannel/rtp_forward/switch_source.ts:1](review-file:examples/mediachannel/rtp_forward/switch_source.ts:1)。`examples/e2e` のカタログ（[catalog.ts](review-diff:examples/e2e/tests/helpers/catalog.ts)）と [mediachannel.test.ts](review-diff:examples/e2e/tests/mediachannel/mediachannel.test.ts) にも載せています。
- README: [packages/rtp/README.md](review-diff:packages/rtp/README.md)（キーフレーム要求、RTCP の注意、`notifySourceChanged` / `replaceRTP` の説明）。
- [changelog.md](review-diff:changelog.md) と、`npm run doc` による `doc/` / `packages/rtp/doc` の再生成分。
- 公開 export: [packages/rtp/src/index.ts](review-diff:packages/rtp/src/index.ts)。

## 4. 判断理由

| 論点 | 採用 | 採らなかった案 |
| --- | --- | --- |
| 連続化の方式 | `RtpContinuity` を合成（offset 方式） | ring#1816 の delta 積み上げ（reorder で出力が飛ぶ） |
| `RtpContinuity` の拡張 | 省略可能な `from` 引数 | 新クラスに offset 計算を複製（ロジック重複） |
| `RTCRtpSender` 内部の置き換え | しない（別チケット向け） | epoch 管理・pacing・SR アンカーが絡むため今回は見送り |
| 破棄の記録 | 追い出さない `RetiredSources` | 件数上限付き LRU（古いパケットで現在のソースを廃止する恐れ） |
| 既定 step | `"auto"` | 固定 1（A/V 同期が崩れやすい） |

## 5. レビュアーが確認すべき点・リスク

- 公開 API の追加: `RtpTimelineRewriter` / `RtpTimelineRewriterOptions` / `RtpTimestampStepMode` / `RtpTimelineSwitch` / `RtpTimelineDropReason`。名前はチケットの候補から `RtpTimelineRewriter` に確定しました。
- `RtpContinuity.schedule` のシグネチャ変更は後方互換（省略可能引数の追加）です。`from` なしの経路が従来と同じかを [continuity.ts:73](review-file:packages/rtp/src/rtp/continuity.ts:73) 付近で確認してください。
- `RetiredSources` は追い出さないため、切替のたびにプリミティブキーが数バイト増えます。数十分ごとの切替では実用上無視できる想定ですが、無制限に増える点は認識しておいてください。
- `source` キーを使わず `switchSource()` だけを呼ぶ場合は、旧ソースと新ソースの遅延パケットを区別できません（TSDoc に明記）。`switchOnSsrcChange` の既定が true である点（SSRC が変わらず timeline だけ変わる入力では false にする）も確認してください。
- キーフレーム要求（PLI / FIR）と上流 SR の書き換えはアプリの責任です。README と TSDoc で案内していますが、ヘルパーは用意していません。
- 時計は `performance.now()` をグローバルから使い、Node 専用 API は持ち込んでいません（ブラウザバンドル対象のため）。`enum` も使っていません。

## 6. 検証結果

今回のドキュメント作成時に自分で実行したもの:

- `cd packages/rtp && npx vitest run tests/rtp/timelineRewriter.test.ts tests/rtp/sendPath.test.ts`: 2 ファイル 27 件がすべて成功。

今回は実行していないもの（チケットの完了条件に挙がっているが、本ドキュメント作成の範囲外）:

- `cd packages/rtp && npm test`（`type` と `type:public` を含む）、`npm run test:browser`、ルートの `npm run type` / `npm run test:small` / `npm run format`、`npm run examples:e2e`、`npm run doc` の再実行。これらの結果は本文書では確認していないため、実行済みとは書きません。
