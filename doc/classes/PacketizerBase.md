[**werift**](../README.md)

***

[werift](../globals.md) / PacketizerBase

# Class: `abstract` PacketizerBase

Shared RTP packet construction for package-local packetizers.
Sequence number increments by 1 (uint16 wrap) per packet.
Marker semantics are left to each codec (typically last packet of a frame;
telephone-event is the RFC 4733 exception: marker on the first event packet).

## Extended by

- [`Av1Packetizer`](Av1Packetizer.md)
- [`G722Packetizer`](G722Packetizer.md)
- [`H264Packetizer`](H264Packetizer.md)
- [`H265Packetizer`](H265Packetizer.md)
- [`AacHbrPacketizer`](AacHbrPacketizer.md)
- [`OpusPacketizer`](OpusPacketizer.md)
- [`TelephoneEventPacketizer`](TelephoneEventPacketizer.md)
- [`Vp8Packetizer`](Vp8Packetizer.md)
- [`Vp9Packetizer`](Vp9Packetizer.md)

## Implements

- [`Packetizer`](../interfaces/Packetizer.md)

## Constructors

### new PacketizerBase()

> **new PacketizerBase**(`options`): [`PacketizerBase`](PacketizerBase.md)

#### Parameters

##### options

[`PacketizerBaseOptions`](../type-aliases/PacketizerBaseOptions.md) = `{}`

#### Returns

[`PacketizerBase`](PacketizerBase.md)

## Properties

### maxPayloadSize

> `protected` `readonly` **maxPayloadSize**: `number`

***

### payloadType

> `protected` `readonly` **payloadType**: `number`

***

### sequenceNumber

> `protected` **sequenceNumber**: `number`

***

### ssrc

> `protected` `readonly` **ssrc**: `number`

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

***

### packetize()

> `abstract` **packetize**(`data`, `rtpTimestamp`): [`RtpPacket`](RtpPacket.md)[]

#### Parameters

##### data

`Buffer`

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)[]

#### Implementation of

[`Packetizer`](../interfaces/Packetizer.md).[`packetize`](../interfaces/Packetizer.md#packetize)
