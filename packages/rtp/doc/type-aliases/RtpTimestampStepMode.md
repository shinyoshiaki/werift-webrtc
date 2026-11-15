[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpTimestampStepMode

# Type Alias: RtpTimestampStepMode

> **RtpTimestampStepMode** = `number` \| `"lastDelta"` \| `"wallClock"` \| `"auto"`

How [RtpTimelineRewriter](../classes/RtpTimelineRewriter.md) chooses the output timestamp increment
between the last packet of the old source and the first packet of the new one.

- `number`: that fixed increment (for example `3000` for 30 fps video at 90 kHz).
- `"lastDelta"`: the last positive timestamp increment seen on the stream
  (the frame / packet interval of the old source), or
  [RtpTimelineRewriterOptions.defaultTimestampStep](../interfaces/RtpTimelineRewriterOptions.md#defaulttimestampstep) when none was seen yet.
- `"wallClock"`: the time between the last packet of the old source and the
  first packet of the new one, times `clockRate / 1000`
  (requires [RtpTimelineRewriterOptions.clockRate](../interfaces/RtpTimelineRewriterOptions.md#clockrate)). The reconnect time
  becomes media time, so separate audio / video rewriters keep their relative
  position (A/V sync). `"lastDelta"` / a fixed number advance audio and video
  by different amounts, so their relative offset can change at each switch.
- `"auto"` (default): `"wallClock"` when `clockRate` is set, otherwise `"lastDelta"`.

Every mode advances the timestamp by at least 1.
