[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtpBuilder

# Class: RtpBuilder

## Constructors

### Constructor

> **new RtpBuilder**(`props`): `RtpBuilder`

#### Parameters

##### props

[`RtpBuilderProps`](../type-aliases/RtpBuilderProps.md)

#### Returns

`RtpBuilder`

## Properties

### sequenceNumber

> **sequenceNumber**: `number`

Sequence number of the last created packet.

## Accessors

### timestamp

#### Get Signature

> **get** **timestamp**(): `number`

Current RTP timestamp (uint32).

##### Returns

`number`

#### Set Signature

> **set** **timestamp**(`timestamp`): `void`

##### Parameters

###### timestamp

`number`

##### Returns

`void`

## Methods

### advanceSamples()

> **advanceSamples**(`samples`): `number`

Advances the timestamp only; the sequence number is unchanged.

#### Parameters

##### samples

`number`

#### Returns

`number`

***

### create()

> **create**(`payload`, `options?`): [`RtpPacket`](RtpPacket.md)

#### Parameters

##### payload

`Buffer`

##### options?

[`RtpBuilderCreateOptions`](../interfaces/RtpBuilderCreateOptions.md) = `{}`

#### Returns

[`RtpPacket`](RtpPacket.md)
