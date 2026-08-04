# RTP test vector source

**GStreamer-generated** via Docker (`gst-launch-1.0` + plugins-good/ugly/libav).

Regenerate:
```bash
docker run --rm --network host -v $(pwd)/../..:/workspace -w /workspace/packages/rtp \
  node:20-bookworm bash -c \
  "apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
   gstreamer1.0-tools gstreamer1.0-plugins-base gstreamer1.0-plugins-good \
   gstreamer1.0-plugins-ugly gstreamer1.0-libav gstreamer1.0-plugins-bad && \
   npx tsx tools/generateVectors/generate.ts"
```

Then rebuild expected sidecars: `npx tsx tools/generateVectors/buildExpectedFromVectors.ts`

| File | Source |
|------|--------|
| vector_pcmu.bin / vector_pcma.bin | GStreamer mulaw/alaw + rtppay |
| vector_g722.bin | GStreamer avenc_g722 + rtpg722pay |
| vector_aac.bin | GStreamer avenc_aac + rtpmp4gpay |
| vector_h265.bin | GStreamer x265enc + rtph265pay |
| vector_telephone_event.bin | Synthetic RFC 4733 (no GST payloader) |
| vector_*_expected.bin | Depacketized / concatenated media for tests |
