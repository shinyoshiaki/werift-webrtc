[werift](../README.md) / [Exports](../modules.md) / LipSync

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
- [rtpPackets](LipSync.md#rtppackets)

### Methods

- [calcNtpTime](LipSync.md#calcntptime)
- [pipe](LipSync.md#pipe)
- [pushRtcpPackets](LipSync.md#pushrtcppackets)
- [pushRtpPackets](LipSync.md#pushrtppackets)
- [srReceived](LipSync.md#srreceived)

## Constructors

### constructor

• **new LipSync**(`clockRate`, `mismatch`, `streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `clockRate` | `number` |
| `mismatch` | `number` |
| `streams?` | `Object` |
| `streams.rtcpStream?` | `default`<[[`RtcpPacket`](../modules.md#rtcppacket)]\> |
| `streams.rtpStream?` | `default`<[[`RtpPacket`](RtpPacket.md)]\> |

#### Overrides

[Pipeline](Pipeline.md).[constructor](Pipeline.md#constructor)

#### Defined in

[packages/rtp/src/processor/lipsync.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L15)

## Properties

### baseNtpTimestamp

• `Optional` **baseNtpTimestamp**: `bigint`

#### Defined in

[packages/rtp/src/processor/lipsync.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L11)

___

### baseRtpTimestamp

• `Optional` **baseRtpTimestamp**: `number`

#### Defined in

[packages/rtp/src/processor/lipsync.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L12)

___

### children

• `Protected` `Optional` **children**: [`Pipeline`](Pipeline.md) \| [`Output`](Output.md)

#### Inherited from

[Pipeline](Pipeline.md).[children](Pipeline.md#children)

#### Defined in

[packages/rtp/src/processor/base.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L6)

___

### clockRate

• **clockRate**: `number`

#### Defined in

[packages/rtp/src/processor/lipsync.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L16)

___

### mismatch

• **mismatch**: `number`

#### Defined in

[packages/rtp/src/processor/lipsync.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L17)

___

### rtpPackets

• `Private` **rtpPackets**: `Object` = `{}`

#### Index signature

▪ [pt: `number`]: [`RtpPacket`](RtpPacket.md)[]

#### Defined in

[packages/rtp/src/processor/lipsync.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L13)

## Methods

### calcNtpTime

▸ `Private` **calcNtpTime**(`rtpTimestamp`): `undefined` \| `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `rtpTimestamp` | `number` |

#### Returns

`undefined` \| `number`

#### Defined in

[packages/rtp/src/processor/lipsync.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L60)

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

[packages/rtp/src/processor/lipsync.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L26)

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

[packages/rtp/src/processor/lipsync.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L41)

___

### srReceived

▸ `Private` **srReceived**(`sr`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `sr` | [`RtcpSrPacket`](RtcpSrPacket.md) |

#### Returns

`void`

#### Defined in

[packages/rtp/src/processor/lipsync.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/lipsync.ts#L35)
