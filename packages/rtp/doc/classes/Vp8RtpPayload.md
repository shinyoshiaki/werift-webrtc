[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / Vp8RtpPayload

# Class: Vp8RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new Vp8RtpPayload()

> **new Vp8RtpPayload**(): [`Vp8RtpPayload`](Vp8RtpPayload.md)

#### Returns

[`Vp8RtpPayload`](Vp8RtpPayload.md)

## Properties

### hBit?

> `optional` **hBit**: `number`

***

### iBit?

> `optional` **iBit**: `number`

***

### kBit?

> `optional` **kBit**: `number`

***

### lBit?

> `optional` **lBit**: `number`

***

### mBit?

> `optional` **mBit**: `number`

***

### nBit

> **nBit**: `number`

***

### pBit?

> `optional` **pBit**: `number`

***

### payload

> **payload**: `Buffer`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`payload`](DePacketizerBase.md#payload)

***

### pictureId?

> `optional` **pictureId**: `number`

***

### pid

> **pid**: `number`

***

### sBit

> **sBit**: `number`

***

### size0

> **size0**: `number` = `0`

***

### size1

> **size1**: `number` = `0`

***

### size2

> **size2**: `number` = `0`

***

### tBit?

> `optional` **tBit**: `number`

***

### ver?

> `optional` **ver**: `number`

***

### xBit

> **xBit**: `number`

## Accessors

### isKeyframe

> `get` **isKeyframe**(): `boolean`

#### Returns

`boolean`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`isKeyframe`](DePacketizerBase.md#iskeyframe)

***

### isPartitionHead

> `get` **isPartitionHead**(): `boolean`

#### Returns

`boolean`

***

### payloadHeaderExist

> `get` **payloadHeaderExist**(): `boolean`

#### Returns

`boolean`

***

### size

> `get` **size**(): `number`

#### Returns

`number`

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`): [`Vp8RtpPayload`](Vp8RtpPayload.md)

#### Parameters

• **buf**: `Buffer`

#### Returns

[`Vp8RtpPayload`](Vp8RtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

• **header**: [`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
