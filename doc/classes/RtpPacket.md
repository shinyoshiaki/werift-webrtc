[werift](../README.md) / [Exports](../modules.md) / RtpPacket

# Class: RtpPacket

## Table of contents

### Constructors

- [constructor](RtpPacket.md#constructor)

### Properties

- [header](RtpPacket.md#header)
- [payload](RtpPacket.md#payload)

### Accessors

- [serializeSize](RtpPacket.md#serializesize)

### Methods

- [clone](RtpPacket.md#clone)
- [serialize](RtpPacket.md#serialize)
- [deSerialize](RtpPacket.md#deserialize)

## Constructors

### constructor

• **new RtpPacket**(`header`, `payload`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |
| `payload` | `Buffer` |

## Properties

### header

• **header**: [`RtpHeader`](RtpHeader.md)

___

### payload

• **payload**: `Buffer`

## Accessors

### serializeSize

• `get` **serializeSize**(): `number`

#### Returns

`number`

## Methods

### clone

▸ **clone**(): [`RtpPacket`](RtpPacket.md)

#### Returns

[`RtpPacket`](RtpPacket.md)

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`RtpPacket`](RtpPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`RtpPacket`](RtpPacket.md)
