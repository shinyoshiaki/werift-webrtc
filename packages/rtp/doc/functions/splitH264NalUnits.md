[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / splitH264NalUnits

# Function: splitH264NalUnits()

> **splitH264NalUnits**(`sample`, `naluLengthSize`): `Buffer`\<`ArrayBufferLike`\>[]

Split H.264 sample into NAL units (no start codes).
Accepts Annex-B (via shared `H264AnnexBParser`) or length-prefixed (AVCC).

## Parameters

### sample

`Buffer`

### naluLengthSize

`number` = `4`

## Returns

`Buffer`\<`ArrayBufferLike`\>[]
