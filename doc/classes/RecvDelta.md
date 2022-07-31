[werift](../README.md) / [Exports](../modules.md) / RecvDelta

# Class: RecvDelta

## Table of contents

### Constructors

- [constructor](RecvDelta.md#constructor)

### Properties

- [delta](RecvDelta.md#delta)
- [parsed](RecvDelta.md#parsed)
- [type](RecvDelta.md#type)

### Methods

- [deSerialize](RecvDelta.md#deserialize)
- [parseDelta](RecvDelta.md#parsedelta)
- [serialize](RecvDelta.md#serialize)
- [deSerialize](RecvDelta.md#deserialize-1)

## Constructors

### constructor

• **new RecvDelta**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[`RecvDelta`](RecvDelta.md)\> |

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:354](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L354)

## Properties

### delta

• **delta**: `number`

micro sec

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:352](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L352)

___

### parsed

• **parsed**: `boolean` = `false`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:380](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L380)

___

### type

• `Optional` **type**: [`TypeTCCPacketReceivedSmallDelta`](../enums/PacketStatus.md#typetccpacketreceivedsmalldelta) \| [`TypeTCCPacketReceivedLargeDelta`](../enums/PacketStatus.md#typetccpacketreceivedlargedelta)

optional (If undefined, it will be set automatically.)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:348](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L348)

## Methods

### deSerialize

▸ **deSerialize**(`data`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

`void`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:375](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L375)

___

### parseDelta

▸ **parseDelta**(): `void`

#### Returns

`void`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:381](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L381)

___

### serialize

▸ **serialize**(): `Buffer`

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:394](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L394)

___

### deSerialize

▸ `Static` **deSerialize**(`data`): [`RecvDelta`](RecvDelta.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RecvDelta`](RecvDelta.md)

#### Defined in

[packages/rtp/src/rtcp/rtpfb/twcc.ts:358](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtpfb/twcc.ts#L358)
