# [userMedia] ファイル再生のループで VP8 の PictureID が初期値に戻る（answer の fmtp で packetizer を作り直す）

## 1. 目的と背景

- Firefox E2E 整備（`a461df90-10bb-4aad-8f1b-3cce626d630b`、親チケット #269 `190063e8-99d9-410f-89ca-cee8cf6423a1` の派生）で見つかった werift 本体の不具合。
- E2E `e2e/tests/mediachannel/vp8Playback.test.ts` の `file`（`createFileMediaPlayer({ loop: true })` の VP8 送出。サーバー側は `e2e/server/handler/mediachannel/vp8Playback.ts`）が、Firefox 157 では毎回失敗する。`pictureIdGapDetails` が `[{ frame: 60, from: 8363, to: 2288 }]` になる。frame 60 は fixture（2 秒、30fps）のループ境界。Chrome は通る。
- 現在このテストは Firefox で `itSkipOnFirefox(firefoxKnownIssue.vp8PictureIdLoop)` によりスキップされている（`e2e/tests/fixture.ts` の `firefoxKnownIssue.vp8PictureIdLoop`、タグ `[firefox-known:vp8-picture-id-loop]`）。
- 目的: negotiate で codec の fmtp が変わっても、ファイル再生のストリーム状態（VP8 PictureID）を連続させる。

## 2. 原因（確認済み、最新コードで再確認）

- `packages/webrtc/src/nonstandard/userMedia.ts` の `TrackPlaybackRunner`:
  - `play()` の先頭で `requireNegotiatedCodec()` → `getPacketizer(codec)` を呼ぶ（ループの 1 周ごとに 1 回）。
  - `getPacketizer()` は `packetizerCodecKey(codec)` が前回と違うと `createPacketizer()` で packetizer を作り直す。
  - `packetizerCodecKey()`（同ファイル末尾付近）は `[normalizeMimeType(mimeType), clockRate, channels, parameters]` の JSON。payloadType は除外済み（`MediaStreamTrack.writeRtp` が `track.codec` から書き換えるため）だが、**`parameters` は含む**。
- `Vp8Packetizer`（`packages/rtp/src/codec/vp8.ts`）は PictureID をインスタンスに持ち、初期値は `options.pictureId ?? random16()`。作り直すと PictureID がランダムな値に戻る。
- 再生は offer の時点で始まるので、1 周目の key は `["video/vp8",90000,null,null]`。Firefox の answer には `a=fmtp:<pt> max-fs=12288;max-fr=60` があり、negotiate 後の `track.codec.parameters` は `"max-fs=12288;max-fr=60"` になる。2 周目の `play()` で key が変わり、packetizer が作り直されて PictureID が飛ぶ（一時的なログで key の変化を確認済み）。
- Chrome の VP8 answer には fmtp がないので key が変わらず、再現しない。
- 既存テスト `packages/webrtc/tests/nonstandard/userMedia.test.ts` の「keeps VP8 PictureID continuous across loops when the sender re-assigns the negotiated codec」は、codec オブジェクトの差し替えと payloadType の確定だけを扱っていて、`parameters` の変化は扱っていない。そのため今回の不具合を検出できていない。

## 3. 実装方針

### 3.1 推奨: packetizer の作り直し判定を「packetizer の出力に影響する値」に絞る

`createPacketizer()`（`packages/webrtc/src/nonstandard/userMedia/packetizer.ts`）が codec から実際に読む値は次のとおり。

| sourceCodec | codec から読む値 | parameters の影響 |
| --- | --- | --- |
| avc | payloadType、`packetization-mode` | `packetization-mode != 1` なら例外。それ以外の fmtp（`profile-level-id` など）は出力に影響しない |
| vp8 / vp9 / av1 / opus | payloadType | なし |

payloadType はすでに key から外れている。mimeType も `requireNegotiatedCodec()` が source codec との一致を検査している。そのため次のようにする。

- `packetizerCodecKey()` から生の `parameters` を外す。H.264 だけ `getH264PacketizationMode(codec.parameters)` で正規化した値（例: `packetization-mode=1`）を key に入れる。必要なら packetizer.ts から key を作るヘルパー（例: `packetizerStateKey({ codec, sourceCodec })`）を export し、`createPacketizer()` と同じ場所で「何が出力に影響するか」を管理する。
- clockRate / channels は今の key に残してよい（変わることはまずないが、変わったら作り直すのが安全）。
- H.264 で answer の `packetization-mode` が 1 以外になったときは、従来どおり `createPacketizer()` の例外で再生を止める（これは意図した挙動）。

### 3.2 代替案（採らない方向）

- 作り直すときに PictureID を引き継ぐ（`Vp8Packetizer` の `pictureId` option に前の値を渡す）。packetizer の内部状態を外へ出す API が要り、VP9 / AV1 で状態が増えると同じ対応が繰り返し必要になる。3.1 で作り直しそのものがなくなるなら不要。

### 3.3 テスト

- `packages/webrtc/tests/nonstandard/userMedia.test.ts` に、既存の PictureID 連続テストと同じ形（Arrange は `userMediaTestUtils.ts` の `createAvWebmBuffer` / `collectFrames` を再利用）で次を追加する。
  - VP8: 1 周目の再生中に `media.video!.codec = useVP8({ payloadType: 96, parameters: "max-fs=12288;max-fr=60" })` に差し替える。ループ境界を含めて PictureID が +1 で続くこと。
  - H.264（任意だが推奨）: `profile-level-id` などだけが変わるときは作り直さないこと、または `packetization-mode` が変わったとき従来どおりエラーになることを確認する。
- Act / Assert のコメントは日本語で書く（AGENTS.md）。

## 4. 考慮すべき制約・注意点

- `RTCRtpSender` は offer / answer のたびに新しい codec オブジェクトを `track.codec` に代入する。比較は値で行い、オブジェクトの同一性では行わない（既存コメントの方針を維持する）。
- PictureID が初期値に戻る問題は Firefox 以外の相手にも起きうる（answer に VP8 fmtp を付ける実装すべて）。修正は E2E 専用ではなく `packages/webrtc/src` の通常動作として入れる。
- `track.writeRtp` が SSRC / payloadType / sequence number を書き換えるので、packetizer の作り直しで実際に壊れるのはコーデック固有の状態（VP8 PictureID）。VP9 / AV1 packetizer には現状フレームをまたぐ ID 状態はないが、key の方針はすべての codec で揃える。
- 公開 API は変えない想定。`changelog.md` には不具合修正として 1 行足す。
- E2E の Firefox 実行は `firefox:record` で記録を残し、`e2e/firefox-runs/` の run record をコミットに含める（AGENTS.md）。

## 5. 完了条件

- [ ] answer で fmtp（`max-fs` / `max-fr`）が付いた後のループでも、VP8 PictureID がフレームごとに +1 で続く。
- [ ] `packages/webrtc/tests/nonstandard/userMedia.test.ts` に、negotiate 前後で codec の `parameters` が変わるケースのテストがある。修正前のコードでは失敗する。
- [ ] H.264 の `packetization-mode` 検査（1 以外なら例外）が従来どおり動く。
- [ ] `e2e/tests/mediachannel/vp8Playback.test.ts` の `itSkipOnFirefox(firefoxKnownIssue.vp8PictureIdLoop)` を `it` に戻し、使われなくなった `firefoxKnownIssue.vp8PictureIdLoop` を `e2e/tests/fixture.ts` から消す（`grep -rn "firefox-known:vp8-picture-id-loop" e2e/tests` で 0 件）。
- [ ] `cd e2e && npm run firefox:record -- tests/mediachannel/vp8Playback.test.ts` で通り、run record をコミットする。
- [ ] `cd packages/webrtc && npm test`（対象テスト）、`npm run type`、`npm run test:small` が通る。Chrome の `npm run e2e` に回帰がない（このホストで HEAD から落ちる既知のテストは除く）。
- [ ] `npm run format` を実行済み。
