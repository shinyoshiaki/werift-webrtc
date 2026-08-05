[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / H264Packetizer

# Class: H264Packetizer

Packetize H.264 access units (Annex-B or length-prefixed) for mode=1.
Single NAL / STAP-A (SPS+PPS) / FU-A fragmentation (RFC 6184).

## Extends

- [`PacketizerBase`](PacketizerBase.md)

## Constructors

### new H264Packetizer()

> **new H264Packetizer**(`options`): [`H264Packetizer`](H264Packetizer.md)

#### Parameters

##### options

[`H264PacketizerOptions`](../type-aliases/H264PacketizerOptions.md) = `{}`

#### Returns

[`H264Packetizer`](H264Packetizer.md)

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

[`H264PacketizeOptions`](../type-aliases/H264PacketizeOptions.md) = `{}`

#### Returns

[`RtpPacket`](RtpPacket.md)[]

#### Overrides

[`PacketizerBase`](PacketizerBase.md).[`packetize`](PacketizerBase.md#packetize)
