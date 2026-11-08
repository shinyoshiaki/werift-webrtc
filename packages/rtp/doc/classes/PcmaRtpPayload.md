[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / PcmaRtpPayload

# Class: PcmaRtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### Constructor

> **new PcmaRtpPayload**(): `PcmaRtpPayload`

#### Returns

`PcmaRtpPayload`

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

> `static` **deSerialize**(`buf`): `PcmaRtpPayload`

#### Parameters

##### buf

`Buffer`

#### Returns

`PcmaRtpPayload`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
