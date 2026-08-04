[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / H265PacketizerOptions

# Type Alias: H265PacketizerOptions

> **H265PacketizerOptions**: [`PacketizerBaseOptions`](PacketizerBaseOptions.md) & `object`

## Type declaration

### naluLengthSize?

> `optional` **naluLengthSize**: `number`

Length field size for HVCC input (default 4). Ignored for Annex-B.

### parameterSets?

> `optional` **parameterSets**: `Buffer`[]

Parameter sets (VPS/SPS/PPS as raw NAL units without start codes).
Prepended via AP on keyframe when not already present in the sample.
