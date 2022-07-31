[werift](../README.md) / [Exports](../modules.md) / RtcpRrPacket

# Class: RtcpRrPacket

## Table of contents

### Constructors

- [constructor](RtcpRrPacket.md#constructor)

### Properties

- [reports](RtcpRrPacket.md#reports)
- [ssrc](RtcpRrPacket.md#ssrc)
- [type](RtcpRrPacket.md#type)
- [type](RtcpRrPacket.md#type-1)

### Methods

- [serialize](RtcpRrPacket.md#serialize)
- [deSerialize](RtcpRrPacket.md#deserialize)

## Constructors

### constructor

• **new RtcpRrPacket**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpRrPacket`](RtcpRrPacket.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rr.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rr.ts#L12)

## Properties

### reports

• **reports**: [`RtcpReceiverInfo`](RtcpReceiverInfo.md)[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rr.ts#L8)

___

### ssrc

• **ssrc**: `number` = `0`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rr.ts#L7)

___

### type

• `Readonly` **type**: ``201``

#### Defined in

[packages/rtp/src/rtcp/rr.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rr.ts#L10)

___

### type

▪ `Static` `Readonly` **type**: ``201``

#### Defined in

[packages/rtp/src/rtcp/rr.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rr.ts#L9)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rr.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rr.ts#L16)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `count`): [`RtcpRrPacket`](RtcpRrPacket.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `count` | `number` |

#### Returns

[`RtcpRrPacket`](RtcpRrPacket.md)

#### Defined in

[packages/rtp/src/rtcp/rr.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rr.ts#L30)
