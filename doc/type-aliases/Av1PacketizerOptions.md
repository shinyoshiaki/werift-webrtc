[**werift**](../README.md)

***

[werift](../globals.md) / Av1PacketizerOptions

# Type Alias: Av1PacketizerOptions

> **Av1PacketizerOptions**: [`PacketizerBaseOptions`](PacketizerBaseOptions.md) & `object`

## Type declaration

### isKeyframe?

> `optional` **isKeyframe**: `boolean`

Default keyframe flag (N bit on first packet of the frame).
Override per call via packetize(..., { isKeyframe }).
