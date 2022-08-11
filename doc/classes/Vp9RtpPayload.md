[werift](../README.md) / [Exports](../modules.md) / Vp9RtpPayload

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

• **new Vp9RtpPayload**()

## Properties

### bBit

• **bBit**: `number`

Start of a frame

#### Defined in

[packages/rtp/src/codec/vp9.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L49)

___

### d

• `Optional` **d**: `number`

inter_layer_predicted

#### Defined in

[packages/rtp/src/codec/vp9.ts:61](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L61)

___

### eBit

• **eBit**: `number`

End of a frame

#### Defined in

[packages/rtp/src/codec/vp9.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L51)

___

### fBit

• **fBit**: `number`

Flexible mode

#### Defined in

[packages/rtp/src/codec/vp9.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L47)

___

### g

• `Optional` **g**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L66)

___

### height

• **height**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/codec/vp9.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L68)

___

### iBit

• **iBit**: `number`

Picture ID (PID) present

#### Defined in

[packages/rtp/src/codec/vp9.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L41)

___

### lBit

• **lBit**: `number`

Layer indices present

#### Defined in

[packages/rtp/src/codec/vp9.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L45)

___

### m

• `Optional` **m**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L55)

___

### n\_g

• **n\_g**: `number` = `0`

#### Defined in

[packages/rtp/src/codec/vp9.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L69)

___

### n\_s

• `Optional` **n\_s**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L64)

___

### pBit

• **pBit**: `number`

Inter-picture predicted frame

#### Defined in

[packages/rtp/src/codec/vp9.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L43)

___

### pDiff

• **pDiff**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/codec/vp9.ts:63](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L63)

___

### payload

• **payload**: `Buffer`

#### Implementation of

[DePacketizerBase](DePacketizerBase.md).[payload](DePacketizerBase.md#payload)

#### Defined in

[packages/rtp/src/codec/vp9.ts:73](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L73)

___

### pgP\_Diff

• **pgP\_Diff**: `number`[][] = `[]`

#### Defined in

[packages/rtp/src/codec/vp9.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L72)

___

### pgT

• **pgT**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/codec/vp9.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L70)

___

### pgU

• **pgU**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/codec/vp9.ts:71](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L71)

___

### pictureId

• `Optional` **pictureId**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L56)

___

### sid

• `Optional` **sid**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L59)

___

### tid

• `Optional` **tid**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:57](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L57)

___

### tl0PicIdx

• `Optional` **tl0PicIdx**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L62)

___

### u

• `Optional` **u**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L58)

___

### vBit

• **vBit**: `number`

Scalability structure

#### Defined in

[packages/rtp/src/codec/vp9.ts:53](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L53)

___

### width

• **width**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/codec/vp9.ts:67](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L67)

___

### y

• `Optional` **y**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L65)

___

### zBit

• **zBit**: `number`

#### Defined in

[packages/rtp/src/codec/vp9.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L54)

## Accessors

### isKeyframe

• `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

DePacketizerBase.isKeyframe

#### Defined in

[packages/rtp/src/codec/vp9.ts:194](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L194)

___

### isPartitionHead

• `get` **isPartitionHead**(): `boolean` \| ``0``

#### Returns

`boolean` \| ``0``

#### Defined in

[packages/rtp/src/codec/vp9.ts:198](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L198)

## Methods

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`Vp9RtpPayload`](Vp9RtpPayload.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`Vp9RtpPayload`](Vp9RtpPayload.md)

#### Defined in

[packages/rtp/src/codec/vp9.ts:75](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L75)

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

[packages/rtp/src/codec/vp9.ts:190](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L190)

___

### parseRtpPayload

▸ `Static` **parseRtpPayload**(`buf`): `Object`

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

#### Defined in

[packages/rtp/src/codec/vp9.ts:81](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/codec/vp9.ts#L81)
