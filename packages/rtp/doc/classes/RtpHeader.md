[werift-rtp](../README.md) / [Exports](../modules.md) / RtpHeader

# Class: RtpHeader

## Table of contents

### Constructors

- [constructor](RtpHeader.md#constructor)

### Properties

- [csrc](RtpHeader.md#csrc)
- [csrcLength](RtpHeader.md#csrclength)
- [extension](RtpHeader.md#extension)
- [extensionLength](RtpHeader.md#extensionlength)
- [extensionProfile](RtpHeader.md#extensionprofile)
- [extensions](RtpHeader.md#extensions)
- [marker](RtpHeader.md#marker)
- [padding](RtpHeader.md#padding)
- [paddingSize](RtpHeader.md#paddingsize)
- [payloadOffset](RtpHeader.md#payloadoffset)
- [payloadType](RtpHeader.md#payloadtype)
- [sequenceNumber](RtpHeader.md#sequencenumber)
- [ssrc](RtpHeader.md#ssrc)
- [timestamp](RtpHeader.md#timestamp)
- [version](RtpHeader.md#version)

### Accessors

- [serializeSize](RtpHeader.md#serializesize)

### Methods

- [serialize](RtpHeader.md#serialize)
- [deSerialize](RtpHeader.md#deserialize)

## Constructors

### constructor

• **new RtpHeader**(`props?`): [`RtpHeader`](RtpHeader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`RtpHeader`](RtpHeader.md)\> |

#### Returns

[`RtpHeader`](RtpHeader.md)

## Properties

### csrc

• **csrc**: `number`[] = `[]`

___

### csrcLength

• **csrcLength**: `number` = `0`

___

### extension

• **extension**: `boolean` = `false`

___

### extensionLength

• `Optional` **extensionLength**: `number`

deserialize only

___

### extensionProfile

• **extensionProfile**: `ExtensionProfile` = `ExtensionProfiles.OneByte`

___

### extensions

• **extensions**: [`Extension`](../modules.md#extension)[] = `[]`

___

### marker

• **marker**: `boolean` = `false`

___

### padding

• **padding**: `boolean` = `false`

___

### paddingSize

• **paddingSize**: `number` = `0`

___

### payloadOffset

• **payloadOffset**: `number` = `0`

___

### payloadType

• **payloadType**: `number` = `0`

___

### sequenceNumber

• **sequenceNumber**: `number` = `0`

16bit, 初期値はランダムである必要があります

___

### ssrc

• **ssrc**: `number` = `0`

___

### timestamp

• **timestamp**: `number` = `0`

32bit microsec (milli/1000), 初期値はランダムである必要があります

___

### version

• **version**: `number` = `2`

## Accessors

### serializeSize

• `get` **serializeSize**(): `number`

#### Returns

`number`

## Methods

### serialize

▸ **serialize**(`size`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `size` | `number` |

#### Returns

`Buffer`

___

### deSerialize

▸ **deSerialize**(`rawPacket`): [`RtpHeader`](RtpHeader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawPacket` | `Buffer` |

#### Returns

[`RtpHeader`](RtpHeader.md)
