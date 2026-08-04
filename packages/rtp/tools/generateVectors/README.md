# RTP test vector generation (GStreamer)

Generates wire-format RTP payload samples for codec tests and saves them under
`packages/rtp/tests/data/`. Tests themselves run **without** GStreamer using the
committed binaries (and synthetic vectors in `*.test.ts`).

## Requirements

- Node.js >= 10
- `gst-launch-1.0` with plugins:
  - **good**: `mulawenc`, `alawenc`, `rtppcmupay`, `rtppcmapay`, `rtpg722pay`, `rtpmp4gpay` (or `rtpgstpay`)
  - **ugly / bad / libav**: `x265enc` or `h265parse`, `avenc_aac`, `g722enc`

## Usage

```bash
cd packages/rtp
npx tsx tools/generateVectors/generate.ts
# After capture, expected sidecars are rebuilt automatically.
# Manual rebuild: npx tsx tools/generateVectors/buildExpectedFromVectors.ts
```

### Docker (when host has no GStreamer)

```bash
docker run --rm --network host \
  -v "$(pwd)/../..":/workspace -w /workspace/packages/rtp \
  node:20-bookworm bash -c \
  "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
   gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
   gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-plugins-bad && \
   npx tsx tools/generateVectors/generate.ts"
```

Each codec opens a UDP socket, launches a short `gst-launch-1.0` pipeline, and
writes the first few RTP **payloads** (not full packets) to:

| File | Codec |
|------|--------|
| `tests/data/vector_pcmu.bin` | PCMU |
| `tests/data/vector_pcma.bin` | PCMA |
| `tests/data/vector_g722.bin` | G.722 |
| `tests/data/vector_aac.bin` | MPEG4-GENERIC (AAC-hbr) |
| `tests/data/vector_h265.bin` | H.265 (may need `x265enc`) |

DTMF / telephone-event has no standard GStreamer payloader; use the synthetic
vectors in `telephoneEvent.test.ts` and the existing `rtp_dtmf.bin` fixture.

## Notes

- Pipelines are short (`num-buffers` limited) so generation finishes quickly.
- If `gst-launch-1.0` is missing, spawn fires an `error` event (ENOENT); that
  codec is **skipped**. If **no** codec produces payloads, the script falls back
  to `writeSyntheticVectors.ts` (RFC wire-format packetizer payloads with
  non-fill PRNG bodies) and writes `tests/data/VECTOR_SOURCE.md`.
- Tests load committed `vector_*.bin` for PCMU/PCMA/G722/AAC/H.265/DTMF.
- Prefer a full GStreamer run when plugins are available, then re-commit binaries.
