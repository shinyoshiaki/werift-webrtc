---
ide:
  viewer: review-document
  version: 1
  title: "TWCC / GCC チケット（c724daf9）のレビューの進め方"
  dock: right
  baseCommit: 5952d17e8e19e658857ed41ca4a4d5a28b08e9fe
---
# TWCC / GCC チケット（c724daf9）のレビューの進め方

PR は分割せず、1 つの PR のまま、リスクの層ごとに読む範囲と読み方を変えて進めます。この文書はその手順書です。仕組みの解説は [reviews/c724daf9-twcc-gcc-mechanism.md](review-file:reviews/c724daf9-twcc-gcc-mechanism.md)、テストの役割は [reviews/c724daf9-twcc-tests.md](review-file:reviews/c724daf9-twcc-tests.md)、変更の要約は [reviews/c724daf9-twcc-bwe-abstraction.md](review-file:reviews/c724daf9-twcc-bwe-abstraction.md) にあります。

## 1. 概要

`develop...HEAD` の差分は **301 ファイル、+36,051 / −710 行、275 コミット** です。ただし、人が行単位で読む必要があるのは、既存の利用者の挙動に効く **約 3,500 行** だけです。残りは、機械的な確認、挙動による判断、テスト設計の確認で済ませます。

<div style="font-size:13px;color:var(--review-fg)">
  <div style="display:flex;height:28px;border:1px solid var(--review-border);border-radius:6px;overflow:hidden">
    <div title="パス 0: 機械確認 18,307 行" style="width:50.8%;background:var(--review-muted);opacity:.45"></div>
    <div title="パス 3: GCC 本体 6,002 行" style="width:16.6%;background:var(--review-warning);opacity:.75"></div>
    <div title="パス 1: 既定経路 3,513 行" style="width:9.7%;background:var(--review-danger)"></div>
    <div title="パス 4: テスト・シミュレーション 約 7,700 行" style="width:21.4%;background:var(--review-accent);opacity:.75"></div>
    <div title="その他 約 500 行" style="width:1.5%;background:var(--review-border)"></div>
  </div>
  <div style="display:flex;flex-wrap:wrap;gap:6px 16px;margin-top:8px">
    <span><span style="display:inline-block;width:10px;height:10px;background:var(--review-muted);opacity:.45"></span> パス 0 機械確認 18,307 行（51%）</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:var(--review-warning)"></span> パス 3 GCC 本体 6,002 行（17%）</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:var(--review-danger)"></span> <strong>パス 1 既定経路 3,513 行（10%）← 行単位で読む</strong></span>
    <span><span style="display:inline-block;width:10px;height:10px;background:var(--review-accent)"></span> パス 4 テスト・シミュレーション 約 7,700 行（21%）</span>
    <span><span style="display:inline-block;width:10px;height:10px;background:var(--review-border)"></span> その他（README・changelog・補助スクリプト）約 500 行</span>
  </div>
</div>

| パス | 対象 | 読み方 | 完了の基準 | 目安 |
| --- | --- | --- | --- | --- |
| 0 | 参照コピー・生成ドキュメント・解説文書 | 読まない。コマンドで確認する | 2 項目のコマンドが通る（今回確認済み） | 数分 |
| **1** | **既定経路（legacy）の `src`** | **行単位で読む** | 全ファイルを読み終え、§2.3 の「意図した変更」表の各項目に納得する | 1 回 400 行前後で 8〜9 回 |
| 2 | 公開 API | changelog・生成ドキュメント・型で外形を見る | 名前・既定値・破壊的変更が changelog と一致する | 1 回 |
| 3 | GCC 本体（opt-in） | 他との境界だけ行で読み、中身は挙動で判断する | 境界の読了と、既知差分・制御応答・E2E 結果への合意 | 2〜3 回 |
| 4 | テスト・シミュレーション | 守っている不変条件と実装の対応を見る | 対応表に抜けがない | 1〜2 回 |

おすすめの順番は 0 → 1 → 2 → 3 → 4 です。既定の利用者への影響が最も大きいパス 1 を、集中力のあるうちに読みます。

## 2. 進め方

### 2.1 差分の見方（全パス共通）

- **コミット単位では読みません。** 275 コミットの大半はレビュー対応の修正の積み重ねで、途中の状態を追っても判断の助けになりません。最終形の差分を `git diff develop...HEAD -- <path>` で読みます。
- この文書のリンクは、**現在のファイルの該当行**を開きます（`review-file:`）。作業ツリーが clean なので、Viewer の Diff リンクは develop との差分を表示しません。差分は上のコマンドで見てください。
- 行番号は HEAD `5952d17e8` 時点です。

### 2.2 パス 0：機械確認（読まない部分、18,307 行）

| 対象 | 行数 | 確認方法 | 今回の結果 |
| --- | --- | --- | --- |
| `third_party/libwebrtc-ref`（libwebrtc の参照用スナップショット、49 ファイル） | 9,070 | `PIN.json` の commit と取得日、`LICENSE` / `PATENTS` があること。`src` から import されていないこと。npm の配布物に入らないこと（`cd packages/webrtc && npm pack --dry-run`） | 確認済み。`src` からはコメントでの参照だけ。配布物 916 ファイルに `third_party` は 0 件で、`THIRD_PARTY_LICENSES_LIBWEBRTC.txt` は含まれる |
| 生成ドキュメント（`doc/`、`packages/rtp/doc`） | 約 6,800 | `npm run doc` で再生成し、差分が出ないこと | 確認済み。差分 0 |
| `reviews/`・`TICKET-twcc.md` | 約 2,450 | レビュー対象ではなく、読む順番の案内として使う | — |

参照スナップショットの出所は [third_party/libwebrtc-ref/PIN.json](review-file:third_party/libwebrtc-ref/PIN.json) です。`src` 側では [packages/webrtc/src/media/sender/estimators/gcc/constants.ts:38](review-file:packages/webrtc/src/media/sender/estimators/gcc/constants.ts:38) のコメントでだけ参照しています。

### 2.3 パス 1：既定経路（行単位、約 3,500 行）

既定の推定器は legacy です（[packages/webrtc/src/api/peerConfig.ts:298](review-file:packages/webrtc/src/api/peerConfig.ts:298)）。このパスで答える問いは 1 つです。

> develop と比べて、既存の利用者の挙動が変わるか。変わるなら、それは意図した不具合修正か。

答え合わせには、次の「意図した変更」の表を使います。前半はチケットの「develop との差分として残るもの」（[TICKET-twcc.md:282](review-file:TICKET-twcc.md:282)）、後半はその後のレビュー対応で既定経路にも入った変更です。表にない挙動の違いを見つけたら、それが指摘です。

| 意図した既定経路の変更 | 主な場所 |
| --- | --- |
| TSN を送信前に同期で割り当て、その値を `SentInfo.wideSeq` に使う（BUNDLE で他 sender の TSN を拾わない） | [packages/webrtc/src/media/rtpSender.ts:1749](review-file:packages/webrtc/src/media/rtpSender.ts:1749)、[packages/webrtc/src/transport/dtls.ts:492](review-file:packages/webrtc/src/transport/dtls.ts:492) |
| 転送元パケットの TWCC / abs-send-time 拡張で新しい値を上書きしない | [packages/webrtc/src/media/rtpSender.ts:1632](review-file:packages/webrtc/src/media/rtpSender.ts:1632) |
| NACK 再送に新しい TSN を割り当てる | [packages/webrtc/src/media/rtpSender.ts:2015](review-file:packages/webrtc/src/media/rtpSender.ts:2015) |
| padding-only パケットを NACK 用キャッシュに入れない | [packages/webrtc/src/media/rtpSender.ts:1767](review-file:packages/webrtc/src/media/rtpSender.ts:1767) |
| `sendingAtMs` は ICE に渡す直前の時刻 | [packages/webrtc/src/media/rtpSender.ts:1773](review-file:packages/webrtc/src/media/rtpSender.ts:1773) |
| legacy の送信履歴を 10 秒の時間窓で捨てる（develop は無制限に増えた） | [packages/webrtc/src/media/sender/estimators/legacyCumulativeBwe.ts:19](review-file:packages/webrtc/src/media/sender/estimators/legacyCumulativeBwe.ts:19) |
| TWCC の照合を共通の照合層で行う（重複・周回・他 sender の番号に強い） | [packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:62](review-file:packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:62) |
| 別の DTLS transport に移ると推定器の経路依存の状態を初期化する | [packages/webrtc/src/media/rtpSender.ts:569](review-file:packages/webrtc/src/media/rtpSender.ts:569) |
| TWCC は受信元 transport に今いる sender だけに配る | [packages/webrtc/src/media/router.ts:510](review-file:packages/webrtc/src/media/router.ts:510) |
| `ReceiverTWCC` を transport ごとに共有し、拡張 TSN と最大 32767 件の窓で報告する | [packages/webrtc/src/media/receiver/receiverTwcc.ts:108](review-file:packages/webrtc/src/media/receiver/receiverTwcc.ts:108) |
| `onReceiveRtp` に第 3 引数（`media` / `padding` / `retransmission`）を渡し、padding-only では unmute しない | [packages/webrtc/src/media/track.ts](review-file:packages/webrtc/src/media/track.ts) |
| 不正な RTP（拡張の切り詰め、padding 長の不正など）を例外にする | [packages/rtp/src/rtp/rtp.ts:58](review-file:packages/rtp/src/rtp/rtp.ts:58) |

読む順番と、ファイルごとの観点は次のとおりです。

**1-1. 送信経路** — [packages/webrtc/src/media/rtpSender.ts](review-file:packages/webrtc/src/media/rtpSender.ts)（+1,216 / −133）。いちばん大きく、既定経路と GCC 経路が同居するファイルです。

- 送信経路の分岐: [packages/webrtc/src/media/rtpSender.ts:1175](review-file:packages/webrtc/src/media/rtpSender.ts:1175)。`needsPacedSendPath`（[packages/webrtc/src/media/sender/bandwidthEstimator.ts:218](review-file:packages/webrtc/src/media/sender/bandwidthEstimator.ts:218)）が false の legacy / disabled は、develop と同じく DTLS へ直接書くか。送信キュー（[packages/webrtc/src/media/rtpSender.ts:1186](review-file:packages/webrtc/src/media/rtpSender.ts:1186)）とその上限は GCC だけに効くか。
- 実送信の本体: [packages/webrtc/src/media/rtpSender.ts:1517](review-file:packages/webrtc/src/media/rtpSender.ts:1517)。TSN の割り当て（1749 行）から推定器への報告（[packages/webrtc/src/media/rtpSender.ts:1812](review-file:packages/webrtc/src/media/rtpSender.ts:1812)）までに await を挟む位置と、世代番号（[packages/webrtc/src/media/rtpSender.ts:1128](review-file:packages/webrtc/src/media/rtpSender.ts:1128)）の照合。
- padding: [packages/webrtc/src/media/rtpSender.ts:1343](review-file:packages/webrtc/src/media/rtpSender.ts:1343)。legacy では padding 0 件で何も送らないこと。RTX の SSRC で送ること（[packages/webrtc/src/media/rtpSender.ts:1505](review-file:packages/webrtc/src/media/rtpSender.ts:1505)）。NACK されても padding を再送しないこと（[packages/webrtc/src/media/rtpSender.ts:1994](review-file:packages/webrtc/src/media/rtpSender.ts:1994)）。
- 差し替えと transport 切替: [packages/webrtc/src/media/rtpSender.ts:525](review-file:packages/webrtc/src/media/rtpSender.ts:525)、[packages/webrtc/src/media/rtpSender.ts:477](review-file:packages/webrtc/src/media/rtpSender.ts:477)。購読の付け替え漏れ、タイマの止め忘れ。
- RTCP の受信: [packages/webrtc/src/media/rtpSender.ts:1933](review-file:packages/webrtc/src/media/rtpSender.ts:1933)。TWCC の推定器への配送（1981 行）と RR の RTT（1960 行）。
- `mediaPacingEnabled`（[packages/webrtc/src/media/rtpSender.ts:300](review-file:packages/webrtc/src/media/rtpSender.ts:300)）はシミュレーション用のフックです。既定値 true で本番の挙動を変えないことだけ見ます。

**1-2. 共通契約と照合層**（約 950 行）

- [packages/webrtc/src/media/sender/bandwidthEstimator.ts:76](review-file:packages/webrtc/src/media/sender/bandwidthEstimator.ts:76) の interface、[packages/webrtc/src/media/sender/bandwidthEstimator.ts:8](review-file:packages/webrtc/src/media/sender/bandwidthEstimator.ts:8) の `SentInfo`、変化時だけ通知する [packages/webrtc/src/media/sender/bandwidthEstimator.ts:341](review-file:packages/webrtc/src/media/sender/bandwidthEstimator.ts:341)。
- 照合層: [packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:45](review-file:packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:45) の時刻の取り決めを先に読み、`onSent`（[packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:104](review-file:packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:104)）と `onFeedback`（[packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:167](review-file:packages/webrtc/src/media/sender/estimators/twccFeedbackAdapter.ts:167)）がその取り決めを守るかを確かめます。不変条件の一覧はチケット §2.11（[TICKET-twcc.md:293](review-file:TICKET-twcc.md:293)）にあります。この部品はレビューで反例が集中した場所なので、境界（周回、順序外、時刻の遅れ）を重点的に見ます。
- **`gcc/` 配下だが既定経路**: 照合層が使う番号の展開 [packages/webrtc/src/media/sender/estimators/gcc/sequenceNumber.ts:24](review-file:packages/webrtc/src/media/sender/estimators/gcc/sequenceNumber.ts:24)（139 行）。`gcc/` のうち既定経路から使われるのはこのファイルだけです。
- 小さなファイル: [packages/webrtc/src/media/sender/estimators/twccReferenceTime.ts](review-file:packages/webrtc/src/media/sender/estimators/twccReferenceTime.ts)、[packages/webrtc/src/media/sender/estimators/twccReceiveTiming.ts](review-file:packages/webrtc/src/media/sender/estimators/twccReceiveTiming.ts)、[packages/webrtc/src/media/sender/createBandwidthEstimator.ts](review-file:packages/webrtc/src/media/sender/createBandwidthEstimator.ts)、[packages/webrtc/src/media/sender/estimators/disabledBwe.ts](review-file:packages/webrtc/src/media/sender/estimators/disabledBwe.ts)、互換用の再エクスポートになった [packages/webrtc/src/media/sender/senderBWE.ts](review-file:packages/webrtc/src/media/sender/senderBWE.ts)。

**1-3. legacy** — [packages/webrtc/src/media/sender/estimators/legacyCumulativeBwe.ts:95](review-file:packages/webrtc/src/media/sender/estimators/legacyCumulativeBwe.ts:95)（+195）。

- develop の実装（`git show develop:packages/webrtc/src/media/sender/senderBWE.ts`）と並べて読みます。判定式（経過 100ms 以上かつ 20 パケット以上で `min(送信, 受信)`、1 秒超で輻輳カウンタ）が同じであること。
- 違ってよいのは、照合を共通層に任せたこと、照合 0 件の feedback（他 sender 宛て）を無視すること、10 秒の時間窓、テスト用の clock 注入だけです。

**1-4. 受信と配送**（約 610 行）

- [packages/webrtc/src/media/receiver/receiverTwcc.ts:174](review-file:packages/webrtc/src/media/receiver/receiverTwcc.ts:174) の報告の組み立てと、[packages/webrtc/src/media/receiver/receiverTwcc.ts:316](review-file:packages/webrtc/src/media/receiver/receiverTwcc.ts:316) の番号の展開。報告済みの番号を再報告しないこと（develop と同じ）。transport ごとの共有（[packages/webrtc/src/media/receiver/receiverTwcc.ts:53](review-file:packages/webrtc/src/media/receiver/receiverTwcc.ts:53)）の参照数と停止。
- [packages/webrtc/src/media/rtpReceiver.ts:731](review-file:packages/webrtc/src/media/rtpReceiver.ts:731) の padding-only の扱い。TWCC と packet 数には数え、depacketize・NACK のロス・unmute には使わないこと。既定（`filterProbePaddingOnReceiveRtp = false`、[packages/webrtc/src/media/rtpReceiver.ts:821](review-file:packages/webrtc/src/media/rtpReceiver.ts:821)）での `onReceiveRtp` の配送が、既存アプリを壊さないこと。
- [packages/webrtc/src/media/router.ts:510](review-file:packages/webrtc/src/media/router.ts:510) の TWCC の配送先。
- [packages/webrtc/src/transport/dtls.ts:492](review-file:packages/webrtc/src/transport/dtls.ts:492) の TSN の割り当て（16-bit と拡張値の同期）。

**1-5. `rtp` パッケージ**（+408 / −140）

- TWCC の wire 形式: [packages/rtp/src/rtcp/rtpfb/twcc.ts:180](review-file:packages/rtp/src/rtcp/rtpfb/twcc.ts:180)（32-bit 境界と P ビット）、[packages/rtp/src/rtcp/rtpfb/twcc.ts:238](review-file:packages/rtp/src/rtcp/rtpfb/twcc.ts:238)（`packetResults` の展開）。Chrome など他実装との互換に直結します。
- 不正入力の例外化: [packages/rtp/src/rtp/rtp.ts:27](review-file:packages/rtp/src/rtp/rtp.ts:27)（padding-only の判定）、[packages/rtp/src/rtp/rtp.ts:180](review-file:packages/rtp/src/rtp/rtp.ts:180)（拡張の切り詰め）、[packages/rtp/src/rtp/headerExtension.ts:101](review-file:packages/rtp/src/rtp/headerExtension.ts:101)、[packages/rtp/src/rtp/red/packet.ts:37](review-file:packages/rtp/src/rtp/red/packet.ts:37)、codec の長さ検査（`codec/assertPayload.ts`、`h264.ts`、`vp8.ts`、`vp9.ts`、`av1.ts`）。**観点は、例外を投げるようになった箇所の呼び出し側です。** 受信経路で 1 パケットの不正が接続全体を止めないか、握りつぶして原因が分からなくならないかを確かめます。
- depacketize の padding スキップ: [packages/rtp/src/extra/processor/depacketizer.ts:79](review-file:packages/rtp/src/extra/processor/depacketizer.ts:79)。

### 2.4 パス 2：公開 API

行ではなく、外から見える形を changelog・生成ドキュメント・型で確かめます。

- changelog の破壊的変更と機能: [changelog.md:5](review-file:changelog.md:5)。`senderBWE` が getter になったこと、`onAvailableBitrate` が値の変化時だけ発火するようになったこと。
- 選択 API: [packages/webrtc/src/api/peerConfig.ts:145](review-file:packages/webrtc/src/api/peerConfig.ts:145)（`bandwidthEstimator`）、[packages/webrtc/src/api/peerConfig.ts:143](review-file:packages/webrtc/src/api/peerConfig.ts:143)（`filterProbePaddingOnReceiveRtp`）、[packages/webrtc/src/media/rtpSender.ts:269](review-file:packages/webrtc/src/media/rtpSender.ts:269)（`senderBWE` getter）。
- export: [packages/webrtc/src/media/index.ts:14](review-file:packages/webrtc/src/media/index.ts:14)。内部向けの部品（例: `TwccFeedbackAdapter`）まで公開する必要があるか、名前が一貫しているか。
- 利用者向けの説明: [packages/webrtc/README.md:86](review-file:packages/webrtc/README.md:86)。

観点は、名前、既定値、破壊的変更の説明が changelog・README・生成ドキュメントの間で食い違わないことです。

### 2.5 パス 3：GCC 本体（挙動で判断、6,002 行）

GCC は opt-in です。チケット §2.12 で、完成度は「libwebrtc と 1:1 で一致すること」ではなく「GCC として正しく機能すること」で判定すると決めています。そのため中身は行で読まず、他の部分との境界だけを行で読みます。

**行で読む境界**（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts)）

- 入力: `rtpPacketSent`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:552](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:552)）、`receiveTWCC`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:590](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:590)）、`process`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:362](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:362)）。
- 送信側との約束: `reserveOutgoingProbe`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:304](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:304)）、`getPacingBitrateBps`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:286](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:286)）、`setNetworkAvailable`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:521](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:521)）。
- 設定と寿命: `setBitrates`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:429](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:429)）、`resetNetworkRoute`（[packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:943](review-file:packages/webrtc/src/media/sender/estimators/gcc/gccBwe.ts:943)）。dispose / reset でタイマや購読が残らないこと。

**挙動で判断する中身**（`lossBasedBwe.ts` 1,187 行、`probeController.ts` 1,149 行、`aimdRateControl.ts` 435 行など）

判断の材料は次の 4 つです。

| 材料 | 何が分かるか | 場所 |
| --- | --- | --- |
| 既知差分の一覧 | libwebrtc と意図して違う点。納得できるかを判断する | [packages/webrtc/src/media/sender/estimators/gcc/constants.ts:435](review-file:packages/webrtc/src/media/sender/estimators/gcc/constants.ts:435) |
| 制御応答テスト（CI、8 件） | 混雑・容量変化・ロス・固定遅延・feedback 途絶への応答の傾向 | [packages/webrtc/tests/media/bandwidthEstimator.test.ts:436](review-file:packages/webrtc/tests/media/bandwidthEstimator.test.ts:436) |
| 性質テスト（CI） | 通知値が常に有限で [min, max] に収まり、変化時だけ出る | [packages/webrtc/tests/pbt/bwe/bweProperty.test.ts](review-file:packages/webrtc/tests/pbt/bwe/bweProperty.test.ts) |
| Chrome 受信側ボトルネックの E2E（CI 外、Docker） | 本物の Chrome の TWCC を相手にした応答 | [e2e/simulations/netns/chromeNetnsGcc.sim.ts](review-file:e2e/simulations/netns/chromeNetnsGcc.sim.ts) |

観点は、安全側に倒れているか（暴走せず、0 に張り付かない）と、既知差分を利用者に説明できるかです。処理の流れを追いたいときは仕組みの解説の §4 を使います。

### 2.6 パス 4：テスト・シミュレーション（約 7,700 行）

テストは全行を読まず、守っている不変条件と対象の実装が対応しているかを見ます。対応表は [reviews/c724daf9-twcc-tests.md](review-file:reviews/c724daf9-twcc-tests.md) にあります。

- パス 1 で読んだ各変更に、それを守るテストがあるか。「意図した変更」表の各行について、対応する回帰テストか性質テストを 1 つ指せれば十分です。
- 共通の準備処理が 1 か所にまとまっているか（[packages/webrtc/tests/media/twccTestUtils.ts](review-file:packages/webrtc/tests/media/twccTestUtils.ts)、[packages/webrtc/tests/media/gccSimulation.ts](review-file:packages/webrtc/tests/media/gccSimulation.ts)）。
- CI で回るもの（`packages/webrtc/tests`）と回らないもの（`packages/webrtc/simulations`、`e2e/simulations`）の区別。CI 外のテストは手動で実行しない限り回帰を検出しません。

### 2.7 指摘の残し方と完了の判断

- 指摘はパスごとにまとめます。**パス 1 の指摘は既定の利用者に影響するので、優先度を高くします。** パス 3 の指摘は、opt-in の GCC を選んだ利用者だけに効きます。
- 完了の基準は次のとおりです。

| パス | 完了の基準 |
| --- | --- |
| 0 | 2 項目のコマンドが通る（今回確認済み） |
| 1 | 全ファイルを読み終え、「意図した変更」表の各項目に納得し、§5 の未確認の E2E が通る |
| 2 | changelog・README・生成ドキュメントの説明が一致する |
| 3 | 境界を読み終え、既知差分と制御応答・E2E の結果に合意する |
| 4 | 「意図した変更」表の各行に、守るテストを指せる |

## 3. 判断理由

- **リスクは既定の利用者に集中しています。** 既定は legacy で、既存アプリはここを通ります。GCC は明示的に選んだ利用者にしか効きません。行単位の精読をパス 1 に集中させるのはそのためです。
- **GCC の判定基準は合意済みです。** チケット §2.12 で「GCC として正しく機能すること」を基準にしました。6,000 行を libwebrtc と突き合わせて読むのは、この基準に照らすと費用に見合いません。
- **生成物と参照コピーは機械で十分です。** 再生成して差分が出ないこと、配布物に入らないことを確かめれば、行を読んでも得られる情報はありません。
- **1 回の精読量を区切ります。** 長時間続けるほど見落としが増えるため、1 回 400 行前後を目安にしています。
- **コミットではなく最終形を読みます。** 履歴はレビュー対応の修正の積み重ねで、途中の状態はもう存在しないからです。

## 4. リスク（この進め方で見落としうること）

- **GCC 内部の細かな誤り。** 制御応答テストは範囲で判定するので、境界値のずれやわずかな性能劣化は検出しません（チケット §2.12 のトレードオフ）。
- **テストを信頼する前提。** パス 4 は、テストが正しく失敗することを前提にしています。主要なテストは故障を入れて失敗を確認していますが、すべてではありません（[reviews/c724daf9-twcc-tests.md](review-file:reviews/c724daf9-twcc-tests.md) §5）。
- **`rtp` パッケージの例外化の影響範囲。** 呼び出し側の扱いはパス 1 で読みますが、TWCC 以外の機能（録画・転送など）の経路まで網羅して試してはいません。
- **既定経路の E2E が未確認。** §5 のとおり、このブランチで通常の E2E と examples smoke が通った記録はありません。
- **リンクの行番号は HEAD `5952d17e8` 時点です。** 以降に変更が入るとずれます。

## 5. 検証結果

この文書の作成時に、HEAD `5952d17e8`（作業ツリーは clean）で次を実行しました。

- `npm run doc`: 終了コード 0。再生成後の差分 0。
- `cd packages/webrtc && npm pack --dry-run`: 916 ファイル。`third_party` / `libwebrtc-ref` は 0 件、`THIRD_PARTY_LICENSES_LIBWEBRTC.txt` は含まれる。
- `git diff develop...HEAD` の集計: 301 ファイル、+36,051 / −710、275 コミット。パスごとの行数は §1 の値。

実行していないもの（パス 1 の完了前に必要）:

- 通常の E2E（`npm run e2e`）と examples smoke（`npm run examples:e2e`）。チケットには、E2E 全体の ICE-TCP タイムアウトが未対応の課題として残っています。レビュー側の記録では、examples smoke の失敗 12 件はポート 8878 の占有によるもので、develop でも同じでした。
- `npm run test:small` の再実行。最後の記録はチケットの検証記録（2026-11-03、`packages/webrtc` で 1,586 件成功・5 件 skip）です。
