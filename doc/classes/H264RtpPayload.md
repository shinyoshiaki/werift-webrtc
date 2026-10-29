[**werift**](../README.md)

***

[werift](../globals.md) / H264RtpPayload

# Class: H264RtpPayload

## Implements

- [`DePacketizerBase`](DePacketizerBase.md)

## Constructors

### Constructor

> **new H264RtpPayload**(): `H264RtpPayload`

#### Returns

`H264RtpPayload`

## Properties

### aggregatedNalUnitTypes

> **aggregatedNalUnitTypes**: `number`[] = `[]`

nal_unit_types of the NAL units aggregated in a STAP-A packet

***

### e?

> `optional` **e?**: `number`

end of a fragmented NAL unit (FU-A / FU-B only)

***

### f

> **f**: `number`

forbidden_zero_bit

***

### fragment?

> `optional` **fragment?**: `Buffer`\<`ArrayBufferLike`\>

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`fragment`](DePacketizerBase.md#fragment)

***

### nalUnitPayloadType?

> `optional` **nalUnitPayloadType?**: `number`

nal_unit_type of the fragmented NAL unit (FU-A / FU-B only)

***

### nalUnitType

> **nalUnitType**: `number`

nal_unit_types

***

### nri

> **nri**: `number`

nal_ref_idc

***

### payload

> **payload**: `Buffer`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`payload`](DePacketizerBase.md#payload)

***

### r?

> `optional` **r?**: `number`

reserved bit of the FU header (FU-A / FU-B only)

***

### s?

> `optional` **s?**: `number`

start of a fragmented NAL unit (FU-A / FU-B only)

## Accessors

### isKeyframe

#### Get Signature

> **get** **isKeyframe**(): `boolean`

true only when this packet carries (a part of) an IDR slice

##### Returns

`boolean`

#### Implementation of

[`DePacketizerBase`](DePacketizerBase.md).[`isKeyframe`](DePacketizerBase.md#iskeyframe)

***

### isPartitionHead

#### Get Signature

> **get** **isPartitionHead**(): `boolean`

##### Returns

`boolean`

## Methods

### deSerialize()

> `static` **deSerialize**(`buf`, `fragment?`): `H264RtpPayload`

#### Parameters

##### buf

`Buffer`

##### fragment?

`Buffer`\<`ArrayBufferLike`\>

#### Returns

`H264RtpPayload`

***

### isDetectedFinalPacketInSequence()

> `static` **isDetectedFinalPacketInSequence**(`header`): `boolean`

#### Parameters

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`boolean`
