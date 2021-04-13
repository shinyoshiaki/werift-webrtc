---
id: "rtcrtpcodecparameters"
title: "Class: RTCRtpCodecParameters"
sidebar_label: "RTCRtpCodecParameters"
custom_edit_url: null
hide_title: true
---

# Class: RTCRtpCodecParameters

## Constructors

### constructor

\+ **new RTCRtpCodecParameters**(`props`: *Pick*<[*RTCRtpCodecParameters*](rtcrtpcodecparameters.md), *mimeType* \| *clockRate*\> & *Partial*<[*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)\>): [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Pick*<[*RTCRtpCodecParameters*](rtcrtpcodecparameters.md), *mimeType* \| *clockRate*\> & *Partial*<[*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)\> |

**Returns:** [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)

Defined in: [webrtc/src/media/parameters.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L35)

## Properties

### channels

• `Optional` **channels**: *number*

Defined in: [webrtc/src/media/parameters.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L33)

___

### clockRate

• **clockRate**: *number*

Defined in: [webrtc/src/media/parameters.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L32)

___

### mimeType

• **mimeType**: *string*

Defined in: [webrtc/src/media/parameters.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L31)

___

### parameters

• **parameters**: *object*= {}

#### Type declaration:

Defined in: [webrtc/src/media/parameters.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L35)

___

### payloadType

• **payloadType**: *number*

Defined in: [webrtc/src/media/parameters.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L30)

___

### rtcpFeedback

• **rtcpFeedback**: RTCPFB[]= []

Defined in: [webrtc/src/media/parameters.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L34)

## Accessors

### name

• get **name**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/media/parameters.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L44)

___

### str

• get **str**(): *string*

**Returns:** *string*

Defined in: [webrtc/src/media/parameters.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/8232339/packages/webrtc/src/media/parameters.ts#L48)
