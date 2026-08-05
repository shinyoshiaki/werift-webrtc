[**werift**](../README.md)

***

[werift](../globals.md) / H264PacketizerOptions

# Type Alias: H264PacketizerOptions

> **H264PacketizerOptions**: [`PacketizerBaseOptions`](PacketizerBaseOptions.md) & `object`

## Type declaration

### isKeyframe?

> `optional` **isKeyframe**: `boolean`

Force keyframe path for parameter-set prepending even without IDR NAL.
Default: auto-detect IDR (type 5).

### naluLengthSize?

> `optional` **naluLengthSize**: `number`

Length field size for AVCC input (default 4). Ignored for Annex-B.

### parameterSets?

> `optional` **parameterSets**: `Buffer`[]

Parameter sets (SPS/PPS as raw NAL units without start codes).
On IDR / keyframe, only types missing from the sample are prepended
(SPS and PPS checked independently — partial sample SPS-only gets PPS only).
Prefer STAP-A when ≥2 leading sets fit; else individual Single NAL.
