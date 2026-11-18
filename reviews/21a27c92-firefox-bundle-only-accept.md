---
ide:
  viewer: review-document
  version: 1
  title: "Firefox bundle-only m-line の受け入れと拒否 m-line の c="
  dock: right
  baseCommit: 5d901e2e0522a924529e607a89b0ccea8dc61e04
---
# Firefox `a=bundle-only` m-line の受け入れと拒否 m-line の `c=`

## 1. 概要

Firefox は BUNDLE の非tag m-line を `port 0` + `a=bundle-only` で offer します（RFC 8843 §6）。werift はこれを「拒否された m-line」と解釈し、`c=` 行のない `port 0` の answer を返していたため、Firefox が SDP を拒否して交渉が失敗していました。

この変更で、BUNDLE に受け入れる bundle-only の m-line を通常の非tag m-line として受け入れ、answer では port 9 + `c=IN IP4 0.0.0.0`（`a=bundle-only` なし）で返します。あわせて、本当に拒否する m-line の answer にも `c=IN IP4 0.0.0.0` を出します（RFC 8866 §5.7）。

比較対象は develop `1f007fe89` です。この範囲には親チケット #269 の `bundleCandidates` も含まれますが、この文書は bundle-only に関する変更だけを扱います。

## 2. 修正前と修正後の流れ

<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;font-size:13px;line-height:1.5">
<div style="border:1px solid #d9534f;border-radius:8px;padding:10px">
<b style="color:#d9534f">Before</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li>Firefox の offer に <code>m=video 0</code> + <code>a=bundle-only</code>（mid 2, 3）</li>
<li><code>port === 0</code> なので「拒否」と判定（<code>RemoteMediaApplication</code> など 70 か所超）</li>
<li>transceiver を関連付けない・停止する</li>
<li><code>buildAnswerBundleGroups</code> が group から外す（<code>BUNDLE 0 1</code>）</li>
<li><code>buildAnswerSdp</code> の port 0 分岐が <code>c=</code> なしの m-line を出す</li>
<li style="color:#d9534f"><b>Firefox: <code>c= connection line not specified</code> で answer を拒否</b></li>
</ol>
</div>
<div style="border:1px solid #2e8b57;border-radius:8px;padding:10px">
<b style="color:#2e8b57">After</b>
<ol style="margin:6px 0 0 18px;padding:0">
<li>同じ offer を受信</li>
<li><code>SDPManager.parseSdp</code> 直後の <code>acceptBundleOnlyMedia</code> が、group に入る bundle-only の内部 port を 9 にし <code>acceptedBundleOnly</code> を立てる</li>
<li>既存の「port 0 = 拒否」判定は変更せず、受け入れ扱いになる</li>
<li>group に残る（<code>BUNDLE 0 1 2 3</code>）</li>
<li style="color:#2e8b57">answer は port 9 + <code>c=IN IP4 0.0.0.0</code>、<code>a=bundle-only</code> なし</li>
<li style="color:#2e8b57"><b>Firefox が受理し、DataChannel と映像が往復</b></li>
</ol>
</div>
</div>

*図: 同じ Firefox offer を受けたときの処理の流れ。赤が問題の経路、緑が修正後の経路。*

70 か所以上ある `port === 0` 判定を個別に書き換えず、パース直後に 1 か所で内部 port を置き換える方式にしています。`remoteDescription` と `toString()` は受信した値（port 0）のまま出力します。

## 3. 主要変更

### パースと出力

- [packages/webrtc/src/sdp.ts:176](review-file:packages/webrtc/src/sdp.ts:176) で `a=bundle-only` を読みます。変更の核は [packages/webrtc/src/sdp.ts:176](review-diff:packages/webrtc/src/sdp.ts:176) です。
- [packages/webrtc/src/sdp.ts:465](review-file:packages/webrtc/src/sdp.ts:465) の `bundleOnly` は読み書きの対象です。[packages/webrtc/src/sdp.ts:472](review-file:packages/webrtc/src/sdp.ts:472) の `acceptedBundleOnly` は、内部 port を置き換えた m-line の印です。`toString()` は、この印があれば port 0 を書きます（[packages/webrtc/src/sdp.ts:500](review-file:packages/webrtc/src/sdp.ts:500)）。
- ICE 資格情報のない m-line が group から引き継ぐ処理を、m-line index ではなく MID で探すように直しました。bundle-only の m-line は資格情報を省略でき、MID と index が一致しないと例外になっていたためです。差分は [packages/webrtc/src/sdp.ts](review-diff:packages/webrtc/src/sdp.ts) にあります。

### 受け入れの判定（answer 側）

- [packages/webrtc/src/sdpManager.ts:339](review-file:packages/webrtc/src/sdpManager.ts:339) で remote offer のパース直後に `acceptBundleOnlyMedia`（[packages/webrtc/src/sdpManager.ts:363](review-file:packages/webrtc/src/sdpManager.ts:363)）を呼びます。差分は [packages/webrtc/src/sdpManager.ts:363](review-diff:packages/webrtc/src/sdpManager.ts:363) です。
- 受け入れない条件は次の三つです。いずれも本当の拒否として扱い、`c=` を出します。
  - `bundlePolicy: "disable"`
  - MID がどの BUNDLE group にも入っていない
  - bundle-only の m-line が group の tag 自身（JSEP §5.10 / RFC 8843 §6）
- [packages/webrtc/src/sdpManager.ts:1106](review-file:packages/webrtc/src/sdpManager.ts:1106) の `rejectBundleOnlyWithoutTag` は、answerer が tag を拒否した場合に代替 tag を選びます。代替がなければ bundle-only の m-line を拒否します（RFC 8843 §7.3.1）。

### 拒否 m-line の `c=`

- [packages/webrtc/src/sdpManager.ts:979](review-file:packages/webrtc/src/sdpManager.ts:979) の `buildAnswerSdp()` の port 0 分岐に `media.host = DISCARD_HOST` を追加しました。差分は [packages/webrtc/src/sdpManager.ts:979](review-diff:packages/webrtc/src/sdpManager.ts:979) です。`c=` が出なかったのはこの分岐だけでした。

### transport パラメータの参照元

- [packages/webrtc/src/negotiation/remoteMediaApplication.ts:461](review-file:packages/webrtc/src/negotiation/remoteMediaApplication.ts:461) で、ICE / DTLS パラメータと候補の参照元から、受け入れた bundle-only の m-line を除きます。差分は [packages/webrtc/src/negotiation/remoteMediaApplication.ts:461](review-diff:packages/webrtc/src/negotiation/remoteMediaApplication.ts:461) です。
- answer の新 tag の選び方（`buildAnswerBundleGroups`）と同じ規則にそろえるための修正です。bundle-only の m-line は候補を省略でき、参照元にすると tag の候補が適用されませんでした（承認後レビューの指摘、`[bundle-only-8]`）。
- あわせて、SCTP の「answer で m=application を拒否した」判定に `sctpTransport?.mid` を加えています。

### テスト・E2E・docs

- [packages/webrtc/tests/negotiation/cases/negotiationTransactionBundleOnly.test.ts:71](review-file:packages/webrtc/tests/negotiation/cases/negotiationTransactionBundleOnly.test.ts:71) に、再 offer での追加（1）、ICE restart（2）、`max-bundle` の初回（3）、拒否の各条件（4〜7）、tag 拒否時の代替 tag（7, 8）、rollback のケースを追加しました。
- [packages/webrtc/tests/sdp.test.ts](review-diff:packages/webrtc/tests/sdp.test.ts) にパースと出力の往復テストを追加しました。PBT の oracle にも「全 m-line に `c=` がある」検査を追加しています（[packages/webrtc/tests/pbt/model/oracles.ts](review-diff:packages/webrtc/tests/pbt/model/oracles.ts)）。
- [e2e/tools/firefoxBundleOnly.ts](review-file:e2e/tools/firefoxBundleOnly.ts) は、Firefox 157 との直結確認スクリプトです（6 シナリオ）。
- [changelog.md](review-diff:changelog.md) に修正内容を記載しました。

## 4. 判断理由

| 判断 | 理由 | 採らなかった案 |
| --- | --- | --- |
| パース直後に内部 port を 9 へ置き換える | 70 か所超の拒否判定を触らずに済み、`mLineReuse: "aggressive"` の port 0 + inactive（拒否ではない）との混同も避けられる | 判定関数 `isRejectedRemoteMedia` を各所へ導入する案（変更範囲が広く、remote / local の取り違えが起きやすい） |
| answer の非tag は port 9 + `c=IN IP4 0.0.0.0` | Chrome 156 の実測と一致し、Firefox が受理することを直結確認で確かめた | Firefox 流の実ポートを書く案 |
| werift の offer は `a=bundle-only` を出さない | Chrome 互換を優先した。範囲を広げる場合は別チケットにする | `max-bundle` で出す案 |

## 5. レビュアーが確認すべき点・リスク

- **内部の port と出力の port が一致しない。** `acceptedBundleOnly` の m-line は、内部では port 9、`toString()` では port 0 です。この m-line の `port` を読む新規コードは、拒否ではないことに注意が必要です。
- **公開 API の変更。** `MediaDescription` に `bundleOnly` と `acceptedBundleOnly` が増えます。`acceptedBundleOnly` は内部用の印です。
- **answer の変化。** 拒否 m-line の answer に `c=IN IP4 0.0.0.0` が増えます。これは意図した差分で、negotiation-diff では差分 0 でした。
- **`pbt:deep` は exit 1 のままです。** チケット §7.2 の基準で判定してください。確定した失敗は leak P3 の heap seed 4 だけで、develop でも同じ env・同じメッセージで再現しています（スコープ外）。model seed 275 は develop にもある既知の flake です（サブタスク B / C で扱います）。
- コードの追加変更はチケット §7.3 のとおり想定していません。

## 6. 検証結果

チケット §6 / §7 に記録された結果を転記しています。この文書の作成にあたり、テストなどは再実行していません。

- `npm run type` 成功。`npm test`（packages/webrtc）は 82 files、1747 passed、5 skipped。
- `npm run pbt:deep -- --jobs 3` は exit 1。fuzz / scenario / model の確定した失敗はなく、leak P3 の heap seed 4 のみが失敗しました（develop でも再現）。
- negotiation-diff（develop 比、`--mutate 0.3`、seed 1–25）: 差分 0。
- `npm run e2e`（Chrome）: 24 files、68 tests passed。
- Firefox 157 直結確認 6 シナリオ（`max-bundle` / `balanced` の初回、video を追加する再 offer、Firefox 起点の ICE restart）: すべて pass。変更前は 6 件とも `c=` エラーで失敗しました。
