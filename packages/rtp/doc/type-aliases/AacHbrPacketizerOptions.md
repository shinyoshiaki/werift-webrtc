[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / AacHbrPacketizerOptions

# Type Alias: AacHbrPacketizerOptions

> **AacHbrPacketizerOptions** = [`PacketizerBaseOptions`](PacketizerBaseOptions.md) & `object`

## Type Declaration

### auDurationInSamples?

> `optional` **auDurationInSamples?**: `number`

RTP clock ticks per AU (default 1024 = AAC-LC frame). Used to give AUs that
land in different packets distinct timestamps (RFC 3640 §3.1).
