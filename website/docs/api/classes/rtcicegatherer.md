---
id: "rtcicegatherer"
title: "Class: RTCIceGatherer"
sidebar_label: "RTCIceGatherer"
custom_edit_url: null
hide_title: true
---

# Class: RTCIceGatherer

## Constructors

### constructor

\+ **new RTCIceGatherer**(`options?`: *Partial*<IceOptions\>): [*RTCIceGatherer*](rtcicegatherer.md)

#### Parameters:

Name | Type | Default value |
:------ | :------ | :------ |
`options` | *Partial*<IceOptions\> | {} |

**Returns:** [*RTCIceGatherer*](rtcicegatherer.md)

Defined in: [webrtc/src/transport/ice.ts:102](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L102)

## Properties

### connection

• `Readonly` **connection**: *Connection*

Defined in: [webrtc/src/transport/ice.ts:102](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L102)

___

### gatheringState

• **gatheringState**: *new* \| *gathering* \| *complete*= "new"

Defined in: [webrtc/src/transport/ice.ts:99](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L99)

___

### onGatheringStateChange

• `Readonly` **onGatheringStateChange**: *default*<[*new* \| *gathering* \| *complete*]\>

Defined in: [webrtc/src/transport/ice.ts:101](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L101)

___

### onIceCandidate

• **onIceCandidate**: (`candidate`: *RTCIceCandidate*) => *void*

#### Type declaration:

▸ (`candidate`: *RTCIceCandidate*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`candidate` | *RTCIceCandidate* |

**Returns:** *void*

Defined in: [webrtc/src/transport/ice.ts:98](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L98)

Defined in: [webrtc/src/transport/ice.ts:98](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L98)

## Accessors

### localCandidates

• get **localCandidates**(): *RTCIceCandidate*[]

**Returns:** *RTCIceCandidate*[]

Defined in: [webrtc/src/transport/ice.ts:116](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L116)

___

### localParameters

• get **localParameters**(): *RTCIceParameters*

**Returns:** *RTCIceParameters*

Defined in: [webrtc/src/transport/ice.ts:120](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L120)

## Methods

### gather

▸ **gather**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/ice.ts:106](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L106)

___

### setState

▸ `Private`**setState**(`state`: *new* \| *gathering* \| *complete*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *gathering* \| *complete* |

**Returns:** *void*

Defined in: [webrtc/src/transport/ice.ts:129](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/ice.ts#L129)
