[werift](../README.md) / [Exports](../modules.md) / WebmOutput

# Class: WebmOutput

## Implements

- [`Output`](Output.md)

## Table of contents

### Constructors

- [constructor](WebmOutput.md#constructor)

### Properties

- [path](WebmOutput.md#path)
- [stopped](WebmOutput.md#stopped)
- [tracks](WebmOutput.md#tracks)

### Methods

- [pushRtpPackets](WebmOutput.md#pushrtppackets)
- [stop](WebmOutput.md#stop)

## Constructors

### constructor

• **new WebmOutput**(`fs`, `path`, `tracks`, `streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `fs` | `any` |
| `path` | `string` |
| `tracks` | { `clockRate`: `number` ; `codec`: ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"AV1"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `payloadType`: `number` ; `trackNumber`: `number` ; `width?`: `number`  }[] |
| `streams?` | `Object` |
| `streams.rtpStream?` | `default`<[[`RtpPacket`](RtpPacket.md)]\> |

## Properties

### path

• **path**: `string`

___

### stopped

• **stopped**: `boolean` = `false`

___

### tracks

• **tracks**: { `clockRate`: `number` ; `codec`: ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"AV1"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `payloadType`: `number` ; `trackNumber`: `number` ; `width?`: `number`  }[]

## Methods

### pushRtpPackets

▸ **pushRtpPackets**(`packets`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`void`

#### Implementation of

[Output](Output.md).[pushRtpPackets](Output.md#pushrtppackets)

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>
