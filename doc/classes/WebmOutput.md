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

• **new WebmOutput**(`writer`, `path`, `tracks`, `streams?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `writer` | [`FileIO`](../interfaces/FileIO.md) |
| `path` | `string` |
| `tracks` | { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `payloadType`: `number` ; `trackNumber`: `number` ; `width?`: `number`  }[] |
| `streams?` | `Object` |
| `streams.rtpStream?` | `Event`<[[`RtpPacket`](RtpPacket.md)]\> |

## Properties

### path

• **path**: `string`

___

### stopped

• **stopped**: `boolean` = `false`

___

### tracks

• **tracks**: { `clockRate`: `number` ; `codec`: ``"AV1"`` \| ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `payloadType`: `number` ; `trackNumber`: `number` ; `width?`: `number`  }[]

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

▸ **stop**(`insertDuration?`): `Promise`<`void`\>

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `insertDuration` | `boolean` | `true` |

#### Returns

`Promise`<`void`\>
