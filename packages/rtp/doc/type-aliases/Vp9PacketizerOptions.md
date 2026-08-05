[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Vp9PacketizerOptions

# Type Alias: Vp9PacketizerOptions

> **Vp9PacketizerOptions**: [`PacketizerBaseOptions`](PacketizerBaseOptions.md) & `object`

## Type declaration

### isKeyframe?

> `optional` **isKeyframe**: `boolean`

When true, set P=0 (not inter-predicted = keyframe).
When false, set P=1 (inter-predicted / delta). Default false.
Also accept via packetize(..., { isKeyframe }) override.
