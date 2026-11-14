[**werift**](../README.md)

***

[werift](../globals.md) / RtcpSenderInfo

# Class: RtcpSenderInfo

## Constructors

### Constructor

> **new RtcpSenderInfo**(`props?`): `RtcpSenderInfo`

#### Parameters

##### props?

`Partial`\<`RtcpSenderInfo`\> = `{}`

#### Returns

`RtcpSenderInfo`

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

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### ntpTimestamp

> **ntpTimestamp**: `any`

##### rtpTimestamp

> **rtpTimestamp**: `number`

***

### deSerialize()

> `static` **deSerialize**(`data`): `RtcpSenderInfo`

#### Parameters

##### data

`Buffer`

#### Returns

`RtcpSenderInfo`
