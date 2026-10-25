[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpBuilderProps

# Type Alias: RtpBuilderProps

> **RtpBuilderProps**: `RtpBuilderCommonProps` & `object` \| `RtpBuilderCommonProps` & `object` \| `RtpBuilderCommonProps` & `object`

- `{ between, clockRate }`: legacy fixed pacing. Each `create()` advances the
  timestamp by `between * clockRate / 1000` (before the first packet too).
- `{ clock }`: `create()` uses the timestamp of the clock's latest tick.
- `{}`: explicit timeline via `advanceSamples()` / `create()` options.
