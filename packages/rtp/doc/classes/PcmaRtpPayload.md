[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / PcmaRtpPayload

# Class: PcmaRtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new PcmaRtpPayload()

> **new PcmaRtpPayload**(): [`PcmaRtpPayload`](PcmaRtpPayload.md)

#### Returns

[`PcmaRtpPayload`](PcmaRtpPayload.md)

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

> `static` **deSerialize**(`buf`): [`PcmaRtpPayload`](PcmaRtpPayload.md)

#### Parameters

##### buf

`Buffer`

#### Returns

[`PcmaRtpPayload`](PcmaRtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
