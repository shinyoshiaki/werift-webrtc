[werift](../README.md) / [Exports](../modules.md) / Output

# Class: Output

## Implemented by

- [`WebmOutput`](WebmOutput.md)

## Table of contents

### Constructors

- [constructor](Output.md#constructor)

### Methods

- [pushRtcpPackets](Output.md#pushrtcppackets)
- [pushRtpPackets](Output.md#pushrtppackets)

## Constructors

### constructor

• **new Output**()

## Methods

### pushRtcpPackets

▸ `Optional` **pushRtcpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtcpPacket`](../modules.md#rtcppacket)[] |

#### Returns

`void`

#### Defined in

[packages/rtp/src/processor/base.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L28)

___

### pushRtpPackets

▸ `Optional` **pushRtpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`void`

#### Defined in

[packages/rtp/src/processor/base.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/base.ts#L27)
