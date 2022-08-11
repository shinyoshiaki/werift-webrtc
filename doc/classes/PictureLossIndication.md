[werift](../README.md) / [Exports](../modules.md) / PictureLossIndication

# Class: PictureLossIndication

## Table of contents

### Constructors

- [constructor](PictureLossIndication.md#constructor)

### Properties

- [count](PictureLossIndication.md#count)
- [length](PictureLossIndication.md#length)
- [mediaSsrc](PictureLossIndication.md#mediassrc)
- [senderSsrc](PictureLossIndication.md#senderssrc)
- [count](PictureLossIndication.md#count-1)

### Methods

- [serialize](PictureLossIndication.md#serialize)
- [deSerialize](PictureLossIndication.md#deserialize)

## Constructors

### constructor

• **new PictureLossIndication**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`PictureLossIndication`](PictureLossIndication.md)\> |

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L11)

## Properties

### count

• **count**: `number` = `PictureLossIndication.count`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L5)

___

### length

• **length**: `number` = `2`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L6)

___

### mediaSsrc

• **mediaSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L9)

___

### senderSsrc

• **senderSsrc**: `number`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L8)

___

### count

▪ `Static` **count**: `number` = `1`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:4](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L4)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L20)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`PictureLossIndication`](PictureLossIndication.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`PictureLossIndication`](PictureLossIndication.md)

#### Defined in

[packages/rtp/src/rtcp/psfb/pictureLossIndication.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/psfb/pictureLossIndication.ts#L15)
