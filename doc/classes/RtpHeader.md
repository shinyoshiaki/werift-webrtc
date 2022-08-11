[werift](../README.md) / [Exports](../modules.md) / RtpHeader

# Class: RtpHeader

## Table of contents

### Constructors

- [constructor](RtpHeader.md#constructor)

### Properties

- [csrc](RtpHeader.md#csrc)
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

• **new RtpHeader**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtpHeader`](RtpHeader.md)\> |

#### Defined in

[packages/rtp/src/rtp/rtp.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L51)

## Properties

### csrc

• **csrc**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L46)

___

### extension

• **extension**: `boolean` = `false`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L37)

___

### extensionLength

• `Optional` **extensionLength**: `number`

deserialize only

#### Defined in

[packages/rtp/src/rtp/rtp.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L49)

___

### extensionProfile

• **extensionProfile**: `ExtensionProfile` = `ExtensionProfiles.OneByte`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L47)

___

### extensions

• **extensions**: [`Extension`](../modules.md#extension)[] = `[]`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L50)

___

### marker

• **marker**: `boolean` = `false`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L38)

___

### padding

• **padding**: `boolean` = `false`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L35)

___

### paddingSize

• **paddingSize**: `number` = `0`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L36)

___

### payloadOffset

• **payloadOffset**: `number` = `0`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L39)

___

### payloadType

• **payloadType**: `number` = `0`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L40)

___

### sequenceNumber

• **sequenceNumber**: `number` = `0`

16bit

#### Defined in

[packages/rtp/src/rtp/rtp.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L42)

___

### ssrc

• **ssrc**: `number` = `0`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L45)

___

### timestamp

• **timestamp**: `number` = `0`

32bit milliseconds/1000

#### Defined in

[packages/rtp/src/rtp/rtp.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L44)

___

### version

• **version**: `number` = `2`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L34)

## Accessors

### serializeSize

• `get` **serializeSize**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:164](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L164)

## Methods

### serialize

▸ **serialize**(`size`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `size` | `number` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:191](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L191)

___

### deSerialize

▸ `Static` **deSerialize**(`rawPacket`): [`RtpHeader`](RtpHeader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawPacket` | `Buffer` |

#### Returns

[`RtpHeader`](RtpHeader.md)

#### Defined in

[packages/rtp/src/rtp/rtp.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L55)
