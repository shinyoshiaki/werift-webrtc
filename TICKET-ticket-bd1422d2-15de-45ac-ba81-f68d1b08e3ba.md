## Summary

`RTCRtpSender` currently caches the NTP time and RTP timestamp when the most recent RTP packet is dispatched, then reuses that cached pair when emitting a later RTCP Sender Report (SR).

That means an SR sent substantially after the last RTP packet can advertise an **old NTP timestamp** instead of the wall-clock time when the SR is actually sent.

RFC 3550 defines the SR NTP timestamp as the wall-clock time when the report is sent, and the SR RTP timestamp as the RTP-clock value corresponding to that same instant.

## Current behavior

The sender updates the cached pair while sending RTP:

```ts
const ntpTimestamp = ntpTime();
...
this.ntpTimestamp = ntpTimestamp;
this.rtpTimestamp = header.timestamp;
```

Later, `runRtcp()` builds the Sender Report using the cached values:

```ts
new RtcpSenderInfo({
  ntpTimestamp: this.ntpTimestamp,
  rtpTimestamp: this.rtpTimestamp,
  ...
})
```

So, for example:

```text
last RTP packet sent at t = 10.000 s
  RTP timestamp = 480000

RTCP SR actually sent at t = 10.700 s

current SR reports:
  NTP = 10.000 s
  RTP = 480000
```

The NTP value is stale by 700 ms.

This can also distort RTT calculations that use the SR's LSR/DLSR fields, because the NTP timestamp no longer represents the report transmission time.

## Expected behavior

At SR generation time:

1. Sample the **current NTP/wall-clock time**.
2. Report an RTP timestamp corresponding to that same instant in the sender's RTP clock domain.

For a continuously advancing 48 kHz audio clock, conceptually:

```text
anchor:
  NTP = 10.000 s
  RTP = 480000

SR generated at:
  NTP = 10.700 s

SR RTP timestamp:
  approximately 480000 + 0.700 * 48000
  = 513600
```

The exact implementation should respect the sender's actual media clock and not assume that packet send cadence itself defines sampling time.

## Design considerations

This needs care for:

- raw RTP relay sources whose timestamps originate elsewhere,
- silence suppression / gaps,
- codecs with different clock rates,
- timestamp wraparound,
- source replacement / continuity rewriting,
- delayed or jittery packet delivery.

A robust implementation likely needs to maintain an explicit NTP↔RTP clock anchor rather than simply extrapolating from packet-count or `setInterval` cadence.

## Suggested tests

- SR emitted immediately after RTP: mapping remains close to the last packet anchor.
- SR emitted hundreds of milliseconds after the last RTP packet: NTP reflects SR send time, not the previous RTP send time.
- RTP timestamp corresponds to the same instant as the SR NTP timestamp.
- 32-bit RTP timestamp wraparound.
- 48 kHz audio and 90 kHz video clock rates.
- sender with source replacement / RTP continuity rewrite.
- long idle gap / silence-suppression-like behavior.

## Related downstream finding

This was noticed while reviewing OpenClaw PR https://github.com/openclaw/openclaw/pull/146078, which fixed a separate RTP media-clock drift issue in its `werift`-backed GPT-Live sender. That downstream bug should remain fixed in OpenClaw; this issue is specifically about werift's own RTCP SR timestamp semantics.