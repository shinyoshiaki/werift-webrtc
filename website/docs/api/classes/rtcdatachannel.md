---
id: "rtcdatachannel"
title: "Class: RTCDataChannel"
sidebar_label: "RTCDataChannel"
sidebar_position: 0
custom_edit_url: null
---

## Hierarchy

- [EventTarget](eventtarget.md)

  ↳ **RTCDataChannel**

## Constructors

### constructor

• **new RTCDataChannel**(`transport`, `parameters`, `sendOpen?`)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `transport` | [RTCSctpTransport](rtcsctptransport.md) | `undefined` |
| `parameters` | [RTCDataChannelParameters](rtcdatachannelparameters.md) | `undefined` |
| `sendOpen` | `boolean` | true |

#### Overrides

[EventTarget](eventtarget.md).[constructor](eventtarget.md#constructor)

#### Defined in

[packages/webrtc/src/dataChannel.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L27)

## Properties

### \_bufferedAmountLowThreshold

• `Private` **\_bufferedAmountLowThreshold**: `number` = 0

#### Defined in

[packages/webrtc/src/dataChannel.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L27)

___

### bufferedAmount

• **bufferedAmount**: `number` = 0

#### Defined in

[packages/webrtc/src/dataChannel.ts:26](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L26)

___

### bufferedAmountLow

• `Readonly` **bufferedAmountLow**: `default`<any[]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L15)

___

### error

• `Readonly` **error**: `default`<[`Error`]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L14)

___

### id

• **id**: `number`

#### Defined in

[packages/webrtc/src/dataChannel.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L23)

___

### isCreatedByRemote

• **isCreatedByRemote**: `boolean` = false

#### Defined in

[packages/webrtc/src/dataChannel.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L22)

___

### message

• `Readonly` **message**: `default`<[`string` \| `Buffer`]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L12)

___

### onclose

• `Optional` **onclose**: `Callback`

#### Defined in

[packages/webrtc/src/dataChannel.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L17)

___

### onclosing

• `Optional` **onclosing**: `Callback`

#### Defined in

[packages/webrtc/src/dataChannel.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L18)

___

### onerror

• `Optional` **onerror**: `CallbackWithValue`<[RTCErrorEvent](../interfaces/rtcerrorevent.md)\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L21)

___

### onmessage

• `Optional` **onmessage**: `CallbackWithValue`<[MessageEvent](../interfaces/messageevent.md)\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L19)

___

### onopen

• `Optional` **onopen**: `Callback`

#### Defined in

[packages/webrtc/src/dataChannel.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L16)

___

### readyState

• **readyState**: [DCState](../modules.md#dcstate) = "connecting"

#### Defined in

[packages/webrtc/src/dataChannel.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L24)

___

### sendOpen

• `Readonly` **sendOpen**: `boolean` = true

___

### stateChanged

• `Readonly` **stateChanged**: `default`<[[DCState](../modules.md#dcstate)]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L11)

___

### captureRejectionSymbol

▪ `Static` `Readonly` **captureRejectionSymbol**: typeof [captureRejectionSymbol](rtcdatachannel.md#capturerejectionsymbol)

#### Inherited from

[EventTarget](eventtarget.md).[captureRejectionSymbol](eventtarget.md#capturerejectionsymbol)

#### Defined in

node_modules/@types/node/events.d.ts:46

___

### captureRejections

▪ `Static` **captureRejections**: `boolean`

Sets or gets the default captureRejection value for all emitters.

#### Inherited from

[EventTarget](eventtarget.md).[captureRejections](eventtarget.md#capturerejections)

#### Defined in

node_modules/@types/node/events.d.ts:52

___

### defaultMaxListeners

▪ `Static` **defaultMaxListeners**: `number`

#### Inherited from

[EventTarget](eventtarget.md).[defaultMaxListeners](eventtarget.md#defaultmaxlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:53

___

### errorMonitor

▪ `Static` `Readonly` **errorMonitor**: typeof [errorMonitor](rtcdatachannel.md#errormonitor)

This symbol shall be used to install a listener for only monitoring `'error'`
events. Listeners installed using this symbol are called before the regular
`'error'` listeners are called.

Installing a listener using this symbol does not change the behavior once an
`'error'` event is emitted, therefore the process will still crash if no
regular `'error'` listener is installed.

#### Inherited from

[EventTarget](eventtarget.md).[errorMonitor](eventtarget.md#errormonitor)

#### Defined in

node_modules/@types/node/events.d.ts:45

## Accessors

### bufferedAmountLowThreshold

• `get` **bufferedAmountLowThreshold**(): `number`

#### Returns

`number`

#### Defined in

[packages/webrtc/src/dataChannel.ts:74](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L74)

• `set` **bufferedAmountLowThreshold**(`value`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `number` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:78](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L78)

___

### label

• `get` **label**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/dataChannel.ts:62](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L62)

___

### maxPacketLifeTime

• `get` **maxPacketLifeTime**(): `undefined` \| `number`

#### Returns

`undefined` \| `number`

#### Defined in

[packages/webrtc/src/dataChannel.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L58)

___

### maxRetransmits

• `get` **maxRetransmits**(): `undefined` \| `number`

#### Returns

`undefined` \| `number`

#### Defined in

[packages/webrtc/src/dataChannel.ts:54](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L54)

___

### negotiated

• `get` **negotiated**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/dataChannel.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L70)

___

### ordered

• `get` **ordered**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/dataChannel.ts:50](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L50)

___

### protocol

• `get` **protocol**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/dataChannel.ts:66](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L66)

## Methods

### addBufferedAmount

▸ **addBufferedAmount**(`amount`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `amount` | `number` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:112](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L112)

___

### addEventListener

▸ **addEventListener**(`type`, `listener`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | `string` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

`void`

#### Inherited from

[EventTarget](eventtarget.md).[addEventListener](eventtarget.md#addeventlistener)

#### Defined in

[packages/webrtc/src/helper.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L37)

___

### addListener

▸ **addListener**(`event`, `listener`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[addListener](eventtarget.md#addlistener)

#### Defined in

node_modules/@types/node/events.d.ts:72

___

### close

▸ **close**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:127](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L127)

___

### emit

▸ **emit**(`event`, ...`args`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `...args` | `any`[] |

#### Returns

`boolean`

#### Inherited from

[EventTarget](eventtarget.md).[emit](eventtarget.md#emit)

#### Defined in

node_modules/@types/node/events.d.ts:82

___

### eventNames

▸ **eventNames**(): (`string` \| `symbol`)[]

#### Returns

(`string` \| `symbol`)[]

#### Inherited from

[EventTarget](eventtarget.md).[eventNames](eventtarget.md#eventnames)

#### Defined in

node_modules/@types/node/events.d.ts:87

___

### getMaxListeners

▸ **getMaxListeners**(): `number`

#### Returns

`number`

#### Inherited from

[EventTarget](eventtarget.md).[getMaxListeners](eventtarget.md#getmaxlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:79

___

### listenerCount

▸ **listenerCount**(`event`): `number`

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |

#### Returns

`number`

#### Inherited from

[EventTarget](eventtarget.md).[listenerCount](eventtarget.md#listenercount)

#### Defined in

node_modules/@types/node/events.d.ts:83

___

### listeners

▸ **listeners**(`event`): `Function`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

[EventTarget](eventtarget.md).[listeners](eventtarget.md#listeners)

#### Defined in

node_modules/@types/node/events.d.ts:80

___

### off

▸ **off**(`event`, `listener`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[off](eventtarget.md#off)

#### Defined in

node_modules/@types/node/events.d.ts:76

___

### on

▸ **on**(`event`, `listener`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[on](eventtarget.md#on)

#### Defined in

node_modules/@types/node/events.d.ts:73

___

### once

▸ **once**(`event`, `listener`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[once](eventtarget.md#once)

#### Defined in

node_modules/@types/node/events.d.ts:74

___

### prependListener

▸ **prependListener**(`event`, `listener`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[prependListener](eventtarget.md#prependlistener)

#### Defined in

node_modules/@types/node/events.d.ts:85

___

### prependOnceListener

▸ **prependOnceListener**(`event`, `listener`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[prependOnceListener](eventtarget.md#prependoncelistener)

#### Defined in

node_modules/@types/node/events.d.ts:86

___

### rawListeners

▸ **rawListeners**(`event`): `Function`[]

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

[EventTarget](eventtarget.md).[rawListeners](eventtarget.md#rawlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:81

___

### removeAllListeners

▸ **removeAllListeners**(`event?`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event?` | `string` \| `symbol` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[removeAllListeners](eventtarget.md#removealllisteners)

#### Defined in

node_modules/@types/node/events.d.ts:77

___

### removeEventListener

▸ **removeEventListener**(`type`, `listener`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `type` | `string` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

`void`

#### Inherited from

[EventTarget](eventtarget.md).[removeEventListener](eventtarget.md#removeeventlistener)

#### Defined in

[packages/webrtc/src/helper.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/helper.ts#L41)

___

### removeListener

▸ **removeListener**(`event`, `listener`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[removeListener](eventtarget.md#removelistener)

#### Defined in

node_modules/@types/node/events.d.ts:75

___

### send

▸ **send**(`data`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `string` \| `Buffer` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:123](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L123)

___

### setId

▸ **setId**(`id`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `id` | `number` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:86](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L86)

___

### setMaxListeners

▸ **setMaxListeners**(`n`): [RTCDataChannel](rtcdatachannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

[RTCDataChannel](rtcdatachannel.md)

#### Inherited from

[EventTarget](eventtarget.md).[setMaxListeners](eventtarget.md#setmaxlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:78

___

### setReadyState

▸ **setReadyState**(`state`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `state` | [DCState](../modules.md#dcstate) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:90](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/webrtc/src/dataChannel.ts#L90)

___

### getEventListener

▸ `Static` **getEventListener**(`emitter`, `name`): `Function`[]

Returns a list listener for a specific emitter event name.

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `DOMEventTarget` \| `EventEmitter` |
| `name` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

[EventTarget](eventtarget.md).[getEventListener](eventtarget.md#geteventlistener)

#### Defined in

node_modules/@types/node/events.d.ts:34

___

### listenerCount

▸ `Static` **listenerCount**(`emitter`, `event`): `number`

**`deprecated`** since v4.0.0

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `EventEmitter` |
| `event` | `string` \| `symbol` |

#### Returns

`number`

#### Inherited from

[EventTarget](eventtarget.md).[listenerCount](eventtarget.md#listenercount)

#### Defined in

node_modules/@types/node/events.d.ts:30

___

### on

▸ `Static` **on**(`emitter`, `event`, `options?`): `AsyncIterableIterator`<any\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `EventEmitter` |
| `event` | `string` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`AsyncIterableIterator`<any\>

#### Inherited from

[EventTarget](eventtarget.md).[on](eventtarget.md#on)

#### Defined in

node_modules/@types/node/events.d.ts:27

___

### once

▸ `Static` **once**(`emitter`, `event`, `options?`): `Promise`<any[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `NodeEventTarget` |
| `event` | `string` \| `symbol` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`Promise`<any[]\>

#### Inherited from

[EventTarget](eventtarget.md).[once](eventtarget.md#once)

#### Defined in

node_modules/@types/node/events.d.ts:25

▸ `Static` **once**(`emitter`, `event`, `options?`): `Promise`<any[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `DOMEventTarget` |
| `event` | `string` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`Promise`<any[]\>

#### Inherited from

[EventTarget](eventtarget.md).[once](eventtarget.md#once)

#### Defined in

node_modules/@types/node/events.d.ts:26
