[werift](../README.md) / [Exports](../modules.md) / GenericNack

# Class: GenericNack

## Table of contents

### Constructors

- [constructor](GenericNack.md#constructor)

### Properties

- [count](GenericNack.md#count)
- [header](GenericNack.md#header)
- [lost](GenericNack.md#lost)
- [mediaSourceSsrc](GenericNack.md#mediasourcessrc)
- [senderSsrc](GenericNack.md#senderssrc)
- [count](GenericNack.md#count-1)

### Methods

- [serialize](GenericNack.md#serialize)
- [deSerialize](GenericNack.md#deserialize)

## Constructors

### constructor

• **new GenericNack**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`GenericNack`](GenericNack.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L14)

## Properties

### count

• `Readonly` **count**: `number` = `GenericNack.count`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L8)

___

### header

• **header**: [`RtcpHeader`](RtcpHeader.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L9)

___

### lost

• **lost**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L12)

___

### mediaSourceSsrc

• **mediaSourceSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L11)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L10)

___

### count

▪ `Static` **count**: `number` = `1`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L7)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:49](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L49)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [`GenericNack`](GenericNack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`GenericNack`](GenericNack.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/nack.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/nack.ts#L25)
