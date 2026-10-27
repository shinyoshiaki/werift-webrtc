[**werift**](../README.md)

***

[werift](../globals.md) / PcmuRtpPayload

# Class: PcmuRtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### Constructor

> **new PcmuRtpPayload**(): `PcmuRtpPayload`

#### Returns

`PcmuRtpPayload`

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

> `static` **deSerialize**(`buf`): `PcmuRtpPayload`

#### Parameters

##### buf

`Buffer`

#### Returns

`PcmuRtpPayload`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
