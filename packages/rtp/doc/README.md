**werift-rtp**

***

# werift-rtp

RTP/RTCP/SRTP/SRTCP implementation for TypeScript

# install

`npm install werift-rtp`

# basic usage

```typescript
const buffer: Buffer = something;
const rtpPacket: RtpPacket = RtpPacket.deSerialize(buffer);

const buffer: Buffer = rtpPacket.serialize();
```

# codecs (packetizer / depacketizer)

Depacketizers implement `DePacketizerBase` and are registered in
`dePacketizeRtpPackets` / `depacketizerCodecs`. Packetizers extend
`PacketizerBase` and live next to their depacketizer in `src/codec/`.

| Codec | Depacketizer | Packetizer | Notes |
|-------|--------------|------------|--------|
| H.264 | `H264RtpPayload` | (see webrtc userMedia) | RFC 6184 |
| H.265 / HEVC | `H265RtpPayload` | `H265Packetizer` | RFC 7798 — AP / FU / single NAL |
| VP8 / VP9 / AV1 | `Vp8RtpPayload` / … | (see webrtc userMedia) | |
| Opus | `OpusRtpPayload` | (see webrtc userMedia) | |
| PCMU / PCMA | `PcmuRtpPayload` / `PcmaRtpPayload` | `PcmuPacketizer` / `PcmaPacketizer` | RFC 3551 PT 0 / 8, 8000 Hz |
| G.722 | `G722RtpPayload` | `G722Packetizer` | RFC 3551 PT 9, **RTP clock 8000 Hz** |
| AAC-hbr | `AacHbrRtpPayload` | `AacHbrPacketizer` | RFC 3640, registry `MPEG4-GENERIC` |
| telephone-event | `TelephoneEventRtpPayload` | `TelephoneEventPacketizer` | RFC 4733 (not frame-aggregated) |

## depacketize frames

```typescript
import { dePacketizeRtpPackets, H265RtpPayload } from "werift-rtp";

// Registry path (H265, PCMU, PCMA, G722, MPEG4-GENERIC, …)
const frame = dePacketizeRtpPackets("H265", rtpPackets);
// frame.data is Annex-B for H.265 / H.264

// Or call the payload class directly
const nal = H265RtpPayload.deSerialize(rtp.payload);
```

## packetize media

```typescript
import { PcmuPacketizer, H265Packetizer, AacHbrPacketizer } from "werift-rtp";

const pcmu = new PcmuPacketizer(); // PT 0
const packets = pcmu.packetize(pcmUlawBytes, rtpTimestamp);

const h265 = new H265Packetizer({ maxPayloadSize: 1200 });
const videoPackets = h265.packetize(annexBOrLengthPrefixedSample, ts);
```

## telephone-event (DTMF)

Not registered in `dePacketizeRtpPackets` (single-packet primitive; marker on
**first** packet of the event per RFC 4733):

```typescript
import { TelephoneEventPacketizer, TelephoneEventRtpPayload } from "werift-rtp";

const p = new TelephoneEventPacketizer(); // PT 101 default
// Prefer Start / Continue / End for RFC marker + E-bit control
const start = p.packetizeStart(1, 10, 160, ts); // marker=1
const cont = p.packetizeContinue(1, 10, 480, ts);
const end = p.packetizeEnd(1, 10, 800, ts); // E=1
// Or: p.packetize({ event, volume, duration, start: true }, ts)
const fields = TelephoneEventRtpPayload.deSerialize(start.payload);
```

## plain RTP-over-UDP example

See `examples/node/rtp_over_udp/` (Node `dgram` peer, no GStreamer required):

```bash
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ pcmu
```

# When using in browser

```sh
npm i buffer
```

```ts
import "buffer";
import {} from "werift-rtp";
```

# advanced usage

see `./tests/**/*.test.ts`

# test vectors

Committed payloads under `tests/data/vector_*.bin` (and synthetic cases in tests).
Regenerate with GStreamer via `tools/generateVectors/` when available.
If `gst-launch-1.0` is missing, the generator logs a spawn `error` and skips
that codec without overwriting committed files.

# RFC authority notes

Where earlier task notes disagreed with the RFCs, **`docs/rfc/` text is authoritative** (ticket text has been aligned):

- **H.265** (RFC 7798): AP Type=**48**, FU Type=**49**. AP PayloadHdr: **F = OR** of aggregated NALs, **LayerId/TID = minimum**. FU **F** equals the fragmented NAL’s F bit.
- **G.722** (RFC 3551 §4.5.2): RTP clock **and** octet rate are **8000**/s (20 ms = **160** octets, not 320).
- **AAC-hbr** (RFC 3640 §3.2.1.1 / §3.3.6): AU-size is the size **in octets** (not size−1); max 8191. CTS/DTS are optional via `AacHbrDepacketizerOptions`.

# reference

- https://github.com/pion/srtp
- RFCs under repo `docs/rfc/` (`rfc3551`, `rfc3640`, `rfc4733`, `rfc7798`, …)
