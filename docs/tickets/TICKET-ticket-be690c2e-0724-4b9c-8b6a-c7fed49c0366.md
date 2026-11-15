# [Simulcast] a=ssrc / ssrc-group:FID を持つ simulcast answer で、RID のトラックとは別に SSRC のトラックが作られ、そのレイヤーの RTX がそちらへ復元される

## 1. 目的と背景

- Firefox E2E 整備（`a461df90-10bb-4aad-8f1b-3cce626d630b`、親チケット #269 `190063e8-99d9-410f-89ca-cee8cf6423a1` の派生）で見つかった werift 本体の不具合。
- E2E `e2e/tests/mediachannel/simulcast.test.ts` の `mediachannel_simulcast_rtx_answer` が Firefox 157 ではタイムアウトする（2 レイヤーの relay と再生はできるが、`repaired` が `high` / `low` の両方にならない）。Chrome は通る。
- Firefox の simulcast answer は、`a=rid:high send` / `a=rid:low send` / `a=simulcast:send high;low` と RID / RRID のヘッダー拡張に加えて、レイヤーごとの `a=ssrc` と `a=ssrc-group:FID <media> <rtx>` を載せる（Chrome は a=ssrc を載せず、RTX を rrid で対応付ける）。

## 2. 現象（E2E ハンドラーに一時的なログを入れて確認）

- `transceiver.onTrack` が 3 回発火する: `rid: "high"`、`rid: "low"`、`rid: undefined, ssrc: 3388294025`（high レイヤーの media SSRC）。
- `low` は落としたパケットが RTX で復元され、`low` のトラックに届く。`high` は落としたパケットが RTX で復元されても `high` のトラックに届かず、ハンドラーが NACK と再送を繰り返す（Firefox の outbound-rtp で high の nackCount / retransmittedPacketsSent が増え続ける）。
- `packages/webrtc/src/media/rtpReceiver.ts` の RTX 復元（`handleRTP` → `mediaSsrcOfRtx`、SDP の FID を優先）の後で、`track = this.trackBySSRC[originalSsrc]` が SDP の a=ssrc から作られた SSRC のトラックを指していると考えられる。RID から学習した対応（`handleRtpByRid` の `if (!this.trackBySSRC[ssrc])`）は、SDP 由来の対応を上書きしない。

## 3. 完了条件

- simulcast（RID）の受信で、answer / offer に a=ssrc と ssrc-group:FID があっても、RID ごとのトラックだけが作られ、各レイヤーの RTX がそのレイヤーのトラックへ復元される。`packages/webrtc` にテストを足す（Firefox 形式の simulcast SDP）。
- `e2e/tests/mediachannel/simulcast.test.ts` の Firefox スキップを外し、`cd e2e && npm run firefox:record -- tests/mediachannel/simulcast.test.ts` で通る。スキップ箇所は `grep -rn "firefox-known:simulcast-ssrc-track" e2e/tests` で探す。
- Chrome の E2E（`npm run e2e`）と `npm run test:small` に回帰がない。