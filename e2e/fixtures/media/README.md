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

Scenario A/B for H.264 require a browser that advertises `video/H264` in
`RTCRtpSender/Receiver.getCapabilities` (P0 — **not** a silent skip).

CI / local setup:

```bash
# Prefer system Google Chrome, or extract a user-local copy (no root):
./e2e/tools/ensure-google-chrome.sh
# ensure-browser.js also auto-downloads into e2e/.cache/google-chrome/
cd e2e && npm run install:browsers
```

`vitest.config.mts` prefers `CHROME_BIN` / `GOOGLE_CHROME_BIN` / the cached extract over
Playwright’s open-source Chromium. Black frames remain acceptable for H.264 decode checks.

Only set `__E2E_ALLOW_H264_SKIP__=1` in the browser context for intentional local OSS-Chromium
runs; default is **fail** if H.264 is missing so CI does not greenwash P0.

**Scenario A (depacketize)** requires live Chrome RTP (`source: "chrome"`). There is **no**
fixture fallback that can greenwash P0. Use Google Chrome (see above) so H.264 encode is
available; the browser is offerer / Node answers. Scenario B always uses live Chrome receive
of packetized fixture RTP.

**Scenario C (repacketize)** runs for VP8, H.264, Opus, VP9, and AV1 (Chrome → depacketize →
`packages/rtp` Packetizer → Chrome). All codecs use the same signaling: **Node offerer /
Chrome answerer**. (H.264 requires SDP encoding name `H264` uppercase — see `useH264()` —
so Chrome can software-encode as answerer.)

## Regenerating (developers)

```bash
# Requires GStreamer plugins (vp8enc, vp9enc, av1enc, x264enc, opusenc, …)
./e2e/tools/generateCodecFixtures.sh
```

See also root `packages/rtp` README (Chrome E2E section).
