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
- [stop](Pipeline.md#stop)

## Constructors

### constructor

• **new Pipeline**(`streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `Event`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `Event`<[[`RtpPacket`](RtpPacket.md)]\> |

## Properties

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

## Methods

### pipe

▸ **pipe**(`children`): [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `children` | [`Pipeline`](Pipeline.md) \| [`Output`](Output.md) |

#### Returns

[`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

___

### pushRtcpPackets

▸ **pushRtcpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtcpPacket`](../modules.md#rtcppacket)[] |

#### Returns

`void`

___

### pushRtpPackets

▸ **pushRtpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`void`

___

### stop

▸ **stop**(): `void`

#### Returns

`void`
