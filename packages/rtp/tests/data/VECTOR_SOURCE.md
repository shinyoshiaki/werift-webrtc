# RTP test vector source

**Mixed**: GStreamer where plugins succeeded (9: PCMU, PCMA, G722, AAC, H265, VP8, VP9, H264, Opus);
package packetizer synthetic for the rest (including telephone-event / AV1 without payloader).

Regenerate:

```bash
cd packages/rtp
npx tsx tools/generateVectors/generate.ts
```

Docker (if host has no GStreamer):

```bash
docker run --rm --network host -v "$(pwd)/../..":/workspace -w /workspace/packages/rtp \
  node:20-bookworm bash -c \
  "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
   gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
   gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-plugins-bad && \
   npx tsx tools/generateVectors/generate.ts"
```

| File | Source (when GST available) |
|------|------------------------------|
| vector_pcmu / pcma | mulawenc/alawenc + rtppay |
| vector_g722 | avenc_g722 + rtpg722pay |
| vector_aac | avenc_aac + rtpmp4gpay |
| vector_h265 | x265enc + rtph265pay |
| vector_h264 | x264enc + rtph264pay |
| vector_vp8 | vp8enc + rtpvp8pay |
| vector_vp9 | vp9enc + rtpvp9pay |
| vector_opus | opusenc + rtpopuspay |
| vector_av1 | synthetic Av1Packetizer (no rtpav1pay on most distros) |
| vector_telephone_event | synthetic RFC 4733 |
| vector_*_expected.bin | depacketized / concatenated media for tests |
