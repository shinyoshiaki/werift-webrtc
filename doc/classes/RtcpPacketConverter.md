[werift](../README.md) / [Exports](../modules.md) / RtcpPacketConverter

# Class: RtcpPacketConverter

## Table of contents

### Constructors

- [constructor](RtcpPacketConverter.md#constructor)

### Methods

- [deSerialize](RtcpPacketConverter.md#deserialize)
- [serialize](RtcpPacketConverter.md#serialize)

## Constructors

### constructor

• **new RtcpPacketConverter**()

## Methods

### deSerialize

▸ `Static` **deSerialize**(`data`): [`RtcpPacket`](../modules.md#rtcppacket)[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |

#### Returns

[`RtcpPacket`](../modules.md#rtcppacket)[]

#### Defined in

[packages/rtp/src/rtcp/rtcp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtcp.ts#L36)

___

### serialize

▸ `Static` **serialize**(`type`, `count`, `payload`, `length`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | `number` |
| `count` | `number` |
| `payload` | `Buffer` |
| `length` | `number` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtcp/rtcp.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/rtcp/rtcp.ts#L20)
