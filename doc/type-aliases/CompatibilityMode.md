[**werift**](../README.md)

***

[werift](../globals.md) / CompatibilityMode

# Type Alias: CompatibilityMode

> **CompatibilityMode** = `"standard"` \| `"legacy"`

The values every constructor-fixed compatibility option of `PeerConfig`
shares (`certificateScope`, `mLineReuse`, `transceiverPairing`,
`keyFrameRequestRouting`):
- `"standard"`: the behavior the specifications (W3C WebRTC, JSEP, the RTP
  RFCs) define and browsers implement.
- `"legacy"`: werift's own behavior, kept so existing werift applications
  keep working.

Each option documents what the two values do, which one is its default and
whether `setConfiguration()` may change it. Any other value is a
`TypeError`. The names these options used up to v0.27.0 are still accepted
and read back as the new name (see `DeprecatedCompatibilityValues` in
`api/peerConfig.ts`).
