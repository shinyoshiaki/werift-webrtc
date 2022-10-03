[werift](../README.md) / [Exports](../modules.md) / RTCIceTransport

# Class: RTCIceTransport

## Table of contents

### Constructors

- [constructor](RTCIceTransport.md#constructor)

### Properties

- [connection](RTCIceTransport.md#connection)
- [id](RTCIceTransport.md#id)
- [onStateChange](RTCIceTransport.md#onstatechange)
- [state](RTCIceTransport.md#state)

### Accessors

- [iceGather](RTCIceTransport.md#icegather)
- [role](RTCIceTransport.md#role)

### Methods

- [addRemoteCandidate](RTCIceTransport.md#addremotecandidate)
- [setRemoteParams](RTCIceTransport.md#setremoteparams)
- [start](RTCIceTransport.md#start)
- [stop](RTCIceTransport.md#stop)

## Constructors

### constructor

• **new RTCIceTransport**(`gather`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `gather` | [`RTCIceGatherer`](RTCIceGatherer.md) |

## Properties

### connection

• **connection**: [`Connection`](Connection.md)

___

### id

• `Readonly` **id**: `string`

___

### onStateChange

• `Readonly` **onStateChange**: `Event`<[``"disconnected"`` \| ``"closed"`` \| ``"completed"`` \| ``"new"`` \| ``"connected"`` \| ``"failed"`` \| ``"checking"``]\>

___

### state

• **state**: ``"disconnected"`` \| ``"closed"`` \| ``"completed"`` \| ``"new"`` \| ``"connected"`` \| ``"failed"`` \| ``"checking"`` = `"new"`

## Accessors

### iceGather

• `get` **iceGather**(): [`RTCIceGatherer`](RTCIceGatherer.md)

#### Returns

[`RTCIceGatherer`](RTCIceGatherer.md)

___

### role

• `get` **role**(): ``"controlling"`` \| ``"controlled"``

#### Returns

``"controlling"`` \| ``"controlled"``

## Methods

### addRemoteCandidate

▸ **addRemoteCandidate**(`candidate?`): `undefined` \| `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `candidate?` | [`IceCandidate`](IceCandidate.md) |

#### Returns

`undefined` \| `Promise`<`void`\>

___

### setRemoteParams

▸ **setRemoteParams**(`remoteParameters`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteParameters` | [`RTCIceParameters`](RTCIceParameters.md) |

#### Returns

`void`

___

### start

▸ **start**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>
