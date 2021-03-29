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

Name | Type |
:------ | :------ |
`options` | *Partial*<IceOptions\> |

**Returns:** [*RTCIceGatherer*](rtcicegatherer.md)

Defined in: [webrtc/src/transport/ice.ts:99](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L99)

## Properties

### connection

• `Readonly` **connection**: *Connection*

Defined in: [webrtc/src/transport/ice.ts:99](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L99)

___

### gatheringState

• **gatheringState**: *new* \| *gathering* \| *complete*= "new"

Defined in: [webrtc/src/transport/ice.ts:96](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L96)

___

### onGatheringStateChange

• `Readonly` **onGatheringStateChange**: *default*<[*new* \| *gathering* \| *complete*]\>

Defined in: [webrtc/src/transport/ice.ts:98](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L98)

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

Defined in: [webrtc/src/transport/ice.ts:95](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L95)

Defined in: [webrtc/src/transport/ice.ts:95](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L95)

## Accessors

### localCandidates

• get **localCandidates**(): *RTCIceCandidate*[]

**Returns:** *RTCIceCandidate*[]

Defined in: [webrtc/src/transport/ice.ts:113](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L113)

___

### localParameters

• get **localParameters**(): *RTCIceParameters*

**Returns:** *RTCIceParameters*

Defined in: [webrtc/src/transport/ice.ts:117](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L117)

## Methods

### gather

▸ **gather**(): *Promise*<void\>

**Returns:** *Promise*<void\>

Defined in: [webrtc/src/transport/ice.ts:103](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L103)

___

### setState

▸ `Private`**setState**(`state`: *new* \| *gathering* \| *complete*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`state` | *new* \| *gathering* \| *complete* |

**Returns:** *void*

Defined in: [webrtc/src/transport/ice.ts:126](https://github.com/shinyoshiaki/werift-webrtc/blob/92b5725/packages/webrtc/src/transport/ice.ts#L126)
