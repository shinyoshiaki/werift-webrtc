[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpMediaClockStallPolicy

# Type Alias: RtpMediaClockStallPolicy

> **RtpMediaClockStallPolicy**: `"skip"` \| `"delay"`

What to do when the clock falls behind by one frame or more.

- `"skip"`: jump to the latest reached slot. The slots in between are
  reported as `skippedFrames` and appear as a timestamp gap. RTP time stays
  aligned with real time. Suited to audio and to live video that encodes the
  latest captured frame on each tick.
- `"delay"`: never skip a slot. The late slot is emitted immediately and the
  timeline is re-anchored to `now`, so the stall is absorbed as added latency
  instead of a gap or a burst. Suited to already-encoded video (or any source
  where every frame must be sent) at a constant frame rate.
