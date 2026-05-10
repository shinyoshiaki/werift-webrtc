[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / DePacketizerBase

# Class: `abstract` DePacketizerBase

## Constructors

### new DePacketizerBase()

> **new DePacketizerBase**(): [`DePacketizerBase`](DePacketizerBase.md)

#### Returns

[`DePacketizerBase`](DePacketizerBase.md)

## Properties

### fragment?

> `optional` **fragment**: `Buffer`\<`ArrayBufferLike`\>

***

### payload

> **payload**: `Buffer`

## Accessors

### isKeyframe

#### Get Signature

> **get** **isKeyframe**(): `boolean`

##### Returns

`boolean`

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`, `fragment`?): [`DePacketizerBase`](DePacketizerBase.md)

#### Parameters

##### buf

`Buffer`

##### fragment?

`Buffer`\<`ArrayBufferLike`\>

#### Returns

[`DePacketizerBase`](DePacketizerBase.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
