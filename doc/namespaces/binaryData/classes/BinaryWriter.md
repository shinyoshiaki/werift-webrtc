[**werift**](../../../README.md)

***

[werift](../../../globals.md) / [binaryData](../README.md) / BinaryWriter

# Class: BinaryWriter

Collects written chunks and concatenates them once at the end.

## Constructors

### new BinaryWriter()

> **new BinaryWriter**(): [`BinaryWriter`](BinaryWriter.md)

#### Returns

[`BinaryWriter`](BinaryWriter.md)

## Accessors

### bytes

#### Get Signature

> **get** **bytes**(): `number`

The number of bytes written so far.

##### Returns

`number`

## Methods

### toBuffer()

> **toBuffer**(): `Buffer`

#### Returns

`Buffer`

***

### writeBuffer()

> **writeBuffer**(`buf`): `void`

#### Parameters

##### buf

`Buffer`

#### Returns

`void`

***

### writeUIntBE()

> **writeUIntBE**(`value`, `size`): `void`

#### Parameters

##### value

`number`

##### size

`number`

#### Returns

`void`
