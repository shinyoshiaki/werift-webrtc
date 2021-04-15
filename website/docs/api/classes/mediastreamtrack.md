---
id: "mediastreamtrack"
title: "Class: MediaStreamTrack"
sidebar_label: "MediaStreamTrack"
custom_edit_url: null
hide_title: true
---

# Class: MediaStreamTrack

## Constructors

### constructor

\+ **new MediaStreamTrack**(`props`: *Partial*<[*MediaStreamTrack*](mediastreamtrack.md)\> & *Pick*<[*MediaStreamTrack*](mediastreamtrack.md), *kind*\>): [*MediaStreamTrack*](mediastreamtrack.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*MediaStreamTrack*](mediastreamtrack.md)\> & *Pick*<[*MediaStreamTrack*](mediastreamtrack.md), *kind*\> |

**Returns:** [*MediaStreamTrack*](mediastreamtrack.md)

Defined in: [webrtc/src/media/track.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L20)

## Properties

### codec

• `Optional` **codec**: [*RTCRtpCodecParameters*](rtcrtpcodecparameters.md)

Defined in: [webrtc/src/media/track.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L15)

___

### header

• `Optional` **header**: [*RtpHeader*](rtpheader.md)

Defined in: [webrtc/src/media/track.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L14)

___

### id

• **id**: *string*

Defined in: [webrtc/src/media/track.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L10)

___

### kind

• **kind**: [*Kind*](../modules.md#kind)

Defined in: [webrtc/src/media/track.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L11)

___

### label

• **label**: *string*

Defined in: [webrtc/src/media/track.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L9)

___

### muted

• **muted**: *boolean*= true

Defined in: [webrtc/src/media/track.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L20)

___

### onReceiveRtp

• `Readonly` **onReceiveRtp**: *default*<[[*RtpPacket*](rtppacket.md)]\>

Defined in: [webrtc/src/media/track.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L17)

___

### remote

• **remote**: *boolean*= false

Defined in: [webrtc/src/media/track.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L8)

___

### rid

• `Optional` **rid**: *string*

Defined in: [webrtc/src/media/track.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L13)

___

### ssrc

• `Optional` **ssrc**: *number*

Defined in: [webrtc/src/media/track.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L12)

___

### stopped

• **stopped**: *boolean*= false

Defined in: [webrtc/src/media/track.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L19)

## Methods

### stop

▸ **stop**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/media/track.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L35)

___

### writeRtp

▸ **writeRtp**(`rtp`: *Buffer* \| [*RtpPacket*](rtppacket.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`rtp` | *Buffer* \| [*RtpPacket*](rtppacket.md) |

**Returns:** *void*

Defined in: [webrtc/src/media/track.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/media/track.ts#L41)
