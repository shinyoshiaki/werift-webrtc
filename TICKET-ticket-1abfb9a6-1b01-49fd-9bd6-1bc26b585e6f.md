## Summary

`RTCRtpSender` only updates RTT when an incoming Receiver Report's `LSR` matches the **most recently sent** Sender Report.

If a receiver report refers to an older SR — which is normal when media/RTCP is delayed or queued — werift ignores that RTT sample entirely.

This was reproduced against a real Chrome receiver in `Rkcr007/mfarm-cloud` while debugging video over a bandwidth-constrained TURN path:

https://github.com/Rkcr007/mfarm-cloud/pull/273

Their regression test sends/records multiple SR clock points, then feeds werift an RR that echoes an older SR. werift ignores it, while the downstream history-based implementation calculates the expected RTT.

## Current implementation

Current `develop` in `packages/webrtc/src/media/rtpSender.ts` keeps only one SR identity/time pair:

```ts
private lastSRtimestamp?: number;
private lastSentSRTimestamp?: number;
```

Each new Sender Report overwrites it:

```ts
this.lastSRtimestamp = compactNtp(this.ntpTimestamp);
this.lastSentSRTimestamp = timestampSeconds();
```

Receiver Reports are accepted only when they echo that latest SR:

```ts
if (this.lastSRtimestamp === report.lsr && report.dlsr) {
  if (this.lastSentSRTimestamp) {
    const rtt =
      timestampSeconds() -
      this.lastSentSRTimestamp -
      report.dlsr / 65536;
    ...
  }
}
```

So with SRs A, B, C already sent, an RR for A or B is dropped once C has become `lastSRtimestamp`.

## Why this is valid traffic

RTCP Receiver Reports identify the Sender Report they are reporting on through `LSR` and `DLSR`.

A receiver is not required to return a report quickly enough that the sender has sent no newer SR in the meantime. Queueing, scheduling delay, relay delay, or a congested media path can easily make an RR for SR A arrive after SR B/C were transmitted.

RFC 3550 RTT calculation is based on the particular SR identified by the RR, not on “whatever SR was most recently transmitted locally”.

## Downstream impact

mfarm-cloud observed a constrained video path where Chrome's effective round trip grew substantially behind a queue, while werift's sender RTT could remain stale because delayed RRs referenced older SRs and were ignored.

They introduced a bounded `SenderReportLog` that records multiple SR identities/times and resolves RTT by the RR's LSR.

Their test explicitly covers:

```text
send SR A
send SR B
send SR C
receive RR whose LSR references SR A
=> RTT must still be computed
```

This matters for:

- `RTCRemoteInboundRtpStreamStats.roundTripTime`
- congestion/adaptation logic consuming sender RTT
- diagnostics on queued/congested media paths
- applications that use media RTT as an input to transport policy

## Relation to #701

#701 tracks a separate Sender Report timestamp-mapping problem: the SR NTP/RTP pair should represent the instant the SR is sent.

This issue is distinct.

Even after #701 is fixed, a sender that stores only the latest SR cannot match a delayed RR that legitimately references an older SR.

The two changes should be compatible. Once SR timestamps are correct, RTT can either:

- follow the RFC compact-NTP calculation directly, or
- retain a bounded history keyed by LSR and the actual send time.

## Expected behavior

When an RR contains a non-zero LSR corresponding to any **recently sent** SR, werift should be able to calculate an RTT sample even if newer SRs were sent afterwards.

Unknown/stale LSR values that cannot safely be matched should still be ignored.

## Suggested implementation

One option is a bounded recent-SR history, e.g.:

```ts
Map<compactNtpLsr, monotonicSendTime>
```

On SR send:

1. record the compact NTP value actually placed in the SR;
2. record a monotonic send timestamp;
3. retain only a bounded number/time window of entries.

On RR receive:

1. look up `report.lsr`;
2. if found, compute `now - srSendTime - DLSR`;
3. reject negative/unreasonable samples;
4. update `rtt`, `totalRoundTripTime`, and measurement count.

Alternatively, after #701 makes the SR NTP timestamp standards-correct, implement the RFC 3550 compact-NTP arithmetic directly while handling wrap correctly.

## Regression tests

Please cover:

1. SR A sent, then SR B, RR references A -> RTT updates.
2. Several newer SRs are sent before the RR -> older recent SR still matches.
3. RR references latest SR -> existing behavior remains.
4. Unknown LSR -> no RTT update.
5. Bounded history eviction -> very old LSR is ignored safely.
6. Compact-NTP wraparound.
7. RTT statistics (`roundTripTime`, `totalRoundTripTime`, count) update correctly.
8. Integration with the SR timestamp semantics fixed by #701.

I did not find an existing issue specifically tracking the latest-SR-only RR matching behavior.