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
  for `"delay"`. `resume({ continuous: false })` reflects the pause as a gap
  with either policy.
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

# codecs (packetizer / depacketizer)

Depacketizers implement `DePacketizerBase` and are registered in
`dePacketizeRtpPackets` / `depacketizerCodecs`. Packetizers extend
`PacketizerBase` and live next to their depacketizer in `src/codec/`.

| Codec | Depacketizer | Packetizer | Notes |
|-------|--------------|------------|--------|
| H.264 | `H264RtpPayload` | `H264Packetizer` | RFC 6184 mode=1 — Single / **STAP-A** (SPS+PPS preferred) / FU-A |
| H.265 / HEVC | `H265RtpPayload` | `H265Packetizer` | RFC 7798 — AP / FU / single NAL |
| VP8 | `Vp8RtpPayload` | `Vp8Packetizer` | RFC 7741 — minimal descriptor (S/PID) |
| VP9 | `Vp9RtpPayload` | `Vp9Packetizer` | RFC 9628 — B/E/P minimal descriptor |
| AV1 | `AV1RtpPayload` | `Av1Packetizer` | AV1 RTP — W=0 length-prefixed aggregation, Z/Y/N |
| Opus | `OpusRtpPayload` | `OpusPacketizer` | RFC 7587 — raw payload; no TOC-blind MTU split |
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
import {
  PcmuPacketizer,
  H265Packetizer,
  H264Packetizer,
  Vp8Packetizer,
  OpusPacketizer,
  AacHbrPacketizer,
} from "werift-rtp";

const pcmu = new PcmuPacketizer(); // PT 0
const packets = pcmu.packetize(pcmUlawBytes, rtpTimestamp);

const h265 = new H265Packetizer({ maxPayloadSize: 1200 });
const videoPackets = h265.packetize(annexBOrLengthPrefixedSample, ts);

// H.264 keyframe: only missing SPS/PPS types are prepended (checked separately);
// STAP-A when ≥2 sets fit, else Single NAL
const h264 = new H264Packetizer({
  parameterSets: [spsNal, ppsNal],
});
const h264Pkts = h264.packetize(annexBOrAvccIdr, ts);

const vp8 = new Vp8Packetizer();
const vp8Pkts = vp8.packetize(vp8Frame, ts);

const opus = new OpusPacketizer({ payloadType: 111 });
const opusPkts = opus.packetize(opusPacket, ts); // throws if > maxPayloadSize
```

## Chrome E2E (interop)

Packetizer / Depacketizer interop with Chromium is covered by the repo root E2E suite:

- Tests: `e2e/tests/mediachannel/codecRtp.test.ts`
- Handlers / demux utils: `e2e/server/handler/mediachannel/codecRtp.ts`, `e2e/server/codecRtpUtils.ts`
- Pre-encoded fixtures (no GStreamer at CI runtime): `e2e/fixtures/media/`
- Fixture generator (dev only): `e2e/tools/generateCodecFixtures.sh`

Run from repo root: `npm run e2e` (or `cd e2e && npm run ci:silent`).

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
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ vp8
RUN_SELF_TEST=1 npx tsx examples/node/rtp_over_udp/recv.ts _ h264
```

# test vectors

Committed payloads under `tests/data/vector_*.bin` (and synthetic cases in tests),
including GStreamer-derived **VP8 / VP9 / H.264 / Opus** (and synthetic **AV1**
when `rtpav1pay` is unavailable).
Regenerate with GStreamer via `tools/generateVectors/` when available:
`npx tsx tools/generateVectors/generate.ts` (synthetic baseline first, GST
overwrites per codec).

# RFC authority notes

Where earlier task notes disagreed with the RFCs, **`docs/rfc/` text is authoritative** (ticket text has been aligned):

- **H.265** (RFC 7798): AP Type=**48**, FU Type=**49**. AP PayloadHdr: **F = OR** of aggregated NALs, **LayerId/TID = minimum**. FU **F** equals the fragmented NAL’s F bit.
- **H.264** (RFC 6184): packetization-mode=**1**; keyframe SPS/PPS are checked **independently** (sample with SPS-only still gets PPS); prefer **STAP-A** (Type 24) when ≥2 leading sets fit MTU, else Single NAL; large NAL → **FU-A** (Type 28).
- **VP9** (RFC 9628): payload descriptor `I|P|L|F|B|E|V|Z`; package packetizer uses the legal minimal subset (no Picture ID / SS).
- **Opus** (RFC 7587): no codec header; **do not** MTU-split one Opus packet (TOC would break).
- **G.722** (RFC 3551 §4.5.2): RTP clock **and** octet rate are **8000**/s (20 ms = **160** octets, not 320).
- **AAC-hbr** (RFC 3640 §3.2.1.1 / §3.3.6): AU-size is the size **in octets** (not size−1); max 8191. CTS/DTS are optional via `AacHbrDepacketizerOptions`.

# reference

- https://github.com/pion/srtp
- RFCs under repo `docs/rfc/` (`rfc3551`, `rfc3640`, `rfc4733`, `rfc6184`, `rfc7587`, `rfc7741`, `rfc7798`, `rfc9628`, `av1-rtp-spec.html`, …)
