---
id: "rtcicegatherer"
title: "Class: RTCIceGatherer"
sidebar_label: "RTCIceGatherer"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RTCIceGatherer**(`options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `Partial`<IceOptions\> |

#### Defined in

[packages/webrtc/src/transport/ice.ts:103](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L103)

## Properties

### connection

• `Readonly` **connection**: `Connection`

#### Defined in

[packages/webrtc/src/transport/ice.ts:103](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L103)

___

### gatheringState

• **gatheringState**: ``"new"`` \| ``"gathering"`` \| ``"complete"`` = "new"

#### Defined in

[packages/webrtc/src/transport/ice.ts:100](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L100)

___

### onGatheringStateChange

• `Readonly` **onGatheringStateChange**: `default`<[``"new"`` \| ``"gathering"`` \| ``"complete"``]\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:102](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L102)

___

### onIceCandidate

• **onIceCandidate**: (`candidate`: [IceCandidate](icecandidate.md)) => `void`

#### Type declaration

▸ (`candidate`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `candidate` | [IceCandidate](icecandidate.md) |

##### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/ice.ts:99](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L99)

## Accessors

### localCandidates

• `get` **localCandidates**(): [IceCandidate](icecandidate.md)[]

#### Returns

[IceCandidate](icecandidate.md)[]

#### Defined in

[packages/webrtc/src/transport/ice.ts:117](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L117)

___

### localParameters

• `get` **localParameters**(): [RTCIceParameters](rtciceparameters.md)

#### Returns

[RTCIceParameters](rtciceparameters.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:121](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L121)

## Methods

### gather

▸ **gather**(): `Promise`<void\>

#### Returns

`Promise`<void\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:107](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L107)

___

### setState

▸ `Private` **setState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"new"`` \| ``"gathering"`` \| ``"complete"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/ice.ts:130](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/ice.ts#L130)
