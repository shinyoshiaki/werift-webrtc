[werift](../README.md) / [Exports](../modules.md) / JitterBuffer

# Class: JitterBuffer

## Hierarchy

- [`Pipeline`](Pipeline.md)

  ↳ **`JitterBuffer`**

## Table of contents

### Constructors

- [constructor](JitterBuffer.md#constructor)

### Properties

- [children](JitterBuffer.md#children)
- [maxRetry](JitterBuffer.md#maxretry)

### Methods

- [pipe](JitterBuffer.md#pipe)
- [pushRtcpPackets](JitterBuffer.md#pushrtcppackets)
- [pushRtpPackets](JitterBuffer.md#pushrtppackets)
- [stop](JitterBuffer.md#stop)

## Constructors

### constructor

• **new JitterBuffer**(`streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `Event`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `Event`<[[`RtpPacket`](RtpPacket.md)]\> |

#### Inherited from

[Pipeline](Pipeline.md).[constructor](Pipeline.md#constructor)

## Properties

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Inherited from

[Pipeline](Pipeline.md).[children](Pipeline.md#children)

___

### maxRetry

• **maxRetry**: `number` = `100`

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

▸ **pushRtpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

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
