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

Defined in: [webrtc/src/media/track.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L15)

## Properties

### header

• `Optional` **header**: [*RtpHeader*](rtpheader.md)

Defined in: [webrtc/src/media/track.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L11)

___

### id

• `Optional` **id**: *string*

Defined in: [webrtc/src/media/track.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L8)

___

### kind

• **kind**: [*Kind*](../modules.md#kind)

Defined in: [webrtc/src/media/track.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L7)

___

### onReceiveRtp

• `Readonly` **onReceiveRtp**: *default*<[[*RtpPacket*](rtppacket.md)]\>

Defined in: [webrtc/src/media/track.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L13)

___

### rid

• `Optional` **rid**: *string*

Defined in: [webrtc/src/media/track.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L10)

___

### role

• **role**: *read* \| *write*= "write"

Defined in: [webrtc/src/media/track.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L6)

___

### ssrc

• `Optional` **ssrc**: *number*

Defined in: [webrtc/src/media/track.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L9)

___

### stopped

• **stopped**: *boolean*= false

Defined in: [webrtc/src/media/track.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L15)

## Methods

### stop

▸ **stop**(): *void*

**Returns:** *void*

Defined in: [webrtc/src/media/track.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L27)

___

### writeRtp

▸ **writeRtp**(`rtp`: *Buffer* \| [*RtpPacket*](rtppacket.md)): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`rtp` | *Buffer* \| [*RtpPacket*](rtppacket.md) |

**Returns:** *void*

Defined in: [webrtc/src/media/track.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/media/track.ts#L32)
