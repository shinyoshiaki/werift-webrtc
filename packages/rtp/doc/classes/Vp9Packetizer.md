[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / Vp9Packetizer

# Class: Vp9Packetizer

Packetize one VP9 frame with the minimal 1-byte descriptor (RFC 9628).
Picture ID / layer / SS extensions are not sent (legal optional subset).

## Extends

- [`PacketizerBase`](PacketizerBase.md)

## Constructors

### new Vp9Packetizer()

> **new Vp9Packetizer**(`options`): [`Vp9Packetizer`](Vp9Packetizer.md)

#### Parameters

##### options

[`Vp9PacketizerOptions`](../type-aliases/Vp9PacketizerOptions.md) = `{}`

#### Returns

[`Vp9Packetizer`](Vp9Packetizer.md)

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

> **packetize**(`data`, `rtpTimestamp`, `options`): [`RtpPacket`](RtpPacket.md)[]

#### Parameters

##### data

`Buffer`

##### rtpTimestamp

`number`

##### options

[`Vp9PacketizeOptions`](../type-aliases/Vp9PacketizeOptions.md) = `{}`

#### Returns

[`RtpPacket`](RtpPacket.md)[]

#### Overrides

[`PacketizerBase`](PacketizerBase.md).[`packetize`](PacketizerBase.md#packetize)
