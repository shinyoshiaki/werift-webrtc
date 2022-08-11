[werift](../README.md) / [Exports](../modules.md) / RtcpTransportLayerFeedback

# Class: RtcpTransportLayerFeedback

## Table of contents

### Constructors

- [constructor](RtcpTransportLayerFeedback.md#constructor)

### Properties

- [feedback](RtcpTransportLayerFeedback.md#feedback)
- [header](RtcpTransportLayerFeedback.md#header)
- [type](RtcpTransportLayerFeedback.md#type)
- [type](RtcpTransportLayerFeedback.md#type-1)

### Methods

- [serialize](RtcpTransportLayerFeedback.md#serialize)
- [deSerialize](RtcpTransportLayerFeedback.md#deserialize)

## Constructors

### constructor

• **new RtcpTransportLayerFeedback**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/index.ts#L17)

## Properties

### feedback

• **feedback**: `Feedback`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/index.ts#L14)

___

### header

• **header**: [`RtcpHeader`](RtcpHeader.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/index.ts#L15)

___

### type

• `Readonly` **type**: ``205``

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/index.ts#L13)

___

### type

▪ `Static` `Readonly` **type**: ``205``

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/index.ts#L12)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/index.ts#L21)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/index.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/index.ts#L26)
