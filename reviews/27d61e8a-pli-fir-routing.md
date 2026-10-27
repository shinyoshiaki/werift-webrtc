---
ide:
  viewer: review-document
  version: 1
  title: "PLI/FIR 配送修正のレビュー解説"
  dock: right
  baseCommit: 69e7c85da66d534810e31da438f2b472ff82745a
---
# RTCP PLI/FIR を media SSRC で配送する修正のレビュー解説

対象チケット: `27d61e8a-9e52-4b83-9797-51c6369b9dbf`（reviewStatus: approved）。比較の基準は `develop`（merge-base `69e7c85d`）、最新は `9fadc74f`（develop を取り込み済み）です。

## 1. 概要

キーフレーム要求（PLI / FIR）が、**要求の送信元 SSRC ではなく、要求の対象 SSRC** で配送されるようにしました。あわせて次の 4 つを入れています。

- Sender が FIR を受けたことをアプリが知れるようにした（`onFullIntraRequest`、統合イベント `onKeyFrameRequest`、`firCount` の集計）
- 対象 SSRC が登録されていない要求の扱いを選べるようにした（`keyFrameRequestRouting`。既定は `"compatible"` で救済する、`"strict"` は RFC どおり）
- 複合 RTCP の分割で、後続パケットのバイトを FIR の FCI として読む不具合を直した（`werift-rtp`）
- `FullIntraRequest` の送信長を RFC 5104 の値に直した（`werift-rtp`）

<div style="display:flex;gap:12px;flex-wrap:wrap">
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-danger);border-radius:6px">
    <strong>Before</strong><br>PSFB は <code>senderSsrc</code> を先に引く。sendrecv では自分の Receiver に誤配送され、<code>onPictureLossIndication</code> が発火しない。Chrome の FIR（media SSRC = 0）は誤配送か未配送。FIR が Sender に届いても通知も <code>firCount</code> もない。複合 RTCP の FIR は後続パケットのバイトを FCI として読む。
  </div>
  <div style="flex:1;min-width:240px;padding:8px 12px;border:1px solid var(--review-border);border-left:4px solid var(--review-success);border-radius:6px">
    <strong>After</strong><br>PLI は <code>mediaSsrc</code>、FIR は FCI の各 <code>ssrc</code> で配送。<code>senderSsrc</code> は使わない。未登録の対象は既定で RTX の持ち主か唯一の video Sender へ。Sender は FIR をパケット単位で数え、(送信元, 対象) ごとの Seq nr で再送を除いて通知する。複合 RTCP は各パケットの宣言長で区切る。
  </div>
</div>

### なぜ誤配送が起きていたか（sendrecv video の例）

werift の `sendRtcpPLI` も Chrome も、PLI の `senderSsrc` に自分の送信 SSRC を入れます。sendrecv では、その SSRC は受信側 router の `ssrcTable` で **Receiver** に登録されています。

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

## 2. 主要変更

### 2.1 Router: 対象 SSRC で配送する

PLI は [packages/webrtc/src/media/router.ts:441](review-file:packages/webrtc/src/media/router.ts:441) で `mediaSsrc` から配送先を決めます。FIR は [packages/webrtc/src/media/router.ts:450](review-file:packages/webrtc/src/media/router.ts:450) で FCI エントリごとに配送先を決め、同じ配送先には 1 回だけ届けます。Sender には、その Sender に解決したエントリを `handleRtcpPacket(packet, entries)` で渡します。

最初の修正の差分は [packages/webrtc/src/media/router.ts](review-diff:packages/webrtc/src/media/router.ts:commit:fcfe4833) です。

| 種別 | Before | After | 根拠 |
| --- | --- | --- | --- |
| PLI（FMT=1） | `senderSsrc` → なければ `mediaSsrc` | `mediaSsrc` から解決（§2.2） | RFC 4585 §6.1 |
| FIR（FMT=4） | `senderSsrc` → なければ `mediaSsrc`（Chrome は 0） | FCI の各 `fir[].ssrc` から解決し、配送先ごとに 1 回。`fir[]` が空なら 0 以外の `mediaSsrc` のみ | RFC 5104 §4.3.1 |
| REMB（FMT=15） | `ssrcFeedbacks[0]` | 変更なし | - |
| 未知 FMT（SLI, RPSI など） | `feedback` 未定義で throw しうる | 配送しない（[packages/webrtc/src/media/router.ts:432](review-file:packages/webrtc/src/media/router.ts:432)） | - |

### 2.2 未登録の対象 SSRC の扱い: `keyFrameRequestRouting`

対象 SSRC は [packages/webrtc/src/media/router.ts:495](review-file:packages/webrtc/src/media/router.ts:495) の `keyFrameRequestTarget` で解決します。設定は `RTCPeerConnection` の `keyFrameRequestRouting` です（[packages/webrtc/src/api/peerConfig.ts:130](review-file:packages/webrtc/src/api/peerConfig.ts:130)）。`setConfiguration` で router に反映し（[packages/webrtc/src/peerConnection.ts:504](review-file:packages/webrtc/src/peerConnection.ts:504)）、未知の値は `TypeError` です。

差分は [packages/webrtc/src/media/router.ts](review-diff:packages/webrtc/src/media/router.ts:commit:5b19896e) です。

| 対象 SSRC | `"compatible"`（既定） | `"strict"` |
| --- | --- | --- |
| `ssrcTable` に登録済み | そのまま配送 | そのまま配送 |
| ある Sender の RTX SSRC | その Sender | 配送しない |
| 上記以外で、停止していない video Sender が 1 つだけ | その Sender | 配送しない |
| 上記以外（video Sender が 0 または複数） | 配送しない | 配送しない |
| `senderSsrc` | 使わない | 使わない |

救済の対象は、SSRC 0、RTX の SSRC、再ネゴシエーション後の古い SSRC を指す要求です。video Sender が複数あるときは、どれ宛か決められないので配送しません（SFU / relay で無関係な相手に届くのを避けるため）。

### 2.3 Sender: FIR の集計と通知

FIR は [packages/webrtc/src/media/rtpSender.ts:910](review-file:packages/webrtc/src/media/rtpSender.ts:910) で処理します。

<div style="display:flex;gap:8px;flex-wrap:wrap;align-items:stretch">
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>1. 自分宛を決める</strong><br>Router が渡したエントリ。直接呼び出しで無ければ <code>ssrc === this.ssrc</code> のエントリ。0 件なら何もしない</div>
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>2. firCount</strong><br>パケット 1 つにつき 1 加算。エントリ数は関係なく、再送も数える</div>
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-border);border-radius:6px"><strong>3. 再送判定</strong><br>エントリごとに <code>(senderSsrc, 対象 ssrc)</code> の前回 Seq nr と比べ、記録を更新する</div>
  <div style="flex:1;min-width:150px;padding:8px;border:1px solid var(--review-accent);border-radius:6px"><strong>4. 通知</strong><br>新しいエントリが 1 つでもあれば <code>onFullIntraRequest</code> と <code>onKeyFrameRequest("fir")</code> を 1 回</div>
</div>

| イベント / 統計 | 型 | 発火・加算の条件 |
| --- | --- | --- |
| `onPictureLossIndication`（既存） | `Event<[]>` | PLI を受けるたび（変更なし） |
| `onFullIntraRequest`（新規、[packages/webrtc/src/media/rtpSender.ts:154](review-file:packages/webrtc/src/media/rtpSender.ts:154)） | `Event<[FullIntraRequest]>` | 自分宛で、新しい Seq nr のエントリを含む FIR |
| `onKeyFrameRequest`（新規、[packages/webrtc/src/media/rtpSender.ts:159](review-file:packages/webrtc/src/media/rtpSender.ts:159)） | `Event<["pli" \| "fir"]>` | PLI ごと、および再送でない FIR |
| `pliCount`（既存） | outbound-rtp | PLI を受けるたび（変更なし） |
| `firCount`（集計を新規実装） | outbound-rtp | 自分宛エントリを含む FIR パケット 1 つにつき 1 |

再送判定とパケット単位の集計の差分は [packages/webrtc/src/media/rtpSender.ts](review-diff:packages/webrtc/src/media/rtpSender.ts:commit:b5e5716e) と [packages/webrtc/src/media/rtpSender.ts](review-diff:packages/webrtc/src/media/rtpSender.ts:commit:130cb55f) です。

例: primary と RTX のエントリが同じ Sender に解決される場合です。

| 受信した FIR | 通知 | `firCount` |
| --- | --- | --- |
| `[primary=5, RTX=9]` | する（どちらも初めて） | 1 |
| 同じパケットの再送 | しない（どちらも既受信の番号） | 2 |
| `[RTX=5]` | する（RTX 宛の番号空間では 5 は新しい） | 3 |

### 2.4 werift-rtp: 複合 RTCP の分割と FIR の送信長

- **受信**: [packages/rtp/src/rtcp/rtcp.ts:30](review-file:packages/rtp/src/rtcp/rtcp.ts:30) で、各パケットの payload をヘッダーの宣言長で区切ります。以前は複合パケットの末尾まで渡していたので、`RR + SDES + FIR(A 宛) + PLI(B 宛)` では PLI のバイトが FIR の FCI として読まれ、B 宛の偽エントリができていました。FIR の配送と通知を入れたことで、これが B への余分な FIR 通知と `firCount` として表面化しました。padding 長も、自分のパケットの末尾から読むようになります。
- **送信**: [packages/rtp/src/rtcp/psfb/fullIntraRequest.ts:17](review-file:packages/rtp/src/rtcp/psfb/fullIntraRequest.ts:17) の `length` を 2 + 2 × N（1 エントリなら 4）にしました。以前は 1 ワード足りず、相手が解析に失敗しえました。既存テストの期待値も誤った 3 だったため、4 に直しました。
- 差分は [packages/rtp/src/rtcp/rtcp.ts](review-diff:packages/rtp/src/rtcp/rtcp.ts:commit:caa9aa28) と [packages/rtp/src/rtcp/psfb/fullIntraRequest.ts](review-diff:packages/rtp/src/rtcp/psfb/fullIntraRequest.ts:commit:caa9aa28) です。

### 2.5 公開 API・example・ドキュメント

- `FullIntraRequest` を [packages/rtp/src/index.ts:8](review-file:packages/rtp/src/index.ts:8) から export し、`werift-rtp` / `werift` の利用者が型を参照できます。
- example は [examples/mediachannel/sendrecv/offer.ts:28](review-file:examples/mediachannel/sendrecv/offer.ts:28) で `onKeyFrameRequest` の 1 購読に移行しました。
- [changelog.md:11](review-file:changelog.md:11) 以降に Feature と Bug Fix を記載し、`npm run doc` で `doc/` と `packages/rtp/doc/` を再生成しました。

## 3. 判断理由

- **FIR の common header の media SSRC は使わない**: RFC 5104 で 0 と定められ、libwebrtc も 0 を送ります。
- **FIR を `onPictureLossIndication` に流さない**: 既存の購読者が、名前と違う種類のパケットで動き出すためです。PLI と FIR のどちらでもキーフレームを出すアプリのために、統合イベント `onKeyFrameRequest` を追加しました（レビューでの指示）。
- **`firCount` はパケット単位**: W3C webrtc-stats の `firCount` は「受信した FIR パケット数」です。1 パケットに自分宛エントリが複数あっても 1 です。再送も数え、通知だけを Seq nr で重複除去します。
- **再送判定は（送信元, 対象 SSRC）ごと**: RFC 5104 §4.3.1.1 では Seq nr の番号空間がこの組ごとです。送信元だけをキーにすると、primary と RTX のエントリが同じ Sender に解決されたとき、再送で通知したり、新しい要求を再送扱いしたりします。

### 3.1 「senderSsrc へフォールバック」案を採らない理由

レビューで「`mediaSsrc` → なければ `senderSsrc`」を既定にし、RFC 準拠をオプションにする案が出ました。キーフレーム要求に最大限応えるという狙いは §2.2 で採用しました。ただし `senderSsrc` を引く方法では、この狙いを達成できません。

| 観点 | 内容 |
| --- | --- |
| `senderSsrc` の意味 | 要求を**送ってきた相手**の SSRC（RFC 4585 §6.1）。自分の Sender の SSRC は自分で乱数で決めるので、ここに一致しない |
| 実測 | werift 同士の sendrecv video で、相手 PLI の `senderSsrc` を自分の `ssrcTable` で引くと `RTCRtpReceiver` に当たった |
| 結果 | Receiver は PSFB を処理しないので、キーフレームは出ない。Receiver の `onRtcp` に PSFB が流れるだけ |
| SFU / relay | `senderSsrc` が別 endpoint の stream に当たり、無関係な相手に要求が届く。下流の relay が monkey-patch で避けていた誤配送そのもの |

## 4. リスク・互換性

- **挙動変更**: `senderSsrc` が自分の Sender に一致することで偶然届いていた PLI は、届かなくなります。RFC 上は誤りなので許容し、changelog に記載しました。
- **既定の救済（`"compatible"`）**: 未登録 SSRC 宛の PLI / FIR が、RTX の持ち主か唯一の video Sender に届きます。余分なキーフレームが出る可能性はありますが、要求に応えない場合より影響は小さいと判断しました。RFC どおりにしたい場合は `"strict"` を指定します。
- **挙動変更**: 未知 FMT の PSFB は配送されなくなります。
- **`werift-rtp` の受信**: 複合 RTCP の分割は全 RTCP 種別に効きます。宣言長どおりに区切るのが仕様どおりで、rtp・webrtc の全テストに回帰はありません。
- **API は追加のみ**: 既存イベント・統計の名前とシグネチャは変えていません。`handleRtcpPacket` の第 2 引数は Router 用の省略可能な引数です。
- **未移行の example**: [examples/certificate/offer.ts](review-file:examples/certificate/offer.ts) と [examples/mediachannel/rtx/offer.ts](review-file:examples/mediachannel/rtx/offer.ts) は `onPictureLossIndication` のままです。動作は変わりませんが、FIR には反応しません。

### 4.1 チケット本文との差分

チケット本文は作成時のままです。次の点は、レビューでの指示や指摘によって本文から変わっています。

| チケット本文 | 実装 | 経緯 |
| --- | --- | --- |
| §2.1「`mediaSsrc` が無ければ配送しない」 | 既定 `"compatible"` は救済する。`"strict"` が本文どおり | レビューでの指示（§3.1） |
| §2.3.1「`onKeyFrameRequest` は今回は作らない」 | 追加した | レビューでの指示 |
| §2.3「自分宛エントリ 1 つにつき `firCount++`」 | パケット 1 つにつき 1 | レビュー指摘（W3C の定義） |
| §2.3「前回の Seq nr は送信元ごとに覚える」 | (送信元, 対象 SSRC) ごと | レビュー指摘（RFC 5104 §4.3.1.1） |
| `packages/rtp` は export の追加のみ | 複合 RTCP の分割と FIR の送信長も修正 | レビュー指摘（配送の追加で表面化） |

## 5. テスト

Arrange は [packages/webrtc/tests/fixture.ts:210](review-file:packages/webrtc/tests/fixture.ts:210) 以降の共通 utility（`createRtcpFeedbackRouter`、`createSingleVideoSenderRouter`、`createCompoundFeedbackBytes`、`sendRawRtcp` など）に集約しています。

| 対象 | ファイル | 内容 |
| --- | --- | --- |
| Router | [packages/webrtc/tests/media/router.test.ts:104](review-file:packages/webrtc/tests/media/router.test.ts:104) | PLI の media SSRC 配送、複数 video Sender での未登録 SSRC、FIR の FCI 配送・重複除去・空 FCI、REMB、未知 FMT |
| Router（救済） | [packages/webrtc/tests/media/router.test.ts:142](review-file:packages/webrtc/tests/media/router.test.ts:142) | compatible: RTX SSRC 宛 PLI、唯一の video Sender、FIR エントリの解決と再送。strict: 未登録 SSRC は配送しない |
| Router（複合 RTCP） | [packages/webrtc/tests/media/router.test.ts:346](review-file:packages/webrtc/tests/media/router.test.ts:346) | 実バイト列を復号して配送。A は FIR、B は PLI だけを受け、再送では A の通知は出ず `firCount` だけ増える |
| Sender | [packages/webrtc/tests/media/rtpSender.test.ts:1268](review-file:packages/webrtc/tests/media/rtpSender.test.ts:1268) | `firCount`、再送の扱い、(送信元, 対象) ごとの再送判定、他 SSRC 宛の FIR、`onKeyFrameRequest` の発火順、PLI と FIR の独立 |
| 結合 | [packages/webrtc/tests/integrate/mediaChannel.test.ts:173](review-file:packages/webrtc/tests/integrate/mediaChannel.test.ts:173) | werift 同士の sendrecv video で PLI が相手 Sender に届く。media SSRC 0 の PLI は既定で届き、strict では届かない。未知のモードは `TypeError` |
| rtp（複合 RTCP） | [packages/rtp/tests/rtcp/rtcp.test.ts:64](review-file:packages/rtp/tests/rtcp/rtcp.test.ts:64) | `RR + SDES + FIR + PLI` の分割、padding 付きパケットの後続、FIR の length が 2 + 2 × N で往復できる |
| rtp（FIR） | [packages/rtp/tests/rtcp/psfb/fullIntraRequest.test.ts:6](review-file:packages/rtp/tests/rtcp/psfb/fullIntraRequest.test.ts:6) | RFC どおりの length=4 のベクタで復号・再シリアライズ |

各修正では、修正前の実装に戻すと追加テストが失敗することを確認してから元に戻しています（strict 判定、唯一の video Sender への解決、payload の区切り、(送信元, 対象) ごとの再送判定、パケット単位の `firCount`）。

## 6. 検証結果

| 項目 | 結果 | 備考 |
| --- | --- | --- |
| ルートの `npm run type` / `npm run test:small`（`9fadc74f`、develop 取り込み後） | 成功 | rtp 40 ファイル・372 テスト、webrtc 58 ファイル・896 テスト（5 件 skip）を含む全パッケージ |
| `npm run doc` | 成功 | `keyFrameRequestRouting` 追加時に実施。以降は公開シグネチャの変更なし |
| examples の Chromium カタログ（`npm run examples:e2e`） | 成功 | 初回の自動レビュー時（`onKeyFrameRequest` 追加前）のみ |

**未確認**: WPT と `npm run e2e` は実施していません。`npm run examples:e2e` は `onKeyFrameRequest` 追加以降、実施していません。Chrome などが未登録 SSRC 宛の PLI / FIR を実際にどの程度送るかも調べていません。
