[**werift**](../README.md)

***

[werift](../globals.md) / OpusRtpPayload

# Class: OpusRtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new OpusRtpPayload()

> **new OpusRtpPayload**(): [`OpusRtpPayload`](OpusRtpPayload.md)

#### Returns

[`OpusRtpPayload`](OpusRtpPayload.md)

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

### createCodecPrivate()

> `static` **createCodecPrivate**(`samplingFrequency`): `Buffer`\<`ArrayBuffer`\>

#### Parameters

##### samplingFrequency

`number` = `48000`

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`buf`): [`OpusRtpPayload`](OpusRtpPayload.md)

#### Parameters

##### buf

`Buffer`

#### Returns

[`OpusRtpPayload`](OpusRtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
