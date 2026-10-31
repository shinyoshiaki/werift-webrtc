[**werift**](../README.md)

***

[werift](../globals.md) / RtcpSrPacket

# Class: RtcpSrPacket

## Constructors

### Constructor

> **new RtcpSrPacket**(`props`): `RtcpSrPacket`

#### Parameters

##### props

`Pick`\<`RtcpSrPacket`, `"senderInfo"`\> & `Partial`\<`RtcpSrPacket`\>

#### Returns

`RtcpSrPacket`

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

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### reports

> **reports**: `object`[]

##### senderInfo

> **senderInfo**: `object`

###### senderInfo.ntpTimestamp

> **ntpTimestamp**: `any`

###### senderInfo.rtpTimestamp

> **rtpTimestamp**: `number`

##### ssrc

> **ssrc**: `number`

***

### deSerialize()

> `static` **deSerialize**(`payload`, `count`): `RtcpSrPacket`

#### Parameters

##### payload

`Buffer`

##### count

`number`

#### Returns

`RtcpSrPacket`
