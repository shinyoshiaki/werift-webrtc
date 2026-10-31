[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Vp8RtpPayload

# Class: Vp8RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### Constructor

> **new Vp8RtpPayload**(): `Vp8RtpPayload`

#### Returns

`Vp8RtpPayload`

## Properties

### hBit?

> `optional` **hBit?**: `number`

***

### iBit?

> `optional` **iBit?**: `number`

***

### kBit?

> `optional` **kBit?**: `number`

***

### lBit?

> `optional` **lBit?**: `number`

***

### mBit?

> `optional` **mBit?**: `number`

***

### nBit

> **nBit**: `number`

***

### payload

> **payload**: `Buffer`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`payload`](DePacketizerBase.md#payload)

***

### pBit?

> `optional` **pBit?**: `number`

***

### pictureId?

> `optional` **pictureId?**: `number`

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

> `optional` **tBit?**: `number`

***

### ver?

> `optional` **ver?**: `number`

***

### xBit

> **xBit**: `number`

## Accessors

### isKeyframe

#### Get Signature

> **get** **isKeyframe**(): `boolean`

##### Returns

`boolean`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`isKeyframe`](DePacketizerBase.md#iskeyframe)

***

### isPartitionHead

#### Get Signature

> **get** **isPartitionHead**(): `boolean`

##### Returns

`boolean`

***

### payloadHeaderExist

#### Get Signature

> **get** **payloadHeaderExist**(): `boolean`

##### Returns

`boolean`

***

### size

#### Get Signature

> **get** **size**(): `number`

##### Returns

`number`

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`): `Vp8RtpPayload`

#### Parameters

##### buf

`Buffer`

#### Returns

`Vp8RtpPayload`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
