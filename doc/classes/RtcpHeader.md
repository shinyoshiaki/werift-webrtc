[werift](../README.md) / [Exports](../modules.md) / RtcpHeader

# Class: RtcpHeader

## Table of contents

### Constructors

- [constructor](RtcpHeader.md#constructor)

### Properties

- [count](RtcpHeader.md#count)
- [length](RtcpHeader.md#length)
- [padding](RtcpHeader.md#padding)
- [type](RtcpHeader.md#type)
- [version](RtcpHeader.md#version)

### Methods

- [serialize](RtcpHeader.md#serialize)
- [deSerialize](RtcpHeader.md#deserialize)

## Constructors

### constructor

• **new RtcpHeader**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RtcpHeader`](RtcpHeader.md)\> |

#### Defined in

[packages/rtp/src/rtcp/header.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L25)

## Properties

### count

• **count**: `number` = `0`

#### Defined in

[packages/rtp/src/rtcp/header.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L21)

___

### length

• **length**: `number` = `0`

#### Defined in

[packages/rtp/src/rtcp/header.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L23)

___

### padding

• **padding**: `boolean` = `false`

#### Defined in

[packages/rtp/src/rtcp/header.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L20)

___

### type

• **type**: `number` = `0`

#### Defined in

[packages/rtp/src/rtcp/header.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L22)

___

### version

• **version**: `number` = `2`

#### Defined in

[packages/rtp/src/rtcp/header.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L19)

## Methods

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/header.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L29)

___

### deSerialize

▸ `Static` **deSerialize**(`buf`): [`RtcpHeader`](RtcpHeader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

[`RtcpHeader`](RtcpHeader.md)

#### Defined in

[packages/rtp/src/rtcp/header.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/header.ts#L38)
