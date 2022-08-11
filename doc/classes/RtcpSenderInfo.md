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

#### Defined in

[packages/rtp/src/rtcp/sr.ts:90](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L90)

## Properties

### ntpTimestamp

• **ntpTimestamp**: `bigint`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:85](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L85)

___

### octetCount

• **octetCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L88)

___

### packetCount

• **packetCount**: `number`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:87](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L87)

___

### rtpTimestamp

• **rtpTimestamp**: `number`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:86](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L86)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/sr.ts:94](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L94)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RtcpSenderInfo`](RtcpSenderInfo.md)

#### Defined in

[packages/rtp/src/rtcp/sr.ts:101](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/sr.ts#L101)
