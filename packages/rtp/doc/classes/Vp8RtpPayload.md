[werift-rtp](../README.md) / [Exports](../modules.md) / Vp8RtpPayload

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
- [payloadHeaderExist](Vp8RtpPayload.md#payloadheaderexist)
- [size](Vp8RtpPayload.md#size)

### Methods

- [deSerialize](Vp8RtpPayload.md#deserialize)
- [isDetectedFinalPacketInSequence](Vp8RtpPayload.md#isdetectedfinalpacketinsequence)

## Constructors

### constructor

• **new Vp8RtpPayload**()

## Properties

### hBit

• `Optional` **hBit**: `number`

___

### iBit

• `Optional` **iBit**: `number`

___

### kBit

• `Optional` **kBit**: `number`

___

### lBit

• `Optional` **lBit**: `number`

___

### mBit

• `Optional` **mBit**: `number`

___

### nBit

• **nBit**: `number`

___

### pBit

• `Optional` **pBit**: `number`

___

### payload

• **payload**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[payload](DePacketizerBase.md#payload)

___

### pictureId

• `Optional` **pictureId**: `number`

___

### pid

• **pid**: `number`

___

### sBit

• **sBit**: `number`

___

### size0

• **size0**: `number` = `0`

___

### size1

• **size1**: `number` = `0`

___

### size2

• **size2**: `number` = `0`

___

### tBit

• `Optional` **tBit**: `number`

___

### ver

• `Optional` **ver**: `number`

___

### xBit

• **xBit**: `number`

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

___

### isPartitionHead

• `get` **isPartitionHead**(): `boolean`

#### Returns

`boolean`

___

### payloadHeaderExist

• `get` **payloadHeaderExist**(): `boolean`

#### Returns

`boolean`

___

### size

• `get` **size**(): `number`

#### Returns

`number`

## Methods

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`Vp8RtpPayload`](Vp8RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`Vp8RtpPayload`](Vp8RtpPayload.md)

___

### isDetectedFinalPacketInSequence

▸ `Static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`
