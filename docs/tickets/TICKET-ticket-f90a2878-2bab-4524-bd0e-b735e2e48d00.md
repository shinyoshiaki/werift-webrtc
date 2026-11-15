# [userMedia] ファイル再生のループで VP8 の PictureID が初期値に戻る（answer の fmtp で packetizer を作り直す）

## 1. 目的と背景

- Firefox E2E 整備（`a461df90-10bb-4aad-8f1b-3cce626d630b`、親チケット #269 `190063e8-99d9-410f-89ca-cee8cf6423a1` の派生）で見つかった werift 本体の不具合。
- E2E `e2e/tests/mediachannel/vp8Playback.test.ts` の `file`（`createFileMediaPlayer({ loop: true })` の VP8 送出）が、Firefox 157 では毎回失敗する。`pictureIdGapDetails` が `[{ frame: 60, from: 8363, to: 2288 }]` になる。frame 60 は fixture（2 秒、30fps）のループ境界。Chrome は通る。

## 2. 原因（確認済み）

- `packages/webrtc/src/nonstandard/userMedia.ts` の `TrackPlaybackRunner.getPacketizer()` は、`packetizerCodecKey(codec)`（mimeType / clockRate / channels / **parameters**）が変わると packetizer を作り直す。作り直すと PictureID などの状態が初期化される。
- 再生は offer の時点で始まるので、1 周目の key は `["video/vp8",90000,null,null]` になる。Firefox の answer には `a=fmtp:<pt> max-fs=12288;max-fr=60` があるので、negotiate 後の codec の parameters は `"max-fs=12288;max-fr=60"` に変わる。2 周目の `play()` で key が変わり、packetizer が作り直されて PictureID が飛ぶ（一時的なログで key の変化を確認した）。
- Chrome の VP8 answer には fmtp がないので、key が変わらず再現しない。

## 3. 対応の方向

- packetization に関係しない fmtp（VP8 の `max-fs` / `max-fr` など）の変化では packetizer を作り直さないようにする。H.264 の `packetization-mode` のように packetization を変える parameter は区別する。または、作り直すときに PictureID などのストリーム状態を引き継ぐ。

## 4. 完了条件

- answer で fmtp が付いた後のループでも PictureID が +1 で続く。`packages/webrtc` にテストを足す（negotiate 前後で codec の parameters が変わるケース）。
- `e2e/tests/mediachannel/vp8Playback.test.ts` の Firefox スキップを外し、`cd e2e && npm run firefox:record -- tests/mediachannel/vp8Playback.test.ts` で通る。スキップ箇所は `grep -rn "firefox-known:vp8-picture-id-loop" e2e/tests` で探す。
- Chrome の E2E（`npm run e2e`）と `npm run test:small` に回帰がない。