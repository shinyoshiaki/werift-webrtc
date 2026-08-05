[**werift**](../README.md)

***

[werift](../globals.md) / OpusPacketizer

# Class: OpusPacketizer

Packetize one Opus packet into one RTP packet (RFC 7587 §3).
Throws if the Opus packet exceeds maxPayloadSize (no TOC-blind split).

## Extends

- [`PacketizerBase`](PacketizerBase.md)

## Constructors

### new OpusPacketizer()

> **new OpusPacketizer**(`options`): [`OpusPacketizer`](OpusPacketizer.md)

#### Parameters

##### options

[`PacketizerBaseOptions`](../type-aliases/PacketizerBaseOptions.md) = `{}`

#### Returns

[`OpusPacketizer`](OpusPacketizer.md)

#### Overrides

[`PacketizerBase`](PacketizerBase.md).[`constructor`](PacketizerBase.md#constructors)

## Properties

### maxPayloadSize

> `protected` `readonly` **maxPayloadSize**: `number`

#### Inherited from

[`PacketizerBase`](PacketizerBase.md).[`maxPayloadSize`](PacketizerBase.md#maxpayloadsize)

***

### payloadType

> `protected` `readonly` **payloadType**: `number`

#### Inherited from

[`PacketizerBase`](PacketizerBase.md).[`payloadType`](PacketizerBase.md#payloadtype)

***

### sequenceNumber

> `protected` **sequenceNumber**: `number`

#### Inherited from

[`PacketizerBase`](PacketizerBase.md).[`sequenceNumber`](PacketizerBase.md#sequencenumber)

***

### ssrc

> `protected` `readonly` **ssrc**: `number`

#### Inherited from

[`PacketizerBase`](PacketizerBase.md).[`ssrc`](PacketizerBase.md#ssrc)

## Methods

### buildPacket()

> `protected` **buildPacket**(`payload`, `timestamp`, `marker`): [`RtpPacket`](RtpPacket.md)

#### Parameters

##### payload

`Buffer`

##### timestamp

`number`

##### marker

`boolean`

#### Returns

[`RtpPacket`](RtpPacket.md)

#### Inherited from

[`PacketizerBase`](PacketizerBase.md).[`buildPacket`](PacketizerBase.md#buildpacket)

***

### packetize()

> **packetize**(`data`, `rtpTimestamp`): [`RtpPacket`](RtpPacket.md)[]

#### Parameters

##### data

`Buffer`

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)[]

#### Overrides

[`PacketizerBase`](PacketizerBase.md).[`packetize`](PacketizerBase.md#packetize)
