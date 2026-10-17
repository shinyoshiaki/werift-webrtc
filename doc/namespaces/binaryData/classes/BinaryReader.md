[**werift**](../../../README.md)

***

[werift](../../../globals.md) / [binaryData](../README.md) / BinaryReader

# Class: BinaryReader

Sequential reader over a single Buffer. Returned buffers share memory with the input.

## Constructors

### new BinaryReader()

> **new BinaryReader**(`buf`): [`BinaryReader`](BinaryReader.md)

#### Parameters

##### buf

`Buffer`

#### Returns

[`BinaryReader`](BinaryReader.md)

## Accessors

### bytes

#### Get Signature

> **get** **bytes**(): `number`

The number of bytes consumed so far.

##### Returns

`number`

***

### length

#### Get Signature

> **get** **length**(): `number`

The number of unread bytes.

##### Returns

`number`

## Methods

### readBuffer()

> **readBuffer**(`size`): `Buffer`

#### Parameters

##### size

`number`

#### Returns

`Buffer`

***

### readUIntBE()

> **readUIntBE**(`size`): `number`

#### Parameters

##### size

`number`

#### Returns

`number`
