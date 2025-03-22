[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / RtcpPacketConverter

# Class: RtcpPacketConverter

## Constructors

### new RtcpPacketConverter()

> **new RtcpPacketConverter**(): [`RtcpPacketConverter`](RtcpPacketConverter.md)

#### Returns

[`RtcpPacketConverter`](RtcpPacketConverter.md)

## Methods

### deSerialize()

> `static` **deSerialize**(`data`): [`RtcpPacket`](../type-aliases/RtcpPacket.md)[]

#### Parameters

• **data**: `Buffer`

#### Returns

[`RtcpPacket`](../type-aliases/RtcpPacket.md)[]

***

### serialize()

> `static` **serialize**(`type`, `count`, `payload`, `length`): `Buffer`

#### Parameters

• **type**: `number`

• **count**: `number`

• **payload**: `Buffer`

• **length**: `number`

#### Returns

`Buffer`
