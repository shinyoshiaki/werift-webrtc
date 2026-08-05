# RTP-over-UDP example (Node-only)

Demonstrates package-local **packetizers** and **depacketizers** without WebRTC
or GStreamer. Two UDP peers on loopback exchange plain RTP.

## Self-test (recommended)

Round-trip in one process (ephemeral port, no external tools):

```bash
cd packages/rtp
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ pcmu
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ h265
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ aac
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ vp8
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ vp9
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ av1
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ opus
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ h264
```

Supported codec names: `pcmu`, `pcma`, `g722`, `aac`, `h265`, `vp8`, `vp9`, `av1`, `opus`, `h264`.

## Two-process send / receive

Terminal A:

```bash
npx tsx examples/node/rtp_over_udp/recv.ts 5004 pcmu
```

Terminal B:

```bash
npx tsx examples/node/rtp_over_udp/send.ts 127.0.0.1 5004 pcmu
```

## Notes

- Payload types follow RFC 3551 static assignments where applicable (PCMU=0, PCMA=8, G722=9).
- H.265 / AAC use dynamic PT 96 by default.
- Telephone-event (RFC 4733) is intentionally not frame-aggregated; use `TelephoneEventRtpPayload` directly.
