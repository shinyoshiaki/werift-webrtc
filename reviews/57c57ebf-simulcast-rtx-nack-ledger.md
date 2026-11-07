---
ide:
  viewer: review-document
  version: 1
  title: "Simulcast RTX 受信と NACK 台帳のレビュー"
  dock: right
  baseCommit: dd10a379f169720e9c58a91c19e66f199f2ae9cb
---
# Simulcast + RTX 受信の修正（レビュー解説）

## 1. 概要

RID ベースの simulcast（Chrome は `a=ssrc-group:FID` を出さない）で届く RTX を、該当レイヤーの track に元の SSRC・シーケンス番号・payload type へ復元して届けるようにしました。あわせて NACK を媒体 SSRC ごとの状態に分け、レイヤー間の偽ロスと NACK 宛先ずれをなくしました。

要点は §8 の方針どおり、「NACK が要求している欠落」と「RTX を検証できる欠落」を同じ台帳（`NackStream.holes`）に一本化したことです。独立した窓や受信済みリングは持ちません。

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px">
<div style="border:1px solid #c66;border-radius:8px;padding:10px"><b>変更前</b><br>RTX は rid も ssrcTable も持たず <code>// bug</code> 分岐で破棄。<br>NACK は receiver 単位で 1 状態のため、レイヤーが混ざる。</div>
<div style="border:1px solid #4a8;border-radius:8px;padding:10px"><b>変更後</b><br>rrid で RTX SSRC を RID に結び付け、RID の現在の媒体 SSRC の欠落台帳に載る RTX だけ復元。<br>NACK と台帳は媒体 SSRC ごと。</div>
</div>

## 2. 主要変更

| 領域 | 内容 | リンク |
| --- | --- | --- |
| 欠落台帳と NACK | `NackHandler` が媒体 SSRC ごとに `NackStream` を持つ。欠落ごとに番号と前後パケットの timestamp を記録し、NACK 要求と RTX 検証が同じ台帳を使う | [packages/webrtc/src/media/receiver/nack.ts:156](review-file:packages/webrtc/src/media/receiver/nack.ts:156) / [diff](review-diff:packages/webrtc/src/media/receiver/nack.ts:156) |
| RTX の検証 | `canRepair` が「台帳に番号がある」かつ「timestamp が欠落前後の範囲に収まる（符号付き差、slack 付き）」を判定 | [packages/webrtc/src/media/receiver/nack.ts:215](review-file:packages/webrtc/src/media/receiver/nack.ts:215) |
| ルーティング | `repaired-rtp-stream-id` 付きパケットを RID の receiver へ渡し、最初の rid / rrid 付きパケットで SSRC を学習済み経路として登録（拡張が後で省略されても届く） | [packages/webrtc/src/media/router.ts:367](review-file:packages/webrtc/src/media/router.ts:367) / [diff](review-diff:packages/webrtc/src/media/router.ts:367) |
| RTX の結び付け | `handleRtxByRid` が RTX SSRC を RID に束縛。`mediaSsrcOfRtx` が RID の現在の媒体 SSRC だけを候補にして復元 | [packages/webrtc/src/media/rtpReceiver.ts:799](review-file:packages/webrtc/src/media/rtpReceiver.ts:799) / [packages/webrtc/src/media/rtpReceiver.ts:971](review-file:packages/webrtc/src/media/rtpReceiver.ts:971) |
| SSRC 切り替え | 同じ RID で媒体 SSRC は 1 つ。変わったらリセットし、旧 SSRC の NACK・台帳・RTX 対応を同時に捨て、遅着を破棄 | [packages/webrtc/src/media/rtpReceiver.ts:849](review-file:packages/webrtc/src/media/rtpReceiver.ts:849) |
| track codec | RTX/RED を飛ばす `primaryTrackCodec` を RID 登録と `resyncCodecs` で使用。古い「RTX 未対応」コメントを更新 | [packages/webrtc/src/media/codecCompatibility.ts:94](review-file:packages/webrtc/src/media/codecCompatibility.ts:94) / [packages/webrtc/src/media/router.ts:314](review-file:packages/webrtc/src/media/router.ts:314) |
| 破損パケット防止 | `originalSsrc` 未解決、`apt` codec 不在の RTX は破棄（壊れたパケットを流さない） | [packages/webrtc/src/media/rtpReceiver.ts:754](review-file:packages/webrtc/src/media/rtpReceiver.ts:754) |
| テスト | nack / router の単体テストと、`receiver.nack` の要求リストを判定基準にした property テスト | [packages/webrtc/tests/media/nack.test.ts](review-file:packages/webrtc/tests/media/nack.test.ts) / [packages/webrtc/tests/pbt/simulcastRtx/generator.ts](review-file:packages/webrtc/tests/pbt/simulcastRtx/generator.ts) / [packages/webrtc/tests/pbt/simulcastRtx/simulcastRtxProperty.test.ts](review-file:packages/webrtc/tests/pbt/simulcastRtx/simulcastRtxProperty.test.ts) |
| 文書 | `changelog.md`、`packages/webrtc/AGENTS.md`（`pbt:deep` に simulcastRtx を追加） | [changelog.md:47](review-file:changelog.md:47) |

## 3. 判断理由

- **台帳の一本化**: 以前は NACK の要求と RTX の検証が別々の上限で別々に保持され、片方だけ切れて不整合になりました。台帳から欠落を捨てるときに NACK 要求も同時に止まる構造にし、「NACK が (SSRC, seq) を要求している間は、その RTX を検証できる」を保証します。
- **同じ RID で媒体 SSRC は 1 つ**: 複数候補を持つ判定は採りませんでした。SDP に対応がない以上、RTX を候補から推測する方式は誤配信の余地が残るためです。切り替えはリセットとして扱い、判別できない遅着パケットの破棄を許容します。
- **SDP の対応がない RTX は台帳照合を必須にした**: 重複、NACK 未要求の番号、別ストリームの RTX は復元しません。

保証範囲外（チケット §5）: seq と timestamp の基点が同じストリーム（RFC 3550 §5.1 違反）は判別できません。

## 4. 保持上限と NACK を途中で切らない理由

| 上限 | 値 | 超えたときの扱い | NACK を切らない（または同時に捨てる）理由 |
| --- | --- | --- | --- |
| 台帳の欠落数 `MAX_HOLES` | 1024 / 媒体 SSRC | 古い欠落を台帳から削除 | 削除は欠落そのものの削除なので NACK 要求も同時に止まる。NACK 要求数 `LOST_SIZE`(150) より大きく、要求中の欠落は常に台帳にある ([nack.ts:19](review-file:packages/webrtc/src/media/receiver/nack.ts:19)) |
| seq 距離 | 0x8000 未満 | 超えた欠落を台帳から削除 | 16 bit では前後を区別できないため。台帳から消すのと同時に要求も止まる ([nack.ts:233](review-file:packages/webrtc/src/media/receiver/nack.ts:233)) |
| NACK 要求数 `LOST_SIZE` | 150（新しい順） | 要求だけ止める（台帳には残す） | 遅れて届く RTX を検証できるよう台帳は残す。要求が止まるだけで検証能力は縮まない |
| 再送回数 `retryCount` | 10 | 要求だけ止める（台帳には残す） | 同上 |
| NACK 状態の SSRC 数 `MAX_NACK_STREAMS` | 16 / receiver | 最も古く受信した SSRC を `close()` して削除 | SSRC ごとにタイマーと台帳を同時に捨てるので不整合なし ([nack.ts:26](review-file:packages/webrtc/src/media/receiver/nack.ts:26)) |
| RTX SSRC 数 | 8 / RID | 現在の媒体 SSRC を修復していないものから追い出す | 使用中の RTX は残る。追い出した SSRC の学習経路も同時に消す ([rtpReceiver.ts:63](review-file:packages/webrtc/src/media/rtpReceiver.ts:63)) |
| 退役 SSRC 数 | 8 / RID | 古いものから忘れる | 忘れた SSRC が再出現すると新しい切り替え（リセット）として扱う ([rtpReceiver.ts:70](review-file:packages/webrtc/src/media/rtpReceiver.ts:70)) |
| 媒体 SSRC 数 | 1 / RID | 切り替え時にリセット | 旧 SSRC の NACK・台帳・RTX 対応を同時に解放 |

## 5. レビュアーが確認すべき点・リスク

- **挙動の互換性**: `NackHandler` は公開 `receiver.onPacketLost` を維持（NACK 送信ごとに 1 回）。アイドル時にタイマーが止まるようになり、seq 比較が 16 bit 折り返しに対応しました。公開 API のシグネチャ変更はありません。
- **RTX の取りこぼし**: SDP に対応がない RTX は台帳に載る場合のみ復元します。NACK が要求していない RTX（たとえば送信側が自発的に送る再送）は破棄されます。実ブラウザでの影響は未確認です。
- **SSRC 変更時の遅着破棄**: リセット時に旧 SSRC と旧 RTX SSRC の遅着パケットを破棄します。判別不能パケットの破棄はチケットで許容済みです。
- **ネゴシエーション状態**: 学習した経路は rollback / commit を跨いで保持し、退役・追い出しした経路は baseline から復活させません（`snapshotRoutes` / `restoreRoutes`）。
- **timestamp slack**: B-frame を考慮して 1 秒（メディアクロック換算）。広めの値の妥当性を見てください。
- 実ブラウザ（Chrome）での手動確認の結果は、本ドキュメント作成時点では確認していません。

## 6. 検証結果

本ドキュメント作成時に自分で実行したもの:

- `cd packages/webrtc && npx vitest run tests/media/nack.test.ts tests/media/router.test.ts tests/pbt/simulcastRtx` → 3 ファイル / 88 テスト成功。

実行していないもの（過去のレビューで確認済みかもしれませんが、今回の作業では再確認していません）: `npm run type`、`npm run test:small`、`npm run e2e`、`npm run wpt`、`memleak`、`pbt:deep`、Chrome での `examples/mediachannel/rtx/simulcast_offer.ts` の手動確認。
