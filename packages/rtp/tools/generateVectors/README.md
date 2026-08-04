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
# or: node --import tsx tools/generateVectors/generate.ts
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
- If a plugin is missing, that codec is skipped with a warning; other codecs continue.
- Re-run and commit updated binaries when intentionally refreshing vectors.
