[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / AacHbrRtpPayload

# Class: AacHbrRtpPayload

AAC-hbr RTP payload (RFC 3640 §3.3.6).
deSerialize validates AU-headers-length and AU sizes before concatenation.

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### new AacHbrRtpPayload()

> **new AacHbrRtpPayload**(): [`AacHbrRtpPayload`](AacHbrRtpPayload.md)

#### Returns

[`AacHbrRtpPayload`](AacHbrRtpPayload.md)

## Properties

### auHeaders

> **auHeaders**: [`AuHeader`](../type-aliases/AuHeader.md)[] = `[]`

***

### fragment?

> `optional` **fragment**: `Buffer`\<`ArrayBufferLike`\>

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`fragment`](DePacketizerBase.md#fragment)

***

### isContinuationFragment

> **isContinuationFragment**: `boolean` = `false`

***

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

> `static` **deSerialize**(`buf`, `fragment`?): [`AacHbrRtpPayload`](AacHbrRtpPayload.md)

#### Parameters

##### buf

`Buffer`

##### fragment?

`Buffer`\<`ArrayBufferLike`\>

#### Returns

[`AacHbrRtpPayload`](AacHbrRtpPayload.md)

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
