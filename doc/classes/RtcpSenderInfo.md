[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RtcpSenderInfo

# Class: RtcpSenderInfo

## Constructors

### new RtcpSenderInfo()

> **new RtcpSenderInfo**(`props`): [`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Parameters

• **props**: `Partial`\<[`RtcpSenderInfo`](RtcpSenderInfo.md)\> = `{}`

#### Returns

[`RtcpSenderInfo`](RtcpSenderInfo.md)

## Properties

### ntpTimestamp

> **ntpTimestamp**: `bigint`

***

### octetCount

> **octetCount**: `number`

***

### packetCount

> **packetCount**: `number`

***

### rtpTimestamp

> **rtpTimestamp**: `number`

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

##### ntpTimestamp

> **ntpTimestamp**: `number`

##### rtpTimestamp

> **rtpTimestamp**: `number`

***

### deSerialize()

> `static` **deSerialize**(`data`): [`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Parameters

• **data**: `Buffer`

#### Returns

[`RtcpSenderInfo`](RtcpSenderInfo.md)
