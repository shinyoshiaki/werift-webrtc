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

# real-time media pacing (RtpMediaClock)

`setInterval(() => { timestamp += frameSamples; ... }, frameDurationMs)` drifts:
every late timer callback makes wall-clock time run ahead of the RTP media clock.
`RtpMediaClock` schedules each frame at a monotonic absolute deadline
(`performance.now()`), so lateness never accumulates.

```typescript
import { RtpBuilder, RtpMediaClock } from "werift-rtp"; // also exported from "werift"

const clock = new RtpMediaClock({
  clockRate: 48_000,
  frameSamples: 960, // or frameDurationMs: 20 (fractional values are allowed)
  // signal: abortController.signal, unref: true,
});
const builder = new RtpBuilder({ payloadType: 111 });

clock.onTick.subscribe((tick) => {
  // tick: { frameIndex, timestamp, elapsedSamples, skippedFrames, deadline, lateness }
  const rtp = builder.create(encodeOpusFrame(), { tick });
  sender.sendRtp(rtp); // RTCRtpSender from werift
});
clock.start();

// clock.pause(); clock.resume(); clock.resume({ continuous: true }); clock.stop();
```

- **Stall handling**: if the event loop stalls past several deadlines, `onTick`
  fires once for the latest reached slot. The slots in between are reported as
  `skippedFrames` and appear as a timestamp gap; late packets are never burst.
- **pause / resume**: `resume()` re-anchors the clock to the resume time and
  emits a tick immediately (no burst). By default the paused wall-clock time is
  reflected as a timestamp gap (same as a stall), which keeps RTP time aligned
  with real time for RTCP SR / lip-sync. `resume({ continuous: true })` collapses
  the pause and advances by exactly one frame.
- `onTick` subscribers run synchronously after the clock state and the next
  timer are committed. Returned promises are **not** awaited (no backpressure).
- Inject `now` / `scheduler` options for deterministic tests.

`RtpBuilder` keeps sequence numbers per created packet (16-bit wrap) and the
timestamp on the media timeline (32-bit wrap):

```typescript
// legacy fixed pacing (unchanged): +between*clockRate/1000 per create()
new RtpBuilder({ between: 20, clockRate: 48_000 });

// video: several packets share one timestamp
const video = new RtpBuilder({ payloadType: 96, ssrc });
video.create(part1, { elapsedSamples: 3000 });
video.create(part2, { elapsedSamples: 0, marker: true });

// explicit timeline control
video.advanceSamples(3000); // timestamp only, seq unchanged
video.create(payload, { timestamp: remoteTimestamp }); // absolute timestamp
```

**When not to use it**: relays, recording and file playback already own their
timeline (e.g. the remote source's RTP timestamps or container timestamps).
Pass those timestamps through as-is (`create(payload, { timestamp })` or the
original packet). `RTCRtpSender.sendRtp()` never rewrites RTP timestamps based on
send time, and no pacing is enforced on these use cases.

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
