[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / DePacketizerBase

# Abstract Class: DePacketizerBase

## Constructors

### Constructor

> **new DePacketizerBase**(): `DePacketizerBase`

#### Returns

`DePacketizerBase`

## Properties

### fragment?

> `optional` **fragment?**: `Buffer`\<`ArrayBufferLike`\>

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

> `static` **deSerialize**(`buf`, `fragment?`): `DePacketizerBase`

#### Parameters

##### buf

`Buffer`

##### fragment?

`Buffer`\<`ArrayBufferLike`\>

#### Returns

`DePacketizerBase`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
