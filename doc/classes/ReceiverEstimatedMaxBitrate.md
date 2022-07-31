[werift](../README.md) / [Exports](../modules.md) / ReceiverEstimatedMaxBitrate

# Class: ReceiverEstimatedMaxBitrate

## Table of contents

### Constructors

- [constructor](ReceiverEstimatedMaxBitrate.md#constructor)

### Properties

- [bitrate](ReceiverEstimatedMaxBitrate.md#bitrate)
- [brExp](ReceiverEstimatedMaxBitrate.md#brexp)
- [brMantissa](ReceiverEstimatedMaxBitrate.md#brmantissa)
- [count](ReceiverEstimatedMaxBitrate.md#count)
- [length](ReceiverEstimatedMaxBitrate.md#length)
- [mediaSsrc](ReceiverEstimatedMaxBitrate.md#mediassrc)
- [senderSsrc](ReceiverEstimatedMaxBitrate.md#senderssrc)
- [ssrcFeedbacks](ReceiverEstimatedMaxBitrate.md#ssrcfeedbacks)
- [ssrcNum](ReceiverEstimatedMaxBitrate.md#ssrcnum)
- [uniqueID](ReceiverEstimatedMaxBitrate.md#uniqueid)
- [count](ReceiverEstimatedMaxBitrate.md#count-1)

### Methods

- [serialize](ReceiverEstimatedMaxBitrate.md#serialize)
- [deSerialize](ReceiverEstimatedMaxBitrate.md#deserialize)

## Constructors

### constructor

• **new ReceiverEstimatedMaxBitrate**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)\> |

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L21)

## Properties

### bitrate

• **bitrate**: `bigint`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L18)

___

### brExp

• **brExp**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L16)

___

### brMantissa

• **brMantissa**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L17)

___

### count

• **count**: `number` = `ReceiverEstimatedMaxBitrate.count`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L11)

___

### length

• **length**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L10)

___

### mediaSsrc

• **mediaSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L13)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L12)

___

### ssrcFeedbacks

• **ssrcFeedbacks**: `number`[] = `[]`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L19)

___

### ssrcNum

• **ssrcNum**: `number` = `0`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L15)

___

### uniqueID

• `Readonly` **uniqueID**: `string` = `"REMB"`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L14)

___

### count

▪ `Static` **count**: `number` = `15`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L9)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:55](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L55)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`ReceiverEstimatedMaxBitrate`](ReceiverEstimatedMaxBitrate.md)

#### Defined in

[packages/rtp/src/rtcp/psfb/remb.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/remb.ts#L25)
