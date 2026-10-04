## Summary

Add a reusable monotonic real-time RTP media clock/pacer to `werift-rtp`, and integrate it with `RtpBuilder` so server-side media sources can keep RTP timestamps aligned with the sampling timeline even when the Node.js event loop is late or temporarily stalled.

This should be an **opt-in source-side utility**. `RTCRtpSender.sendRtp()` should continue treating supplied RTP packets as authoritative and should not rewrite timestamps based on send time.

## Motivation

A common server-side pattern is:

```ts
setInterval(() => {
  timestamp += frameSamples;
  sender.sendRtp(packet(timestamp));
}, frameDurationMs);
```

This assumes each timer callback occurs exactly on schedule. In Node.js that is not true: small callback delays accumulate, so wall-clock time can move significantly ahead of the RTP media clock.

OpenClaw hit this in its werift-backed GPT-Live relay:

https://github.com/openclaw/openclaw/pull/146078

Its old 20 ms interval-based implementation accumulated about 2.857 seconds of RTP clock error in a one-minute regression with only 1 ms callback lateness. The fix switched to monotonic deadlines and skipped elapsed media slots after scheduler stalls instead of replaying overdue packets in a burst.

The same class of bug is easy for any application generating RTP in Node.js to reproduce.

## Existing `RtpBuilder` limitation

`RtpBuilder` currently advances timestamps only when `create()` is called:

```ts
const elapsed = (between * clockRate) / 1000;
this.timestamp = uint32Add(this.timestamp, elapsed);
```

So `create()` effectively assumes that exactly `between` milliseconds of media time elapsed since the previous call.

If callbacks are late, the RTP clock drifts behind real time.

## Proposed direction

Introduce a reusable primitive in `werift-rtp`, for example:

```ts
const clock = new RtpMediaClock({
  clockRate: 48_000,
  frameSamples: 960,
});

clock.start((tick) => {
  // tick.timestamp
  // tick.skippedFrames
  // tick.elapsedSamples
});
```

or an equivalent API that separates **media-clock calculation** from actual packet transmission.

The clock should use monotonic absolute deadlines rather than repeated relative intervals:

```text
nextDeadline = origin + N * frameDuration
```

If the event loop stalls, elapsed media slots should be represented in the RTP timeline without emitting a burst of stale packets.

Example for 48 kHz / 20 ms audio:

```text
packet A:
  seq = 100
  ts  = 48000

5 second scheduler pause

packet B:
  seq = 101
  ts  = 288960  // media clock advanced across the pause
```

Desired semantics:

- sequence number advances only for packets actually emitted,
- RTP timestamp advances according to the media/sample timeline,
- missed real-time slots can be represented as timestamp gaps,
- overdue frames are not automatically burst-sent,
- timestamp wraparound is handled correctly.

## `RtpBuilder` integration

`RtpBuilder` should be able to consume this media clock rather than assuming every `create()` call is exactly `between` milliseconds after the previous one.

Possible APIs include:

```ts
builder.create(payload, {
  sampleTime: performance.now(),
});
```

or explicit timeline control:

```ts
builder.advanceSamples(960);
builder.skipSamples(240_000);
const packet = builder.create(payload);
```

or constructing it with a reusable clock:

```ts
const clock = new RtpMediaClock(...);
const builder = new RtpBuilder({ clock });
```

The exact API can be decided separately; the important part is that RTP timeline ownership remains explicit and does not move into `RTCRtpSender.sendRtp()`.

## Requirements / edge cases

Please cover:

- 8/16/24/48 kHz audio and 90 kHz video clocks,
- fractional frame durations / sample counts where applicable,
- long-running drift tests,
- repeated 1 ms scheduler lateness,
- multi-second event-loop stalls,
- no catch-up burst after a stall,
- RTP timestamp 32-bit wraparound,
- sequence-number 16-bit wraparound,
- explicit pause/resume,
- clean cancellation without keeping the Node process alive,
- compatibility with raw RTP relay sources where the application already owns timestamps.

## Non-goals

This feature should **not**:

- make `sendRtp()` rewrite caller-provided RTP timestamps,
- infer sampling time from UDP send completion,
- force pacing on relay/recording/playback users,
- assume every RTP packet corresponds to one media frame.

Video can have multiple RTP packets sharing one timestamp, and relays may intentionally preserve a remote source clock.

## Related

- OpenClaw downstream fix: https://github.com/openclaw/openclaw/pull/146078
- RTCP SR clock-mapping issue: #701