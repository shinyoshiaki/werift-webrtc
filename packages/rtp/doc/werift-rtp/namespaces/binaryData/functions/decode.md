[**werift-rtp**](../../../../README.md)

***

[werift-rtp](../../../../globals.md) / [binaryData](../README.md) / decode

# Function: decode()

> **decode**\<`S`\>(`buf`, `typeOrSchema`): [`Decoded`](../type-aliases/Decoded.md)\<`S`\>

Decode `buf` using a type or schema.
Trailing bytes are ignored. Throws NotEnoughDataError when `buf` is too short.

## Type Parameters

### S

`S` *extends* [`TypeOrSchema`](../type-aliases/TypeOrSchema.md)

## Parameters

### buf

`Buffer`

### typeOrSchema

`S`

## Returns

[`Decoded`](../type-aliases/Decoded.md)\<`S`\>
