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

- **Stall handling** (`stallPolicy`): if the event loop stalls past several
  deadlines, `onTick` fires once; late ticks are never burst.
  - `"skip"` (default): the tick is for the latest reached slot. The slots in
    between are reported as `skippedFrames` and appear as a timestamp gap, so
    RTP time stays aligned with real time. Use it for audio and for live video
    that encodes the latest captured frame on each tick (skipped slots are never
    encoded, so the delta-frame reference chain stays intact).
  - `"delay"`: no slot is skipped. The next slot is emitted immediately
    (`lateness` shows the delay) and the timeline is re-anchored to that moment,
    so the stall becomes added latency. Use it for already-encoded video, see
    below.
- **pause / resume**: `resume()` re-anchors the clock to the resume time and
  emits a tick immediately (no burst). With `"skip"` the paused wall-clock time
  is reflected as a timestamp gap by default (same as a stall), which keeps RTP
  time aligned with real time for RTCP SR / lip-sync. `resume({ continuous: true })`
  collapses the pause and advances by exactly one frame; this is the default
  for `"delay"`.
- `onTick` subscribers run synchronously after the clock state and the next
  timer are committed. Returned promises are **not** awaited (no backpressure).
- Inject `now` / `scheduler` options for deterministic tests.

## pre-encoded video

Dropping an already-encoded delta frame corrupts the picture until the next
keyframe, so never skip frames of an encoded stream. Pace a constant-frame-rate
stream with `stallPolicy: "delay"` and send exactly one frame per tick:

```typescript
const clock = new RtpMediaClock({
  clockRate: 90_000,
  frameDurationMs: 1000 / 30,
  stallPolicy: "delay",
});
const builder = new RtpBuilder({ payloadType: 96, ssrc });

clock.start((tick) => {
  const frame = encodedFrames.shift(); // one access unit per tick
  if (!frame) return clock.stop();
  const packets = packetize(frame); // codec-specific (e.g. H264 FU-A)
  packets.forEach((payload, i) => {
    sender.sendRtp(
      builder.create(payload, { tick, marker: i === packets.length - 1 }),
    );
  });
});
```

Every frame is sent in order with contiguous timestamps and sequence numbers;
a stall only delays the stream. `RtpMediaClock` assumes a constant frame rate;
for variable frame rate use `RtpMediaPacer` below.

## variable frame rate (RtpMediaPacer)

`RtpMediaPacer` paces frames by their own timestamps instead of a fixed frame
duration. Push each frame with its `pts` (and `dts` when B-frames reorder) in
`clockRate` units; the frame is emitted at
`anchor + (dts - anchor.dts) / clockRate` on a monotonic clock, and its RTP
timestamp is `initialTimestamp + (pts - firstPts)`.

```typescript
import { RtpBuilder, RtpMediaPacer } from "werift-rtp";

const pacer = new RtpMediaPacer<Buffer>({ clockRate: 90_000 });
const builder = new RtpBuilder({ payloadType: 96, ssrc });

pacer.start((tick) => {
  // tick: { frame, frameIndex, timestamp, pts, dts, deadline, lateness, delay }
  const packets = packetize(tick.frame); // codec-specific (e.g. H264 FU-A)
  packets.forEach((payload, i) => {
    sender.sendRtp(
      builder.create(payload, { tick, marker: i === packets.length - 1 }),
    );
  });
});

for await (const sample of demuxer) {
  // container time -> 90 kHz, in decode order
  pacer.push(sample.data, {
    pts: sample.pts * 90_000,
    dts: sample.dts * 90_000,
  });
  while (pacer.queueLength > 30) await sleep(10); // producer-side backpressure
}
```

- Frames are never skipped. If the emitted frame and the next queued frame are
  both overdue (event loop stall, or the producer pushes a late batch), only
  one frame is sent and the timeline is re-anchored to now: the stall becomes
  latency (`tick.delay`), not a burst. Ordinary timer lateness does not move the
  anchor, so there is no drift.
- A frame pushed after its deadline while the queue is empty is sent
  immediately.
- `pause()` / `resume()`: a frame that became due while paused is sent on
  `resume()` and the paused time is added to `delay`.
- `dts` must be non-decreasing in push order (`RangeError` otherwise).

Limitations of `stallPolicy: "delay"` and `RtpMediaPacer`:

- RTP time falls behind real time by the total stall time (`delay`). If an
  audio track runs on a separate `"skip"` clock, lip-sync shifts by that amount.
- `onTick` is not awaited. If producing a frame takes longer than the frame
  interval, the stream keeps falling behind.

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

**When not to use it**: relays and recording already own their timeline (the
remote source's RTP timestamps). Pass those timestamps through as-is
(`create(payload, { timestamp })` or the original packet); for file playback,
`RtpMediaPacer` keeps the container timestamps. `RTCRtpSender.sendRtp()` never
rewrites RTP timestamps based on send time, and no pacing is enforced on these
use cases.

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
