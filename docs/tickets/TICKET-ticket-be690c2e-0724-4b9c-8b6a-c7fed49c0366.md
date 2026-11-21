# [Simulcast] a=ssrc / ssrc-group:FID を持つ simulcast answer で、RID のトラックとは別に SSRC のトラックが作られ、そのレイヤーの RTX がそちらへ復元される

## 1. 目的と背景

- Firefox E2E 整備（`a461df90-10bb-4aad-8f1b-3cce626d630b`、親チケット #269 `190063e8-99d9-410f-89ca-cee8cf6423a1` の派生）で見つかった werift 本体の不具合。
- E2E `e2e/tests/mediachannel/simulcast.test.ts` の `mediachannel_simulcast_rtx_answer` が Firefox 157 ではタイムアウトする（2 レイヤーの relay と再生はできるが、`repaired` が `high` / `low` の両方にならない）。Chrome は通る。
- Firefox の simulcast answer は、`a=rid:high send` / `a=rid:low send` / `a=simulcast:send high;low` と RID / RRID のヘッダー拡張に加えて、レイヤーごとの `a=ssrc` と `a=ssrc-group:FID <media> <rtx>` を載せる（Chrome は a=ssrc を載せず、RTX を rrid で対応付ける）。
- 目的: RID で simulcast を受けるとき、SDP に a=ssrc があっても、アプリが受け取るトラックは RID ごとの 1 本だけにし、各レイヤーの媒体パケットと RTX から復元したパケットが同じ RID のトラックに届くようにする。

## 2. 現象（E2E ハンドラーに一時的なログを入れて確認）

- `transceiver.onTrack` が 3 回発火する: `rid: "high"`、`rid: "low"`、`rid: undefined, ssrc: 3388294025`（high レイヤーの media SSRC = SDP の最初の a=ssrc）。
- `low` は落としたパケットが RTX で復元され、`low` のトラックに届く。`high` は落としたパケットが RTX で復元されても `high` のトラックに届かず、ハンドラーが NACK と再送を繰り返す（Firefox の outbound-rtp で high の nackCount / retransmittedPacketsSent が増え続ける）。
- E2E ハンドラー（`e2e/server/handler/mediachannel/simulcast.ts` の `mediachannel_simulcast_rtx_answer`）は `track.rid` のあるトラックだけを relay / `watchRepair` するので、SSRC のトラックへ届いた high の復元パケットは数えられない。

## 3. 原因（最新コードでの調査結果）

answer 適用の流れ（`packages/webrtc/src/transceiverManager.ts`）:

- `setRemoteRTP`（1240 行付近）/ `commitAnswerCodecs`（1080 行付近）は、`remoteMedia.simulcastParameters` ごとに `router.registerRtpReceiverByRid` を呼んだ**後に**、無条件で `router.registerRtpReceiverBySsrc(transceiver, remoteParams)` を呼ぶ。
- `getRemoteRtpParams`（900 行付近）は、各 primary codec の encoding の `ssrc` に常に `media.ssrc[0]` を入れる。RTX は `media.ssrc.length === 2` のときだけ `media.ssrc[1]` と組にする。`media.ssrcGroup`（`a=ssrc-group:FID`、`sdp.ts` でパース済み）は受信側では使っていない。
  - Firefox の 2 レイヤー answer は a=ssrc が 4 つ（high/low の media と RTX）あるので、`encodings[].ssrc` = high の media SSRC、`rtx` は付かない（`ssrcByRtx` は空）。

その結果（`packages/webrtc/src/media/router.ts` / `media/rtpReceiver.ts`）:

1. `registerRtpReceiverBySsrc` が `ssrc: media.ssrc[0]`（high の media SSRC）の `MediaStreamTrack` を作り `transceiver.addTrack` する → `RTCRtpReceiver.addTrack` が `trackBySSRC[ssrc]` に登録し、`onTrack` が 3 回目に発火する。ルーターの `ssrcTable` にもその SSRC が SDP 由来の経路として入る。
2. high の媒体パケットは RID 拡張を持つので `routeRtp` → `handleRtpByRid` に入り、RID のトラックへ直接渡される。ただし `if (!this.trackBySSRC[ssrc])` の学習は、SDP 由来の SSRC トラックがあるので上書きしない。
3. high の RTX パケットは rrid で `handleRtxByRid` → `bindRtxSsrc` され、`handleRTP` → `mediaSsrcOfRtx` が `mediaSsrcByRid["high"]` を返す。復元後に `track = this.trackBySSRC[originalSsrc]` が SSRC のトラックを指すので、復元パケットは RID のトラックではなくそちらへ届く。
4. low は `media.ssrc[2]` 以降が登録されないので SSRC のトラックがなく、`handleRtpByRid` で `trackBySSRC` を学習して RID のトラックへ正しく復元される。

## 4. 実装方針

- **RID で受ける m-line では SSRC のトラックを作らない**: `remoteMedia.simulcastParameters` に recv 側の RID がある（`registerRtpReceiverByRid` を呼んだ）ときは、`registerRtpReceiverBySsrc` で `MediaStreamTrack` を作らない。ルートの `ssrcTable` と RTX の SDP 対応（`prepareReceive` / `resyncCodecs` の `ssrcByRtx`）は扱いを決めて残すか外す（下記）。
  - 呼び出し側（`transceiverManager.ts` の 2 か所）で分岐するか、`registerRtpReceiverBySsrc` に「トラックを作らない」オプションを足す。分岐の判定は 2 か所で同じものを使う。
- **SDP の a=ssrc / FID の扱い**: RID と a=ssrc の対応は SDP からは決まらない（`a=ssrc` 側に RID の属性がない）ので、レイヤーの割り当ては RID 拡張を持つパケットから学習する現在の経路（`handleRtpByRid` / `handleRtxByRid`）に任せる。
  - `getRemoteRtpParams` が `media.ssrc[0]` だけを RID 受信の encoding に入れる現状は、RID 受信では誤った SDP 対応を作るだけなので、RID 受信時は SSRC 由来の経路・トラックを作らない方向で揃える。
  - `ssrc-group:FID` を全レイヤーぶん `ssrcByRtx` に入れる（媒体 SSRC ↔ RTX SSRC の対応だけを使い、どの RID かは媒体パケットの学習で決める）案は任意。入れる場合は `mediaSsrcOfRtx` が SDP の FID を優先するので、`trackBySSRC[media]` が RID 学習で RID のトラックを指すことを確認する。
- **RTX 復元先の保証**: 上記で SSRC のトラックがなくなれば、`handleRtpByRid` が `trackBySSRC[media] = RID のトラック` を学習し、`handleRTP` の復元は RID のトラックへ届く。防御として、RID で受ける receiver では復元後のトラックを `mediaSsrcByRid` 経由で `trackByRID` から引くことも検討する（RTX が媒体より先に届いた場合など）。
- 既存の再交渉ステート（`snapshotNegotiationState` / `restoreNegotiationState`、`learnedTrackSsrcs`、`unboundTracks`、ルーターの `provisionalSsrc` / `stagedSsrc`）を壊さないこと。SDP 由来とパケット学習由来の区別（`learnedTrackSsrcs`、`router.learnedSsrcs`）はそのまま使う。

## 5. 制約・注意点

- 非 simulcast（RID なし）の SSRC 受信、Chrome 形式（a=ssrc なし、rrid で RTX）の simulcast、offer 側（werift が simulcast を送る / 受ける両方向）の挙動を変えない。`onTrack` の発火回数が変わるのは「RID 受信 + a=ssrc あり」の場合だけにする。
- RID 受信の m-line に a=ssrc がある場合でも、RID 拡張なしで届く SSRC パケットの扱い（`routeRtp` の「simulcast after send receiver report」分岐、`trackBySSRC` での検索）が引き続き動くこと。
- 再交渉（pranswer / rollback / re-offer）で a=ssrc の有無や RID が変わるケースで、トラックが増減しないこと。`tests/negotiation` の既存ケースと `tests/pbt/simulcastRtx` を回す。
- `tests/pbt/simulcastRtx/simulcastRtxProperty.test.ts` は「`ssrc-group:FID` なしの RID RTX」が前提。FID ありの生成を足すかはこのチケットの範囲で判断する。
- テストは Arrange / Act / Assert、共有セットアップは `packages/webrtc/tests/media/rtpReceiverTestUtils.ts` など既存の utility に寄せ、Act / Assert に日本語コメントを付ける（ルート `AGENTS.md`）。
- 既知のホスト依存の失敗（tcp active-only、setConfiguration、modern_sdp）は回帰と区別する。

## 6. 完了条件

- simulcast（RID）の受信で、answer / offer に a=ssrc と ssrc-group:FID があっても、RID ごとのトラックだけが作られ（`onTrack` は RID の数だけ）、各レイヤーの RTX がそのレイヤーのトラックへ復元される。
- `packages/webrtc` にテストを足す（Firefox 形式の simulcast SDP: `a=rid` ×2、`a=simulcast`、RID / RRID 拡張、レイヤーごとの `a=ssrc` ×4 と `a=ssrc-group:FID` ×2）。answer 側と offer 側の両方で、トラック数と、両レイヤーの RTX 復元先が RID のトラックであることを確かめる。
- `e2e/tests/mediachannel/simulcast.test.ts` の `itSkipOnFirefox(firefoxKnownIssue.simulcastSsrcTrack)` を `it` に戻し、使われなくなった `e2e/tests/fixture.ts` の `firefoxKnownIssue.simulcastSsrcTrack` を削除する（`grep -rn "firefox-known:simulcast-ssrc-track" e2e/tests` が空になる）。`cd e2e && npm run firefox:record -- tests/mediachannel/simulcast.test.ts` で通り、その run record（`e2e/firefox-runs/`）をコミットする。
- `cd packages/webrtc && npm test`、`npm run type`、`npm run test:small`、Chrome の E2E（`npm run e2e`）に回帰がない。
- `npm run format` 済み。公開 API に変更があれば docs / `changelog.md` を更新する（この修正は内部挙動のみの想定）。

## 7. Firefox 全スイート実行での既知の失敗（このチケットの範囲外）

完了条件の Firefox 記録は simulcast 単体（`npm run firefox:record -- tests/mediachannel/simulcast.test.ts`）。参考として取った全スイートの記録（`e2e/firefox-runs/20261121T032323Z-affd1237e.json`）では simulcast 3 件は通り、次の ICE の失敗が残る。どちらもこのチケットの差分（RTP 受信 / SDP、ICE は未変更）とは無関係。

- `ice/failover`（werift の host ソケット切断後に relay ペアへ移る 2 件）: develop `75bf5ed0a` で同じファイルを単体実行しても同じ 2 件が失敗する。
- `ice/nomination`（relay から host への切り替え 4 件）: このチケット以前の記録（`20261118T233958Z-bcbcc593a.json` など）から同じ 4 件が失敗している。再現調査は別チケットで扱う。
