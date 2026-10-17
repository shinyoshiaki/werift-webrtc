[**werift-rtp**](../../../README.md)

***

[werift-rtp](../../../globals.md) / [binaryData](../README.md) / types

# Variable: types

> `const` **types**: `object`

## Type declaration

### array()

> **array**: \<`S`\>(`type`, `length`, `lengthType`) => [`DataType`](../interfaces/DataType.md)\<[`Decoded`](../type-aliases/Decoded.md)\<`S`\>[]\>

Array type.

#### Type Parameters

• **S** *extends* [`TypeOrSchema`](../type-aliases/TypeOrSchema.md)

#### Parameters

##### type

`S`

type or schema of each item.

##### length

`LengthSpec`

fixed length, number type for length-prefixed arrays, or callback.

##### lengthType

`count` (number of items) or `bytes` (number of bytes).

`"count"` | `"bytes"`

#### Returns

[`DataType`](../interfaces/DataType.md)\<[`Decoded`](../type-aliases/Decoded.md)\<`S`\>[]\>

### buffer()

> **buffer**: (`length`) => [`DataType`](../interfaces/DataType.md)\<`Buffer`\<`ArrayBufferLike`\>\>

Buffer type.

#### Parameters

##### length

`LengthSpec`

fixed number of bytes, number type for size-prefixed buffers,
or callback returning the number of bytes.

#### Returns

[`DataType`](../interfaces/DataType.md)\<`Buffer`\<`ArrayBufferLike`\>\>

### string()

> **string**: (`length`, `encoding`) => [`DataType`](../interfaces/DataType.md)\<`string`\>

String type.

#### Parameters

##### length

`LengthSpec`

fixed number of bytes, number type for size-prefixed strings,
or callback returning the number of bytes.

##### encoding

`BufferEncoding` = `"ascii"`

#### Returns

[`DataType`](../interfaces/DataType.md)\<`string`\>

### uint16be

> **uint16be**: [`NumberType`](../type-aliases/NumberType.md)

### uint24be

> **uint24be**: [`NumberType`](../type-aliases/NumberType.md)

### uint32be

> **uint32be**: [`NumberType`](../type-aliases/NumberType.md)

### uint48be

> **uint48be**: [`NumberType`](../type-aliases/NumberType.md)

### uint8

> **uint8**: [`NumberType`](../type-aliases/NumberType.md)
