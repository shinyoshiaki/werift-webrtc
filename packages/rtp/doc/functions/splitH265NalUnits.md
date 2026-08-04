[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / splitH265NalUnits

# Function: splitH265NalUnits()

> **splitH265NalUnits**(`sample`, `naluLengthSize`): `Buffer`\<`ArrayBufferLike`\>[]

Split H.265 sample into NAL units.
Accepts Annex-B (start codes) or length-prefixed (HVCC) with `naluLengthSize`.

## Parameters

### sample

`Buffer`

### naluLengthSize

`number` = `4`

## Returns

`Buffer`\<`ArrayBufferLike`\>[]
