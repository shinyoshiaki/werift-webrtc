[**werift**](../README.md)

***

[werift](../globals.md) / PcmaPacketizer

# Class: PcmaPacketizer

## Extends

- `G711Packetizer`

## Constructors

### new PcmaPacketizer()

> **new PcmaPacketizer**(`options`): [`PcmaPacketizer`](PcmaPacketizer.md)

#### Parameters

##### options

[`G711PacketizerOptions`](../type-aliases/G711PacketizerOptions.md) = `{}`

#### Returns

[`PcmaPacketizer`](PcmaPacketizer.md)

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
