[werift](../README.md) / [Exports](../modules.md) / SampleBuilder

# Class: SampleBuilder

## Hierarchy

- [`Pipeline`](Pipeline.md)

  ↳ **`SampleBuilder`**

## Table of contents

### Constructors

- [constructor](SampleBuilder.md#constructor)

### Properties

- [buffering](SampleBuilder.md#buffering)
- [children](SampleBuilder.md#children)

### Methods

- [pipe](SampleBuilder.md#pipe)
- [pushRtcpPackets](SampleBuilder.md#pushrtcppackets)
- [pushRtpPackets](SampleBuilder.md#pushrtppackets)

## Constructors

### constructor

• **new SampleBuilder**(`isFinalPacketInSequence`, `streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `isFinalPacketInSequence` | (`header`: [`RtpHeader`](RtpHeader.md)) => `boolean` |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `default`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `default`<[[`RtpPacket`](RtpPacket.md)]\> |

#### Overrides

[Pipeline](Pipeline.md).[constructor](Pipeline.md#constructor)

#### Defined in

[packages/rtp/src/processor/sampleBuilder.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/sampleBuilder.ts#L10)

## Properties

### buffering

• `Private` **buffering**: [`RtpPacket`](RtpPacket.md)[] = `[]`

#### Defined in

[packages/rtp/src/processor/sampleBuilder.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/sampleBuilder.ts#L8)

___

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Inherited from

[Pipeline](Pipeline.md).[children](Pipeline.md#children)

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

[packages/rtp/src/processor/sampleBuilder.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/sampleBuilder.ts#L40)

___

### pushRtpPackets

▸ **pushRtpPackets**(`incoming`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `incoming` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`void`

#### Overrides

[Pipeline](Pipeline.md).[pushRtpPackets](Pipeline.md#pushrtppackets)

#### Defined in

[packages/rtp/src/processor/sampleBuilder.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/sampleBuilder.ts#L20)
