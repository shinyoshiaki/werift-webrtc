[werift](../README.md) / [Exports](../modules.md) / JitterBuffer

# Class: JitterBuffer

## Hierarchy

- [`Pipeline`](Pipeline.md)

  ↳ **`JitterBuffer`**

## Table of contents

### Constructors

- [constructor](JitterBuffer.md#constructor)

### Properties

- [buffer](JitterBuffer.md#buffer)
- [children](JitterBuffer.md#children)
- [head](JitterBuffer.md#head)
- [maxRetry](JitterBuffer.md#maxretry)
- [retry](JitterBuffer.md#retry)

### Methods

- [onRtp](JitterBuffer.md#onrtp)
- [pipe](JitterBuffer.md#pipe)
- [pushRtcpPackets](JitterBuffer.md#pushrtcppackets)
- [pushRtpPackets](JitterBuffer.md#pushrtppackets)

## Constructors

### constructor

• **new JitterBuffer**(`streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `default`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `default`<[[`RtpPacket`](RtpPacket.md)]\> |

#### Inherited from

[Pipeline](Pipeline.md).[constructor](Pipeline.md#constructor)

#### Defined in

[packages/rtp/src/processor/base.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L7)

## Properties

### buffer

• `Private` **buffer**: `Object` = `{}`

#### Index signature

▪ [sequenceNumber: `number`]: [`RtpPacket`](RtpPacket.md)

#### Defined in

[packages/rtp/src/processor/jitterBuffer.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/jitterBuffer.ts#L13)

___

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Inherited from

[Pipeline](Pipeline.md).[children](Pipeline.md#children)

#### Defined in

[packages/rtp/src/processor/base.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L6)

___

### head

• `Private` `Optional` **head**: `number`

#### Defined in

[packages/rtp/src/processor/jitterBuffer.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/jitterBuffer.ts#L12)

___

### maxRetry

• **maxRetry**: `number` = `100`

#### Defined in

[packages/rtp/src/processor/jitterBuffer.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/jitterBuffer.ts#L15)

___

### retry

• `Private` **retry**: `number` = `0`

#### Defined in

[packages/rtp/src/processor/jitterBuffer.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/jitterBuffer.ts#L11)

## Methods

### onRtp

▸ `Private` **onRtp**(`p`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `p` | [`RtpPacket`](RtpPacket.md) |

#### Returns

`void`

#### Defined in

[packages/rtp/src/processor/jitterBuffer.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/jitterBuffer.ts#L25)

___

### pipe

▸ **pipe**(`children`): [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `children` | [`Pipeline`](Pipeline.md) \| [`Output`](Output.md) |

#### Returns

[`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Inherited from

[Pipeline](Pipeline.md).[pipe](Pipeline.md#pipe)

#### Defined in

[packages/rtp/src/processor/base.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L18)

___

### pushRtcpPackets

▸ **pushRtcpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtcpPacket`](../modules.md#rtcppacket)[] |

#### Returns

`void`

#### Overrides

[Pipeline](Pipeline.md).[pushRtcpPackets](Pipeline.md#pushrtcppackets)

#### Defined in

[packages/rtp/src/processor/jitterBuffer.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/jitterBuffer.ts#L21)

___

### pushRtpPackets

▸ **pushRtpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`void`

#### Overrides

[Pipeline](Pipeline.md).[pushRtpPackets](Pipeline.md#pushrtppackets)

#### Defined in

[packages/rtp/src/processor/jitterBuffer.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/jitterBuffer.ts#L17)
