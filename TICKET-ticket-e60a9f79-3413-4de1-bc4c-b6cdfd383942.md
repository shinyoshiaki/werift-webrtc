## Motivation

Applications that relay RTP from one upstream source into a long-lived downstream RTP/SRTP session often need to replace the upstream source without resetting the downstream sequence-number/timestamp timeline.

A concrete example is dgreif/ring#1816: Ring closes an answered live-view transport after roughly 30 minutes, so the application creates a replacement WebRTC connection while keeping the existing HomeKit stream alive. The replacement connection starts RTP sequence numbers and timestamps from a new origin, so the application currently implements its own RTP continuity rewriting.

werift already contains similar continuity logic internally in `RTCRtpSender.replaceRTP()`, but that logic is not reusable by applications that operate on received/raw RTP packets.

This feature should build on/follow #677, which covers correctness issues in the current sender-side source-switch behavior.

## Proposal

Expose a reusable RTP continuity primitive from the RTP package, for example:

```ts
const rewriter = new RtpContinuityRewriter({
  clockRate: 90_000,
})

rewriter.switchSource(firstPacket.header, {
  timestampStep: 3000,
})

const output = rewriter.rewrite(packet)
```

The exact API is open for discussion. The important part is to centralize wrap-safe source-switch translation instead of requiring every relay/gateway application to reimplement it.

## Desired behavior

On a source change, calculate fixed sequence-number and timestamp translations once at the boundary:

```text
seqOffset = nextOutputSeq - firstInputSeq
timestampOffset = nextOutputTimestamp - firstInputTimestamp
```

Then apply those offsets to all packets from that source.

Using a fixed translation preserves the source's own RTP structure, including:

- sequence gaps caused by packet loss;
- reordered/duplicate packets;
- multiple RTP packets belonging to the same video frame;
- natural timestamp spacing;
- 16-bit sequence and 32-bit timestamp wrap-around.

The primitive should avoid deriving a new offset from every packet delta, because reordered/lost packets can otherwise distort the output timeline.

## Scope

The utility should be useful outside `RTCPeerConnection`, including:

- WebRTC-to-SRTP/HomeKit gateways;
- WebRTC/RTSP/SIP media relays;
- source failover;
- reconnecting cameras;
- recording/transmuxing pipelines that want a stable RTP timeline;
- SFU/proxy-like forwarding where the downstream transport must survive an upstream replacement.

It should not implement signaling-layer reconnection or application-specific retry policy.

## Integration with RTCRtpSender

Ideally, `RTCRtpSender` should use the same continuity primitive internally for `replaceTrack()` / `MediaStreamTrack.onSourceChanged`, so sender-side and application-side rewriting share one implementation and one set of wrap/edge-case tests.

Possible exported state/API should also make it practical to preserve continuity across wrapper objects or explicitly start a new generation/source.

## RTCP / SSRC considerations

The initial version can focus on RTP sequence/timestamp translation, but the design should explicitly document how it interacts with:

- SSRC rewriting or preservation;
- RTP payload type rewriting;
- RTX sequence/history state;
- RTCP Sender Reports and RTP timestamp mappings;
- transport-wide sequence-number extensions;
- repeated source switches.

These do not all need to be handled by the utility itself, but callers should not be left with ambiguous semantics.

## Acceptance criteria

- Public reusable API in an appropriate RTP/nonstandard package.
- Fixed-offset translation after each source switch.
- 16-bit sequence-number and 32-bit timestamp wrap-safe arithmetic.
- Tests for multiple-packet video frames, loss, duplicates, reordering, and wrap-around.
- Tests for multiple consecutive source switches.
- No mutation surprises: document whether `rewrite()` mutates or clones its input.
- Demonstrate one relay-style example where upstream source B replaces source A while downstream RTP remains continuous.
- Reuse the same implementation from `RTCRtpSender` where practical.

## Related

- #677
- dgreif/ring#1816: Preserve HomeKit streams after Ring answered timeout

---

## Comment 1
Thanks for taking a look at my Ring PR and for opening this upstream. I’d love to see this implemented in werift. Let me know if there’s anything I can do to help test or validate it against the Ring/HomeKit use case.

I think the structure you outlined will work well. It seems much cleaner to handle the RTP continuity in werift than to maintain that logic separately in downstream projects like Ring.