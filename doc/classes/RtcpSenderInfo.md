[werift](../README.md) / [Exports](../modules.md) / RtcpSenderInfo

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
- [deSerialize](RtcpSenderInfo.md#deserialize)

## Constructors

### constructor

• **new RtcpSenderInfo**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpSenderInfo`](RtcpSenderInfo.md)\> |

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

### deSerialize

▸ `Static` **deSerialize**(`data`): [`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RtcpSenderInfo`](RtcpSenderInfo.md)
