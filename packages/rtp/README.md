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
duration, so it handles variable frame rate from both kinds of source:

- **read-ahead sources** (demuxed files): frames are available long before
  they are due and wait in the queue.
- **streaming sources** (live encoders, ffmpeg / GStreamer pipes, network
  ingest, screen capture that only emits frames on change): frames arrive in
  real time, with jitter and in bursts.

Push each frame with its `pts` (and `dts` when B-frames reorder) in `clockRate`
units; the frame is emitted at `anchor + (dts - anchor.dts) / clockRate` on a
monotonic clock, and its RTP timestamp is `initialTimestamp + (pts - firstPts)`.
The send side is the same for both kinds of source:

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
```

Read-ahead source (demuxer):

```typescript
for await (const sample of demuxer) {
  // container time (s) -> 90 kHz, in decode order
  pacer.push(sample.data, {
    pts: sample.pts * 90_000,
    dts: sample.dts * 90_000,
  });
  while (pacer.queueLength > 30) await sleep(10); // producer-side backpressure
}
```

Streaming source (live encoder / pipe):

```typescript
// headroom for arrival jitter and pipe bursts
const pacer = new RtpMediaPacer<Buffer>({ clockRate: 90_000, latencyMs: 50 });

encoder.on("frame", (chunk: { data: Buffer; timestampUs: number }) => {
  // the encoder's capture timestamp (µs) -> 90 kHz; frame intervals may vary
  pacer.push(chunk.data, { pts: (chunk.timestampUs * 90_000) / 1_000_000 });
});

// a source without timestamps: use the capture/arrival time as pts
source.on("frame", (data: Buffer) => {
  pacer.push(data, { pts: performance.now() * 90 });
});
```

A runnable streaming example (ffmpeg live VP8 switching between 30 fps and
10 fps, IVF over a pipe, RTP over UDP) is in
`examples/node/pacer/ffmpeg-vfr-stream.ts`. `npm test` runs it as a separate
process and checks the received RTP stream
(`tests/examples/ffmpegVfrStream.test.ts`; requires `ffmpeg` with `libvpx` on
`PATH`).

- Frames are never skipped. If the emitted frame and the next queued frame are
  both overdue (event loop stall, or the producer pushes a late batch), only
  one frame is sent and the timeline is re-anchored to now: the stall becomes
  latency (`tick.delay`), not a burst. Ordinary timer lateness does not move the
  anchor, so there is no drift.
- Streaming sources: early frames (bursts) wait for their pts and late frames
  are sent immediately when the queue is empty. Re-anchoring only happens when
  a late burst leaves two frames overdue, so `delay` grows to the worst arrival
  lateness seen and then stays there; it does not accumulate. Set `latencyMs`
  to at least the expected jitter to avoid re-anchoring altogether.
- Gaps in a stream (e.g. a screen capture that sends nothing for 10 s) are
  just a larger pts step: the next frame is sent when it is due, and the RTP
  timestamp jumps by the same amount.
- `pause()` / `resume()`: a frame that became due while paused is sent on
  `resume()` and the paused time is added to `delay`.
- `dts` (or `pts` when `dts` is omitted) must be non-decreasing in push order
  (`RangeError` otherwise). If a streaming source resets its timestamps, create
  a new pacer with `initialTimestamp` continuing from the last tick.

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
