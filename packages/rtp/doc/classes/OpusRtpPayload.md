[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / OpusRtpPayload

# Class: OpusRtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### Constructor

> **new OpusRtpPayload**(): `OpusRtpPayload`

#### Returns

`OpusRtpPayload`

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

> `static` **createCodecPrivate**(`samplingFrequency?`): `Buffer`\<`ArrayBuffer`\>

#### Parameters

##### samplingFrequency?

`number` = `48000`

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`buf`): `OpusRtpPayload`

#### Parameters

##### buf

`Buffer`

#### Returns

`OpusRtpPayload`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`_header`): `boolean`

#### Parameters

##### \_header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
