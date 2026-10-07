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

# RTP continuity across source replacement

`RtpContinuityRewriter` keeps one continuous downstream sequence number /
timestamp timeline while the upstream RTP source is replaced (relays,
reconnecting upstreams).

```typescript
import { RtpContinuityRewriter, timestampStepFromElapsed } from "werift-rtp";

const rewriter = new RtpContinuityRewriter({ ssrc: downstreamSsrc });

// forward packets; rewrite() returns a shallow clone and never mutates the input
const output = rewriter.rewrite(packet);

// when upstream A is replaced by upstream B
rewriter.switchSource({
  timestampStep: timestampStepFromElapsed(Date.now() - lastSentAt, 90000), // default 1
});
// the first packet rewritten after this is highest output seq + 1 / ts + step
```

- The first source passes through unchanged. Each `switchSource()` freezes fixed
  offsets on the next rewritten packet, based on the most advanced output
  (16/32-bit wrap aware). Loss, duplicates and reordering are kept as-is.
- `rewriteHeaderInPlace(header)` mutates a header you already own.
- `state` / `new RtpContinuityRewriter({ state })` carry the timeline over to
  another instance. `reset()` starts a new timeline.

Responsibilities left to the caller:

| Item | Caller |
| --- | --- |
| SSRC | rewritten only when the `ssrc` option is set |
| Payload type | not touched; rewrite it yourself if upstream/downstream differ |
| RTX | translate an upstream OSN with `translateSequenceNumber()`, drop retransmission history on switch, keep the RTX sequence space separate |
| Downstream NACK | no reverse mapping; retransmit from your own history keyed by output seq |
| RTCP SR | generate SR from the rewritten timestamp, or convert a forwarded SR with `translateTimestamp()` and fix its SSRC |
| TWCC | number per transport; strip or replace upstream TWCC extensions |

See `examples/node/continuity/relay.ts`.

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

# reference

https://github.com/pion/srtp
