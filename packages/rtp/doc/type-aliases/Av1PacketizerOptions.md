[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Av1PacketizerOptions

# Type Alias: Av1PacketizerOptions

> **Av1PacketizerOptions**: [`PacketizerBaseOptions`](PacketizerBaseOptions.md) & `object`

## Type declaration

### isKeyframe?

> `optional` **isKeyframe**: `boolean`

Default keyframe flag. Keyframe-ness alone does not set the N bit; see
[Av1PacketizeOptions.startsNewCodedVideoSequence](Av1PacketizeOptions.md#startsnewcodedvideosequence).
Override per call via packetize(..., { isKeyframe }).
