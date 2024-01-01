[werift-rtp](../README.md) / [Exports](../modules.md) / Vp9RtpPayload

# Class: Vp9RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Table of contents

### Constructors

- [constructor](Vp9RtpPayload.md#constructor)

### Properties

- [bBit](Vp9RtpPayload.md#bbit)
- [d](Vp9RtpPayload.md#d)
- [eBit](Vp9RtpPayload.md#ebit)
- [fBit](Vp9RtpPayload.md#fbit)
- [g](Vp9RtpPayload.md#g)
- [height](Vp9RtpPayload.md#height)
- [iBit](Vp9RtpPayload.md#ibit)
- [lBit](Vp9RtpPayload.md#lbit)
- [m](Vp9RtpPayload.md#m)
- [n\_g](Vp9RtpPayload.md#n_g)
- [n\_s](Vp9RtpPayload.md#n_s)
- [pBit](Vp9RtpPayload.md#pbit)
- [pDiff](Vp9RtpPayload.md#pdiff)
- [payload](Vp9RtpPayload.md#payload)
- [pgP\_Diff](Vp9RtpPayload.md#pgp_diff)
- [pgT](Vp9RtpPayload.md#pgt)
- [pgU](Vp9RtpPayload.md#pgu)
- [pictureId](Vp9RtpPayload.md#pictureid)
- [sid](Vp9RtpPayload.md#sid)
- [tid](Vp9RtpPayload.md#tid)
- [tl0PicIdx](Vp9RtpPayload.md#tl0picidx)
- [u](Vp9RtpPayload.md#u)
- [vBit](Vp9RtpPayload.md#vbit)
- [width](Vp9RtpPayload.md#width)
- [y](Vp9RtpPayload.md#y)
- [zBit](Vp9RtpPayload.md#zbit)

### Accessors

- [isKeyframe](Vp9RtpPayload.md#iskeyframe)
- [isPartitionHead](Vp9RtpPayload.md#ispartitionhead)

### Methods

- [deSerialize](Vp9RtpPayload.md#deserialize)
- [isDetectedFinalPacketInSequence](Vp9RtpPayload.md#isdetectedfinalpacketinsequence)
- [parseRtpPayload](Vp9RtpPayload.md#parsertppayload)

## Constructors

### constructor

• **new Vp9RtpPayload**(): [`Vp9RtpPayload`](Vp9RtpPayload.md)

#### Returns

[`Vp9RtpPayload`](Vp9RtpPayload.md)

## Properties

### bBit

• **bBit**: `number`

Start of a frame

___

### d

• `Optional` **d**: `number`

inter_layer_predicted

___

### eBit

• **eBit**: `number`

End of a frame

___

### fBit

• **fBit**: `number`

Flexible mode

___

### g

• `Optional` **g**: `number`

___

### height

• **height**: `number`[] = `[]`

___

### iBit

• **iBit**: `number`

Picture ID (PID) present

___

### lBit

• **lBit**: `number`

Layer indices present

___

### m

• `Optional` **m**: `number`

___

### n\_g

• **n\_g**: `number` = `0`

___

### n\_s

• `Optional` **n\_s**: `number`

___

### pBit

• **pBit**: `number`

Inter-picture predicted frame

___

### pDiff

• **pDiff**: `number`[] = `[]`

___

### payload

• **payload**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[payload](DePacketizerBase.md#payload)

___

### pgP\_Diff

• **pgP\_Diff**: `number`[][] = `[]`

___

### pgT

• **pgT**: `number`[] = `[]`

___

### pgU

• **pgU**: `number`[] = `[]`

___

### pictureId

• `Optional` **pictureId**: `number`

___

### sid

• `Optional` **sid**: `number`

___

### tid

• `Optional` **tid**: `number`

___

### tl0PicIdx

• `Optional` **tl0PicIdx**: `number`

___

### u

• `Optional` **u**: `number`

___

### vBit

• **vBit**: `number`

Scalability structure

___

### width

• **width**: `number`[] = `[]`

___

### y

• `Optional` **y**: `number`

___

### zBit

• **zBit**: `number`

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

___

### isPartitionHead

• `get` **isPartitionHead**(): `boolean` \| ``0``

#### Returns

`boolean` \| ``0``

## Methods

### deSerialize

▸ **deSerialize**(`buf`): [`Vp9RtpPayload`](Vp9RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`Vp9RtpPayload`](Vp9RtpPayload.md)

___

### isDetectedFinalPacketInSequence

▸ **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `header` | [`RtpHeader`](RtpHeader.md) |

#### Returns

`boolean`

___

### parseRtpPayload

▸ **parseRtpPayload**(`buf`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `offset` | `number` |
| `p` | [`Vp9RtpPayload`](Vp9RtpPayload.md) |
