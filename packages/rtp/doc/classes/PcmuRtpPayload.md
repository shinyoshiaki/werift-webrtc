[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / PcmuRtpPayload

# Class: PcmuRtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new PcmuRtpPayload()

> **new PcmuRtpPayload**(): [`PcmuRtpPayload`](PcmuRtpPayload.md)

#### Returns

[`PcmuRtpPayload`](PcmuRtpPayload.md)

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

> `static` **deSerialize**(`buf`): [`PcmuRtpPayload`](PcmuRtpPayload.md)

#### Parameters

##### buf

`Buffer`

#### Returns

[`PcmuRtpPayload`](PcmuRtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
