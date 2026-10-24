[**werift**](../README.md)

***

[werift](../globals.md) / G722RtpPayload

# Class: G722RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new G722RtpPayload()

> **new G722RtpPayload**(): [`G722RtpPayload`](G722RtpPayload.md)

#### Returns

[`G722RtpPayload`](G722RtpPayload.md)

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

> `static` **deSerialize**(`buf`): [`G722RtpPayload`](G722RtpPayload.md)

#### Parameters

##### buf

`Buffer`

#### Returns

[`G722RtpPayload`](G722RtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
