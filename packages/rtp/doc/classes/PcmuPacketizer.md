[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / PcmuPacketizer

# Class: PcmuPacketizer

## Extends

- `G711Packetizer`

## Constructors

### Constructor

> **new PcmuPacketizer**(`options?`): `PcmuPacketizer`

#### Parameters

##### options?

[`G711PacketizerOptions`](../type-aliases/G711PacketizerOptions.md) = `{}`

#### Returns

`PcmuPacketizer`

#### Overrides

`G711Packetizer.constructor`

## Properties

### frameBytes

> `protected` `readonly` **frameBytes**: `number`

#### Inherited from

`G711Packetizer.frameBytes`

***

### maxPayloadSize

> `protected` `readonly` **maxPayloadSize**: `number`

#### Inherited from

`G711Packetizer.maxPayloadSize`

***

### payloadType

> `protected` `readonly` **payloadType**: `number`

#### Inherited from

`G711Packetizer.payloadType`

***

### sequenceNumber

> `protected` **sequenceNumber**: `number`

#### Inherited from

`G711Packetizer.sequenceNumber`

***

### ssrc

> `protected` `readonly` **ssrc**: `number`

#### Inherited from

`G711Packetizer.ssrc`

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

`G711Packetizer.buildPacket`

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

#### Inherited from

`G711Packetizer.packetize`

***

### startTalkspurt()

> **startTalkspurt**(): `void`

Mark the next audio packet as the first of a talkspurt (e.g. after
silence suppression). The first packet of a new packetizer is also one.

#### Returns

`void`

#### Inherited from

`G711Packetizer.startTalkspurt`

***

### takeTalkspurtMarker()

> `protected` **takeTalkspurtMarker**(): `boolean`

Marker for audio packets: true once per talkspurt, false otherwise.

#### Returns

`boolean`

#### Inherited from

`G711Packetizer.takeTalkspurtMarker`
