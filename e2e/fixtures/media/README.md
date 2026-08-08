# Codec RTP E2E media fixtures

Short pre-encoded samples used by `mediachannel/codecRtp` E2E tests (scenario B: demux → `packages/rtp` Packetizer → Chrome).

| File | Codec | Container |
|------|--------|-----------|
| `vp8.webm` | VP8 | WebM |
| `vp9.webm` | VP9 | WebM |
| `av1.webm` | AV1 | WebM |
| `h264.mp4` | H.264 | MP4 |
| `opus.webm` | Opus | WebM |

## CI

**Do not** regenerate during CI. Tests only read these committed files. No GStreamer at runtime.

## H.264 note

Scenario A/B for H.264 require a Chromium/Chrome build that advertises `video/H264` in
`RTCRtpSender/Receiver.getCapabilities`. Playwright’s open-source Chromium often omits
proprietary H.264; those cases are **skipped** with a log line. Google Chrome (or a build
with H.264) runs them fully. Black frames are acceptable when the tests do run.

## Regenerating (developers)

```bash
# Requires GStreamer plugins (vp8enc, vp9enc, av1enc, x264enc, opusenc, …)
./e2e/tools/generateCodecFixtures.sh
```

See also root `packages/rtp` README (Chrome E2E section).
