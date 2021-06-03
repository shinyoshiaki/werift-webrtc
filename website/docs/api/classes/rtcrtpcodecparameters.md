---
id: "rtcrtpcodecparameters"
title: "Class: RTCRtpCodecParameters"
sidebar_label: "RTCRtpCodecParameters"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RTCRtpCodecParameters**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Pick`<[RTCRtpCodecParameters](rtcrtpcodecparameters.md), ``"mimeType"`` \| ``"clockRate"``\> & `Partial`<[RTCRtpCodecParameters](rtcrtpcodecparameters.md)\> |

#### Defined in

[packages/webrtc/src/media/parameters.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L31)

## Properties

### channels

• `Optional` **channels**: `number`

#### Defined in

[packages/webrtc/src/media/parameters.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L29)

___

### clockRate

• **clockRate**: `number`

#### Defined in

[packages/webrtc/src/media/parameters.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L28)

___

### mimeType

• **mimeType**: `string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L27)

___

### parameters

• **parameters**: `Object` = {}

#### Defined in

[packages/webrtc/src/media/parameters.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L31)

___

### payloadType

• **payloadType**: `number`

#### Defined in

[packages/webrtc/src/media/parameters.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L26)

___

### rtcpFeedback

• **rtcpFeedback**: [RTCPFB](../modules.md#rtcpfb)[] = []

#### Defined in

[packages/webrtc/src/media/parameters.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L30)

## Accessors

### name

• `get` **name**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L40)

___

### str

• `get` **str**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/media/parameters.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/parameters.ts#L44)
