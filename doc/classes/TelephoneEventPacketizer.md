[**werift**](../README.md)

***

[werift](../globals.md) / TelephoneEventPacketizer

# Class: TelephoneEventPacketizer

Packetize named telephone events (RFC 4733).

Preferred APIs for RFC-correct marker/E-bit control:
- [packetizeStart](TelephoneEventPacketizer.md#packetizestart) / [packetizeContinue](TelephoneEventPacketizer.md#packetizecontinue) / [packetizeEnd](TelephoneEventPacketizer.md#packetizeend)
- [packetizeEvent](TelephoneEventPacketizer.md#packetizeevent) with start/end flags
- [packetize](TelephoneEventPacketizer.md#packetize)(fields, timestamp) with structured fields

[packetizeBuffer](TelephoneEventPacketizer.md#packetizebuffer) exists only to re-wrap a pre-serialized 4-byte
payload (marker defaults to false — not for new event starts).

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

Packetize a telephone-event snapshot.
Accepts structured fields (recommended) or a pre-built 4-byte Buffer.
For Buffer input, marker is false unless you use packetizeEvent/Start.

#### Parameters

##### data

`Buffer`\<`ArrayBufferLike`\> | [`TelephoneEventPacketizeInput`](../type-aliases/TelephoneEventPacketizeInput.md)

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)[]

#### Overrides

[`PacketizerBase`](PacketizerBase.md).[`packetize`](PacketizerBase.md#packetize)

***

### packetizeBuffer()

> **packetizeBuffer**(`data`, `rtpTimestamp`, `marker`): [`RtpPacket`](RtpPacket.md)

Re-wrap a pre-serialized 4-byte payload. Marker is controlled explicitly;
default false (not suitable for event start without marker=true).

#### Parameters

##### data

`Buffer`

##### rtpTimestamp

`number`

##### marker

`boolean` = `false`

#### Returns

[`RtpPacket`](RtpPacket.md)

***

### packetizeContinue()

> **packetizeContinue**(`event`, `volume`, `duration`, `rtpTimestamp`): [`RtpPacket`](RtpPacket.md)

Intermediate update: marker=0, E=0; duration is cumulative.

#### Parameters

##### event

`number`

##### volume

`number`

##### duration

`number`

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)

***

### packetizeEnd()

> **packetizeEnd**(`event`, `volume`, `duration`, `rtpTimestamp`): [`RtpPacket`](RtpPacket.md)

Final packet(s): marker=0, E=1; duration is cumulative.

#### Parameters

##### event

`number`

##### volume

`number`

##### duration

`number`

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)

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

***

### packetizeStart()

> **packetizeStart**(`event`, `volume`, `duration`, `rtpTimestamp`): [`RtpPacket`](RtpPacket.md)

First packet of an event: marker=1, E=0 (RFC 4733 §2.5.1.1).

#### Parameters

##### event

`number`

##### volume

`number`

##### duration

`number`

##### rtpTimestamp

`number`

#### Returns

[`RtpPacket`](RtpPacket.md)
