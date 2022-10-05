[werift-rtp](../README.md) / [Exports](../modules.md) / RtcpPacketConverter

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
