[werift](../README.md) / [Exports](../modules.md) / RTCPeerConnection

# Class: RTCPeerConnection

## Hierarchy

- `EventTarget`

  ↳ **`RTCPeerConnection`**

## Table of contents

### Constructors

- [constructor](RTCPeerConnection.md#constructor)

### Properties

- [cname](RTCPeerConnection.md#cname)
- [config](RTCPeerConnection.md#config)
- [connectionState](RTCPeerConnection.md#connectionstate)
- [connectionStateChange](RTCPeerConnection.md#connectionstatechange)
- [iceConnectionState](RTCPeerConnection.md#iceconnectionstate)
- [iceConnectionStateChange](RTCPeerConnection.md#iceconnectionstatechange)
- [iceGatheringState](RTCPeerConnection.md#icegatheringstate)
- [iceGatheringStateChange](RTCPeerConnection.md#icegatheringstatechange)
- [masterTransportEstablished](RTCPeerConnection.md#mastertransportestablished)
- [negotiationneeded](RTCPeerConnection.md#negotiationneeded)
- [onDataChannel](RTCPeerConnection.md#ondatachannel)
- [onIceCandidate](RTCPeerConnection.md#onicecandidate)
- [onNegotiationneeded](RTCPeerConnection.md#onnegotiationneeded)
- [onRemoteTransceiverAdded](RTCPeerConnection.md#onremotetransceiveradded)
- [onTrack](RTCPeerConnection.md#ontrack)
- [onTransceiverAdded](RTCPeerConnection.md#ontransceiveradded)
- [onconnectionstatechange](RTCPeerConnection.md#onconnectionstatechange)
- [ondatachannel](RTCPeerConnection.md#ondatachannel-1)
- [onicecandidate](RTCPeerConnection.md#onicecandidate-1)
- [onnegotiationneeded](RTCPeerConnection.md#onnegotiationneeded-1)
- [onsignalingstatechange](RTCPeerConnection.md#onsignalingstatechange)
- [ontrack](RTCPeerConnection.md#ontrack-1)
- [sctpRemotePort](RTCPeerConnection.md#sctpremoteport)
- [sctpTransport](RTCPeerConnection.md#sctptransport)
- [signalingState](RTCPeerConnection.md#signalingstate)
- [signalingStateChange](RTCPeerConnection.md#signalingstatechange)
- [transceivers](RTCPeerConnection.md#transceivers)
- [captureRejectionSymbol](RTCPeerConnection.md#capturerejectionsymbol)
- [captureRejections](RTCPeerConnection.md#capturerejections)
- [defaultMaxListeners](RTCPeerConnection.md#defaultmaxlisteners)
- [errorMonitor](RTCPeerConnection.md#errormonitor)

### Accessors

- [dtlsTransports](RTCPeerConnection.md#dtlstransports)
- [iceTransports](RTCPeerConnection.md#icetransports)
- [localDescription](RTCPeerConnection.md#localdescription)
- [remoteDescription](RTCPeerConnection.md#remotedescription)
- [remoteIsBundled](RTCPeerConnection.md#remoteisbundled)

### Methods

- [addEventListener](RTCPeerConnection.md#addeventlistener)
- [addIceCandidate](RTCPeerConnection.md#addicecandidate)
- [addListener](RTCPeerConnection.md#addlistener)
- [addTrack](RTCPeerConnection.md#addtrack)
- [addTransceiver](RTCPeerConnection.md#addtransceiver)
- [buildOfferSdp](RTCPeerConnection.md#buildoffersdp)
- [close](RTCPeerConnection.md#close)
- [createAnswer](RTCPeerConnection.md#createanswer)
- [createDataChannel](RTCPeerConnection.md#createdatachannel)
- [createOffer](RTCPeerConnection.md#createoffer)
- [emit](RTCPeerConnection.md#emit)
- [eventNames](RTCPeerConnection.md#eventnames)
- [getMaxListeners](RTCPeerConnection.md#getmaxlisteners)
- [getReceivers](RTCPeerConnection.md#getreceivers)
- [getSenders](RTCPeerConnection.md#getsenders)
- [getTransceivers](RTCPeerConnection.md#gettransceivers)
- [listenerCount](RTCPeerConnection.md#listenercount)
- [listeners](RTCPeerConnection.md#listeners)
- [off](RTCPeerConnection.md#off)
- [on](RTCPeerConnection.md#on)
- [once](RTCPeerConnection.md#once)
- [prependListener](RTCPeerConnection.md#prependlistener)
- [prependOnceListener](RTCPeerConnection.md#prependoncelistener)
- [rawListeners](RTCPeerConnection.md#rawlisteners)
- [removeAllListeners](RTCPeerConnection.md#removealllisteners)
- [removeEventListener](RTCPeerConnection.md#removeeventlistener)
- [removeListener](RTCPeerConnection.md#removelistener)
- [removeTrack](RTCPeerConnection.md#removetrack)
- [setLocalDescription](RTCPeerConnection.md#setlocaldescription)
- [setMaxListeners](RTCPeerConnection.md#setmaxlisteners)
- [setRemoteDescription](RTCPeerConnection.md#setremotedescription)
- [getEventListeners](RTCPeerConnection.md#geteventlisteners)
- [listenerCount](RTCPeerConnection.md#listenercount-1)
- [on](RTCPeerConnection.md#on-1)
- [once](RTCPeerConnection.md#once-1)
- [setMaxListeners](RTCPeerConnection.md#setmaxlisteners-1)

## Constructors

### constructor

• **new RTCPeerConnection**(`config?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | `Partial`<[`PeerConfig`](../interfaces/PeerConfig.md)\> |

#### Overrides

EventTarget.constructor

## Properties

### cname

• `Readonly` **cname**: `string`

___

### config

• **config**: `Required`<[`PeerConfig`](../interfaces/PeerConfig.md)\>

___

### connectionState

• **connectionState**: ``"disconnected"`` \| ``"closed"`` \| ``"new"`` \| ``"connected"`` \| ``"connecting"`` \| ``"failed"`` = `"new"`

___

### connectionStateChange

• `Readonly` **connectionStateChange**: `Event`<[``"disconnected"`` \| ``"closed"`` \| ``"new"`` \| ``"connected"`` \| ``"connecting"`` \| ``"failed"``]\>

___

### iceConnectionState

• **iceConnectionState**: ``"disconnected"`` \| ``"closed"`` \| ``"completed"`` \| ``"new"`` \| ``"connected"`` \| ``"failed"`` \| ``"checking"`` = `"new"`

___

### iceConnectionStateChange

• `Readonly` **iceConnectionStateChange**: `Event`<[``"disconnected"`` \| ``"closed"`` \| ``"completed"`` \| ``"new"`` \| ``"connected"`` \| ``"failed"`` \| ``"checking"``]\>

___

### iceGatheringState

• **iceGatheringState**: ``"new"`` \| ``"complete"`` \| ``"gathering"`` = `"new"`

___

### iceGatheringStateChange

• `Readonly` **iceGatheringStateChange**: `Event`<[``"new"`` \| ``"complete"`` \| ``"gathering"``]\>

___

### masterTransportEstablished

• **masterTransportEstablished**: `boolean` = `false`

___

### negotiationneeded

• **negotiationneeded**: `boolean` = `false`

___

### onDataChannel

• `Readonly` **onDataChannel**: `Event`<[[`RTCDataChannel`](RTCDataChannel.md)]\>

___

### onIceCandidate

• `Readonly` **onIceCandidate**: `Event`<[[`RTCIceCandidate`](RTCIceCandidate.md)]\>

___

### onNegotiationneeded

• `Readonly` **onNegotiationneeded**: `Event`<[]\>

___

### onRemoteTransceiverAdded

• `Readonly` **onRemoteTransceiverAdded**: `Event`<[[`RTCRtpTransceiver`](RTCRtpTransceiver.md)]\>

___

### onTrack

• `Readonly` **onTrack**: `Event`<[[`MediaStreamTrack`](MediaStreamTrack.md)]\>

___

### onTransceiverAdded

• `Readonly` **onTransceiverAdded**: `Event`<[[`RTCRtpTransceiver`](RTCRtpTransceiver.md)]\>

___

### onconnectionstatechange

• `Optional` **onconnectionstatechange**: `Callback`

___

### ondatachannel

• `Optional` **ondatachannel**: `CallbackWithValue`<[`RTCDataChannelEvent`](../interfaces/RTCDataChannelEvent.md)\>

___

### onicecandidate

• `Optional` **onicecandidate**: `CallbackWithValue`<[`RTCPeerConnectionIceEvent`](../interfaces/RTCPeerConnectionIceEvent.md)\>

___

### onnegotiationneeded

• `Optional` **onnegotiationneeded**: `CallbackWithValue`<`any`\>

___

### onsignalingstatechange

• `Optional` **onsignalingstatechange**: `CallbackWithValue`<`any`\>

___

### ontrack

• `Optional` **ontrack**: `CallbackWithValue`<[`RTCTrackEvent`](../interfaces/RTCTrackEvent.md)\>

___

### sctpRemotePort

• `Optional` **sctpRemotePort**: `number`

___

### sctpTransport

• `Optional` **sctpTransport**: [`RTCSctpTransport`](RTCSctpTransport.md)

___

### signalingState

• **signalingState**: ``"closed"`` \| ``"stable"`` \| ``"have-local-offer"`` \| ``"have-remote-offer"`` \| ``"have-local-pranswer"`` \| ``"have-remote-pranswer"`` = `"stable"`

___

### signalingStateChange

• `Readonly` **signalingStateChange**: `Event`<[``"closed"`` \| ``"stable"`` \| ``"have-local-offer"`` \| ``"have-remote-offer"`` \| ``"have-local-pranswer"`` \| ``"have-remote-pranswer"``]\>

___

### transceivers

• `Readonly` **transceivers**: [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[] = `[]`

___

### captureRejectionSymbol

▪ `Static` `Readonly` **captureRejectionSymbol**: typeof [`captureRejectionSymbol`](RTCDataChannel.md#capturerejectionsymbol)

#### Inherited from

EventTarget.captureRejectionSymbol

___

### captureRejections

▪ `Static` **captureRejections**: `boolean`

Sets or gets the default captureRejection value for all emitters.

#### Inherited from

EventTarget.captureRejections

___

### defaultMaxListeners

▪ `Static` **defaultMaxListeners**: `number`

#### Inherited from

EventTarget.defaultMaxListeners

___

### errorMonitor

▪ `Static` `Readonly` **errorMonitor**: typeof [`errorMonitor`](RTCDataChannel.md#errormonitor)

This symbol shall be used to install a listener for only monitoring `'error'`
events. Listeners installed using this symbol are called before the regular
`'error'` listeners are called.

Installing a listener using this symbol does not change the behavior once an
`'error'` event is emitted, therefore the process will still crash if no
regular `'error'` listener is installed.

#### Inherited from

EventTarget.errorMonitor

## Accessors

### dtlsTransports

• `get` **dtlsTransports**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)[]

#### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)[]

___

### iceTransports

• `get` **iceTransports**(): [`RTCIceTransport`](RTCIceTransport.md)[]

#### Returns

[`RTCIceTransport`](RTCIceTransport.md)[]

___

### localDescription

• `get` **localDescription**(): `undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

#### Returns

`undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

___

### remoteDescription

• `get` **remoteDescription**(): `undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

#### Returns

`undefined` \| [`RTCSessionDescription`](RTCSessionDescription.md)

___

### remoteIsBundled

• `get` **remoteIsBundled**(): `undefined` \| [`GroupDescription`](GroupDescription.md)

#### Returns

`undefined` \| [`GroupDescription`](GroupDescription.md)

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

EventTarget.addEventListener

___

### addIceCandidate

▸ **addIceCandidate**(`candidateMessage`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `candidateMessage` | [`RTCIceCandidate`](RTCIceCandidate.md) |

#### Returns

`Promise`<`void`\>

___

### addListener

▸ **addListener**(`eventName`, `listener`): [`RTCPeerConnection`](RTCPeerConnection.md)

Alias for `emitter.on(eventName, listener)`.

**`Since`**

v0.1.26

#### Parameters

| Name | Type |
| :------ | :------ |
| `eventName` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.addListener

___

### addTrack

▸ **addTrack**(`track`, `ms?`): `RTCRtpSender`

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `track` | [`MediaStreamTrack`](MediaStreamTrack.md) | - |
| `ms?` | [`MediaStream`](MediaStream.md) | todo impl |

#### Returns

`RTCRtpSender`

___

### addTransceiver

▸ **addTransceiver**(`trackOrKind`, `options?`): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `trackOrKind` | [`Kind`](../modules.md#kind) \| [`MediaStreamTrack`](MediaStreamTrack.md) |
| `options` | `Partial`<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> |

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

___

### buildOfferSdp

▸ **buildOfferSdp**(): [`SessionDescription`](SessionDescription.md)

#### Returns

[`SessionDescription`](SessionDescription.md)

___

### close

▸ **close**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### createAnswer

▸ **createAnswer**(): `Promise`<[`RTCSessionDescription`](RTCSessionDescription.md)\>

#### Returns

`Promise`<[`RTCSessionDescription`](RTCSessionDescription.md)\>

___

### createDataChannel

▸ **createDataChannel**(`label`, `options?`): [`RTCDataChannel`](RTCDataChannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `label` | `string` |
| `options` | `Partial`<{ `id?`: `number` ; `maxPacketLifeTime?`: `number` ; `maxRetransmits?`: `number` ; `negotiated`: `boolean` ; `ordered`: `boolean` ; `protocol`: `string`  }\> |

#### Returns

[`RTCDataChannel`](RTCDataChannel.md)

___

### createOffer

▸ **createOffer**(): `Promise`<[`RTCSessionDescription`](RTCSessionDescription.md)\>

#### Returns

`Promise`<[`RTCSessionDescription`](RTCSessionDescription.md)\>

___

### emit

▸ **emit**(`eventName`, ...`args`): `boolean`

Synchronously calls each of the listeners registered for the event named`eventName`, in the order they were registered, passing the supplied arguments
to each.

Returns `true` if the event had listeners, `false` otherwise.

```js
const EventEmitter = require('events');
const myEmitter = new EventEmitter();

// First listener
myEmitter.on('event', function firstListener() {
  console.log('Helloooo! first listener');
});
// Second listener
myEmitter.on('event', function secondListener(arg1, arg2) {
  console.log(`event with parameters ${arg1}, ${arg2} in second listener`);
});
// Third listener
myEmitter.on('event', function thirdListener(...args) {
  const parameters = args.join(', ');
  console.log(`event with parameters ${parameters} in third listener`);
});

console.log(myEmitter.listeners('event'));

myEmitter.emit('event', 1, 2, 3, 4, 5);

// Prints:
// [
//   [Function: firstListener],
//   [Function: secondListener],
//   [Function: thirdListener]
// ]
// Helloooo! first listener
// event with parameters 1, 2 in second listener
// event with parameters 1, 2, 3, 4, 5 in third listener
```

**`Since`**

v0.1.26

#### Parameters

| Name | Type |
| :------ | :------ |
| `eventName` | `string` \| `symbol` |
| `...args` | `any`[] |

#### Returns

`boolean`

#### Inherited from

EventTarget.emit

___

### eventNames

▸ **eventNames**(): (`string` \| `symbol`)[]

Returns an array listing the events for which the emitter has registered
listeners. The values in the array are strings or `Symbol`s.

```js
const EventEmitter = require('events');
const myEE = new EventEmitter();
myEE.on('foo', () => {});
myEE.on('bar', () => {});

const sym = Symbol('symbol');
myEE.on(sym, () => {});

console.log(myEE.eventNames());
// Prints: [ 'foo', 'bar', Symbol(symbol) ]
```

**`Since`**

v6.0.0

#### Returns

(`string` \| `symbol`)[]

#### Inherited from

EventTarget.eventNames

___

### getMaxListeners

▸ **getMaxListeners**(): `number`

Returns the current max listener value for the `EventEmitter` which is either
set by `emitter.setMaxListeners(n)` or defaults to [defaultMaxListeners](RTCPeerConnection.md#defaultmaxlisteners).

**`Since`**

v1.0.0

#### Returns

`number`

#### Inherited from

EventTarget.getMaxListeners

___

### getReceivers

▸ **getReceivers**(): `RTCRtpReceiver`[]

#### Returns

`RTCRtpReceiver`[]

___

### getSenders

▸ **getSenders**(): `RTCRtpSender`[]

#### Returns

`RTCRtpSender`[]

___

### getTransceivers

▸ **getTransceivers**(): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

___

### listenerCount

▸ **listenerCount**(`eventName`): `number`

Returns the number of listeners listening to the event named `eventName`.

**`Since`**

v3.2.0

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` \| `symbol` | The name of the event being listened for |

#### Returns

`number`

#### Inherited from

EventTarget.listenerCount

___

### listeners

▸ **listeners**(`eventName`): `Function`[]

Returns a copy of the array of listeners for the event named `eventName`.

```js
server.on('connection', (stream) => {
  console.log('someone connected!');
});
console.log(util.inspect(server.listeners('connection')));
// Prints: [ [Function] ]
```

**`Since`**

v0.1.26

#### Parameters

| Name | Type |
| :------ | :------ |
| `eventName` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

EventTarget.listeners

___

### off

▸ **off**(`eventName`, `listener`): [`RTCPeerConnection`](RTCPeerConnection.md)

Alias for `emitter.removeListener()`.

**`Since`**

v10.0.0

#### Parameters

| Name | Type |
| :------ | :------ |
| `eventName` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.off

___

### on

▸ **on**(`eventName`, `listener`): [`RTCPeerConnection`](RTCPeerConnection.md)

Adds the `listener` function to the end of the listeners array for the
event named `eventName`. No checks are made to see if the `listener` has
already been added. Multiple calls passing the same combination of `eventName`and `listener` will result in the `listener` being added, and called, multiple
times.

```js
server.on('connection', (stream) => {
  console.log('someone connected!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

By default, event listeners are invoked in the order they are added. The`emitter.prependListener()` method can be used as an alternative to add the
event listener to the beginning of the listeners array.

```js
const myEE = new EventEmitter();
myEE.on('foo', () => console.log('a'));
myEE.prependListener('foo', () => console.log('b'));
myEE.emit('foo');
// Prints:
//   b
//   a
```

**`Since`**

v0.1.101

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` \| `symbol` | The name of the event. |
| `listener` | (...`args`: `any`[]) => `void` | The callback function |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.on

___

### once

▸ **once**(`eventName`, `listener`): [`RTCPeerConnection`](RTCPeerConnection.md)

Adds a **one-time**`listener` function for the event named `eventName`. The
next time `eventName` is triggered, this listener is removed and then invoked.

```js
server.once('connection', (stream) => {
  console.log('Ah, we have our first user!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

By default, event listeners are invoked in the order they are added. The`emitter.prependOnceListener()` method can be used as an alternative to add the
event listener to the beginning of the listeners array.

```js
const myEE = new EventEmitter();
myEE.once('foo', () => console.log('a'));
myEE.prependOnceListener('foo', () => console.log('b'));
myEE.emit('foo');
// Prints:
//   b
//   a
```

**`Since`**

v0.3.0

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` \| `symbol` | The name of the event. |
| `listener` | (...`args`: `any`[]) => `void` | The callback function |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.once

___

### prependListener

▸ **prependListener**(`eventName`, `listener`): [`RTCPeerConnection`](RTCPeerConnection.md)

Adds the `listener` function to the _beginning_ of the listeners array for the
event named `eventName`. No checks are made to see if the `listener` has
already been added. Multiple calls passing the same combination of `eventName`and `listener` will result in the `listener` being added, and called, multiple
times.

```js
server.prependListener('connection', (stream) => {
  console.log('someone connected!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

**`Since`**

v6.0.0

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` \| `symbol` | The name of the event. |
| `listener` | (...`args`: `any`[]) => `void` | The callback function |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.prependListener

___

### prependOnceListener

▸ **prependOnceListener**(`eventName`, `listener`): [`RTCPeerConnection`](RTCPeerConnection.md)

Adds a **one-time**`listener` function for the event named `eventName` to the _beginning_ of the listeners array. The next time `eventName` is triggered, this
listener is removed, and then invoked.

```js
server.prependOnceListener('connection', (stream) => {
  console.log('Ah, we have our first user!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

**`Since`**

v6.0.0

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `eventName` | `string` \| `symbol` | The name of the event. |
| `listener` | (...`args`: `any`[]) => `void` | The callback function |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.prependOnceListener

___

### rawListeners

▸ **rawListeners**(`eventName`): `Function`[]

Returns a copy of the array of listeners for the event named `eventName`,
including any wrappers (such as those created by `.once()`).

```js
const emitter = new EventEmitter();
emitter.once('log', () => console.log('log once'));

// Returns a new Array with a function `onceWrapper` which has a property
// `listener` which contains the original listener bound above
const listeners = emitter.rawListeners('log');
const logFnWrapper = listeners[0];

// Logs "log once" to the console and does not unbind the `once` event
logFnWrapper.listener();

// Logs "log once" to the console and removes the listener
logFnWrapper();

emitter.on('log', () => console.log('log persistently'));
// Will return a new Array with a single function bound by `.on()` above
const newListeners = emitter.rawListeners('log');

// Logs "log persistently" twice
newListeners[0]();
emitter.emit('log');
```

**`Since`**

v9.4.0

#### Parameters

| Name | Type |
| :------ | :------ |
| `eventName` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

EventTarget.rawListeners

___

### removeAllListeners

▸ **removeAllListeners**(`event?`): [`RTCPeerConnection`](RTCPeerConnection.md)

Removes all listeners, or those of the specified `eventName`.

It is bad practice to remove listeners added elsewhere in the code,
particularly when the `EventEmitter` instance was created by some other
component or module (e.g. sockets or file streams).

Returns a reference to the `EventEmitter`, so that calls can be chained.

**`Since`**

v0.1.26

#### Parameters

| Name | Type |
| :------ | :------ |
| `event?` | `string` \| `symbol` |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.removeAllListeners

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

EventTarget.removeEventListener

___

### removeListener

▸ **removeListener**(`eventName`, `listener`): [`RTCPeerConnection`](RTCPeerConnection.md)

Removes the specified `listener` from the listener array for the event named`eventName`.

```js
const callback = (stream) => {
  console.log('someone connected!');
};
server.on('connection', callback);
// ...
server.removeListener('connection', callback);
```

`removeListener()` will remove, at most, one instance of a listener from the
listener array. If any single listener has been added multiple times to the
listener array for the specified `eventName`, then `removeListener()` must be
called multiple times to remove each instance.

Once an event is emitted, all listeners attached to it at the
time of emitting are called in order. This implies that any`removeListener()` or `removeAllListeners()` calls _after_ emitting and _before_ the last listener finishes execution
will not remove them from`emit()` in progress. Subsequent events behave as expected.

```js
const myEmitter = new MyEmitter();

const callbackA = () => {
  console.log('A');
  myEmitter.removeListener('event', callbackB);
};

const callbackB = () => {
  console.log('B');
};

myEmitter.on('event', callbackA);

myEmitter.on('event', callbackB);

// callbackA removes listener callbackB but it will still be called.
// Internal listener array at time of emit [callbackA, callbackB]
myEmitter.emit('event');
// Prints:
//   A
//   B

// callbackB is now removed.
// Internal listener array [callbackA]
myEmitter.emit('event');
// Prints:
//   A
```

Because listeners are managed using an internal array, calling this will
change the position indices of any listener registered _after_ the listener
being removed. This will not impact the order in which listeners are called,
but it means that any copies of the listener array as returned by
the `emitter.listeners()` method will need to be recreated.

When a single function has been added as a handler multiple times for a single
event (as in the example below), `removeListener()` will remove the most
recently added instance. In the example the `once('ping')`listener is removed:

```js
const ee = new EventEmitter();

function pong() {
  console.log('pong');
}

ee.on('ping', pong);
ee.once('ping', pong);
ee.removeListener('ping', pong);

ee.emit('ping');
ee.emit('ping');
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

**`Since`**

v0.1.26

#### Parameters

| Name | Type |
| :------ | :------ |
| `eventName` | `string` \| `symbol` |
| `listener` | (...`args`: `any`[]) => `void` |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.removeListener

___

### removeTrack

▸ **removeTrack**(`sender`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `sender` | `RTCRtpSender` |

#### Returns

`void`

___

### setLocalDescription

▸ **setLocalDescription**(`sessionDescription`): `Promise`<[`SessionDescription`](SessionDescription.md)\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `sessionDescription` | `Object` |
| `sessionDescription.sdp` | `string` |
| `sessionDescription.type` | ``"offer"`` \| ``"answer"`` |

#### Returns

`Promise`<[`SessionDescription`](SessionDescription.md)\>

___

### setMaxListeners

▸ **setMaxListeners**(`n`): [`RTCPeerConnection`](RTCPeerConnection.md)

By default `EventEmitter`s will print a warning if more than `10` listeners are
added for a particular event. This is a useful default that helps finding
memory leaks. The `emitter.setMaxListeners()` method allows the limit to be
modified for this specific `EventEmitter` instance. The value can be set to`Infinity` (or `0`) to indicate an unlimited number of listeners.

Returns a reference to the `EventEmitter`, so that calls can be chained.

**`Since`**

v0.3.5

#### Parameters

| Name | Type |
| :------ | :------ |
| `n` | `number` |

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Inherited from

EventTarget.setMaxListeners

___

### setRemoteDescription

▸ **setRemoteDescription**(`sessionDescription`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `sessionDescription` | `Object` |
| `sessionDescription.sdp` | `string` |
| `sessionDescription.type` | ``"offer"`` \| ``"answer"`` |

#### Returns

`Promise`<`void`\>

___

### getEventListeners

▸ `Static` **getEventListeners**(`emitter`, `name`): `Function`[]

Returns a copy of the array of listeners for the event named `eventName`.

For `EventEmitter`s this behaves exactly the same as calling `.listeners` on
the emitter.

For `EventTarget`s this is the only way to get the event listeners for the
event target. This is useful for debugging and diagnostic purposes.

```js
const { getEventListeners, EventEmitter } = require('events');

{
  const ee = new EventEmitter();
  const listener = () => console.log('Events are fun');
  ee.on('foo', listener);
  getEventListeners(ee, 'foo'); // [listener]
}
{
  const et = new EventTarget();
  const listener = () => console.log('Events are fun');
  et.addEventListener('foo', listener);
  getEventListeners(et, 'foo'); // [listener]
}
```

**`Since`**

v15.2.0, v14.17.0

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `EventEmitter` \| `DOMEventTarget` |
| `name` | `string` \| `symbol` |

#### Returns

`Function`[]

#### Inherited from

EventTarget.getEventListeners

___

### listenerCount

▸ `Static` **listenerCount**(`emitter`, `eventName`): `number`

A class method that returns the number of listeners for the given `eventName`registered on the given `emitter`.

```js
const { EventEmitter, listenerCount } = require('events');
const myEmitter = new EventEmitter();
myEmitter.on('event', () => {});
myEmitter.on('event', () => {});
console.log(listenerCount(myEmitter, 'event'));
// Prints: 2
```

**`Since`**

v0.9.12

**`Deprecated`**

Since v3.2.0 - Use `listenerCount` instead.

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `emitter` | `EventEmitter` | The emitter to query |
| `eventName` | `string` \| `symbol` | The event name |

#### Returns

`number`

#### Inherited from

EventTarget.listenerCount

___

### on

▸ `Static` **on**(`emitter`, `eventName`, `options?`): `AsyncIterableIterator`<`any`\>

```js
const { on, EventEmitter } = require('events');

(async () => {
  const ee = new EventEmitter();

  // Emit later on
  process.nextTick(() => {
    ee.emit('foo', 'bar');
    ee.emit('foo', 42);
  });

  for await (const event of on(ee, 'foo')) {
    // The execution of this inner block is synchronous and it
    // processes one event at a time (even with await). Do not use
    // if concurrent execution is required.
    console.log(event); // prints ['bar'] [42]
  }
  // Unreachable here
})();
```

Returns an `AsyncIterator` that iterates `eventName` events. It will throw
if the `EventEmitter` emits `'error'`. It removes all listeners when
exiting the loop. The `value` returned by each iteration is an array
composed of the emitted event arguments.

An `AbortSignal` can be used to cancel waiting on events:

```js
const { on, EventEmitter } = require('events');
const ac = new AbortController();

(async () => {
  const ee = new EventEmitter();

  // Emit later on
  process.nextTick(() => {
    ee.emit('foo', 'bar');
    ee.emit('foo', 42);
  });

  for await (const event of on(ee, 'foo', { signal: ac.signal })) {
    // The execution of this inner block is synchronous and it
    // processes one event at a time (even with await). Do not use
    // if concurrent execution is required.
    console.log(event); // prints ['bar'] [42]
  }
  // Unreachable here
})();

process.nextTick(() => ac.abort());
```

**`Since`**

v13.6.0, v12.16.0

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `emitter` | `EventEmitter` | - |
| `eventName` | `string` | The name of the event being listened for |
| `options?` | `StaticEventEmitterOptions` | - |

#### Returns

`AsyncIterableIterator`<`any`\>

that iterates `eventName` events emitted by the `emitter`

#### Inherited from

EventTarget.on

___

### once

▸ `Static` **once**(`emitter`, `eventName`, `options?`): `Promise`<`any`[]\>

Creates a `Promise` that is fulfilled when the `EventEmitter` emits the given
event or that is rejected if the `EventEmitter` emits `'error'` while waiting.
The `Promise` will resolve with an array of all the arguments emitted to the
given event.

This method is intentionally generic and works with the web platform [EventTarget](https://dom.spec.whatwg.org/#interface-eventtarget) interface, which has no special`'error'` event
semantics and does not listen to the `'error'` event.

```js
const { once, EventEmitter } = require('events');

async function run() {
  const ee = new EventEmitter();

  process.nextTick(() => {
    ee.emit('myevent', 42);
  });

  const [value] = await once(ee, 'myevent');
  console.log(value);

  const err = new Error('kaboom');
  process.nextTick(() => {
    ee.emit('error', err);
  });

  try {
    await once(ee, 'myevent');
  } catch (err) {
    console.log('error happened', err);
  }
}

run();
```

The special handling of the `'error'` event is only used when `events.once()`is used to wait for another event. If `events.once()` is used to wait for the
'`error'` event itself, then it is treated as any other kind of event without
special handling:

```js
const { EventEmitter, once } = require('events');

const ee = new EventEmitter();

once(ee, 'error')
  .then(([err]) => console.log('ok', err.message))
  .catch((err) => console.log('error', err.message));

ee.emit('error', new Error('boom'));

// Prints: ok boom
```

An `AbortSignal` can be used to cancel waiting for the event:

```js
const { EventEmitter, once } = require('events');

const ee = new EventEmitter();
const ac = new AbortController();

async function foo(emitter, event, signal) {
  try {
    await once(emitter, event, { signal });
    console.log('event emitted!');
  } catch (error) {
    if (error.name === 'AbortError') {
      console.error('Waiting for the event was canceled!');
    } else {
      console.error('There was an error', error.message);
    }
  }
}

foo(ee, 'foo', ac.signal);
ac.abort(); // Abort waiting for the event
ee.emit('foo'); // Prints: Waiting for the event was canceled!
```

**`Since`**

v11.13.0, v10.16.0

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `NodeEventTarget` |
| `eventName` | `string` \| `symbol` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`Promise`<`any`[]\>

#### Inherited from

EventTarget.once

▸ `Static` **once**(`emitter`, `eventName`, `options?`): `Promise`<`any`[]\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `emitter` | `DOMEventTarget` |
| `eventName` | `string` |
| `options?` | `StaticEventEmitterOptions` |

#### Returns

`Promise`<`any`[]\>

#### Inherited from

EventTarget.once

___

### setMaxListeners

▸ `Static` **setMaxListeners**(`n?`, ...`eventTargets`): `void`

```js
const {
  setMaxListeners,
  EventEmitter
} = require('events');

const target = new EventTarget();
const emitter = new EventEmitter();

setMaxListeners(5, target, emitter);
```

**`Since`**

v15.4.0

#### Parameters

| Name | Type | Description |
| :------ | :------ | :------ |
| `n?` | `number` | A non-negative number. The maximum number of listeners per `EventTarget` event. |
| `...eventTargets` | (`EventEmitter` \| `DOMEventTarget`)[] | - |

#### Returns

`void`

#### Inherited from

EventTarget.setMaxListeners
