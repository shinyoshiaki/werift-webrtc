[werift](../README.md) / [Exports](../modules.md) / Pipeline

# Class: Pipeline

## Hierarchy

- **`Pipeline`**

  ↳ [`JitterBuffer`](JitterBuffer.md)

  ↳ [`LipSync`](LipSync.md)

  ↳ [`SampleBuilder`](SampleBuilder.md)

## Table of contents

### Constructors

- [constructor](Pipeline.md#constructor)

### Properties

- [children](Pipeline.md#children)

### Methods

- [pipe](Pipeline.md#pipe)
- [pushRtcpPackets](Pipeline.md#pushrtcppackets)
- [pushRtpPackets](Pipeline.md#pushrtppackets)

## Constructors

### constructor

• **new Pipeline**(`streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `default`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `default`<[[`RtpPacket`](RtpPacket.md)]\> |

#### Defined in

[packages/rtp/src/processor/base.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L7)

## Properties

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Defined in

[packages/rtp/src/processor/base.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L6)

## Methods

### pipe

▸ **pipe**(`children`): [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `children` | [`Pipeline`](Pipeline.md) \| [`Output`](Output.md) |

#### Returns

[`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

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

#### Defined in

[packages/rtp/src/processor/base.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L23)

___

### pushRtpPackets

▸ **pushRtpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`void`

#### Defined in

[packages/rtp/src/processor/base.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L22)
