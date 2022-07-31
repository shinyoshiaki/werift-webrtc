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

#### Defined in

[packages/rtp/src/rtp/rtp.ts:269](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L269)

## Properties

### header

• **header**: [`RtpHeader`](RtpHeader.md)

#### Defined in

[packages/rtp/src/rtp/rtp.ts:269](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L269)

___

### payload

• **payload**: `Buffer`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:269](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L269)

## Accessors

### serializeSize

• `get` **serializeSize**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:271](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L271)

## Methods

### clone

▸ **clone**(): [`RtpPacket`](RtpPacket.md)

#### Returns

[`RtpPacket`](RtpPacket.md)

#### Defined in

[packages/rtp/src/rtp/rtp.ts:275](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L275)

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:279](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L279)

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`RtpPacket`](RtpPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`RtpPacket`](RtpPacket.md)

#### Defined in

[packages/rtp/src/rtp/rtp.ts:294](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtp/rtp.ts#L294)
