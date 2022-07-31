[werift](../README.md) / [Exports](../modules.md) / RTCIceGatherer

# Class: RTCIceGatherer

## Table of contents

### Constructors

- [constructor](RTCIceGatherer.md#constructor)

### Properties

- [connection](RTCIceGatherer.md#connection)
- [gatheringState](RTCIceGatherer.md#gatheringstate)
- [onGatheringStateChange](RTCIceGatherer.md#ongatheringstatechange)
- [onIceCandidate](RTCIceGatherer.md#onicecandidate)

### Accessors

- [localCandidates](RTCIceGatherer.md#localcandidates)
- [localParameters](RTCIceGatherer.md#localparameters)

### Methods

- [gather](RTCIceGatherer.md#gather)
- [setState](RTCIceGatherer.md#setstate)

## Constructors

### constructor

• **new RTCIceGatherer**(`options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `Partial`<[`IceOptions`](../interfaces/IceOptions.md)\> |

#### Defined in

[packages/webrtc/src/transport/ice.ts:111](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L111)

## Properties

### connection

• `Readonly` **connection**: [`Connection`](Connection.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:109](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L109)

___

### gatheringState

• **gatheringState**: ``"new"`` \| ``"complete"`` \| ``"gathering"`` = `"new"`

#### Defined in

[packages/webrtc/src/transport/ice.ts:106](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L106)

___

### onGatheringStateChange

• `Readonly` **onGatheringStateChange**: `default`<[``"new"`` \| ``"complete"`` \| ``"gathering"``]\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:108](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L108)

___

### onIceCandidate

• **onIceCandidate**: (`candidate`: [`IceCandidate`](IceCandidate.md)) => `void`

#### Type declaration

▸ (`candidate`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `candidate` | [`IceCandidate`](IceCandidate.md) |

##### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/ice.ts:105](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L105)

## Accessors

### localCandidates

• `get` **localCandidates**(): [`IceCandidate`](IceCandidate.md)[]

#### Returns

[`IceCandidate`](IceCandidate.md)[]

#### Defined in

[packages/webrtc/src/transport/ice.ts:123](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L123)

___

### localParameters

• `get` **localParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

#### Returns

[`RTCIceParameters`](RTCIceParameters.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:127](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L127)

## Methods

### gather

▸ **gather**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:113](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L113)

___

### setState

▸ `Private` **setState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"new"`` \| ``"complete"`` \| ``"gathering"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/ice.ts:136](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L136)
