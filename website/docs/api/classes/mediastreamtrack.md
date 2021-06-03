---
id: "mediastreamtrack"
title: "Class: MediaStreamTrack"
sidebar_label: "MediaStreamTrack"
sidebar_position: 0
custom_edit_url: null
---

## Hierarchy

- [EventTarget](eventtarget.md)

  ↳ **MediaStreamTrack**

## Constructors

### constructor

• **new MediaStreamTrack**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[MediaStreamTrack](mediastreamtrack.md)\> & `Pick`<[MediaStreamTrack](mediastreamtrack.md), ``"kind"``\> |

#### Overrides

[EventTarget](eventtarget.md).[constructor](eventtarget.md#constructor)

#### Defined in

[packages/webrtc/src/media/track.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L24)

## Properties

### codec

• `Optional` **codec**: [RTCRtpCodecParameters](rtcrtpcodecparameters.md)

#### Defined in

[packages/webrtc/src/media/track.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L17)

___

### enabled

• **enabled**: `boolean` = true

todo impl

#### Defined in

[packages/webrtc/src/media/track.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L19)

___

### header

• `Optional` **header**: [RtpHeader](rtpheader.md)

#### Defined in

[packages/webrtc/src/media/track.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L16)

___

### id

• **id**: `string`

#### Defined in

[packages/webrtc/src/media/track.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L12)

___

### kind

• **kind**: [Kind](../modules.md#kind)

#### Defined in

[packages/webrtc/src/media/track.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L13)

___

### label

• **label**: `string`

#### Defined in

[packages/webrtc/src/media/track.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L11)

___

### muted

• **muted**: `boolean` = true

#### Defined in

[packages/webrtc/src/media/track.ts:24](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L24)

___

### onReceiveRtp

• `Readonly` **onReceiveRtp**: `default`<[[RtpPacket](rtppacket.md)]\>

#### Defined in

[packages/webrtc/src/media/track.ts:21](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L21)

___

### remote

• **remote**: `boolean` = false

#### Defined in

[packages/webrtc/src/media/track.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L10)

___

### rid

• `Optional` **rid**: `string`

#### Defined in

[packages/webrtc/src/media/track.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L15)

___

### ssrc

• `Optional` **ssrc**: `number`

#### Defined in

[packages/webrtc/src/media/track.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L14)

___

### stopped

• **stopped**: `boolean` = false

#### Defined in

[packages/webrtc/src/media/track.ts:23](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L23)

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

## Methods

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

▸ **addListener**(`event`, `listener`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

#### Inherited from

[EventTarget](eventtarget.md).[addListener](eventtarget.md#addlistener)

#### Defined in

node_modules/@types/node/events.d.ts:72

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

▸ **off**(`event`, `listener`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

#### Inherited from

[EventTarget](eventtarget.md).[off](eventtarget.md#off)

#### Defined in

node_modules/@types/node/events.d.ts:76

___

### on

▸ **on**(`event`, `listener`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

#### Inherited from

[EventTarget](eventtarget.md).[on](eventtarget.md#on)

#### Defined in

node_modules/@types/node/events.d.ts:73

___

### once

▸ **once**(`event`, `listener`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

#### Inherited from

[EventTarget](eventtarget.md).[once](eventtarget.md#once)

#### Defined in

node_modules/@types/node/events.d.ts:74

___

### prependListener

▸ **prependListener**(`event`, `listener`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

#### Inherited from

[EventTarget](eventtarget.md).[prependListener](eventtarget.md#prependlistener)

#### Defined in

node_modules/@types/node/events.d.ts:85

___

### prependOnceListener

▸ **prependOnceListener**(`event`, `listener`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

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

▸ **removeAllListeners**(`event?`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event?` | `string` \| `symbol` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

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

▸ **removeListener**(`event`, `listener`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `event` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

#### Inherited from

[EventTarget](eventtarget.md).[removeListener](eventtarget.md#removelistener)

#### Defined in

node_modules/@types/node/events.d.ts:75

___

### setMaxListeners

▸ **setMaxListeners**(`n`): [MediaStreamTrack](mediastreamtrack.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

[MediaStreamTrack](mediastreamtrack.md)

#### Inherited from

[EventTarget](eventtarget.md).[setMaxListeners](eventtarget.md#setmaxlisteners)

#### Defined in

node_modules/@types/node/events.d.ts:78

___

### stop

▸ **stop**(): `void`

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/track.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L40)

___

### writeRtp

▸ **writeRtp**(`rtp`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `rtp` | `Buffer` \| [RtpPacket](rtppacket.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/track.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/9b072fd/packages/webrtc/src/media/track.ts#L46)

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
