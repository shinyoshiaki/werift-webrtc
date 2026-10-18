[**werift-rtp**](../../../README.md)

***

[werift-rtp](../../../globals.md) / [binaryData](../README.md) / DataType

# Interface: DataType\<T\>

## Type Parameters

• **T**

## Methods

### decode()

> **decode**(`reader`, `context`): `T`

#### Parameters

##### reader

[`BinaryReader`](../classes/BinaryReader.md)

##### context

[`BinaryContext`](BinaryContext.md)

#### Returns

`T`

***

### encode()

> **encode**(`value`, `writer`, `context`): `void`

#### Parameters

##### value

`T`

##### writer

[`BinaryWriter`](../classes/BinaryWriter.md)

##### context

[`BinaryContext`](BinaryContext.md)

#### Returns

`void`
