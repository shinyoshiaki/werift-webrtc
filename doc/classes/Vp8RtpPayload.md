[werift](../README.md) / [Exports](../modules.md) / Vp8RtpPayload

# Class: Vp8RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Table of contents

### Constructors

- [constructor](Vp8RtpPayload.md#constructor)

### Properties

- [hBit](Vp8RtpPayload.md#hbit)
- [iBit](Vp8RtpPayload.md#ibit)
- [kBit](Vp8RtpPayload.md#kbit)
- [lBit](Vp8RtpPayload.md#lbit)
- [mBit](Vp8RtpPayload.md#mbit)
- [nBit](Vp8RtpPayload.md#nbit)
- [pBit](Vp8RtpPayload.md#pbit)
- [payload](Vp8RtpPayload.md#payload)
- [pictureId](Vp8RtpPayload.md#pictureid)
- [pid](Vp8RtpPayload.md#pid)
- [sBit](Vp8RtpPayload.md#sbit)
- [size0](Vp8RtpPayload.md#size0)
- [size1](Vp8RtpPayload.md#size1)
- [size2](Vp8RtpPayload.md#size2)
- [tBit](Vp8RtpPayload.md#tbit)
- [ver](Vp8RtpPayload.md#ver)
- [xBit](Vp8RtpPayload.md#xbit)

### Accessors

- [isKeyframe](Vp8RtpPayload.md#iskeyframe)
- [isPartitionHead](Vp8RtpPayload.md#ispartitionhead)

### Methods

- [deSerialize](Vp8RtpPayload.md#deserialize)
- [isDetectedFinalPacketInSequence](Vp8RtpPayload.md#isdetectedfinalpacketinsequence)

## Constructors

### constructor

• **new Vp8RtpPayload**()

## Properties

### hBit

• `Optional` **hBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L52)

___

### iBit

• `Optional` **iBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L44)

___

### kBit

• `Optional` **kBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L47)

___

### lBit

• `Optional` **lBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L45)

___

### mBit

• `Optional` **mBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L48)

___

### nBit

• **nBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L41)

___

### pBit

• `Optional` **pBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L54)

___

### payload

• **payload**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[payload](DePacketizerBase.md#payload)

#### Defined in

[packages/rtp/src/codec/vp8.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L50)

___

### pictureId

• `Optional` **pictureId**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L49)

___

### pid

• **pid**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L43)

___

### sBit

• **sBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L42)

___

### size0

• `Optional` **size0**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L51)

___

### size1

• `Optional` **size1**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L55)

___

### size2

• `Optional` **size2**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L56)

___

### tBit

• `Optional` **tBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L46)

___

### ver

• `Optional` **ver**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:53](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L53)

___

### xBit

• **xBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp8.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L40)

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

#### Defined in

[packages/rtp/src/codec/vp8.ts:124](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L124)

___

### isPartitionHead

• `get` **isPartitionHead**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/rtp/src/codec/vp8.ts:128](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L128)

## Methods

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`Vp8RtpPayload`](Vp8RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`Vp8RtpPayload`](Vp8RtpPayload.md)

#### Defined in

[packages/rtp/src/codec/vp8.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L58)

___

### isDetectedFinalPacketInSequence

▸ `Static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

#### Defined in

[packages/rtp/src/codec/vp8.ts:120](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp8.ts#L120)
