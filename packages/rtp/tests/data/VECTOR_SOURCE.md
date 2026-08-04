# RTP test vector source

When GStreamer (`gst-launch-1.0`) is available, prefer:

```bash
npx tsx tools/generateVectors/generate.ts
```

Otherwise this file is written by `writeSyntheticVectors.ts`: RFC-accurate
wire payloads from package packetizers with non-repeating PRNG media bodies
(not constant fill bytes). Format: `[u16be length][payload]` records.

| File | Contents |
|------|----------|
| vector_pcmu.bin / vector_pcma.bin | G.711 20ms frames |
| vector_g722.bin + vector_g722_expected.bin | G.722 + original body |
| vector_aac.bin + vector_aac_expected.bin | AAC-hbr fragments + complete |
| vector_h265.bin | H.265 AP/FU (mixed F/LayerId/TID) |
| vector_telephone_event.bin | RFC 4733 start + end events |
