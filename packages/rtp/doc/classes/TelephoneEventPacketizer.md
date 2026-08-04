[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / TelephoneEventPacketizer

# Class: TelephoneEventPacketizer

Packetize named telephone events.
Callers manage start/continue/end lifecycle via `start` and `end` flags;
each call produces one RTP packet (RFC 4733 multi-packet updates).

## Extends

- [`PacketizerBase`](PacketizerBase.md)

## Constructors

### new TelephoneEventPacketizer()

> **new TelephoneEventPacketizer**(`options`): [`TelephoneEventPacketizer`](TelephoneEventPacketizer.md)

#### Parameters

##### options

[`PacketizerBaseOptions`](../type-aliases/PacketizerBaseOptions.md) = `{}`

#### Returns

[`TelephoneEventPacketizer`](TelephoneEventPacketizer.md)

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

Standard Packetizer interface — treats data as a pre-built 4-byte payload.
Prefer [packetizeEvent](TelephoneEventPacketizer.md#packetizeevent) for structured fields.

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

### packetizeEvent()

> **packetizeEvent**(`input`, `rtpTimestamp`): [`RtpPacket`](RtpPacket.md)

Build one RTP packet for a telephone event snapshot.
- `start: true` → RTP marker = 1 (first packet of event)
- `end: true` → E bit = 1 (end of event)
Duration is cumulative from event start (RFC 4733 §2.5.1.2).

#### Parameters

##### input

[`TelephoneEventPacketizeInput`](../type-aliases/TelephoneEventPacketizeInput.md)

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)
