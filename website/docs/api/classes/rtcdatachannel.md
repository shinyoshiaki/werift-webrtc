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
| `parameters` | `RTCDataChannelParameters` | `undefined` |
| `sendOpen` | `boolean` | true |

#### Overrides

[EventTarget](eventtarget.md).[constructor](eventtarget.md#constructor)

#### Defined in

[packages/webrtc/src/dataChannel.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L25)

## Properties

### \_bufferedAmountLowThreshold

• `Private` **\_bufferedAmountLowThreshold**: `number` = 0

#### Defined in

[packages/webrtc/src/dataChannel.ts:25](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L25)

___

### bufferedAmount

• **bufferedAmount**: `number` = 0

#### Defined in

[packages/webrtc/src/dataChannel.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L24)

___

### bufferedAmountLow

• `Readonly` **bufferedAmountLow**: `default`<any[]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L14)

___

### error

• `Readonly` **error**: `default`<[`Error`]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L13)

___

### id

• **id**: `number`

#### Defined in

[packages/webrtc/src/dataChannel.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L21)

___

### isCreatedByRemote

• **isCreatedByRemote**: `boolean` = false

#### Defined in

[packages/webrtc/src/dataChannel.ts:20](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L20)

___

### message

• `Readonly` **message**: `default`<[`string` \| `Buffer`]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L11)

___

### onclose

• `Optional` **onclose**: ``null`` \| () => `void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L16)

___

### onclosing

• `Optional` **onclosing**: ``null`` \| () => `void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L17)

___

### onerror

• `Optional` **onerror**: ``null`` \| (`props`: { `error`: `any`  }) => `void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L19)

___

### onopen

• `Optional` **onopen**: ``null`` \| () => `void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L15)

___

### readyState

• **readyState**: `DCState` = "connecting"

#### Defined in

[packages/webrtc/src/dataChannel.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L22)

___

### sendOpen

• `Readonly` **sendOpen**: `boolean` = true

___

### stateChanged

• `Readonly` **stateChanged**: `default`<[`DCState`]\>

#### Defined in

[packages/webrtc/src/dataChannel.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L10)

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

[packages/webrtc/src/dataChannel.ts:72](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L72)

• `set` **bufferedAmountLowThreshold**(`value`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `value` | `number` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:76](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L76)

___

### label

• `get` **label**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/dataChannel.ts:60](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L60)

___

### maxPacketLifeTime

• `get` **maxPacketLifeTime**(): `undefined` \| `number`

#### Returns

`undefined` \| `number`

#### Defined in

[packages/webrtc/src/dataChannel.ts:56](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L56)

___

### maxRetransmits

• `get` **maxRetransmits**(): `undefined` \| `number`

#### Returns

`undefined` \| `number`

#### Defined in

[packages/webrtc/src/dataChannel.ts:52](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L52)

___

### negotiated

• `get` **negotiated**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/dataChannel.ts:68](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L68)

___

### ordered

• `get` **ordered**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/dataChannel.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L48)

___

### protocol

• `get` **protocol**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/dataChannel.ts:64](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L64)

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

[packages/webrtc/src/dataChannel.ts:110](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L110)

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

[packages/webrtc/src/helper.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/helper.ts#L37)

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

[packages/webrtc/src/dataChannel.ts:125](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L125)

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

[packages/webrtc/src/helper.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/helper.ts#L41)

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

[packages/webrtc/src/dataChannel.ts:121](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L121)

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

[packages/webrtc/src/dataChannel.ts:84](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L84)

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
| `state` | `DCState` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/dataChannel.ts:88](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/dataChannel.ts#L88)

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
