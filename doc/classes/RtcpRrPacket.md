[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RtcpRrPacket

# Class: RtcpRrPacket

## Constructors

### new RtcpRrPacket()

> **new RtcpRrPacket**(`props`): [`RtcpRrPacket`](RtcpRrPacket.md)

#### Parameters

• **props**: `Partial`\<[`RtcpRrPacket`](RtcpRrPacket.md)\> = `{}`

#### Returns

[`RtcpRrPacket`](RtcpRrPacket.md)

## Properties

### reports

> **reports**: [`RtcpReceiverInfo`](RtcpReceiverInfo.md)[] = `[]`

***

### ssrc

> **ssrc**: `number` = `0`

***

### type

> `readonly` **type**: `201` = `RtcpRrPacket.type`

***

### type

> `readonly` `static` **type**: `201` = `201`

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`data`, `count`): [`RtcpRrPacket`](RtcpRrPacket.md)

#### Parameters

• **data**: `Buffer`

• **count**: `number`

#### Returns

[`RtcpRrPacket`](RtcpRrPacket.md)
