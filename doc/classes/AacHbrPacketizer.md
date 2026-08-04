[**werift**](../README.md)

***

[werift](../globals.md) / AacHbrPacketizer

# Class: AacHbrPacketizer

AAC-hbr packetizer (RFC 3640 §3.3.6).
AU-size fields store the Access Unit size in octets (not size−1).

## Extends

- [`PacketizerBase`](PacketizerBase.md)

## Constructors

### new AacHbrPacketizer()

> **new AacHbrPacketizer**(`options`): [`AacHbrPacketizer`](AacHbrPacketizer.md)

#### Parameters

##### options

[`PacketizerBaseOptions`](../type-aliases/PacketizerBaseOptions.md) = `{}`

#### Returns

[`AacHbrPacketizer`](AacHbrPacketizer.md)

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

***

### packetizeAccessUnits()

> **packetizeAccessUnits**(`aus`, `rtpTimestamp`): [`RtpPacket`](RtpPacket.md)[]

#### Parameters

##### aus

`Buffer`\<`ArrayBufferLike`\>[]

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)[]
