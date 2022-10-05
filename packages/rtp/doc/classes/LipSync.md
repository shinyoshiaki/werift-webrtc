[werift-rtp](../README.md) / [Exports](../modules.md) / LipSync

# Class: LipSync

## Hierarchy

- [`Pipeline`](Pipeline.md)

  ↳ **`LipSync`**

## Table of contents

### Constructors

- [constructor](LipSync.md#constructor)

### Properties

- [baseNtpTimestamp](LipSync.md#basentptimestamp)
- [baseRtpTimestamp](LipSync.md#basertptimestamp)
- [children](LipSync.md#children)
- [clockRate](LipSync.md#clockrate)
- [mismatch](LipSync.md#mismatch)

### Methods

- [pipe](LipSync.md#pipe)
- [pushRtcpPackets](LipSync.md#pushrtcppackets)
- [pushRtpPackets](LipSync.md#pushrtppackets)
- [stop](LipSync.md#stop)

## Constructors

### constructor

• **new LipSync**(`clockRate`, `mismatch`, `streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `clockRate` | `number` |
| `mismatch` | `number` |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `Event`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `Event`<[[`RtpPacket`](RtpPacket.md)]\> |

#### Overrides

[Pipeline](Pipeline.md).[constructor](Pipeline.md#constructor)

## Properties

### baseNtpTimestamp

• `Optional` **baseNtpTimestamp**: `bigint`

___

### baseRtpTimestamp

• `Optional` **baseRtpTimestamp**: `number`

___

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Inherited from

[Pipeline](Pipeline.md).[children](Pipeline.md#children)

___

### clockRate

• **clockRate**: `number`

___

### mismatch

• **mismatch**: `number`

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
