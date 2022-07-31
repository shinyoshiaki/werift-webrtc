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
- [waitStart](RTCIceTransport.md#waitstart)

### Accessors

- [iceGather](RTCIceTransport.md#icegather)
- [role](RTCIceTransport.md#role)

### Methods

- [addRemoteCandidate](RTCIceTransport.md#addremotecandidate)
- [setRemoteParams](RTCIceTransport.md#setremoteparams)
- [setState](RTCIceTransport.md#setstate)
- [start](RTCIceTransport.md#start)
- [stop](RTCIceTransport.md#stop)

## Constructors

### constructor

• **new RTCIceTransport**(`gather`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `gather` | [`RTCIceGatherer`](RTCIceGatherer.md) |

#### Defined in

[packages/webrtc/src/transport/ice.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L16)

## Properties

### connection

• **connection**: [`Connection`](Connection.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L9)

___

### id

• `Readonly` **id**: `string`

#### Defined in

[packages/webrtc/src/transport/ice.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L8)

___

### onStateChange

• `Readonly` **onStateChange**: `default`<[``"disconnected"`` \| ``"closed"`` \| ``"completed"`` \| ``"new"`` \| ``"connected"`` \| ``"failed"`` \| ``"checking"``]\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L12)

___

### state

• **state**: ``"disconnected"`` \| ``"closed"`` \| ``"completed"`` \| ``"new"`` \| ``"connected"`` \| ``"failed"`` \| ``"checking"`` = `"new"`

#### Defined in

[packages/webrtc/src/transport/ice.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L10)

___

### waitStart

• `Private` `Optional` **waitStart**: `default`<[]\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L14)

## Accessors

### iceGather

• `get` **iceGather**(): [`RTCIceGatherer`](RTCIceGatherer.md)

#### Returns

[`RTCIceGatherer`](RTCIceGatherer.md)

#### Defined in

[packages/webrtc/src/transport/ice.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L22)

___

### role

• `get` **role**(): ``"controlling"`` \| ``"controlled"``

#### Returns

``"controlling"`` \| ``"controlled"``

#### Defined in

[packages/webrtc/src/transport/ice.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L26)

## Methods

### addRemoteCandidate

▸ **addRemoteCandidate**(`candidate?`): `undefined` \| `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `candidate?` | [`IceCandidate`](IceCandidate.md) |

#### Returns

`undefined` \| `Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L46)

___

### setRemoteParams

▸ **setRemoteParams**(`remoteParameters`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `remoteParameters` | [`RTCIceParameters`](RTCIceParameters.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/ice.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L56)

___

### setState

▸ `Private` **setState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | ``"disconnected"`` \| ``"closed"`` \| ``"completed"`` \| ``"new"`` \| ``"connected"`` \| ``"failed"`` \| ``"checking"`` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/ice.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L31)

___

### start

▸ **start**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L62)

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/ice.ts:82](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/ice.ts#L82)
