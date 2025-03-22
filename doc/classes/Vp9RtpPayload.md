[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / Vp9RtpPayload

# Class: Vp9RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new Vp9RtpPayload()

> **new Vp9RtpPayload**(): [`Vp9RtpPayload`](Vp9RtpPayload.md)

#### Returns

[`Vp9RtpPayload`](Vp9RtpPayload.md)

## Properties

### bBit

> **bBit**: `number`

Start of a frame

***

### d?

> `optional` **d**: `number`

inter_layer_predicted

***

### eBit

> **eBit**: `number`

End of a frame

***

### fBit

> **fBit**: `number`

Flexible mode

***

### g?

> `optional` **g**: `number`

***

### height

> **height**: `number`[] = `[]`

***

### iBit

> **iBit**: `number`

Picture ID (PID) present

***

### lBit

> **lBit**: `number`

Layer indices present

***

### m?

> `optional` **m**: `number`

***

### n\_g

> **n\_g**: `number` = `0`

***

### n\_s?

> `optional` **n\_s**: `number`

***

### pBit

> **pBit**: `number`

Inter-picture predicted frame

***

### pDiff

> **pDiff**: `number`[] = `[]`

***

### payload

> **payload**: `Buffer`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`payload`](DePacketizerBase.md#payload)

***

### pgP\_Diff

> **pgP\_Diff**: `number`[][] = `[]`

***

### pgT

> **pgT**: `number`[] = `[]`

***

### pgU

> **pgU**: `number`[] = `[]`

***

### pictureId?

> `optional` **pictureId**: `number`

***

### sid?

> `optional` **sid**: `number`

***

### tid?

> `optional` **tid**: `number`

***

### tl0PicIdx?

> `optional` **tl0PicIdx**: `number`

***

### u?

> `optional` **u**: `number`

***

### vBit

> **vBit**: `number`

Scalability structure

***

### width

> **width**: `number`[] = `[]`

***

### y?

> `optional` **y**: `number`

***

### zBit

> **zBit**: `number`

## Accessors

### isKeyframe

> `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`isKeyframe`](DePacketizerBase.md#iskeyframe)

***

### isPartitionHead

> `get` **isPartitionHead**(): `boolean` \| `0`

#### Returns

`boolean` \| `0`

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`): [`Vp9RtpPayload`](Vp9RtpPayload.md)

#### Parameters

• **buf**: `Buffer`

#### Returns

[`Vp9RtpPayload`](Vp9RtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

• **header**: [`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`

***

### parseRtpPayload()

> `static` **parseRtpPayload**(`buf`): `object`

#### Parameters

• **buf**: `Buffer`

#### Returns

`object`

##### offset

> **offset**: `number`

##### p

> **p**: [`Vp9RtpPayload`](Vp9RtpPayload.md)
