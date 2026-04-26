[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / BitStream

# Class: BitStream

## Constructors

### new BitStream()

> **new BitStream**(`uint8Array`): [`BitStream`](BitStream.md)

#### Parameters

• **uint8Array**: `Buffer`

#### Returns

[`BitStream`](BitStream.md)

## Properties

### uint8Array

> **uint8Array**: `Buffer`

## Methods

### readBits()

> **readBits**(`bits`, `bitBuffer`?): `any`

#### Parameters

• **bits**: `number`

• **bitBuffer?**: `number`

#### Returns

`any`

***

### seekTo()

> **seekTo**(`bitPos`): `void`

#### Parameters

• **bitPos**: `number`

#### Returns

`void`

***

### writeBits()

> **writeBits**(`bits`, `value`): [`BitStream`](BitStream.md)

#### Parameters

• **bits**: `number`

• **value**: `number`

#### Returns

[`BitStream`](BitStream.md)
