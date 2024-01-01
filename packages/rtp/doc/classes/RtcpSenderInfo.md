[werift-rtp](../README.md) / [Exports](../modules.md) / RtcpSenderInfo

# Class: RtcpSenderInfo

## Table of contents

### Constructors

- [constructor](RtcpSenderInfo.md#constructor)

### Properties

- [ntpTimestamp](RtcpSenderInfo.md#ntptimestamp)
- [octetCount](RtcpSenderInfo.md#octetcount)
- [packetCount](RtcpSenderInfo.md#packetcount)
- [rtpTimestamp](RtcpSenderInfo.md#rtptimestamp)

### Methods

- [serialize](RtcpSenderInfo.md#serialize)
- [toJSON](RtcpSenderInfo.md#tojson)
- [deSerialize](RtcpSenderInfo.md#deserialize)

## Constructors

### constructor

• **new RtcpSenderInfo**(`props?`): [`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`\<[`RtcpSenderInfo`](RtcpSenderInfo.md)\> |

#### Returns

[`RtcpSenderInfo`](RtcpSenderInfo.md)

## Properties

### ntpTimestamp

• **ntpTimestamp**: `bigint`

___

### octetCount

• **octetCount**: `number`

___

### packetCount

• **packetCount**: `number`

___

### rtpTimestamp

• **rtpTimestamp**: `number`

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### toJSON

▸ **toJSON**(): `Object`

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `ntpTimestamp` | `number` |
| `rtpTimestamp` | `number` |

___

### deSerialize

▸ **deSerialize**(`data`): [`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RtcpSenderInfo`](RtcpSenderInfo.md)
