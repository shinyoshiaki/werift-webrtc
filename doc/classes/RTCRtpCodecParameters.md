[werift](../README.md) / [Exports](../modules.md) / RTCRtpCodecParameters

# Class: RTCRtpCodecParameters

## Table of contents

### Constructors

- [constructor](RTCRtpCodecParameters.md#constructor)

### Properties

- [channels](RTCRtpCodecParameters.md#channels)
- [clockRate](RTCRtpCodecParameters.md#clockrate)
- [mimeType](RTCRtpCodecParameters.md#mimetype)
- [parameters](RTCRtpCodecParameters.md#parameters)
- [payloadType](RTCRtpCodecParameters.md#payloadtype)
- [rtcpFeedback](RTCRtpCodecParameters.md#rtcpfeedback)

### Accessors

- [contentType](RTCRtpCodecParameters.md#contenttype)
- [name](RTCRtpCodecParameters.md#name)
- [str](RTCRtpCodecParameters.md#str)

## Constructors

### constructor

• **new RTCRtpCodecParameters**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Pick`<[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md), ``"mimeType"`` \| ``"clockRate"``\> & `Partial`<[`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)\> |

#### Defined in

[packages/webrtc/src/media/parameters.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L24)

## Properties

### channels

• `Optional` **channels**: `number`

#### Defined in

[packages/webrtc/src/media/parameters.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L20)

___

### clockRate

• **clockRate**: `number`

#### Defined in

[packages/webrtc/src/media/parameters.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L19)

___

### mimeType

• **mimeType**: `string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L18)

___

### parameters

• `Optional` **parameters**: `string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L22)

___

### payloadType

• **payloadType**: `number`

When specifying a codec with a fixed payloadType such as PCMU,
it is necessary to set the correct PayloadType in RTCRtpCodecParameters in advance.

#### Defined in

[packages/webrtc/src/media/parameters.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L17)

___

### rtcpFeedback

• **rtcpFeedback**: [`RTCPFB`](../modules.md#rtcpfb)[] = `[]`

#### Defined in

[packages/webrtc/src/media/parameters.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L21)

## Accessors

### contentType

• `get` **contentType**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L35)

___

### name

• `get` **name**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L31)

___

### str

• `get` **str**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/media/parameters.ts#L39)
