[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / G722RtpPayload

# Class: G722RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### Constructor

> **new G722RtpPayload**(): `G722RtpPayload`

#### Returns

`G722RtpPayload`

## Properties

### payload

> **payload**: `Buffer`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`payload`](DePacketizerBase.md#payload)

## Accessors

### isKeyframe

#### Get Signature

> **get** **isKeyframe**(): `boolean`

##### Returns

`boolean`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`isKeyframe`](DePacketizerBase.md#iskeyframe)

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`): `G722RtpPayload`

#### Parameters

##### buf

`Buffer`

#### Returns

`G722RtpPayload`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
