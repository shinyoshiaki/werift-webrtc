[werift](../README.md) / [Exports](../modules.md) / SampleBuilder

# Class: SampleBuilder

## Hierarchy

- [`Pipeline`](Pipeline.md)

  ↳ **`SampleBuilder`**

## Table of contents

### Constructors

- [constructor](SampleBuilder.md#constructor)

### Properties

- [children](SampleBuilder.md#children)

### Methods

- [pipe](SampleBuilder.md#pipe)
- [pushRtcpPackets](SampleBuilder.md#pushrtcppackets)
- [pushRtpPackets](SampleBuilder.md#pushrtppackets)
- [stop](SampleBuilder.md#stop)

## Constructors

### constructor

• **new SampleBuilder**(`isFinalPacketInSequence`, `streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `isFinalPacketInSequence` | (`header`: [`RtpHeader`](RtpHeader.md)) => `boolean` |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `Event`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `Event`<[[`RtpPacket`](RtpPacket.md)]\> |

#### Overrides

[Pipeline](Pipeline.md).[constructor](Pipeline.md#constructor)

## Properties

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Inherited from

[Pipeline](Pipeline.md).[children](Pipeline.md#children)

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

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

#### Inherited from

[Pipeline](Pipeline.md).[stop](Pipeline.md#stop)
