[**werift**](../README.md)

***

[werift](../globals.md) / MediaStreamTrack

# Class: MediaStreamTrack\<K\>

`K` narrows [kind](#kind) (`new MediaStreamTrack({ kind: "audio" })` is a
`MediaStreamTrack<"audio">`), so that an audio track is assignable to typings
that specialize the DOM track by kind (such as `MediaStreamAudioTrack` of
`@types/dom-mediacapture-transform`).

DOM compatibility covers assigning a werift track to the DOM
`MediaStreamTrack` type and the members DOM-typed libraries such as
`mediasoup-client` use; events follow the DOM through
[DomEventTarget](DomEventTarget.md). werift-specific behavior (RTP I/O, `"ended"` on
[stop](#stop), constraints that cannot reconfigure a source) is documented on
each member.

## Extends

- [`DomEventTarget`](DomEventTarget.md)

## Type Parameters

### K

`K` *extends* [`Kind`](../type-aliases/Kind.md) = [`Kind`](../type-aliases/Kind.md)

## Constructors

### Constructor

> **new MediaStreamTrack**\<`K`\>(`props`): `MediaStreamTrack`\<`K`\>

#### Parameters

##### props

`Partial`\<`MediaStreamTrack`\<`K`\>\> & `Pick`\<`MediaStreamTrack`\<`K`\>, `"kind"`\> & `object`

#### Returns

`MediaStreamTrack`\<`K`\>

#### Overrides

[`DomEventTarget`](DomEventTarget.md).[`constructor`](DomEventTarget.md#constructor)

## Properties

### codec?

> `optional` **codec?**: [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)

***

### contentHint

> **contentHint**: `string` = `""`

DOM `contentHint`. Stored only; werift does not change encoding by it.

***

### enabled

> **enabled**: `boolean` = `true`

todo impl

***

### header?

> `optional` **header?**: [`RtpHeader`](RtpHeader.md)

***

### id

> **id**: `string`

Track ID. Defaults to [uuid](#uuid) when not given to the constructor.

***

### kind

> **kind**: `K`

***

### label

> **label**: `string`

***

### muted

> **muted**: `boolean` = `true`

***

### onReceiveRtcp

> `readonly` **onReceiveRtcp**: [`Event`](Event.md)\<\[[`RtcpPacket`](../type-aliases/RtcpPacket.md)\]\>

***

### onReceiveRtp

> `readonly` **onReceiveRtp**: [`Event`](Event.md)\<\[[`RtpPacket`](RtpPacket.md), [`Extensions`](../interfaces/Extensions.md)?, [`RtpReceiveInfo`](../type-aliases/RtpReceiveInfo.md)?\]\>

***

### onSourceChanged

> `readonly` **onSourceChanged**: [`Event`](Event.md)\<\[`Pick`\<[`RtpHeader`](RtpHeader.md), `"sequenceNumber"` \| `"timestamp"`\>\]\>

***

### remote

> **remote**: `boolean` = `false`

***

### rid?

> `optional` **rid?**: `string`

***

### ssrc?

> `optional` **ssrc?**: `number`

mediaSsrc

***

### stopped

> **stopped**: `boolean` = `false`

***

### streamId?

> `optional` **streamId?**: `string`

MediaStream ID

***

### uuid

> `readonly` **uuid**: `string`

***

### captureRejections

> `static` **captureRejections**: `boolean`

Value: [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type)

Change the default `captureRejections` option on all new `EventEmitter` objects.

#### Since

v13.4.0, v12.16.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`captureRejections`](DomEventTarget.md#capturerejections)

***

### captureRejectionSymbol

> `readonly` `static` **captureRejectionSymbol**: *typeof* [`captureRejectionSymbol`](RTCDataChannel.md#capturerejectionsymbol)

Value: `Symbol.for('nodejs.rejection')`

See how to write a custom `rejection handler`.

#### Since

v13.4.0, v12.16.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`captureRejectionSymbol`](DomEventTarget.md#capturerejectionsymbol)

***

### defaultMaxListeners

> `static` **defaultMaxListeners**: `number`

By default, a maximum of `10` listeners can be registered for any single
event. This limit can be changed for individual `EventEmitter` instances
using the `emitter.setMaxListeners(n)` method. To change the default
for _all_`EventEmitter` instances, the `events.defaultMaxListeners` property
can be used. If this value is not a positive number, a `RangeError` is thrown.

Take caution when setting the `events.defaultMaxListeners` because the
change affects _all_ `EventEmitter` instances, including those created before
the change is made. However, calling `emitter.setMaxListeners(n)` still has
precedence over `events.defaultMaxListeners`.

This is not a hard limit. The `EventEmitter` instance will allow
more listeners to be added but will output a trace warning to stderr indicating
that a "possible EventEmitter memory leak" has been detected. For any single
`EventEmitter`, the `emitter.getMaxListeners()` and `emitter.setMaxListeners()` methods can be used to
temporarily avoid this warning:

```js
import { EventEmitter } from 'node:events';
const emitter = new EventEmitter();
emitter.setMaxListeners(emitter.getMaxListeners() + 1);
emitter.once('event', () => {
  // do stuff
  emitter.setMaxListeners(Math.max(emitter.getMaxListeners() - 1, 0));
});
```

The `--trace-warnings` command-line flag can be used to display the
stack trace for such warnings.

The emitted warning can be inspected with `process.on('warning')` and will
have the additional `emitter`, `type`, and `count` properties, referring to
the event emitter instance, the event's name and the number of attached
listeners, respectively.
Its `name` property is set to `'MaxListenersExceededWarning'`.

#### Since

v0.11.2

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`defaultMaxListeners`](DomEventTarget.md#defaultmaxlisteners)

***

### errorMonitor

> `readonly` `static` **errorMonitor**: *typeof* [`errorMonitor`](RTCDataChannel.md#errormonitor)

This symbol shall be used to install a listener for only monitoring `'error'` events. Listeners installed using this symbol are called before the regular `'error'` listeners are called.

Installing a listener using this symbol does not change the behavior once an `'error'` event is emitted. Therefore, the process will still crash if no
regular `'error'` listener is installed.

#### Since

v13.6.0, v12.17.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`errorMonitor`](DomEventTarget.md#errormonitor)

## Accessors

### onended

#### Get Signature

> **get** **onended**(): [`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

DOM `onended`, a listener of `"ended"` at the position where it was first
set (see [DomEventTarget](DomEventTarget.md)). Unlike the DOM, werift also dispatches
`"ended"` when [stop](#stop) is called, once per track.

##### Returns

[`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

#### Set Signature

> **set** **onended**(`handler`): `void`

##### Parameters

###### handler

[`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

##### Returns

`void`

***

### onmute

#### Get Signature

> **get** **onmute**(): [`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

DOM `onmute`. werift does not detect a muted source and never dispatches
`"mute"` itself; the handler runs for a `"mute"` event passed to
`dispatchEvent`.

##### Returns

[`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

#### Set Signature

> **set** **onmute**(`handler`): `void`

##### Parameters

###### handler

[`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

##### Returns

`void`

***

### onunmute

#### Get Signature

> **get** **onunmute**(): [`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

DOM `onunmute`. werift changes [muted](#muted) on the first received media
packet without dispatching `"unmute"`; the handler runs for an `"unmute"`
event passed to `dispatchEvent`.

##### Returns

[`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

#### Set Signature

> **set** **onunmute**(`handler`): `void`

##### Parameters

###### handler

[`WeriftEventHandler`](../type-aliases/WeriftEventHandler.md)

##### Returns

`void`

***

### readyState

#### Get Signature

> **get** **readyState**(): `"live"` \| `"ended"`

##### Returns

`"live"` \| `"ended"`

## Methods

### \[captureRejectionSymbol\]()?

> `optional` **\[captureRejectionSymbol\]**\<`K`\>(`error`, `event`, ...`args`): `void`

#### Type Parameters

##### K

`K`

#### Parameters

##### error

`Error`

##### event

`string` \| `symbol`

##### args

...`AnyRest`

#### Returns

`void`

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`[captureRejectionSymbol]`](DomEventTarget.md#capturerejectionsymbol-1)

***

### addEventListener()

> **addEventListener**(`type`, `callback`, `options?`): `void`

#### Parameters

##### type

`string`

##### callback

[`WeriftEventListener`](../type-aliases/WeriftEventListener.md) \| `null` \| `undefined`

##### options?

`boolean` \| [`WeriftAddEventListenerOptions`](../interfaces/WeriftAddEventListenerOptions.md)

#### Returns

`void`

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`addEventListener`](DomEventTarget.md#addeventlistener)

***

### addListener()

> **addListener**\<`K`\>(`eventName`, `listener`): `this`

Alias for `emitter.on(eventName, listener)`.

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

##### listener

(...`args`) => `void`

#### Returns

`this`

#### Since

v0.1.26

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`addListener`](DomEventTarget.md#addlistener)

***

### applyConstraints()

> **applyConstraints**(`constraints?`): `Promise`\<`void`\>

DOM `applyConstraints()`. werift cannot reconfigure a source, so the
current settings are the only possible settings: a required (`exact`)
constraint they do not satisfy rejects with `OverconstrainedError` and
keeps the previous constraints (so does a required constraint on a name werift cannot honor, such as `width`); otherwise the constraints, including such ideal ones, are stored
(see [getConstraints](#getconstraints)) and the settings stay the same. An ended
track is checked against its ended settings ([getSettings](#getsettings)).

#### Parameters

##### constraints?

[`WeriftMediaTrackConstraints`](../interfaces/WeriftMediaTrackConstraints.md) = `{}`

#### Returns

`Promise`\<`void`\>

***

### applyIncomingRtp()

> **applyIncomingRtp**(`packet`, `extensions?`, `info?`): `void`

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

##### extensions?

[`Extensions`](../interfaces/Extensions.md)

##### info?

[`RtpReceiveInfo`](../type-aliases/RtpReceiveInfo.md)

#### Returns

`void`

***

### bindUpstreamStop()

> **bindUpstreamStop**(`stop`): `void`

#### Parameters

##### stop

() => `void`

#### Returns

`void`

***

### clone()

> **clone**(): `MediaStreamTrack`\<`K`\>

#### Returns

`MediaStreamTrack`\<`K`\>

***

### dispatchEvent()

> **dispatchEvent**(`event`): `boolean`

DOM `dispatchEvent()`: `false` only when a cancelable event was canceled.

#### Parameters

##### event

`Event`

#### Returns

`boolean`

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`dispatchEvent`](DomEventTarget.md#dispatchevent)

***

### emit()

> **emit**(`type`, ...`args`): `boolean`

Synchronously calls each of the listeners registered for the event named `eventName`, in the order they were registered, passing the supplied arguments
to each.

Returns `true` if the event had listeners, `false` otherwise.

```js
import { EventEmitter } from 'node:events';
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

#### Parameters

##### type

`string` \| `symbol`

##### args

...`any`[]

#### Returns

`boolean`

#### Since

v0.1.26

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`emit`](DomEventTarget.md#emit)

***

### eventNames()

> **eventNames**(): (`string` \| `symbol`)[]

Returns an array listing the events for which the emitter has registered
listeners. The values in the array are strings or `Symbol`s.

```js
import { EventEmitter } from 'node:events';

const myEE = new EventEmitter();
myEE.on('foo', () => {});
myEE.on('bar', () => {});

const sym = Symbol('symbol');
myEE.on(sym, () => {});

console.log(myEE.eventNames());
// Prints: [ 'foo', 'bar', Symbol(symbol) ]
```

#### Returns

(`string` \| `symbol`)[]

#### Since

v6.0.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`eventNames`](DomEventTarget.md#eventnames)

***

### getCapabilities()

> **getCapabilities**(): [`WeriftMediaTrackCapabilities`](../interfaces/WeriftMediaTrackCapabilities.md)

DOM `getCapabilities()`. werift cannot reconfigure a source, so the only
capabilities are the `deviceId` / `groupId` it was selected by.

#### Returns

[`WeriftMediaTrackCapabilities`](../interfaces/WeriftMediaTrackCapabilities.md)

***

### getConstraints()

> **getConstraints**(): [`WeriftMediaTrackConstraints`](../interfaces/WeriftMediaTrackConstraints.md)

DOM `getConstraints()`: the constraints most recently applied by
`getUserMedia` (limited to the constraints werift understands: `deviceId`,
`groupId`, `mimeType`) or [applyConstraints](#applyconstraints) (kept as given).

#### Returns

[`WeriftMediaTrackConstraints`](../interfaces/WeriftMediaTrackConstraints.md)

***

### getEventHandler()

> `protected` **getEventHandler**\<`H`\>(`type`): `H` \| `null`

The value of the `on<type>` handler attribute.

#### Type Parameters

##### H

`H`

#### Parameters

##### type

`string`

#### Returns

`H` \| `null`

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`getEventHandler`](DomEventTarget.md#geteventhandler)

***

### getMaxListeners()

> **getMaxListeners**(): `number`

Returns the current max listener value for the `EventEmitter` which is either
set by `emitter.setMaxListeners(n)` or defaults to [EventEmitter.defaultMaxListeners](RTCDataChannel.md#defaultmaxlisteners).

#### Returns

`number`

#### Since

v1.0.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`getMaxListeners`](DomEventTarget.md#getmaxlisteners)

***

### getSettings()

> **getSettings**(): [`WeriftMediaTrackSettings`](../interfaces/WeriftMediaTrackSettings.md)

DOM `getSettings()`. A track from the polyfill's `getUserMedia` reports
the `deviceId` / `groupId` / `mimeType` its media register was selected
by; another track reports what its [codec](#codec) tells (`mimeType`, and
`sampleRate` / `channelCount` for audio). An ended track reports only the
inherent `deviceId` / `groupId`, as the DOM does.

#### Returns

[`WeriftMediaTrackSettings`](../interfaces/WeriftMediaTrackSettings.md)

***

### listenerCount()

> **listenerCount**\<`K`\>(`eventName`, `listener?`): `number`

Returns the number of listeners listening for the event named `eventName`.
If `listener` is provided, it will return how many times the listener is found
in the list of the listeners of the event.

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

The name of the event being listened for

##### listener?

`Function`

The event handler function

#### Returns

`number`

#### Since

v3.2.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`listenerCount`](DomEventTarget.md#listenercount)

***

### listeners()

> **listeners**\<`K`\>(`eventName`): `Function`[]

Returns a copy of the array of listeners for the event named `eventName`.

```js
server.on('connection', (stream) => {
  console.log('someone connected!');
});
console.log(util.inspect(server.listeners('connection')));
// Prints: [ [Function] ]
```

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

#### Returns

`Function`[]

#### Since

v0.1.26

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`listeners`](DomEventTarget.md#listeners)

***

### notifySourceChanged()

> **notifySourceChanged**(`header`): `void`

Tell the senders of this track that the RTP written with [writeRtp](#writertp)
now comes from another source (for example a recreated upstream
connection). Each `RTCRtpSender` continues its output sequence number /
timestamp from the last sent packet (timestamp step 1; use
`RTCRtpSender.replaceRTP` to choose the step) and drops queued packets of
the old source. `header` is kept for compatibility and is not used for the
offsets. Without an `RTCRtpSender`, use `RtpTimelineRewriter`.

#### Parameters

##### header

`Pick`\<[`RtpHeader`](RtpHeader.md), `"sequenceNumber"` \| `"timestamp"`\>

#### Returns

`void`

***

### off()

> **off**\<`K`\>(`eventName`, `listener`): `this`

Alias for `emitter.removeListener()`.

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

##### listener

(...`args`) => `void`

#### Returns

`this`

#### Since

v10.0.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`off`](DomEventTarget.md#off)

***

### on()

> **on**\<`K`\>(`eventName`, `listener`): `this`

Adds the `listener` function to the end of the listeners array for the event
named `eventName`. No checks are made to see if the `listener` has already
been added. Multiple calls passing the same combination of `eventName` and
`listener` will result in the `listener` being added, and called, multiple times.

```js
server.on('connection', (stream) => {
  console.log('someone connected!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

By default, event listeners are invoked in the order they are added. The `emitter.prependListener()` method can be used as an alternative to add the
event listener to the beginning of the listeners array.

```js
import { EventEmitter } from 'node:events';
const myEE = new EventEmitter();
myEE.on('foo', () => console.log('a'));
myEE.prependListener('foo', () => console.log('b'));
myEE.emit('foo');
// Prints:
//   b
//   a
```

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

The name of the event.

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v0.1.101

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`on`](DomEventTarget.md#on)

***

### once()

> **once**\<`K`\>(`eventName`, `listener`): `this`

Adds a **one-time** `listener` function for the event named `eventName`. The
next time `eventName` is triggered, this listener is removed and then invoked.

```js
server.once('connection', (stream) => {
  console.log('Ah, we have our first user!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

By default, event listeners are invoked in the order they are added. The `emitter.prependOnceListener()` method can be used as an alternative to add the
event listener to the beginning of the listeners array.

```js
import { EventEmitter } from 'node:events';
const myEE = new EventEmitter();
myEE.once('foo', () => console.log('a'));
myEE.prependOnceListener('foo', () => console.log('b'));
myEE.emit('foo');
// Prints:
//   b
//   a
```

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

The name of the event.

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v0.3.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`once`](DomEventTarget.md#once)

***

### prependListener()

> **prependListener**\<`K`\>(`eventName`, `listener`): `this`

Adds the `listener` function to the _beginning_ of the listeners array for the
event named `eventName`. No checks are made to see if the `listener` has
already been added. Multiple calls passing the same combination of `eventName`
and `listener` will result in the `listener` being added, and called, multiple times.

```js
server.prependListener('connection', (stream) => {
  console.log('someone connected!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

The name of the event.

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v6.0.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`prependListener`](DomEventTarget.md#prependlistener)

***

### prependOnceListener()

> **prependOnceListener**\<`K`\>(`eventName`, `listener`): `this`

Adds a **one-time**`listener` function for the event named `eventName` to the _beginning_ of the listeners array. The next time `eventName` is triggered, this
listener is removed, and then invoked.

```js
server.prependOnceListener('connection', (stream) => {
  console.log('Ah, we have our first user!');
});
```

Returns a reference to the `EventEmitter`, so that calls can be chained.

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

The name of the event.

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v6.0.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`prependOnceListener`](DomEventTarget.md#prependoncelistener)

***

### rawListeners()

> **rawListeners**\<`K`\>(`eventName`): `Function`[]

Returns a copy of the array of listeners for the event named `eventName`,
including any wrappers (such as those created by `.once()`).

```js
import { EventEmitter } from 'node:events';
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

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

#### Returns

`Function`[]

#### Since

v9.4.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`rawListeners`](DomEventTarget.md#rawlisteners)

***

### removeAllListeners()

> **removeAllListeners**(`eventName?`): `this`

Removes all listeners, or those of the specified `eventName`.

It is bad practice to remove listeners added elsewhere in the code,
particularly when the `EventEmitter` instance was created by some other
component or module (e.g. sockets or file streams).

Returns a reference to the `EventEmitter`, so that calls can be chained.

#### Parameters

##### eventName?

`string` \| `symbol`

#### Returns

`this`

#### Since

v0.1.26

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`removeAllListeners`](DomEventTarget.md#removealllisteners)

***

### removeEventListener()

> **removeEventListener**(`type`, `callback`, `options?`): `void`

#### Parameters

##### type

`string`

##### callback

[`WeriftEventListener`](../type-aliases/WeriftEventListener.md) \| `null` \| `undefined`

##### options?

`boolean` \| \{ `capture?`: `boolean`; \}

#### Returns

`void`

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`removeEventListener`](DomEventTarget.md#removeeventlistener)

***

### removeListener()

> **removeListener**\<`K`\>(`eventName`, `listener`): `this`

Removes the specified `listener` from the listener array for the event named `eventName`.

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
time of emitting are called in order. This implies that any `removeListener()` or `removeAllListeners()` calls _after_ emitting and _before_ the last listener finishes execution
will not remove them from`emit()` in progress. Subsequent events behave as expected.

```js
import { EventEmitter } from 'node:events';
class MyEmitter extends EventEmitter {}
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
recently added instance. In the example the `once('ping')` listener is removed:

```js
import { EventEmitter } from 'node:events';
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

#### Type Parameters

##### K

`K`

#### Parameters

##### eventName

`string` \| `symbol`

##### listener

(...`args`) => `void`

#### Returns

`this`

#### Since

v0.1.26

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`removeListener`](DomEventTarget.md#removelistener)

***

### setEventHandler()

> `protected` **setEventHandler**(`type`, `handler`): `void`

Set the `on<type>` handler attribute (a non-function value clears it, as the DOM does).

#### Parameters

##### type

`string`

##### handler

`unknown`

#### Returns

`void`

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`setEventHandler`](DomEventTarget.md#seteventhandler)

***

### setMaxListeners()

> **setMaxListeners**(`n`): `this`

By default `EventEmitter`s will print a warning if more than `10` listeners are
added for a particular event. This is a useful default that helps finding
memory leaks. The `emitter.setMaxListeners()` method allows the limit to be
modified for this specific `EventEmitter` instance. The value can be set to `Infinity` (or `0`) to indicate an unlimited number of listeners.

Returns a reference to the `EventEmitter`, so that calls can be chained.

#### Parameters

##### n

`number`

#### Returns

`this`

#### Since

v0.3.5

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`setMaxListeners`](DomEventTarget.md#setmaxlisteners)

***

### stop()

> **stop**(): `void`

#### Returns

`void`

***

### stopMediaSource()

> **stopMediaSource**(): `void`

#### Returns

`void`

***

### writeRtcp()

> **writeRtcp**(`rtcp`): `void`

#### Parameters

##### rtcp

[`RtcpPacket`](../type-aliases/RtcpPacket.md)

#### Returns

`void`

***

### writeRtp()

> **writeRtp**(`rtp`): `void`

#### Parameters

##### rtp

`Buffer`\<`ArrayBufferLike`\> \| [`RtpPacket`](RtpPacket.md)

#### Returns

`void`

***

### addAbortListener()

> `static` **addAbortListener**(`signal`, `resource`): `Disposable`

Listens once to the `abort` event on the provided `signal`.

Listening to the `abort` event on abort signals is unsafe and may
lead to resource leaks since another third party with the signal can
call `e.stopImmediatePropagation()`. Unfortunately Node.js cannot change
this since it would violate the web standard. Additionally, the original
API makes it easy to forget to remove listeners.

This API allows safely using `AbortSignal`s in Node.js APIs by solving these
two issues by listening to the event such that `stopImmediatePropagation` does
not prevent the listener from running.

Returns a disposable so that it may be unsubscribed from more easily.

```js
import { addAbortListener } from 'node:events';

function example(signal) {
  let disposable;
  try {
    signal.addEventListener('abort', (e) => e.stopImmediatePropagation());
    disposable = addAbortListener(signal, (e) => {
      // Do something when signal is aborted.
    });
  } finally {
    disposable?.[Symbol.dispose]();
  }
}
```

#### Parameters

##### signal

`AbortSignal`

##### resource

(`event`) => `void`

#### Returns

`Disposable`

Disposable that removes the `abort` listener.

#### Since

v20.5.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`addAbortListener`](DomEventTarget.md#addabortlistener)

***

### getEventListeners()

> `static` **getEventListeners**(`emitter`, `name`): `Function`[]

Returns a copy of the array of listeners for the event named `eventName`.

For `EventEmitter`s this behaves exactly the same as calling `.listeners` on
the emitter.

For `EventTarget`s this is the only way to get the event listeners for the
event target. This is useful for debugging and diagnostic purposes.

```js
import { getEventListeners, EventEmitter } from 'node:events';

{
  const ee = new EventEmitter();
  const listener = () => console.log('Events are fun');
  ee.on('foo', listener);
  console.log(getEventListeners(ee, 'foo')); // [ [Function: listener] ]
}
{
  const et = new EventTarget();
  const listener = () => console.log('Events are fun');
  et.addEventListener('foo', listener);
  console.log(getEventListeners(et, 'foo')); // [ [Function: listener] ]
}
```

#### Parameters

##### emitter

`EventEmitter`\<`DefaultEventMap`\> \| `EventTarget`

##### name

`string` \| `symbol`

#### Returns

`Function`[]

#### Since

v15.2.0, v14.17.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`getEventListeners`](DomEventTarget.md#geteventlisteners)

***

### getMaxListeners()

> `static` **getMaxListeners**(`emitter`): `number`

Returns the currently set max amount of listeners.

For `EventEmitter`s this behaves exactly the same as calling `.getMaxListeners` on
the emitter.

For `EventTarget`s this is the only way to get the max event listeners for the
event target. If the number of event handlers on a single EventTarget exceeds
the max set, the EventTarget will print a warning.

```js
import { getMaxListeners, setMaxListeners, EventEmitter } from 'node:events';

{
  const ee = new EventEmitter();
  console.log(getMaxListeners(ee)); // 10
  setMaxListeners(11, ee);
  console.log(getMaxListeners(ee)); // 11
}
{
  const et = new EventTarget();
  console.log(getMaxListeners(et)); // 10
  setMaxListeners(11, et);
  console.log(getMaxListeners(et)); // 11
}
```

#### Parameters

##### emitter

`EventEmitter`\<`DefaultEventMap`\> \| `EventTarget`

#### Returns

`number`

#### Since

v19.9.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`getMaxListeners`](DomEventTarget.md#getmaxlisteners-1)

***

### ~~listenerCount()~~

> `static` **listenerCount**(`emitter`, `eventName`): `number`

A class method that returns the number of listeners for the given `eventName` registered on the given `emitter`.

```js
import { EventEmitter, listenerCount } from 'node:events';

const myEmitter = new EventEmitter();
myEmitter.on('event', () => {});
myEmitter.on('event', () => {});
console.log(listenerCount(myEmitter, 'event'));
// Prints: 2
```

#### Parameters

##### emitter

`EventEmitter`

The emitter to query

##### eventName

`string` \| `symbol`

The event name

#### Returns

`number`

#### Since

v0.9.12

#### Deprecated

Since v3.2.0 - Use `listenerCount` instead.

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`listenerCount`](DomEventTarget.md#listenercount-1)

***

### on()

#### Call Signature

> `static` **on**(`emitter`, `eventName`, `options?`): `AsyncIterator`\<`any`[]\>

```js
import { on, EventEmitter } from 'node:events';
import process from 'node:process';

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
```

Returns an `AsyncIterator` that iterates `eventName` events. It will throw
if the `EventEmitter` emits `'error'`. It removes all listeners when
exiting the loop. The `value` returned by each iteration is an array
composed of the emitted event arguments.

An `AbortSignal` can be used to cancel waiting on events:

```js
import { on, EventEmitter } from 'node:events';
import process from 'node:process';

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

Use the `close` option to specify an array of event names that will end the iteration:

```js
import { on, EventEmitter } from 'node:events';
import process from 'node:process';

const ee = new EventEmitter();

// Emit later on
process.nextTick(() => {
  ee.emit('foo', 'bar');
  ee.emit('foo', 42);
  ee.emit('close');
});

for await (const event of on(ee, 'foo', { close: ['close'] })) {
  console.log(event); // prints ['bar'] [42]
}
// the loop will exit after 'close' is emitted
console.log('done'); // prints 'done'
```

##### Parameters

###### emitter

`EventEmitter`

###### eventName

`string` \| `symbol`

###### options?

`StaticEventEmitterIteratorOptions`

##### Returns

`AsyncIterator`\<`any`[]\>

An `AsyncIterator` that iterates `eventName` events emitted by the `emitter`

##### Since

v13.6.0, v12.16.0

##### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`on`](DomEventTarget.md#on-1)

#### Call Signature

> `static` **on**(`emitter`, `eventName`, `options?`): `AsyncIterator`\<`any`[]\>

```js
import { on, EventEmitter } from 'node:events';
import process from 'node:process';

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
```

Returns an `AsyncIterator` that iterates `eventName` events. It will throw
if the `EventEmitter` emits `'error'`. It removes all listeners when
exiting the loop. The `value` returned by each iteration is an array
composed of the emitted event arguments.

An `AbortSignal` can be used to cancel waiting on events:

```js
import { on, EventEmitter } from 'node:events';
import process from 'node:process';

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

Use the `close` option to specify an array of event names that will end the iteration:

```js
import { on, EventEmitter } from 'node:events';
import process from 'node:process';

const ee = new EventEmitter();

// Emit later on
process.nextTick(() => {
  ee.emit('foo', 'bar');
  ee.emit('foo', 42);
  ee.emit('close');
});

for await (const event of on(ee, 'foo', { close: ['close'] })) {
  console.log(event); // prints ['bar'] [42]
}
// the loop will exit after 'close' is emitted
console.log('done'); // prints 'done'
```

##### Parameters

###### emitter

`EventTarget`

###### eventName

`string`

###### options?

`StaticEventEmitterIteratorOptions`

##### Returns

`AsyncIterator`\<`any`[]\>

An `AsyncIterator` that iterates `eventName` events emitted by the `emitter`

##### Since

v13.6.0, v12.16.0

##### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`on`](DomEventTarget.md#on-1)

***

### once()

#### Call Signature

> `static` **once**(`emitter`, `eventName`, `options?`): `Promise`\<`any`[]\>

Creates a `Promise` that is fulfilled when the `EventEmitter` emits the given
event or that is rejected if the `EventEmitter` emits `'error'` while waiting.
The `Promise` will resolve with an array of all the arguments emitted to the
given event.

This method is intentionally generic and works with the web platform [EventTarget](https://dom.spec.whatwg.org/#interface-eventtarget) interface, which has no special`'error'` event
semantics and does not listen to the `'error'` event.

```js
import { once, EventEmitter } from 'node:events';
import process from 'node:process';

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
  console.error('error happened', err);
}
```

The special handling of the `'error'` event is only used when `events.once()` is used to wait for another event. If `events.once()` is used to wait for the
'`error'` event itself, then it is treated as any other kind of event without
special handling:

```js
import { EventEmitter, once } from 'node:events';

const ee = new EventEmitter();

once(ee, 'error')
  .then(([err]) => console.log('ok', err.message))
  .catch((err) => console.error('error', err.message));

ee.emit('error', new Error('boom'));

// Prints: ok boom
```

An `AbortSignal` can be used to cancel waiting for the event:

```js
import { EventEmitter, once } from 'node:events';

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

##### Parameters

###### emitter

`EventEmitter`

###### eventName

`string` \| `symbol`

###### options?

`StaticEventEmitterOptions`

##### Returns

`Promise`\<`any`[]\>

##### Since

v11.13.0, v10.16.0

##### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`once`](DomEventTarget.md#once-1)

#### Call Signature

> `static` **once**(`emitter`, `eventName`, `options?`): `Promise`\<`any`[]\>

Creates a `Promise` that is fulfilled when the `EventEmitter` emits the given
event or that is rejected if the `EventEmitter` emits `'error'` while waiting.
The `Promise` will resolve with an array of all the arguments emitted to the
given event.

This method is intentionally generic and works with the web platform [EventTarget](https://dom.spec.whatwg.org/#interface-eventtarget) interface, which has no special`'error'` event
semantics and does not listen to the `'error'` event.

```js
import { once, EventEmitter } from 'node:events';
import process from 'node:process';

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
  console.error('error happened', err);
}
```

The special handling of the `'error'` event is only used when `events.once()` is used to wait for another event. If `events.once()` is used to wait for the
'`error'` event itself, then it is treated as any other kind of event without
special handling:

```js
import { EventEmitter, once } from 'node:events';

const ee = new EventEmitter();

once(ee, 'error')
  .then(([err]) => console.log('ok', err.message))
  .catch((err) => console.error('error', err.message));

ee.emit('error', new Error('boom'));

// Prints: ok boom
```

An `AbortSignal` can be used to cancel waiting for the event:

```js
import { EventEmitter, once } from 'node:events';

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

##### Parameters

###### emitter

`EventTarget`

###### eventName

`string`

###### options?

`StaticEventEmitterOptions`

##### Returns

`Promise`\<`any`[]\>

##### Since

v11.13.0, v10.16.0

##### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`once`](DomEventTarget.md#once-1)

***

### setMaxListeners()

> `static` **setMaxListeners**(`n?`, ...`eventTargets`): `void`

```js
import { setMaxListeners, EventEmitter } from 'node:events';

const target = new EventTarget();
const emitter = new EventEmitter();

setMaxListeners(5, target, emitter);
```

#### Parameters

##### n?

`number`

A non-negative number. The maximum number of listeners per `EventTarget` event.

##### eventTargets

...(`EventEmitter`\<`DefaultEventMap`\> \| `EventTarget`)[]

Zero or more {EventTarget} or {EventEmitter} instances. If none are specified, `n` is set as the default max for all newly created {EventTarget} and {EventEmitter}
objects.

#### Returns

`void`

#### Since

v15.4.0

#### Inherited from

[`DomEventTarget`](DomEventTarget.md).[`setMaxListeners`](DomEventTarget.md#setmaxlisteners-1)
