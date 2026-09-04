# AGENTS.md

## Purpose

Instructions for coding agents working in `examples/`.

## Scope

* Applies to root `examples/` demos and the `examples/e2e` vitest + Playwright smoke harness.
* Runtime target: Linux, macOS, and other Unix-like environments only. Native Windows is not supported.
* `examples/turn-loopback` has its own guide and chrome-e2e; do not copy that suite into `examples/e2e`.
* `packages/*/examples` are out of scope for this harness.

## Do

1. Keep `examples/e2e/tests/helpers/catalog.ts` and this guide's catalog tables in sync.
2. Smoke tests must spawn the catalog's Node `.ts` file and open the catalog's HTML (or Vite root). Do not reimplement the demo in `/e2e` handlers.
3. Keep Arrange helpers in `examples/e2e/tests/helpers/`. Write Act / Assert (with Japanese comments) in each `*.test.ts` by kind; do not dispatch them through a shared switch.
4. Keep Babel/React vendor scripts in `examples/e2e/vendor/` (committed). Tests route CDN URLs to those files and must not require unpkg/cdnjs at runtime.
5. Skip gst/ffmpeg cases locally when the binary is missing; fail in `CI=true`.
6. Update `examples/e2e/README.md` when harness scripts change.

## Don't

* Do not inject the werift polyfill into Chromium. Use fake media devices only.
* Do not add Heroku, Ring, Google Nest, empty TURN, manual SDP, Node-only benchmark, DASH, playground, or EME demos to the catalog.
* Do not add `test` to `examples/e2e/package.json` (that would run under root `test:small`).
* Do not mix this harness into root `npm run e2e` or `test:small`.

## Commands

| Task | Command |
| --- | --- |
| install example runtime deps | `npm i --prefix examples` |
| run example smoke tests | `cd examples/e2e && npm i && npm run ci:silent` |
| from repo root | `npm run examples:e2e` |
| type-check harness | `cd examples/e2e && npm run type` |
| install Playwright Chromium | `npm run examples:e2e:install` |

`gst-launch-1.0` and `ffmpeg` must be on PATH for the ffmpeg/gstreamer catalog group.

## Catalog (test)

werift + browser (no extra cloud):

| Node | Browser | Check |
| --- | --- | --- |
| `datachannel/offer.ts` | `datachannel/answer.html` | DataChannel ping/pong |
| `datachannel/answer.ts` | `datachannel/offer.html` | DataChannel ping/pong |
| `datachannel/string.ts` | `datachannel/string.html` | 文字列 DC |
| `close/dc/closed.ts` | `close/dc/closing.html` | Node は answer。offer HTML が DC を閉じる |
| `close/dc/closing.ts` | `close/dc/closed.html` | Node が DC を閉じる |
| `close/pc/closed.ts` | `close/pc/closing.html` | Node は answer。offer HTML が PC を閉じる |
| `close/pc/closing.ts` | `close/pc/closed.html` | Node が PC を閉じる |
| `certificate/offer.ts` | `certificate/answer.html` | 固定証明書 + 映像 |
| `ice/restart/offer.ts` | `ice/restart/answer.html` | ICE restart 後も接続 |
| `ice/trickle/offer.ts` | `ice/trickle/answer.html` | trickle + 映像 |
| `ice/trickle/dc.ts` | `ice/trickle/dc.html` | trickle + DC |
| `mediachannel/sendrecv/{offer,answer,multi_offer}.ts` | 対応 HTML | 双方向 / 複数 |
| `mediachannel/recvonly/{offer,multi_offer,dump}.ts` | 対応 HTML | 片方向。dump は exit 0 |
| `mediachannel/rtp_forward/offer.ts` | `rtp_forward/answer.html` | 受信 RTP |
| `mediachannel/pubsub/offer.ts` | `pubsub/answer.html` | publish / subscribe |
| `mediachannel/sdp/{offer,offer_offer}.ts` | 対応 HTML | SDP 経路 |
| `mediachannel/rtx/{offer,simulcast_offer}.ts` | 対応 HTML | RTX / simulcast+RTX |
| `mediachannel/simulcast/{offer,answer,select,abr,twcc,multiple,multiple_answer}.ts` | 同ディレクトリ HTML | rid 受信。offer/answer/select が代表。multiple 2件は werift 側の track A/B を双方確認 |
| `mediachannel/twcc/{offer,multitrack}.ts` | 対応 HTML | TWCC |
| `mediachannel/red/{sendrecv,recv}.ts` | 対応 HTML | RED |
| `mediachannel/codec/{vp8,vp9,h264,av1}.ts` | Vite `codec/index.html` | AV1 は Chrome 未対応なら skip |
| `save_to_disk/{vp8,vp9,h264,opus,av1x,pipeline}.ts` | `answer.html` | 非空ファイル |
| `save_to_disk/mp4/{h264,opus,av}.ts` | `answer.html` (8878) | MP4 |
| `save_to_disk/dtx/server.ts` | Vite `dtx/index.html` | DTX |
| `save_to_disk/encodedTransform/server.ts` | Vite `encodedTransform/index.html` | encoded transform |
| `interop/server.ts` | `interop/index.html` | HTTP `/offer`。外部 pion は使わない |

ffmpeg / GStreamer:

| Node | Peer | Binary |
| --- | --- | --- |
| `mediachannel/sendonly/offer.ts` | `answer.html` | gst videotestsrc |
| `mediachannel/sendonly/ffmpeg.ts` | `answer.html` | ffmpeg |
| `mediachannel/sendonly/multi_offer.ts` | `multi_answer.html` | harness が videotestsrc を 5000/5001 に spawn |
| `mediachannel/sendonly/av.ts` | `av.html` | フィクスチャ webm（`WERIFT_EXAMPLE_MEDIA_PATH`）。gst/ffmpeg 子プロセスなし。`binary` 未設定は意図的 |
| `mediachannel/red/send.ts` | `send.html` | gst opus |
| `mediachannel/red/record/gst.ts` | Vite `record/index.html` | gst RTP受信 + `opus.webm` 非空 + 正常終了 |
| `save_to_disk/gstreamer.ts` | `answer.html` | gst mux + `capture.webm` 非空 |
| `save_to_disk/gst/recoder.ts` | Vite `gst/index.html` | gst |
| `save_to_disk/packetloss/gst.ts` | Vite `packetloss/index.html` | gst |
| `save_to_disk/rtp.ts` | ブラウザなし | gst audiotestsrc。polyfill RTP register |
| `interop/client.ts` + `interop/server.ts` | Node 同士 + gst | ローカル server.ts |

`examples/turn-loopback` is covered by its existing `npm run chrome-e2e`.

## Catalog (do not test)

| Path | Reason |
| --- | --- |
| `datachannel/heroku-*`, `ice/trickle/heroku-*`, `mediachannel/sendrecv/heroku-*` | 外部 Heroku socket.io |
| `datachannel/manual.ts` | 手動 SDP |
| `datachannel/local.ts` | ブラウザなし（werift 同士） |
| `benchmark/` | ベンチマーク。ブラウザなし |
| `getStats/demo.ts` | Node 同士の API デモ |
| `google-nest/` | googleapis + `credential.env` |
| `ring/` | `ring-client-api` |
| `ice/turn/trickle_offer.ts` | TURN URL/資格情報が空 |
| `dash/` | DASH 再生クライアントと別 HTTP |
| `playground/` | 実験用 |
| `save_to_disk/dump.ts` | ローカル RTP dump 再生 |
| `save_to_disk/encrypt/` | EME |
| `save_to_disk/react-client/` | 追加フロント構成 |
| `packages/*/examples` | 範囲外 |
| `examples/turn-loopback` | 既存 chrome-e2e |

Public STUN URLs in HTML are not treated as extra dependencies.

## Validation

* Example behavior or catalog changes: `cd examples/e2e && npm run type` and `npm run ci:silent`.
* Harness-only changes: same commands. Do not run root `test:small` for Chromium/gst work.
* `sendonly/av.ts` media path and `save_to_disk/rtp.ts` polyfill changes must be covered by the ffmpeg/gstreamer group.

## Maintenance

* Keep Purpose / Scope / Do / Don't / Commands / Validation / Maintenance in this order.
* When adding or dropping a demo, update `catalog.ts` and the tables above together.
