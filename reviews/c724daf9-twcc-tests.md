---
ide:
  viewer: review-document
  version: 1
  title: "TWCC / GCC 帯域推定のテストコード解説"
  dock: right
  baseCommit: de7a07b6b3ff376f98a16df52ec53a199798b1b8
---
# TWCC / GCC 帯域推定のテストコード解説

## 1. 概要

このチケットでは、送信側の帯域推定（BWE）を差し替え可能にし、legacy（既定）と GCC を選べるようにしました。この文書は、その動作を確かめるテストの構成・考え方・各テストの役割をまとめたものです。

テストの基準は、チケット §2.12 で決めた「**GCC として正しく機能すること**」です。libwebrtc と同じ処理順・同じ境界値で動くかは見ません。実装はいまも libwebrtc を参考にした処理を残していますが、それを 1 対 1 で固定するテストは削除しました。

テストは次の 5 層に分かれます。下の層ほど速く決定的で、CI で毎回動きます。上の 2 層（シミュレーション）は CI 対象外で、手動で実行します。

<div style="display:flex;flex-direction:column;gap:6px;font-size:13px">
  <div style="padding:6px 10px;border:1px dashed var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>⑤ Chrome ↔ werift シミュレーション</strong>（CI 対象外）　実ブラウザとの相互接続で、帯域超過 → 推定低下 → 追従でドロップ減少</div>
  <div style="padding:6px 10px;border:1px dashed var(--review-border);border-left:4px solid var(--review-warning);border-radius:6px"><strong>④ werift peer 間シミュレーション</strong>（CI 対象外）　実 RTCPeerConnection 2 つを仮想ボトルネックでつなぐ</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:6px"><strong>③ GCC 制御応答テスト</strong>　決定的な仮想ボトルネックで「混んだら下げる・空いたら上げる」を範囲で判定</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-left:4px solid var(--review-accent);border-radius:6px"><strong>② 性質テスト（PBT）</strong>　seed ごとのランダム入力で、どんな入力でも成り立つ不変条件を確かめる（twcc / bwe / sender / receiver）</div>
  <div style="padding:6px 10px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px"><strong>① 例ベースの回帰テスト</strong>　共通契約・API・過去のレビューで見つかった werift の不具合を固定の例で確かめる（rtp パッケージの不正入力を含む）</div>
</div>

## 2. 共通の Arrange（テスト準備）

AGENTS.md の規約（Arrange / Act / Assert、共有の準備は 1 つのユーティリティにまとめる）に合わせ、準備処理は次のファイルに集めています。

**送信側・TWCC 用** — [packages/webrtc/tests/media/twccTestUtils.ts](review-file:packages/webrtc/tests/media/twccTestUtils.ts)
- 接続済みの VP8 + TWCC + RTX の sender を作る [prepareConnectedSender (twccTestUtils.ts:316)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:316)。BUNDLE で同じ DTLS に 2 本目をつなぐ [attachSender (twccTestUtils.ts:280)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:280) も使えます。
- DTLS への書き込みを記録する [recordDtlsWrites (twccTestUtils.ts:204)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:204)、最初の書き込みを止めて送信中の競合を作る [holdFirstWrite (twccTestUtils.ts:224)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:224)。
- GCC の probe を開始する [startGccProbing (twccTestUtils.ts:142)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:142)、止める [settleGccProbe (twccTestUtils.ts:170)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:170)。
- 合成または wire 形式の TWCC を作る [syntheticTwccFeedback (twccTestUtils.ts:36)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:36) と [wireTwccFeedback (twccTestUtils.ts:59)](review-file:packages/webrtc/tests/media/twccTestUtils.ts:59)。

**受信側用** — [packages/webrtc/tests/media/rtpReceiverTestUtils.ts](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts)
- receiver を作る [createVideoReceiver (rtpReceiverTestUtils.ts:19)](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts:19)、`onReceiveRtp` の配送を記録する [collectReceivedRtp (rtpReceiverTestUtils.ts:161)](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts:161)、`["m10", "p11", "m12"]` の形で media / padding を流す [receiveMediaOrPadding (rtpReceiverTestUtils.ts:177)](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts:177)。

**GCC の決定的シミュレーション** — [packages/webrtc/tests/media/gccSimulation.ts](review-file:packages/webrtc/tests/media/gccSimulation.ts)
- 1ms 刻みのモデルです。バイト上限つき FIFO が `capacityBps` で吐き出し、片道遅延とランダムロスを加えます。受信側は wire 形式の TWCC（250µs 量子化）を返し、probe cluster は `RTCRtpSender` と同じ要領で padding を詰めます。入口は [runGccSimulation (gccSimulation.ts:79)](review-file:packages/webrtc/tests/media/gccSimulation.ts:79) です。

## 3. 各層のテスト

### ① 例ベースの回帰テスト

**帯域推定の本体** — [packages/webrtc/tests/media/bandwidthEstimator.test.ts](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts)（37 件）

| グループ | 確かめること |
| --- | --- |
| 共通契約 | probe / RTT / process は共通 interface にあり、legacy と disabled では何もしない。congestion 系 API は共通 interface に無い（型レベル）。`senderBWE` は getter だけ |
| legacy | pacing で遅れない。送信履歴の掃除が償却 O(1) |
| TWCC 入力の解釈 | 壁時計とずれた受信時刻、空の TWCC、24-bit `reference_time` の周回、`receivedAtMs = 0`、16-bit 周回した probe 番号 |
| 送信経路 | padding は RTX の padding-only RTP で送り、`SentInfo` のサイズと一致し、SR の octetCount に数えない。BUNDLE での TSN 順、FIFO の上限、padding が待ち media に譲る、`sendingAtMs` の時刻、RED を組み立てた後のサイズ、TWCC 未交渉時 |
| 差し替え・停止 | 差し替え後の配送、ProcessInterval のタイマー、送信中の差し替えや stop による汚染の防止、dispose |

共通契約は [bandwidthEstimator.test.ts:105](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts:105)、送信経路は [bandwidthEstimator.test.ts:561](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts:561)、差し替え・停止は [bandwidthEstimator.test.ts:815](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts:815) から始まります。送信中の差し替えと stop の競合は、同じ骨格の [test.each (bandwidthEstimator.test.ts:939)](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts:939) にまとめています。

**選択 API** — [packages/webrtc/tests/media/peerConfigBandwidthEstimator.test.ts](review-file:packages/webrtc/tests/media/peerConfigBandwidthEstimator.test.ts)
- `bandwidthEstimator` の各 option（未指定 / `"legacy"` / `"gcc"` / `false` / `"none"`）から作られる estimator のクラスを、[表 (peerConfigBandwidthEstimator.test.ts:26)](review-file:packages/webrtc/tests/media/peerConfigBandwidthEstimator.test.ts:26) の 1 行ずつで確かめます。同じ行で `createBandwidthEstimator` の解釈も確かめます。

**送信側の回帰** — [packages/webrtc/tests/media/rtpSender.test.ts](review-file:packages/webrtc/tests/media/rtpSender.test.ts)
- 古い TWCC で新しい TSN を上書きしない [rtpSender.test.ts:1650](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1650)。NACK の再送は新しい TSN を使う [rtpSender.test.ts:1700](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1700)。
- probe padding は NACK されても再送せず、media の NACK だけを RTX で再送する [rtpSender.test.ts:1486](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1486)。
- legacy はバーストを欠落させず、送信キューも通さない（develop と同じ直接送信）[rtpSender.test.ts:1799](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1799)。
- probe の送信予定が 250ms 先なら、100ms で早く出さない [rtpSender.test.ts:1773](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1773)。
- replaceTrack・estimator の差し替えで、送信キューや probe・pacing の待ちに残った旧パケットを送らない [rtpSender.test.ts:1089](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1089)。

**受信側の回帰** — [packages/webrtc/tests/media/rtpReceiver.test.ts](review-file:packages/webrtc/tests/media/rtpReceiver.test.ts)、[packages/webrtc/tests/media/receiverTwcc.test.ts](review-file:packages/webrtc/tests/media/receiverTwcc.test.ts)、[packages/webrtc/tests/media/router.test.ts](review-file:packages/webrtc/tests/media/router.test.ts)
- 既定では padding-only も wire の seq のまま `type: "padding"` で届く [rtpReceiver.test.ts:562](review-file:packages/webrtc/tests/media/rtpReceiver.test.ts:562)。padding-only は TWCC と packet 数には数え、unmute・byte 数・NACK のロスには影響しない [rtpReceiver.test.ts:586](review-file:packages/webrtc/tests/media/rtpReceiver.test.ts:586)。
- BUNDLE の複数 receiver は同じ `ReceiverTWCC` を共有する [rtpReceiver.test.ts:672](review-file:packages/webrtc/tests/media/rtpReceiver.test.ts:672)。TWCC の RTCP は同じ DTLS の全 sender に配られ、別 DTLS には届かない [router.test.ts:78](review-file:packages/webrtc/tests/media/router.test.ts:78)。
- `ReceiverTWCC` は dumb receiver で、報告済みの番号に遅れて届いた packet を再報告しない [receiverTwcc.test.ts:32](review-file:packages/webrtc/tests/media/receiverTwcc.test.ts:32)。RunLength の 13-bit 上限 [receiverTwcc.test.ts:79](review-file:packages/webrtc/tests/media/receiverTwcc.test.ts:79)、`reference_time` の量子化 [receiverTwcc.test.ts:116](review-file:packages/webrtc/tests/media/receiverTwcc.test.ts:116) も固定の例で残しています。

**照合層の境界** — [packages/webrtc/tests/media/twccFeedbackAdapter.test.ts](review-file:packages/webrtc/tests/media/twccFeedbackAdapter.test.ts)
- 性質テストの生成器が作らない境界だけを残しています。最初の feedback は最新の送信番号を基準に世代を決める [twccFeedbackAdapter.test.ts:8](review-file:packages/webrtc/tests/media/twccFeedbackAdapter.test.ts:8)。遅れて届いた古い feedback で基準が戻らない [twccFeedbackAdapter.test.ts:20](review-file:packages/webrtc/tests/media/twccFeedbackAdapter.test.ts:20)。

**RTP パッケージ（プロトコル層）**
- 不正な RTP の拒否を [表 (packet.test.ts:246)](review-file:packages/rtp/tests/rtp/packet.test.ts:246) にまとめ、各行を `RtpHeader` と `RtpPacket` の両方で確かめます。
- padding-only RTP が SRTP を通っても復元できる [srtp.test.ts:61](review-file:packages/rtp/tests/srtp/srtp.test.ts:61)。RED の切り詰めの拒否 [red/packet.test.ts:42](review-file:packages/rtp/tests/rtp/red/packet.test.ts:42)。32-bit 境界の TWCC で古い P bit を外す [twcc.test.ts:601](review-file:packages/rtp/tests/rtcp/rtpfb/twcc.test.ts:601)。

### ② 性質テスト（PBT）

seed つきの乱数で入力を作り、どんな入力でも成り立つ性質を確かめます。乱数と seed の設定は、交渉の性質テストと同じ共通基盤を使います（[packages/webrtc/tests/pbt/shared/seeds.ts:7](review-file:packages/webrtc/tests/pbt/shared/seeds.ts:7)）。失敗したテストの名前には、その seed だけを再現する環境変数が出ます（例: `WERIFT_TWCC_SEED=5 WERIFT_TWCC_SEEDS=1 WERIFT_TWCC_STEPS=3000`）。

| suite | 確かめる性質 | 場所 |
| --- | --- | --- |
| twcc（144 件） | 周回・重複・並べ替え・再報告を混ぜても受信は高々 1 回で正しい世代にだけ対応する。wire 形式の往復、`reference_time` の展開、送信履歴の窓 | [twccProperty.test.ts:71](review-file:packages/webrtc/tests/pbt/twcc/twccProperty.test.ts:71) |
| bwe（72 件） | GCC の通知は有限・[min, max] 内・変化時だけ。legacy の推定値は min(送信, 受信) を独立に再計算した値と一致する | [bweProperty.test.ts:31](review-file:packages/webrtc/tests/pbt/bwe/bweProperty.test.ts:31) |
| sender（24 件） | 転送した media の番号は source の差を保ち、切替では連続し、padding は RTX の連番だけ。並行送信でも DTLS 書き込みは 1 本ずつで TSN は送信順 | [senderProperty.test.ts:94](review-file:packages/webrtc/tests/pbt/sender/senderProperty.test.ts:94) |
| receiver（72 件） | 順着なら出力 seq = 元の seq − それより前の padding 数。並べ替え・重複でも一意で順序を保つ。`ReceiverTWCC` は受信 TSN をちょうど 1 回、欠番を未受信としてだけ報告する | [receiverProperty.test.ts:73](review-file:packages/webrtc/tests/pbt/receiver/receiverProperty.test.ts:73) |

生成器はそれぞれのディレクトリの `generator.ts` にあります。たとえば受信側は、wrap 直前から始めることが多い media / padding 列を [randomMediaPaddingStream (generator.ts:24)](review-file:packages/webrtc/tests/pbt/receiver/generator.ts:24) で作ります。

### ③ GCC 制御応答テスト

[bandwidthEstimator.test.ts:401](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts:401) の 7 件です。`gccSimulation.ts` の仮想ボトルネックで、結果の**傾向**を範囲で判定します。

| 場面 | 判定 |
| --- | --- |
| 容量を超える送信が続く | 2 秒以内に容量付近まで下がり、0 には張り付かない |
| 容量に余裕がある | probe で 1 秒以内に開始値の 3 倍以上。収束後は容量の 70〜115%、キューはあふれない |
| 容量が下がる | 追従して下がり、追従後の 5 秒間はあふれが 0 |
| 容量が回復する | 推定が 2 倍以上に上がる |
| 片道 300ms の固定遅延だけ | 推定を下げない |
| ロス 20% | ロス 0% のときの半分未満 |
| TWCC feedback が途絶える | 途絶前の半分未満まで下がる |

### ④⑤ シミュレーション（CI 対象外）

- **werift peer 間**: [gccTwccCongestion.sim.test.ts:18](review-file:packages/webrtc/simulations/gcc-twcc-congestion/gccTwccCongestion.sim.test.ts:18) の 2 シナリオです。「容量超過で推定が下がり、追従後はドロップが減る」と、「容量内の低レートではほぼロスせず、padding は RTX にだけ出る」を確かめます。実際の RTCPeerConnection・SRTP・ICE を通るのはこの層からです。
- **Chrome ↔ werift**: [gccTwccChrome.sim.test.ts:14](review-file:e2e/simulations/tests/gccTwccChrome.sim.test.ts:14) の 1 シナリオです。Chrome は recvonly、werift は GCC 付きの sendonly で、ネットワークの制限は werift 側の ICE 送信で作ります。
- どちらも同じ仮想ボトルネック [BottleneckLink (bottleneckLink.ts:108)](review-file:packages/webrtc/simulations/helpers/bottleneckLink.ts:108) を使います。e2e にあった複製は、パケット種別ごとの統計とあわせて 1 つにまとめました。

## 4. 判断理由

- **libwebrtc との 1:1 一致は固定しない**: 以前の `bandwidthEstimator.test.ts` は 8,607 行・221 件で、大半が「2999 と 3000」「clamp と drop の順」などの境界と処理順を固定していました。小さな改善でも大量に落ち、テストが実装の写しになっていました。ユーザーの了承を得て、制御応答（傾向）と性質テスト（不変条件）に置き換えました。
- **不変条件で書けるものは性質テストにする**: レビューで反例が続いた 2 系統（TWCC の世代対応、メディア番号と padding）は、どちらも「どんな入力でも成り立つ」形で書けました。例を 1 本ずつ足すより、生成器で入力を広げる方が反例を先に見つけられます。
- **消す前に故障を入れて確かめる**: 例ベースのテストを消すときや性質テストに移すときは、毎回、実装を一時的に壊しました。残るテストが失敗することを確かめてから消しています。最初の生成器では見逃した故障もあり、そのときは生成器を強めました。経緯と件数はチケット §2.12 にあります。

## 5. 限界とリスク

- **Chrome との細かな挙動差は検出しない**: 立ち上がりの速さや probe の回数などです。判定は範囲なので、わずかな性能劣化も通ります。範囲は当時の実測値を基準に決めました。
- **性質テストは期待値の計算が正しい前提**: 一度、テスト側の期待値の丸めが 1 bps ずれて偽の失敗が出ました（300 seed の深い探索で発見）。
- **検出できないと分かっている故障**: 受信確定後の再報告の判定や padding ループの停止判定には、何重かの防御があります。そのため、そのうち 1 つだけを壊しても結果は変わらず、どのテストも失敗しません。
- **実トラフィックはシミュレーションだけ**: GCC の送信キューと RTX padding を、実際の Chrome や mediasoup で確かめたのは ④⑤ のシミュレーションまでです。④⑤ は CI 対象外なので、GCC / TWCC を変えたときは手動で実行する必要があります。

## 6. 実行方法と検証結果

| 目的 | コマンド |
| --- | --- |
| package のテスト（①②③） | `cd packages/webrtc && npm test` |
| 性質テストの深い探索 | `cd packages/webrtc && npm run pbt:deep -- --suite twcc,bwe,sender,receiver` |
| peer 間シミュレーション | `cd packages/webrtc && npm run test:sim` |
| Chrome とのシミュレーション | `cd e2e && npm run test:sim` |

この文書を書いた時点（HEAD `de7a07b6b`）で、このタスクの主なテストファイル 11 本を実行し、478 件すべて成功しました。内訳は `bandwidthEstimator.test.ts` 37 件と、性質テスト twcc 144・bwe 72・sender 24・receiver 72 件などです。直前の作業では、ほかに次も確認しました。
- 全テスト: 1,554 件成功・5 件 skip
- `pbt:deep`（300 seed）: 4,200 件成功
- 両方のシミュレーション: 成功
