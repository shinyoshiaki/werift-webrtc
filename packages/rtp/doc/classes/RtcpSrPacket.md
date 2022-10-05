[werift-rtp](../README.md) / [Exports](../modules.md) / RtcpSrPacket

# Class: RtcpSrPacket

## Table of contents

### Constructors

- [constructor](RtcpSrPacket.md#constructor)

### Properties

- [reports](RtcpSrPacket.md#reports)
- [senderInfo](RtcpSrPacket.md#senderinfo)
- [ssrc](RtcpSrPacket.md#ssrc)
- [type](RtcpSrPacket.md#type)
- [type](RtcpSrPacket.md#type-1)

### Methods

- [serialize](RtcpSrPacket.md#serialize)
- [deSerialize](RtcpSrPacket.md#deserialize)

## Constructors

### constructor

• **new RtcpSrPacket**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Pick`<[`RtcpSrPacket`](RtcpSrPacket.md), ``"senderInfo"``\> & `Partial`<[`RtcpSrPacket`](RtcpSrPacket.md)\> |

## Properties

### reports

• **reports**: [`RtcpReceiverInfo`](RtcpReceiverInfo.md)[] = `[]`

___

### senderInfo

• **senderInfo**: [`RtcpSenderInfo`](RtcpSenderInfo.md)

___

### ssrc

• **ssrc**: `number` = `0`

___

### type

• `Readonly` **type**: ``200``

___

### type

▪ `Static` `Readonly` **type**: ``200``

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

___

### deSerialize

▸ `Static` **deSerialize**(`payload`, `count`): [`RtcpSrPacket`](RtcpSrPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `count` | `number` |

#### Returns

[`RtcpSrPacket`](RtcpSrPacket.md)
