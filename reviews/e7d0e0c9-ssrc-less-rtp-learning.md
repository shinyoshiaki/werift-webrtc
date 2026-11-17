---
ide:
  viewer: review-document
  version: 1
  title: "#356 SSRCなしSDPの単一ストリームRTP学習"
  dock: right
  baseCommit: 1e89ac22bc6b79d4e606c469db8dcbd137f2d015
---
# #356 SDPにSSRCがない単一ストリームのRTPを学習して配送する

## 1. 概要

SDPに `a=ssrc` がない m-line（SIPゲートウェイ、SBC など）から届くRTPは、これまで `ssrcReceiver not found` で全部捨てられていました。今回の変更で、未知のSSRCを RFC 9143 §9.2 の順序（MID、次に一意なペイロードタイプ）で受信先 receiver に結び付けて学習し、`ontrack` で通知済みの track に初回パケットから配送します。

変更の中心は `RtpRouter` の未知SSRC学習（`learnUnknownSsrc`）と、学習したSSRCを通知済み track に結び付ける `RTCRtpReceiver` 側の処理です。`sdp.ts` は変更していません（`a=rtcp:48037` のパースは #355 の範囲で、テストでは該当1行だけをヘルパーで除いています）。

### 受け入れテスト（ここだけ見れば目的の達成を確認できます）

[packages/webrtc/tests/media/acceptance.test.ts](review-file:packages/webrtc/tests/media/acceptance.test.ts:17)（4 件、約 2 秒）。実行: `cd packages/webrtc && npx vitest run tests/media/acceptance.test.ts`

| テスト | 確認すること |
| --- | --- |
| (RingCentral offer) 3.2・3.3・3.4 | 報告された offer の RTP が初回パケットから `ontrack` の track に届き、SSRC が変わっても同じ track に届き続ける（`ontrack` は再発火しない） |
| (werift 同士、BUNDLE) 3.2・3.3 | 実際の ICE / DTLS 接続で、`a=ssrc` と MID のない audio / video がそれぞれの track に届き、相手の SR と inbound-rtp 統計も学習した SSRC に追従する |
| (werift 同士、BUNDLE) 3.2 | PT が重なる 2 本は推測せず、どちらにも届けない |
| (werift 同士、transport 別) 3.7・3.8 | 同じ PT の 2 本も RTP session が分かれていればそれぞれの track に届く |

実装を 6 か所（transport を渡さない、曖昧判定、PT 一意性の transport 絞り込み、通知済み track への結び付け、SSRC 切替の学習、SR の SSRC 引き当て）壊すと、それぞれ対応する件が落ちます。develop では曖昧判定の件以外の 3 件が「何も届かない」で落ちます。詳細はチケット 8 章。

## 2. 修正前と修正後の流れ

<div style="display:flex;gap:12px;flex-wrap:wrap;font-family:sans-serif;font-size:13px">
<div style="flex:1;min-width:320px;border:1px solid #c0392b;border-radius:8px;padding:10px">
<b style="color:#c0392b">Before</b>
<ol style="margin:6px 0 0 18px">
<li>DTLS から RTP 到着 → <code>router.routeRtp(rtp)</code>（transport を渡さない）</li>
<li><code>ssrcTable[ssrc]</code> なし（SDPに SSRC がない）</li>
<li>RID 拡張なし、simulcast の <code>trackBySSRC</code> にも該当なし</li>
<li style="color:#c0392b"><b>MID 拡張があっても route 決定に使わない → <code>ssrcReceiver not found</code> で破棄</b></li>
<li style="color:#c0392b">アプリの <code>onReceiveRtp</code> には何も届かない</li>
</ol>
</div>
<div style="flex:1;min-width:320px;border:1px solid #1e8449;border-radius:8px;padding:10px">
<b style="color:#1e8449">After</b>
<ol style="margin:6px 0 0 18px">
<li>DTLS から RTP 到着 → <code>router.routeRtp(rtp, dtlsTransport)</code></li>
<li><code>ssrcTable[ssrc]</code> なし</li>
<li>RID 拡張なし、simulcast にも該当なし</li>
<li style="color:#1e8449"><b><code>learnUnknownSsrc</code>: MID があればその m-line、なければ transport 上で PT を受信する m-line が1つだけのとき候補にする</b></li>
<li style="color:#1e8449"><b><code>bindFallbackSsrc</code>: 通知済みの <code>defaultTrack</code> に SSRC を結び付け、初回パケットから配送</b></li>
</ol>
</div>
</div>

<p style="font-size:12px;color:#555">図: 同じ入力（SSRC なし m-line への最初の RTP）に対する経路。赤が破棄される経路、緑が学習して配送される経路。曖昧・RTX・別 transport・未知 PT の場合は After でも破棄しますが、理由はログで区別できます。</p>

## 3. 主要変更

- transport の受け渡し: [packages/webrtc/src/peerConnection.ts:1093](review-file:packages/webrtc/src/peerConnection.ts:1093) で `routeRtp(rtp, dtlsTransport)` にしました（`routeRtcp` と同じ形）。差分は [こちら](review-diff:packages/webrtc/src/peerConnection.ts:1093)。transport なしの `routeRtp(packet)` は従来どおり学習せず drop します。
- 未知SSRCの学習: [packages/webrtc/src/media/router.ts:1060](review-file:packages/webrtc/src/media/router.ts:1060) の `learnUnknownSsrc`。変更の核は [router.ts](review-diff:packages/webrtc/src/media/router.ts:1060) です。
  - MID があれば、その transceiver だけが候補です。transport・受信方向・PT・SSRC 未指定を満たさなければ、別 m-line へ推測せず drop します。
  - MID がなければ、transport 上の受信中 m-line のうち PT（media / RTX）を受信するものが1つだけのときに限り学習します。`a=ssrc` や RID を持つ m-line が該当する場合は何も学習しません。
  - RTX は SSRC の対応付けができないため学習しません。drop 理由は `UnknownSsrcDrop` で区別し、同じ理由の連続ログは抑止します。
- 学習の表現: 学習SSRCは `RouteOrigin.learned` の route として持ちます（優先順位は sender > sdp > learned）。経路は「SSRC → 経路の集合」で、transport（RTP session）ごとに解決します。MID / RID / RRID も同じくパケットの transport 内で解決します（TSDoc 表: [router.ts:170](review-file:packages/webrtc/src/media/router.ts:170)）。
- receiver 側: [packages/webrtc/src/media/rtpReceiver.ts:84](review-file:packages/webrtc/src/media/rtpReceiver.ts:84) の `MAX_FALLBACK_SSRCS = 8` による有界 LRU と、[rtpReceiver.ts:318](review-file:packages/webrtc/src/media/rtpReceiver.ts:318) 付近の `bindFallbackSsrc`。新しいSSRCは置き換えではなく追加され、旧SSRCの遅延パケットも同じ track に届きます。`track.ssrc` は最新のSSRCです。MID による対応付けの更新は、拡張 seq が新しいパケットに限ります。
- ontrack の整合: [packages/webrtc/src/transceiverManager.ts:140](review-file:packages/webrtc/src/transceiverManager.ts:140) の `notifyRemoteTrack` と、[packages/webrtc/src/negotiationTransaction.ts:299](review-file:packages/webrtc/src/negotiationTransaction.ts:299) の `notifyCommittedRemoteTracks` で、通知済み track と同じものを二重通知しないようにしています。学習は通知済みの `receiver.track` に結び付くので、アプリが受け取った track にそのままRTPが届きます。
- pending / rollback / SDP 上書き: pending 中の学習は即時に route へ入ります。commit で SDP の SSRC / RID が有効になると学習分は外れ、RID を運んでいたSSRCはその RID の media SSRC になります。rollback は、学習した route を残しつつ、巻き戻した description だけが与えた PT で学習した分を忘れます。詳細は [router.ts:178](review-file:packages/webrtc/src/media/router.ts:178) 以降の TSDoc に書きました。
- ドキュメント: `doc/` は `npm run doc` で再生成されたもの、`packages/webrtc/README.md` と [compatibilityOptions.ts](review-file:packages/webrtc/src/api/compatibilityOptions.ts:16) の文言（「その transport 上の唯一の video sender」）を更新しています。
- テスト: [packages/webrtc/tests/issue/356.test.ts](review-file:packages/webrtc/tests/issue/356.test.ts:41)（RingCentral offer の配送、SR と統計、werift 同士の BUNDLE）、[packages/webrtc/tests/media/router.test.ts](review-file:packages/webrtc/tests/media/router.test.ts)（組み合わせ表・rollback・上限）、共有 Arrange の [ssrcLessTestUtils.ts](review-file:packages/webrtc/tests/media/ssrcLessTestUtils.ts)、property テスト（`tests/pbt/model/ssrcLessTraffic.ts` ほか）。

## 4. 判断理由

| 論点 | 採用 | 採用しなかった案 |
| --- | --- | --- |
| 新しい track の作成 | 通知済みの `defaultTrack` に結び付ける | 学習時に新 track を作る（`ontrack` で渡した track に RTP が届かなくなる） |
| 候補の持ち方 | 現在の transceivers から都度計算（永続テーブルを増やさない） | 学習専用の表（staging / rollback 規則が増える） |
| 学習SSRCの上限 | receiver ごとに 8 個の LRU、旧SSRCも残す（ユーザー承認済み） | 1個だけ保持して置き換え（遅延パケットが落ちる） |
| 曖昧な PT | 学習せず drop | 最初の m-line などへの推測（誤配送の危険） |
| #355 の扱い | `sdp.ts` を変更せず、テストで1行除去 | 本チケットで #355 も修正（SDP 出力の互換確認が混ざる） |

## 5. レビュアーが確認すべき点・リスク

- 挙動変更は「どの経路も該当しなかった未知SSRCの扱い」だけです。SDP のSSRC / RID / simulcast / sender の既存経路は、優先順位を保ったまま「SSRC → 経路の集合」に置き換えているため、`router.ts` の差分が大きい（約 1100 行）点に注意してください。
- 公開 API の追加はありません。`RtpRouter` の `doc/` 差分は内部メンバーの増加によるものです。
- 同じ PT を受信する m-line が複数あり MID もない場合は、配送されません（ブラウザと同じ考え方で、推測しない設計です）。
- RTX は SSRC を学習しないため、SSRC なし m-line では RTX 再送の受信に対応しません。
- 元の SDP（`a=rtcp:48037` を含む）での統合テストは、#355 が develop に入った後に有効にする必要があります（合流ルールはチケット 3.6）。
- `npm run pbt:deep` と `tools/negotiation-diff` による develop との差分確認は、チケットの完了条件ですが、今回の文書作成では実行していません。

## 6. 検証結果

今回（HEAD `1e89ac22b`）実行したもの:

- `npx vitest run tests/issue/356.test.ts tests/media/router.test.ts`（packages/webrtc）: 2 ファイル、212 テストすべて成功。

今回は実行していないもの（レビュー反復中の結果は、このセッションでは確認していません）:

- `npm run type`、`npm test` 全体、`npm run pbt:deep`、`npm run test:small`、`negotiation-diff`、`npm run format` の確認。
