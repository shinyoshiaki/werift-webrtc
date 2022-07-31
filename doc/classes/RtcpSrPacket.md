[werift](../README.md) / [Exports](../modules.md) / RtcpSrPacket

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

#### Defined in

[packages/rtp/src/rtcp/sr.ts:51](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L51)

## Properties

### reports

• **reports**: [`RtcpReceiverInfo`](RtcpReceiverInfo.md)[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L47)

___

### senderInfo

• **senderInfo**: [`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Defined in

[packages/rtp/src/rtcp/sr.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L46)

___

### ssrc

• **ssrc**: `number` = `0`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L45)

___

### type

• `Readonly` **type**: ``200``

#### Defined in

[packages/rtp/src/rtcp/sr.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L49)

___

### type

▪ `Static` `Readonly` **type**: ``200``

#### Defined in

[packages/rtp/src/rtcp/sr.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L48)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L55)

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

#### Defined in

[packages/rtp/src/rtcp/sr.ts:71](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L71)
