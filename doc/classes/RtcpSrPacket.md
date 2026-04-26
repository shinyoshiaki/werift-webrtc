[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RtcpSrPacket

# Class: RtcpSrPacket

## Constructors

### new RtcpSrPacket()

> **new RtcpSrPacket**(`props`): [`RtcpSrPacket`](RtcpSrPacket.md)

#### Parameters

• **props**: `Pick`\<[`RtcpSrPacket`](RtcpSrPacket.md), `"senderInfo"`\> & `Partial`\<[`RtcpSrPacket`](RtcpSrPacket.md)\>

#### Returns

[`RtcpSrPacket`](RtcpSrPacket.md)

## Properties

### reports

> **reports**: [`RtcpReceiverInfo`](RtcpReceiverInfo.md)[] = `[]`

***

### senderInfo

> **senderInfo**: [`RtcpSenderInfo`](RtcpSenderInfo.md)

***

### ssrc

> **ssrc**: `number` = `0`

***

### type

> `readonly` **type**: `200` = `RtcpSrPacket.type`

***

### type

> `readonly` `static` **type**: `200` = `200`

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### reports

> **reports**: `object`[]

##### senderInfo

> **senderInfo**: `object`

##### senderInfo.ntpTimestamp

> **ntpTimestamp**: `number`

##### senderInfo.rtpTimestamp

> **rtpTimestamp**: `number`

##### ssrc

> **ssrc**: `number`

***

### deSerialize()

> `static` **deSerialize**(`payload`, `count`): [`RtcpSrPacket`](RtcpSrPacket.md)

#### Parameters

• **payload**: `Buffer`

• **count**: `number`

#### Returns

[`RtcpSrPacket`](RtcpSrPacket.md)
