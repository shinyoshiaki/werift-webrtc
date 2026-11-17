---
ide:
  viewer: review-document
  version: 1
  title: "#818 再オファーで削られたcodecを再提示する"
  dock: right
  baseCommit: 179197fd471f45fb210b3f2c518f6ed92c3e789e
---
# #818 再オファーで削られたコーデックを再提示する（レビュー解説）

## 概要

一度でもAnswerでcodecが絞られると、以降の `createOffer()` は絞られた集合しか提示しませんでした。RFC 8829 §5.2.2 は「現在使えるフォーマットはすべて含める」と定めているため、この挙動は仕様違反です。

本変更では、`transceiver.codecs` を「交渉済みcodec」に固定し、offer用の集合は `createOffer()` のたびに `TransceiverManager.resolveOfferCodecs()` で計算するようにしました。交渉済みcodecは交渉済みの形式（PT・fmtp・rtcp-fb）のまま残し、Answerで外れたcodecを設定上のPT（衝突時は空きPT）で足します。WPT `codecs-subsequent-offer` はPASSになりました。

## 修正前の問題と修正後の仕組み

再現条件は、A が `[VP8(96), VP9(98)]`、B が `[VP8(96)]` を設定している場合です。A がOfferし、B がVP8だけでAnswerし、A が再度 `createOffer()` します。

<div style="display:flex;gap:16px;flex-wrap:wrap">
<svg viewBox="0 0 420 330" width="420" role="img" aria-label="修正前のフロー" style="background:#fff;border:1px solid #ccc;border-radius:6px">
<text x="10" y="20" font-size="14" font-weight="bold" fill="#222">Before（修正前）</text>
<rect x="20" y="35" width="380" height="42" fill="#eee" stroke="#999"/><text x="30" y="60" font-size="12" fill="#222">setRemoteRTP: transceiver.codecs = Answerのcodec [VP8]</text>
<rect x="20" y="100" width="380" height="42" fill="#fde2e2" stroke="#c0392b"/><text x="30" y="118" font-size="12" fill="#222">codecs が「交渉済み」と「offer能力」を兼ねる</text><text x="30" y="134" font-size="12" fill="#c0392b">VP9 が失われる</text>
<rect x="20" y="165" width="380" height="42" fill="#eee" stroke="#999"/><text x="30" y="190" font-size="12" fill="#222">createOfferNow: codecs が空でなければ再解決しない</text>
<rect x="20" y="230" width="380" height="42" fill="#fde2e2" stroke="#c0392b"/><text x="30" y="248" font-size="12" fill="#222">buildOfferSdp(transceiver.codecs)</text><text x="30" y="264" font-size="12" fill="#c0392b">rtpmap = [VP8] のみ（VP9 を再提示できない）</text>
<path d="M210 77v23M210 142v23M210 207v23" stroke="#555" stroke-width="2"/>
</svg>
<svg viewBox="0 0 420 330" width="420" role="img" aria-label="修正後のフロー" style="background:#fff;border:1px solid #ccc;border-radius:6px">
<text x="10" y="20" font-size="14" font-weight="bold" fill="#222">After（修正後）</text>
<rect x="20" y="35" width="380" height="42" fill="#eee" stroke="#999"/><text x="30" y="60" font-size="12" fill="#222">setRemoteRTP: transceiver.codecs = Answerのcodec [VP8]</text>
<rect x="20" y="100" width="380" height="42" fill="#e0f4e4" stroke="#27ae60"/><text x="30" y="118" font-size="12" fill="#222">codecs は交渉済みのまま（送受信・統計用）</text><text x="30" y="134" font-size="12" fill="#1e8449">offer用の集合は別に計算する</text>
<rect x="20" y="165" width="380" height="42" fill="#e0f4e4" stroke="#27ae60"/><text x="30" y="183" font-size="12" fill="#222">resolveOfferCodecs → withNegotiatedCodecs</text><text x="30" y="199" font-size="12" fill="#1e8449">→ keepNegotiatedPayloadTypes（毎回）</text>
<rect x="20" y="230" width="380" height="42" fill="#e0f4e4" stroke="#27ae60"/><text x="30" y="248" font-size="12" fill="#222">buildOfferSdp(…, offerCodecs)</text><text x="30" y="264" font-size="12" fill="#1e8449">rtpmap = [VP8（交渉済みPT）, VP9(98)]</text>
<path d="M210 77v23M210 142v23M210 207v23" stroke="#555" stroke-width="2"/>
</svg>
</div>

凡例: 灰は変更のない処理、赤は問題の箇所、緑は修正で変わった箇所です。`createOffer()` を呼ぶだけでは `transceiver.codecs`、sender、receiver、router は変わらず、Answerが確定したときだけ置き換わります。

## 主要変更

### 1. offer用codecの解決 (`TransceiverManager`)

[packages/webrtc/src/transceiverManager.ts:727](review-diff:packages/webrtc/src/transceiverManager.ts:727) に `resolveOfferCodecs()` を追加しました。交渉済み（`currentDirection` あり）のtransceiverは、能力集合から毎回offer用codecを計算して `Map` で返し、`transceiver.codecs` には書き戻しません。交渉前のtransceiverは従来どおり `assignTransceiverCodecs()` です。

- 交渉済みcodecを方向で絞らない（`direction` 変更や `removeTrack()` で外れない。外すのはAnswerだけ）。preferences と固定sourceは交渉済みcodecにも適用します（[transceiverManager.ts:781](review-file:packages/webrtc/src/transceiverManager.ts:781)）。
- 変更がないのに結果が空になる場合は交渉済み集合をそのまま提示し、codec変更で空になる場合は初回と同じ `NotSupportedError` にします。
- 既存の交渉済みm-lineがあるとき、後から足したm-lineも、他m-lineが使うPTを避けます（BUNDLEのPT空間は共有）。
- `filterCodecsByDirection` は `inactive` で全設定codecを返します。初回から `inactive` の構成が失敗していた既存問題も解消します。

### 2. codec合成と対応付け (`codecCompatibility.ts`)

- [packages/webrtc/src/media/codecCompatibility.ts:110](review-diff:packages/webrtc/src/media/codecCompatibility.ts:110) `pairCodecs`: codecを対にする唯一の規則です。(1) 完全に同じ形式 (2) 互換な形式 (3) 同じMIME type の3段で1対1に対応付けます。answer作成・remote answer適用（`resolveRemoteCodecSet`）と再オファーが同じ関数を使います。
- [packages/webrtc/src/media/codecCompatibility.ts:351](review-diff:packages/webrtc/src/media/codecCompatibility.ts:351) `withNegotiatedCodecs`: 交渉済みcodecに現在方向の能力を足します。
- [packages/webrtc/src/media/codecCompatibility.ts:534](review-diff:packages/webrtc/src/media/codecCompatibility.ts:534) `keepNegotiatedPayloadTypes`: 交渉済みcodecは交渉済みのオブジェクトのまま（PT・fmtp・rtcp-fb不変、RFC 3264 §8.3.2）、再追加するcodecは設定PTか空きPTで提示します。RTXの `apt` とREDの参照はPTの付け替えに追従し、primaryが残らないRTX/REDは落とします。
- `isCodecCompatible` はH264に加えてVP9 `profile-id` とAV1 `profile` を区別します（[codecCompatibility.ts:50](review-file:packages/webrtc/src/media/codecCompatibility.ts:50)）。

### 3. 呼び出し側とSDP生成

- [packages/webrtc/src/peerConnection.ts:669](review-diff:packages/webrtc/src/peerConnection.ts:669): `createOfferNow()` は毎回 `resolveOfferCodecs()` を呼びます。従来の「codecsが空のときだけ解決する」条件は廃止しました。
- [packages/webrtc/src/sdpManager.ts:575](review-diff:packages/webrtc/src/sdpManager.ts:575): `buildOfferSdp` が `offerCodecs` を受け取り、`createMediaDescriptionForTransceiver` の `codecs` 引数に渡します。省略時は `transceiver.codecs` です。
- [packages/webrtc/src/media/rtpTransceiver.ts:120](review-diff:packages/webrtc/src/media/rtpTransceiver.ts:120): `markCodecsForResolution()` は、交渉済みなら `codecs` を空にせず `negotiatedCodecsStale` を立てるだけにしました。`getPayloadType()` や統計が一時的に空になりません。`needsCodecResolution`（[rtpTransceiver.ts:127](review-file:packages/webrtc/src/media/rtpTransceiver.ts:127)）がAnswer側の再解決条件になり、snapshot / restore にもフラグを含めます。
- [packages/webrtc/src/peerConnection.ts:2029](review-diff:packages/webrtc/src/peerConnection.ts:2029): `createAnswerNow()` の再解決条件は `needsCodecResolution` に置き換えました。

## 判断理由

- 「能力をゼロから再計算する」案は、方向、固定source、preferences、RTX/RED、BUNDLEのPT空間がすべて新しい失敗面になり、レビューで1入力ずつ指摘されました。そこで「交渉済み集合に能力を足す」方式へ改めました（ticket §9）。
- 交渉済みcodecを設定上の形式へ書き換える案は、非対称な相手でPTやfmtpが変わるため採用していません。交渉済みのオブジェクトをそのまま提示します（§10）。
- 「同じMIME typeの別形式は再提示しない（covered）」規則は、能力の欠落になるため廃止しました。代わりに交渉側の対応付けを形式単位にしました（§11、§12）。
- preferences でVP8だけに制限した場合、再オファーにVP9は戻りません。これは意図した挙動です。

## レビュアーが確認すべき点・リスク

- 公開APIの変更はありません（`pairCodecs` / `negotiatesAs` / `withNegotiatedCodecs` / `keepNegotiatedPayloadTypes` は内部ヘルパの export で、`doc/functions/` に生成ドキュメントが追加されています）。
- 意図したdevelopとの差分:
  - Answerで削られたcodecが再オファーに戻ります。
  - answererが先頭以外の形式（H264 mode 0、VP9 profile 2 など）だけを設定している場合、developはMIME type照合で先頭形式に確定していましたが、本変更は自分の形式で応答します。
  - 固定sourceのcodecだけを提示する場合がありますが、developは相手がVP8を選ぶと offerer 側の `setRemoteDescription` が失敗していました。
  - 再オファーでPTが設定値に戻らず、交渉済みPTを保ちます。
- 交渉済み状態の `markCodecsForResolution()` が `codecs` を空にしなくなったため、rollbackとAnswer作成の経路（`negotiatedCodecsStale`）を重点的に見てください。
- 既存問題として、leak heap seed 4（developでも失敗）と model seed 287（DataChannelのtimeout。developでも同程度に発生）が残ります。本チケットの変更によるものではないとチケットに記録されています。

## 検証結果

以下はチケット（§9〜§12）に記録された、最終コミット `179197fd4` までの実行結果です。このドキュメント作成時には再実行していません。

| 確認 | 結果 |
| --- | --- |
| `npm run type`（rootとwebrtc） | エラー0 |
| `cd packages/webrtc && npm test` | 89ファイル、1876件成功、5件スキップ |
| model property（100 seed） | 160件成功 |
| 公開APIの非対称マトリクス（128行、develop比較） | 交渉済みの形式が変わる行は0 |
| `tools/negotiation-diff`（非対称4構成 × 15 seed、develop比較） | regression / divergence / hang / state difference すべて0 |
| `npm run wpt` | regression 0。`codecs-subsequent-offer` はPASS |
| `npm run pbt:deep` | fuzzは失敗0。既存のflakyとleak heap seed 4は上記のとおり |

回帰テストは [packages/webrtc/tests/issue/818.test.ts](review-file:packages/webrtc/tests/issue/818.test.ts) と [packages/webrtc/tests/media/codecResolution.test.ts](review-file:packages/webrtc/tests/media/codecResolution.test.ts) にあります。変更記録は [changelog.md](review-diff:changelog.md) です。
