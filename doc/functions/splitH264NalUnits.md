[**werift**](../README.md)

***

[werift](../globals.md) / splitH264NalUnits

# Function: splitH264NalUnits()

> **splitH264NalUnits**(`sample`, `naluLengthSize?`, `inputFormat?`): `Buffer`\<`ArrayBufferLike`\>[]

Split H.264 sample into NAL units (no start codes).
Accepts Annex-B (start-code split, no NAL type filtering) or length-prefixed (AVCC).

## Parameters

### sample

`Buffer`

### naluLengthSize?

`number` = `4`

### inputFormat?

[`NalInputFormat`](../type-aliases/NalInputFormat.md) = `"auto"`

## Returns

`Buffer`\<`ArrayBufferLike`\>[]
