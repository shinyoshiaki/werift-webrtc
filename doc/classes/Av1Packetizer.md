[**werift**](../README.md)

***

[werift](../globals.md) / Av1Packetizer

# Class: Av1Packetizer

Packetize one AV1 access unit (OBU sequence) into RTP packets.
Uses W=1 single-element payloads; fragments large OBUs with Z/Y bits.

## Extends

- [`PacketizerBase`](PacketizerBase.md)

## Constructors

### new Av1Packetizer()

> **new Av1Packetizer**(`options`): [`Av1Packetizer`](Av1Packetizer.md)

#### Parameters

##### options

[`Av1PacketizerOptions`](../type-aliases/Av1PacketizerOptions.md) = `{}`

#### Returns

[`Av1Packetizer`](Av1Packetizer.md)

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

[`Av1PacketizeOptions`](../type-aliases/Av1PacketizeOptions.md) = `{}`

#### Returns

[`RtpPacket`](RtpPacket.md)[]

#### Overrides

[`PacketizerBase`](PacketizerBase.md).[`packetize`](PacketizerBase.md#packetize)
