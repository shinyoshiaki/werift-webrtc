---
id: "rtcicetransport"
title: "Class: RTCIceTransport"
sidebar_label: "RTCIceTransport"
custom_edit_url: null
hide_title: true
---

# Class: RTCIceTransport

## Constructors

### constructor

\+ **new RTCIceTransport**(`gather`: [*RTCIceGatherer*](rtcicegatherer.md)): [*RTCIceTransport*](rtcicetransport.md)

#### Parameters:

Name | Type |
:------ | :------ |
`gather` | [*RTCIceGatherer*](rtcicegatherer.md) |

**Returns:** [*RTCIceTransport*](rtcicetransport.md)

Defined in: [webrtc/src/transport/ice.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L12)

## Properties

### connection

• **connection**: *Connection*

Defined in: [webrtc/src/transport/ice.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L6)

___

### onStateChange

• `Readonly` **onStateChange**: *default*<[*new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*]\>

Defined in: [webrtc/src/transport/ice.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L10)

___

### roleSet

• **roleSet**: *boolean*= false

Defined in: [webrtc/src/transport/ice.ts:7](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L7)

___

### state

• **state**: *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*= "new"

Defined in: [webrtc/src/transport/ice.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L8)

___

### waitStart

• `Private` `Optional` **waitStart**: *default*<[]\>

Defined in: [webrtc/src/transport/ice.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L12)

## Accessors

### iceGather

• get **iceGather**(): [*RTCIceGatherer*](rtcicegatherer.md)

**Returns:** [*RTCIceGatherer*](rtcicegatherer.md)

Defined in: [webrtc/src/transport/ice.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L20)

___

### role

• get **role**(): *controlling* \| *controlled*

**Returns:** *controlling* \| *controlled*

Defined in: [webrtc/src/transport/ice.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L24)

## Methods

### addRemoteCandidate

▸ **addRemoteCandidate**(`candidate?`: *RTCIceCandidate*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`candidate?` | *RTCIceCandidate* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/ice.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L44)

___

### setState

▸ `Private`**setState**(`state`: *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *connected* \| *closed* \| *failed* \| *checking* \| *completed* \| *disconnected* |

**Returns:** *void*

Defined in: [webrtc/src/transport/ice.ts:29](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L29)

___

### start

▸ **start**(`remoteParameters`: *RTCIceParameters*): *Promise*<void\>

#### Parameters:

Name | Type |
:------ | :------ |
`remoteParameters` | *RTCIceParameters* |

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/ice.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L54)

___

### stop

▸ **stop**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/ice.ts:75](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/webrtc/src/transport/ice.ts#L75)
