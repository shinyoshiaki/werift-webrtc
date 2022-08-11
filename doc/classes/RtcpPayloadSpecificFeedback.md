[werift](../README.md) / [Exports](../modules.md) / RtcpPayloadSpecificFeedback

# Class: RtcpPayloadSpecificFeedback

## Table of contents

### Constructors

- [constructor](RtcpPayloadSpecificFeedback.md#constructor)

### Properties

- [feedback](RtcpPayloadSpecificFeedback.md#feedback)
- [type](RtcpPayloadSpecificFeedback.md#type)
- [type](RtcpPayloadSpecificFeedback.md#type-1)

### Methods

- [serialize](RtcpPayloadSpecificFeedback.md#serialize)
- [deSerialize](RtcpPayloadSpecificFeedback.md#deserialize)

## Constructors

### constructor

• **new RtcpPayloadSpecificFeedback**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)\> |

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/index.ts#L22)

## Properties

### feedback

• **feedback**: `Feedback`

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/index.ts#L20)

___

### type

• `Readonly` **type**: ``206``

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/index.ts#L18)

___

### type

▪ `Static` `Readonly` **type**: ``206``

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/index.ts#L17)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/index.ts#L26)

___

### deSerialize

▸ `Static` **deSerialize**(`data`, `header`): [`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `header` | [`RtcpHeader`](RtcpHeader.md) |

#### Returns

[`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)

#### Defined in

[packages/rtp/src/rtcp/psfb/index.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/index.ts#L36)
