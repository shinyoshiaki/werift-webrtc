---
ide:
  viewer: review-document
  version: 1
  title: "不正な RED パケットによる経路乗っ取りの修正（レビュー解説）"
  dock: right
  baseCommit: f1f4a2f76295e0e460778dec4c13efab757c0f1b
---
# 不正な RED パケット 1 個で RID の媒体 SSRC が乗っ取られる問題の修正

## 概要

調査の起点は「不正な RTP で Node.js プロセスが落ちるか」でした。チケットの調査では、受信経路の同期例外は ICE ソケット、ICE、DTLS/SRTP の catch で止まります。一方で、**交渉済み RED の壊れた payload 1 個が RID の媒体 SSRC を切り替え、正規の SSRC の配送を止める**不具合が再現しました。

この変更は、壊れた RED を受信状態や経路状態を変える前にパケット単位で破棄します。あわせて、`RtpRouter.routeRtp` の後処理を `finally` に移し、例外が起きても実行されるようにします。

比較の基準は `develop`（`73e59216d`）、対象の HEAD は `f1f4a2f76` です。レビューは 3 回目で承認されています。

## 修正前の問題と修正後の仕組み

入力は Before / After で同じです。RID `high` の媒体 SSRC が 1000 で確立している状態に、同じ RID を名乗る SSRC 5555、交渉済み RED PT、payload `0x80`（1 バイト）のパケットが届きます。

<style>
.df13{display:flex;flex-wrap:wrap;gap:12px;font-family:var(--review-font);font-size:13px;color:var(--review-fg)}
.df13>div{flex:1 1 300px;min-width:0}
.df13 .s{border:1px solid var(--review-border);border-radius:6px;padding:6px 10px;background:var(--review-surface);overflow-wrap:anywhere}
.df13 .bad{border:2px solid var(--review-danger)}
.df13 .good{border:2px solid var(--review-success)}
.df13 .a{text-align:center;color:var(--review-muted);line-height:1.4}
.df13 code{font-family:var(--review-mono)}
.df13 b.r{color:var(--review-danger)} .df13 b.g{color:var(--review-success)}
</style>
<div class="df13">
<div>
<strong>Before</strong>
<div class="s"><code>routeRtp</code> → <code>learnSsrc(5555)</code> → <code>handleRtpByRid</code></div><div class="a">↓</div>
<div class="s bad"><b class="r">先に状態を変更</b><br><code>switchRidMedia</code>: 1000 を retired にする<br><code>trackBySSRC[5555]</code> を学習</div><div class="a">↓</div>
<div class="s bad"><code>handleRTP</code>: 統計・TWCC・<code>payloadTypeBySsrc</code> を更新<br>その後の <code>Red.deSerialize</code> が <b class="r">throw</b></div><div class="a">↓</div>
<div class="s bad"><b class="r">routeRtp の後処理を飛ばす</b><br>経路が残り、キューは未処理<br>DTLS 層の <code>log("RTP error")</code> で止まる</div><div class="a">↓</div>
<div class="s bad">正規の SSRC 1000 seq 11 → <b class="r">retired として破棄</b></div>
</div>
<div>
<strong>After</strong>
<div class="s"><code>routeRtp</code> → <code>learnSsrc(5555)</code> → <code>handleRtpByRid</code></div><div class="a">↓</div>
<div class="s good"><b class="g">先に検査</b><br><code>parseMediaPayload</code> → <code>invalid</code></div><div class="a">↓</div>
<div class="s good"><code>dropInvalidPayload</code><br><code>rejectedSsrcs</code> に 5555 を積み、TWCC だけ観測</div><div class="a">↓</div>
<div class="s good"><b class="g">finally → settleRoutedPacket</b><br>今学習した 5555 の経路を取り消す<br>例外なし</div><div class="a">↓</div>
<div class="s good">正規の SSRC 1000 seq 11 → <b class="g">配送</b></div>
</div>
</div>

赤枠は不具合が起きる箇所、緑枠は修正で変わる箇所です。After でも `learnSsrc(5555)` は先に実行されます。この経路は、既存の `rejectedSsrcs` キューを使って同じパケットの後処理で取り消します。差分は [packages/webrtc/src/media/rtpReceiver.ts:1226](review-diff:packages/webrtc/src/media/rtpReceiver.ts:1226) です。

どちらもプロセスは落ちません。差が出るのは経路状態と後続パケットの配送です。

## 主要変更

読む順番は 1 → 2 → 3 を勧めます。

### 1. 受信側で状態変更の前に検査する（変更の核）

- `parseMediaPayload` が検査するのは RED だけです。パース失敗と、**primary（最後の F=0）block の PT が未交渉**の場合を `invalid` にします。padding-only と RTX は解析しません。catch の範囲は `Red.deSerialize` の 1 呼び出しです。[packages/webrtc/src/media/rtpReceiver.ts:1537](review-diff:packages/webrtc/src/media/rtpReceiver.ts:1537)
- `dropInvalidPayload` は、配送、受信統計、NACK、RTCP、経路学習の対象から外し、transport-wide CC だけを観測します。[packages/webrtc/src/media/rtpReceiver.ts:1568](review-diff:packages/webrtc/src/media/rtpReceiver.ts:1568)
- `handleRTP` では統計、TWCC、`payloadTypeBySsrc` の更新より前に検査します。RID 経路から来た場合は、解析結果を引き継ぎます。[packages/webrtc/src/media/rtpReceiver.ts:1627](review-diff:packages/webrtc/src/media/rtpReceiver.ts:1627)

受理の判定に使う block も変わりました。`96` と記した箇所は交渉済み、`125` と `127` は未交渉の PT です。

<style>
.df13{display:flex;flex-wrap:wrap;gap:12px;font-family:var(--review-font);font-size:13px;color:var(--review-fg)}
.df13>div{flex:1 1 300px;min-width:0}
.df13 .s{border:1px solid var(--review-border);border-radius:6px;padding:6px 10px;background:var(--review-surface);overflow-wrap:anywhere}
.df13 .bad{border:2px solid var(--review-danger)}
.df13 .good{border:2px solid var(--review-success)}
.df13 .a{text-align:center;color:var(--review-muted);line-height:1.4}
.df13 code{font-family:var(--review-mono)}
.df13 b.r{color:var(--review-danger)} .df13 b.g{color:var(--review-success)}
</style>
<div class="df13">
<div>
<strong>Before: <code>fields[0]</code>（先頭の block）で判定</strong>
<div class="s bad">冗長 96 + primary 125<br><b class="r">受理する</b>（RID が切り替わる）</div><div class="a">&nbsp;</div>
<div class="s bad">冗長 127 + primary 96<br><b class="r">パケット全体を捨てる</b></div>
</div>
<div>
<strong>After: 最後の field（primary）で判定</strong>
<div class="s good">冗長 96 + primary 125<br><b class="g">状態変更の前に全体を破棄</b></div><div class="a">&nbsp;</div>
<div class="s good">冗長 127 + primary 96<br><b class="g">受理し、127 の block だけを飛ばす</b>（audio）</div>
</div>
</div>

同じ 2 つの入力に対する判定の違いです。上段が経路の乗っ取り、下段が正規データの取りこぼしにあたります。テストは [packages/webrtc/tests/media/rtpReceiverTestUtils.ts:362](review-file:packages/webrtc/tests/media/rtpReceiverTestUtils.ts:362) の `unknownPrimaryAfterRedundant` と、[packages/webrtc/tests/media/rtpReceiver.test.ts:724](review-file:packages/webrtc/tests/media/rtpReceiver.test.ts:724) です。

### 2. router が壊れた payload で経路を学習・移動しない

SSRC を学習する経路（`a=ssrc` のない m-line）では、受信側の `handleRTP` より前に router が経路状態を決めます。そのため router 側にも判定が必要です。判定には、PT の確認に payload の検査を加えた `receivesMediaPacket` を使います。[packages/webrtc/src/media/rtpReceiver.ts:334](review-diff:packages/webrtc/src/media/rtpReceiver.ts:334)

| 場面 | 壊れた RED の扱い | 差分 |
| --- | --- | --- |
| 未知 SSRC の学習、別 m-line の MID への移動 | `malformedPayload` で drop する。候補の receiver が TWCC だけを観測する | [packages/webrtc/src/media/router.ts:933](review-diff:packages/webrtc/src/media/router.ts:933) |
| 学習済み fallback SSRC | MID の対応付け状態を進めない | [packages/webrtc/src/media/router.ts:1037](review-diff:packages/webrtc/src/media/router.ts:1037) |
| track のない RID を持つパケット | fallback SSRC に RID を記録しない | [packages/webrtc/src/media/router.ts:853](review-diff:packages/webrtc/src/media/router.ts:853) |

router が自分で drop する場合は `observeDroppedPacket` を呼びます。このメソッドは `rejectedSsrcs` に何も積まないので、次のパケットに持ち越すものがありません。[packages/webrtc/src/media/rtpReceiver.ts:351](review-diff:packages/webrtc/src/media/rtpReceiver.ts:351)

drop 理由の追加は [packages/webrtc/src/media/routing/unknownSsrc.ts:17](review-diff:packages/webrtc/src/media/routing/unknownSsrc.ts:17) です。

### 3. `routeRtp` の後処理を必ず実行する

入力は、RID の媒体 SSRC を切り替える正規パケットです。その配送中に、アプリの `onReceiveRtp` 購読者が例外を投げます。

<style>
.df13{display:flex;flex-wrap:wrap;gap:12px;font-family:var(--review-font);font-size:13px;color:var(--review-fg)}
.df13>div{flex:1 1 300px;min-width:0}
.df13 .s{border:1px solid var(--review-border);border-radius:6px;padding:6px 10px;background:var(--review-surface);overflow-wrap:anywhere}
.df13 .bad{border:2px solid var(--review-danger)}
.df13 .good{border:2px solid var(--review-success)}
.df13 .a{text-align:center;color:var(--review-muted);line-height:1.4}
.df13 code{font-family:var(--review-mono)}
.df13 b.r{color:var(--review-danger)} .df13 b.g{color:var(--review-success)}
</style>
<div class="df13">
<div>
<strong>Before</strong>
<div class="s">receiver が <code>forgottenSsrcs</code> に旧 SSRC を積む</div><div class="a">↓</div>
<div class="s">購読者が throw</div><div class="a">↓</div>
<div class="s bad"><b class="r">後処理を飛ばす</b><br>旧経路が残り、キューが持ち越される<br>MID も記録されない</div><div class="a">↓</div>
<div class="s">例外は呼び出し元へ伝わる</div>
</div>
<div>
<strong>After</strong>
<div class="s">receiver が <code>forgottenSsrcs</code> に旧 SSRC を積む</div><div class="a">↓</div>
<div class="s">購読者が throw</div><div class="a">↓</div>
<div class="s good"><b class="g">finally → settleRoutedPacket</b><br>旧経路を削除し、MID を記録する<br>新しい経路は残す</div><div class="a">↓</div>
<div class="s">例外は呼び出し元へ伝わる</div>
</div>
</div>

例外の伝わり方は変わらず、後処理の実行だけが変わります。`catch` はありません。差分は [try](review-diff:packages/webrtc/src/media/router.ts:743)、[finally（packages/webrtc/src/media/router.ts:810）](review-diff:packages/webrtc/src/media/router.ts:810)、[settleRoutedPacket（packages/webrtc/src/media/router.ts:835）](review-diff:packages/webrtc/src/media/router.ts:835) です。`router.ts` の差分の多くは、インデントの変更と後処理のメソッドへの切り出しです。

### 4. 冗長 block の除外（`werift-rtp`）

`RedHandler.push` に省略可能な `accepts` 述語を追加しました。拒否した block は配送せず、**sequence number も消費しません**。同じ番号は、後で届く正規の冗長 block から復元できます。[packages/rtp/src/rtp/red/handler.ts:65](review-diff:packages/rtp/src/rtp/red/handler.ts:65)

呼び出し側は交渉済み PT だけを受け付けます。[packages/webrtc/src/media/rtpReceiver.ts:1683](review-diff:packages/webrtc/src/media/rtpReceiver.ts:1683)

挙動の変更点は [changelog.md:3](review-diff:changelog.md:3) からの Unreleased に記載されています。`doc/` と `packages/rtp/doc/` の差分は、TSDoc とシグネチャの反映です。

## 判断理由

- **`handleRTP` 全体を catch しない**: werift の内部バグやアプリの例外まで隠れるためです。新しく catch するのは、受信バイト列に対するパーサの失敗だけです。
- **経路の取り消し機構を新設しない**: #838 / #855 の `rejectedSsrcs` / `forgottenSsrcs` を使います。reject されたパケットで取り消すのは、そのパケットが今追加した経路だけです。
- **例外で終わっただけでは経路を取り消さない**: `onReceiveRtp` の購読者の例外は、経路の正しさと関係がないためです。
- **TWCC は観測し、受信統計には数えない**: TWCC の番号は transport 全体の通し番号です。欠番にすると、受信したパケットを損失として報告し得ます。2 回目のレビューで、未知 SSRC と MID 移動の drop で観測が漏れると指摘され、`observeDroppedPacket` が追加されました。
- **primary block で受理を判定する**: 1 回目のレビューで、先頭の block を見る判定では未交渉の primary が通り、RID が乗っ取られると指摘されました。

## レビュアーが確認すべき点・リスク

1. **公開 API の追加があります。** チケットの制約は「公開 API は変えない」ですが、`werift-rtp` が export する `RedHandler.push` に第 3 引数 `accepts?` が増えています。省略時はすべて受け付けるので、既存の呼び出しは互換です。この追加を許容するか確認してください。[packages/rtp/src/rtp/red/handler.ts:23](review-diff:packages/rtp/src/rtp/red/handler.ts:23)。`receivesMediaPacket` と `observeDroppedPacket` は `@internal` で、生成ドキュメントの差分には現れません。
2. **RED の受理条件が変わります。** primary が交渉済みなら、冗長 block に未交渉 PT があっても受理します。block を除外する処理は audio の `RedHandler` にあります。video の RED は `track` へ配送しない分岐のままです。
3. **RID を記録する条件は、RED 以外にも影響します。** 修正前は、track のない RID を無視する分岐に入れば `noteFallbackRid` を呼んでいました。修正後は `receivesMediaPacket` が true の場合に限ります。未交渉 PT と RTX のパケットも対象外になります。
4. **RTX の中身は検査しません。** `parseMediaPayload` が見るのは外側の codec です。RED を `apt` に持つ RTX の復元後の payload は、検査も RED の展開もされません。修正前も外側の codec で判定していました。
5. **破棄したパケットも TWCC の状態には触れます。** `observeTransportCc` は、必要に応じて TWCC を初期化し、feedback の `media_ssrc` に使う値を更新します。「状態を変えない」の対象は、ストリームと経路の状態です。
6. **一部の経路では RED を複数回解析します。** fallback SSRC などでは、router の `receivesMediaPacket` と `handleRTP` がそれぞれ解析します。性能への影響は測定していません。
7. **`finally` が保証するのは router の後処理だけです。** 購読者が投げると、後続の購読者と、`handleRTP` の残り（`runRtcp()`）は実行されないままです（チケットの R3）。

チケットの任意項目のうち、次の項目はこの差分で変更していません。

| 項目 | 内容 | チケット記載の状況 |
| --- | --- | --- |
| R1 | `runTWCC()` に `.catch` がない | 投げる入力は未発見 |
| R2 | 中継する `sendRtp` の reject が未処理になり得る。非標準 profile で拡張が落ちる | 例外は未再現。拡張の件は別チケット候補 |
| R5 | 1〜3 バイトの RTCP が `RangeError` になる | 受信経路からは到達しない |

任意のプロパティテストの変異も追加していません。`routeRtcp` の委譲先 `routing/rtcpRouting.ts` には `takeForgottenSsrcs` の呼び出しがありません。

完了条件には、調査結果と、R1〜R5 のうち修正しなかった理由を PR 本文に書くことが含まれます。この解説の作成時には PR 本文を確認していません。

## 検証結果

### 回帰テストの場所

- RID 経路: [packages/webrtc/tests/media/router.test.ts:1599](review-file:packages/webrtc/tests/media/router.test.ts:1599)
- 購読者の例外と後処理: [packages/webrtc/tests/media/router.test.ts:1750](review-file:packages/webrtc/tests/media/router.test.ts:1750)
- audio RED の復元: [packages/webrtc/tests/media/rtpReceiver.test.ts:675](review-file:packages/webrtc/tests/media/rtpReceiver.test.ts:675)
- SSRC 学習: [packages/webrtc/tests/media/ssrcLess/learning.test.ts:655](review-file:packages/webrtc/tests/media/ssrcLess/learning.test.ts:655)
- fallback の MID: [packages/webrtc/tests/media/ssrcLess/learning.test.ts:710](review-file:packages/webrtc/tests/media/ssrcLess/learning.test.ts:710)
- TWCC: [packages/webrtc/tests/media/ssrcLess/learning.test.ts:767](review-file:packages/webrtc/tests/media/ssrcLess/learning.test.ts:767)

### この解説の作成時に実行したもの

下表の「6 ファイル」は、`router.test.ts`、`rtpReceiver.test.ts`、`ssrcLess/` 配下を指します。

| 検証 | 結果 |
| --- | --- |
| HEAD の 6 ファイル（設定どおり `retry: 1`） | 232 件すべて成功 |
| `develop` のソースに HEAD の `packages/webrtc/tests` の変更を重ねた 6 ファイル（`--retry=0`、`/tmp` に展開） | 24 件失敗、208 件成功。失敗名は不正 RED、冗長 block、購読者の例外のテスト |
| `npm run type` | 終了コード 0 |
| `packages/rtp` の `vitest run tests/rtp/red` | 8 件成功 |
| `git diff --check develop...HEAD` | 指摘なし |

### 最終承認レビューの記録（この解説の作成時には再実行していないものを含む）

レビュー記録では、RTP パッケージの 768 テストと型・公開宣言の検査、WebRTC の関連 117 テスト、workspace の型検査、`doc:check` が成功しています。

### 未確認

- `packages/webrtc` の `npm test` 全体は、今回も最終承認レビューでも実行していません。チケットの完了条件に含まれるため、マージ前の確認を勧めます。
- E2E、interop、fuzz は、今回も最終承認レビューでも実行していません。チケットにある fuzz の結果は、調査時の一時スクリプトによるものです。
- `npm run format` の実行は確認していません。
