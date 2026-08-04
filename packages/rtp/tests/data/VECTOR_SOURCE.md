# RTP test vector source

Generated without GStreamer (not available in this environment).

Format: repeated `[u16be length][RTP payload]` records — same layout as
`tools/generateVectors/generate.ts` GStreamer capture.

Contents are **RFC-accurate wire payloads** produced by package packetizers
with non-repeating PRNG media bodies (not constant fill bytes).

| File | Contents |
|------|----------|
| vector_pcmu.bin | PCMU 20ms frame payload |
| vector_pcma.bin | PCMA 20ms frame payload |
| vector_g722.bin | G.722 20ms frame payload |
| vector_aac.bin | AAC-hbr fragmented + complete AU payloads |
| vector_h265.bin | H.265 AP + FU payloads |
| vector_telephone_event.bin | RFC 4733 start + end event payloads |
| vector_*_expected.bin | Original media for round-trip asserts |

To replace with live GStreamer captures when plugins are installed:

```bash
npx tsx tools/generateVectors/generate.ts
```
