# examples e2e

Root `examples/` demos are smoked with Node vitest + Playwright `chromium.launch`.
This is not the protocol suite in `/e2e`, and it does not copy `examples/turn-loopback` chrome-e2e.

## Scripts

| Script | What it does |
| --- | --- |
| `npm run ci:silent` | Install Chromium if needed, verify committed vendor files, run tests |
| `npm run type` | Type-check the harness |
| `npm run chrome` | Vitest only (assumes browsers and vendor already present) |

From the repository root: `npm run examples:e2e`.

Vendor JavaScript (React 16/18, Babel 5 / standalone, regenerator, axios) is committed under `vendor/`. `ensure-vendor.js` does not download from a CDN when `CI=true`; missing files fail the run.

## Requirements

- Linux / macOS (native Windows is unsupported)
- Chromium (Playwright or system Chrome)
- `gst-launch-1.0` on PATH for GStreamer demos
- `ffmpeg` on PATH for `mediachannel/sendonly/ffmpeg.ts` (CI installs it)
- Fake camera/mic only: `--use-fake-device-for-media-stream`
- The browser is never given the werift polyfill

Missing `ffmpeg` / `gst-launch-1.0` skips those cases locally. `CI=true` fails instead of skipping.

Tests run serially because most demos bind `8888` or `8878`.

AV1 cases accept Chromium's standard `video/AV1` capability as well as the
legacy `video/AV1X` name used by older werift examples. Recording cases wait
for each catalog entry's actual stop interval before asserting the output.

The GStreamer recording cases retain the child process and assert its exit
status and error output. `red-record-gst` also requires a positive received
RTP count, and `save-gstreamer` / `red-record-gst` validate their WebM output
with `ffprobe` after checking that it is non-empty.
