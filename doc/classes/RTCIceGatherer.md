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

## Constructors

### constructor

• **new RTCIceGatherer**(`options?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `options` | `Partial`<[`IceOptions`](../interfaces/IceOptions.md)\> |

## Properties

### connection

• `Readonly` **connection**: [`Connection`](Connection.md)

___

### gatheringState

• **gatheringState**: ``"new"`` \| ``"complete"`` \| ``"gathering"`` = `"new"`

___

### onGatheringStateChange

• `Readonly` **onGatheringStateChange**: `default`<[``"new"`` \| ``"complete"`` \| ``"gathering"``]\>

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

## Accessors

### localCandidates

• `get` **localCandidates**(): [`IceCandidate`](IceCandidate.md)[]

#### Returns

[`IceCandidate`](IceCandidate.md)[]

___

### localParameters

• `get` **localParameters**(): [`RTCIceParameters`](RTCIceParameters.md)

#### Returns

[`RTCIceParameters`](RTCIceParameters.md)

## Methods

### gather

▸ **gather**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>
