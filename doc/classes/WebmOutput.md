[werift](../README.md) / [Exports](../modules.md) / WebmOutput

# Class: WebmOutput

## Implements

- [`Output`](Output.md)

## Table of contents

### Constructors

- [constructor](WebmOutput.md#constructor)

### Properties

- [builder](WebmOutput.md#builder)
- [cuePoints](WebmOutput.md#cuepoints)
- [disposer](WebmOutput.md#disposer)
- [path](WebmOutput.md#path)
- [position](WebmOutput.md#position)
- [queue](WebmOutput.md#queue)
- [relativeTimestamp](WebmOutput.md#relativetimestamp)
- [stopped](WebmOutput.md#stopped)
- [timestamps](WebmOutput.md#timestamps)
- [tracks](WebmOutput.md#tracks)

### Methods

- [dePacketizeRtpPackets](WebmOutput.md#depacketizertppackets)
- [init](WebmOutput.md#init)
- [onRtpPackets](WebmOutput.md#onrtppackets)
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

#### Defined in

[packages/rtp/src/processor/webm.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L26)

## Properties

### builder

• `Private` **builder**: `WEBMBuilder`

#### Defined in

[packages/rtp/src/processor/webm.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L17)

___

### cuePoints

• `Private` **cuePoints**: `CuePoint`[] = `[]`

#### Defined in

[packages/rtp/src/processor/webm.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L22)

___

### disposer

• `Private` `Optional` **disposer**: () => `void`

#### Type declaration

▸ (): `void`

##### Returns

`void`

#### Defined in

[packages/rtp/src/processor/webm.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L21)

___

### path

• **path**: `string`

#### Defined in

[packages/rtp/src/processor/webm.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L29)

___

### position

• `Private` **position**: `number` = `0`

#### Defined in

[packages/rtp/src/processor/webm.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L23)

___

### queue

• `Private` **queue**: [`PromiseQueue`](PromiseQueue.md)

#### Defined in

[packages/rtp/src/processor/webm.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L18)

___

### relativeTimestamp

• `Private` **relativeTimestamp**: `number` = `0`

#### Defined in

[packages/rtp/src/processor/webm.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L19)

___

### stopped

• **stopped**: `boolean` = `false`

#### Defined in

[packages/rtp/src/processor/webm.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L24)

___

### timestamps

• `Private` **timestamps**: `Object` = `{}`

#### Index signature

▪ [pt: `number`]: `TimestampManager`

#### Defined in

[packages/rtp/src/processor/webm.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L20)

___

### tracks

• **tracks**: { `clockRate`: `number` ; `codec`: ``"MPEG4/ISO/AVC"`` \| ``"VP8"`` \| ``"VP9"`` \| ``"AV1"`` \| ``"OPUS"`` ; `height?`: `number` ; `kind`: ``"audio"`` \| ``"video"`` ; `payloadType`: `number` ; `trackNumber`: `number` ; `width?`: `number`  }[]

#### Defined in

[packages/rtp/src/processor/webm.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L30)

## Methods

### dePacketizeRtpPackets

▸ `Private` **dePacketizeRtpPackets**(`codec`, `packets`): `Object`

#### Parameters

| Name | Type |
| :------ | :------ |
| `codec` | `string` |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `isKeyframe` | `boolean` |

#### Defined in

[packages/rtp/src/processor/webm.ts:182](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L182)

___

### init

▸ `Private` **init**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/rtp/src/processor/webm.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L59)

___

### onRtpPackets

▸ `Private` **onRtpPackets**(`packets`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `packets` | [`RtpPacket`](RtpPacket.md)[] |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/rtp/src/processor/webm.ts:128](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L128)

___

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

#### Defined in

[packages/rtp/src/processor/webm.ts:123](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L123)

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/rtp/src/processor/webm.ts:79](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/processor/webm.ts#L79)
