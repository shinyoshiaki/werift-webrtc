[**werift**](../README.md)

***

[werift](../globals.md) / RTCPeerConnection

# Class: RTCPeerConnection

W3C compatibility notes kept near the public RTCPeerConnection surface so the
reviewable diff does not depend on external PR text.

- `current/pending*Description`, `canTrickleIceCandidates`, `sctp`,
  `addIceCandidate(null)`, and `RTCConfiguration` round-trip behavior are
  implemented here and covered by `tests/wpt/peerConnectionApiCompatibility.test.ts`.
- `bundlePolicy: "balanced"` is accepted for input compatibility but is
  normalized to werift's `"max-compat"` behavior, so `getConfiguration()`
  returns the normalized value.
- `setLocalDescription()` keeps the historical `SessionDescription` return
  value for non-rollback calls, while `{ type: "rollback" }` resolves `void`
  to match the actual behavior without pretending to return a description.
- API reference markdown is regenerated with `cd packages/webrtc && npm run doc`.
  The generated output lives under `packages/webrtc/doc/`; compatibility
  notes remain here and in the package README so review context is visible
  even when generated docs are not committed in the same change.

## Extends

- `EventTarget`

## Constructors

### new RTCPeerConnection()

> **new RTCPeerConnection**(`config`): [`RTCPeerConnection`](RTCPeerConnection.md)

#### Parameters

##### config

[`RTCPeerConnectionConfig`](../type-aliases/RTCPeerConnectionConfig.md) = `{}`

#### Returns

[`RTCPeerConnection`](RTCPeerConnection.md)

#### Overrides

`EventTarget.constructor`

## Properties

### cname

> `readonly` **cname**: `string`

***

### config

> **config**: `Required`\<[`PeerConfig`](../interfaces/PeerConfig.md)\>

***

### connectionStateChange

> `readonly` **connectionStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"disconnected"` \| `"new"` \| `"connected"` \| `"connecting"` \| `"failed"`\]\>

***

### iceConnectionStateChange

> `readonly` **iceConnectionStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"disconnected"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"` \| `"checking"`\]\>

***

### iceGatheringStateChange

> `readonly` **iceGatheringStateChange**: [`Event`](Event.md)\<\[`"complete"` \| `"new"` \| `"gathering"`\]\>

***

### id

> `readonly` **id**: `string`

***

### needRestart

> **needRestart**: `boolean` = `false`

***

### negotiationneeded

> **negotiationneeded**: `boolean` = `false`

***

### onconnectionstatechange?

> `optional` **onconnectionstatechange**: `Callback`

***

### ondatachannel?

> `optional` **ondatachannel**: `CallbackWithValue`\<[`RTCDataChannelEvent`](../interfaces/RTCDataChannelEvent.md)\>

***

### onDataChannel

> `readonly` **onDataChannel**: [`Event`](Event.md)\<\[[`RTCDataChannel`](RTCDataChannel.md)\]\>

***

### onicecandidate?

> `optional` **onicecandidate**: `CallbackWithValue`\<[`RTCPeerConnectionIceEvent`](../interfaces/RTCPeerConnectionIceEvent.md)\>

***

### onIceCandidate

> `readonly` **onIceCandidate**: [`Event`](Event.md)\<\[`undefined` \| [`RTCIceCandidate`](RTCIceCandidate.md)\]\>

***

### onicecandidateerror?

> `optional` **onicecandidateerror**: `CallbackWithValue`\<`any`\>

***

### oniceconnectionstatechange?

> `optional` **oniceconnectionstatechange**: `Callback`

***

### onicegatheringstatechange?

> `optional` **onicegatheringstatechange**: `CallbackWithValue`\<`any`\>

***

### onnegotiationneeded?

> `optional` **onnegotiationneeded**: `CallbackWithValue`\<`any`\>

***

### onNegotiationneeded

> `readonly` **onNegotiationneeded**: [`Event`](Event.md)\<\[\]\>

***

### onRemoteTransceiverAdded

> `readonly` **onRemoteTransceiverAdded**: [`Event`](Event.md)\<\[[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\]\>

***

### onsignalingstatechange?

> `optional` **onsignalingstatechange**: `CallbackWithValue`\<`any`\>

***

### ontrack?

> `optional` **ontrack**: `CallbackWithValue`\<[`RTCTrackEvent`](../interfaces/RTCTrackEvent.md)\>

***

### onTrack

> `readonly` **onTrack**: [`Event`](Event.md)\<\[[`MediaStreamTrack`](MediaStreamTrack.md)\]\>

***

### onTransceiverAdded

> `readonly` **onTransceiverAdded**: [`Event`](Event.md)\<\[[`RTCRtpTransceiver`](RTCRtpTransceiver.md)\]\>

***

### signalingState

> **signalingState**: `"closed"` \| `"stable"` \| `"have-local-offer"` \| `"have-remote-offer"` \| `"have-local-pranswer"` \| `"have-remote-pranswer"` = `"stable"`

***

### signalingStateChange

> `readonly` **signalingStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"stable"` \| `"have-local-offer"` \| `"have-remote-offer"` \| `"have-local-pranswer"` \| `"have-remote-pranswer"`\]\>

***

### captureRejections

> `static` **captureRejections**: `boolean`

Value: [boolean](https://developer.mozilla.org/en-US/docs/Web/JavaScript/Data_structures#Boolean_type)

Change the default `captureRejections` option on all new `EventEmitter` objects.

#### Since

v13.4.0, v12.16.0

#### Inherited from

`EventTarget.captureRejections`

***

### captureRejectionSymbol

> `readonly` `static` **captureRejectionSymbol**: *typeof* [`captureRejectionSymbol`](RTCDataChannel.md#capturerejectionsymbol)

Value: `Symbol.for('nodejs.rejection')`

See how to write a custom `rejection handler`.

#### Since

v13.4.0, v12.16.0

#### Inherited from

`EventTarget.captureRejectionSymbol`

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

`EventTarget.defaultMaxListeners`

***

### errorMonitor

> `readonly` `static` **errorMonitor**: *typeof* [`errorMonitor`](RTCDataChannel.md#errormonitor)

This symbol shall be used to install a listener for only monitoring `'error'` events. Listeners installed using this symbol are called before the regular `'error'` listeners are called.

Installing a listener using this symbol does not change the behavior once an `'error'` event is emitted. Therefore, the process will still crash if no
regular `'error'` listener is installed.

#### Since

v13.6.0, v12.17.0

#### Inherited from

`EventTarget.errorMonitor`

## Accessors

### canTrickleIceCandidates

#### Get Signature

> **get** **canTrickleIceCandidates**(): `null` \| `boolean`

##### Returns

`null` \| `boolean`

***

### connectionState

#### Get Signature

> **get** **connectionState**(): `"closed"` \| `"disconnected"` \| `"new"` \| `"connected"` \| `"connecting"` \| `"failed"`

##### Returns

`"closed"` \| `"disconnected"` \| `"new"` \| `"connected"` \| `"connecting"` \| `"failed"`

***

### currentLocalDescription

#### Get Signature

> **get** **currentLocalDescription**(): `null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### currentRemoteDescription

#### Get Signature

> **get** **currentRemoteDescription**(): `null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### dtlsTransports

#### Get Signature

> **get** **dtlsTransports**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)[]

##### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)[]

***

### extIdUriMap

#### Get Signature

> **get** **extIdUriMap**(): `object`

##### Returns

`object`

***

### iceConnectionState

#### Get Signature

> **get** **iceConnectionState**(): `"closed"` \| `"disconnected"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"` \| `"checking"`

##### Returns

`"closed"` \| `"disconnected"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"` \| `"checking"`

***

### iceGathererState

#### Get Signature

> **get** **iceGathererState**(): `"complete"` \| `"new"` \| `"gathering"`

##### Returns

`"complete"` \| `"new"` \| `"gathering"`

***

### iceGatheringState

#### Get Signature

> **get** **iceGatheringState**(): `"complete"` \| `"new"` \| `"gathering"`

##### Returns

`"complete"` \| `"new"` \| `"gathering"`

***

### iceGeneration

#### Get Signature

> **get** **iceGeneration**(): `number`

##### Returns

`number`

***

### iceTransports

#### Get Signature

> **get** **iceTransports**(): [`RTCIceTransport`](RTCIceTransport.md)[]

##### Returns

[`RTCIceTransport`](RTCIceTransport.md)[]

***

### localDescription

#### Get Signature

> **get** **localDescription**(): `null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### pendingLocalDescription

#### Get Signature

> **get** **pendingLocalDescription**(): `null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### pendingRemoteDescription

#### Get Signature

> **get** **pendingRemoteDescription**(): `null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### remoteDescription

#### Get Signature

> **get** **remoteDescription**(): `null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

##### Returns

`null` \| [`RTCSessionDescription`](RTCSessionDescription.md)

***

### remoteIsBundled

#### Get Signature

> **get** **remoteIsBundled**(): `undefined` \| [`GroupDescription`](GroupDescription.md)

##### Returns

`undefined` \| [`GroupDescription`](GroupDescription.md)

***

### sctp

#### Get Signature

> **get** **sctp**(): `null` \| [`RTCSctpTransport`](RTCSctpTransport.md)

##### Returns

`null` \| [`RTCSctpTransport`](RTCSctpTransport.md)

***

### sctpRemotePort

#### Get Signature

> **get** **sctpRemotePort**(): `undefined` \| `number`

##### Returns

`undefined` \| `number`

***

### sctpTransport

#### Get Signature

> **get** **sctpTransport**(): `undefined` \| [`RTCSctpTransport`](RTCSctpTransport.md)

##### Returns

`undefined` \| [`RTCSctpTransport`](RTCSctpTransport.md)

## Methods

### \[captureRejectionSymbol\]()?

> `optional` **\[captureRejectionSymbol\]**\<`K`\>(`error`, `event`, ...`args`): `void`

#### Type Parameters

• **K**

#### Parameters

##### error

`Error`

##### event

`string` | `symbol`

##### args

...`AnyRest`

#### Returns

`void`

#### Inherited from

`EventTarget.[captureRejectionSymbol]`

***

### addEventListener()

> **addEventListener**(`type`, `listener`, `options`?): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

##### options?

`boolean` | \{ `once`: `boolean`; \}

#### Returns

`void`

#### Inherited from

`EventTarget.addEventListener`

***

### addIceCandidate()

> **addIceCandidate**(`candidateMessage`): `Promise`\<`void`\>

#### Parameters

##### candidateMessage

`null` | [`RTCIceCandidateInit`](../interfaces/RTCIceCandidateInit.md) | [`RTCIceCandidate`](RTCIceCandidate.md)

#### Returns

`Promise`\<`void`\>

***

### addListener()

> **addListener**\<`K`\>(`eventName`, `listener`): `this`

Alias for `emitter.on(eventName, listener)`.

#### Type Parameters

• **K**

#### Parameters

##### eventName

`string` | `symbol`

##### listener

(...`args`) => `void`

#### Returns

`this`

#### Since

v0.1.26

#### Inherited from

`EventTarget.addListener`

***

### addTrack()

> **addTrack**(`track`, `ms`?): [`RTCRtpSender`](RTCRtpSender.md)

#### Parameters

##### track

[`MediaStreamTrack`](MediaStreamTrack.md)

##### ms?

[`MediaStream`](MediaStream.md)

todo impl

#### Returns

[`RTCRtpSender`](RTCRtpSender.md)

***

### addTransceiver()

> **addTransceiver**(`trackOrKind`, `options`): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Parameters

##### trackOrKind

[`Kind`](../type-aliases/Kind.md) | [`MediaStreamTrack`](MediaStreamTrack.md)

##### options

`Partial`\<[`TransceiverOptions`](../interfaces/TransceiverOptions.md)\> = `{}`

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

***

### close()

> **close**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### createAnswer()

> **createAnswer**(): `Promise`\<[`RTCSessionDescription`](RTCSessionDescription.md)\>

#### Returns

`Promise`\<[`RTCSessionDescription`](RTCSessionDescription.md)\>

***

### createDataChannel()

> **createDataChannel**(`label`, `options`): [`RTCDataChannel`](RTCDataChannel.md)

#### Parameters

##### label

`string`

##### options

`Partial`\<\{ `id`: `number`; `maxPacketLifeTime`: `number`; `maxRetransmits`: `number`; `negotiated`: `boolean`; `ordered`: `boolean`; `protocol`: `string`; \}\> = `{}`

#### Returns

[`RTCDataChannel`](RTCDataChannel.md)

***

### createOffer()

> **createOffer**(`__namedParameters`): `Promise`\<[`RTCSessionDescription`](RTCSessionDescription.md)\>

#### Parameters

##### \_\_namedParameters

###### iceRestart?

`boolean`

#### Returns

`Promise`\<[`RTCSessionDescription`](RTCSessionDescription.md)\>

***

### emit()

> **emit**\<`K`\>(`eventName`, ...`args`): `boolean`

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

#### Type Parameters

• **K**

#### Parameters

##### eventName

`string` | `symbol`

##### args

...`AnyRest`

#### Returns

`boolean`

#### Since

v0.1.26

#### Inherited from

`EventTarget.emit`

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

`EventTarget.eventNames`

***

### getConfiguration()

> **getConfiguration**(): `object`

#### Returns

`object`

##### bundlePolicy

> **bundlePolicy**: [`BundlePolicy`](../type-aliases/BundlePolicy.md)

##### certificates

> **certificates**: [`RTCCertificate`](RTCCertificate.md)[]

##### codecs

> **codecs**: `object`

###### codecs.audio

> **audio**: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

###### codecs.video

> **video**: `undefined` \| [`RTCRtpCodecParameters`](RTCRtpCodecParameters.md)[]

##### debug

> **debug**: `object`

###### debug.disableRecvRetransmit?

> `optional` **disableRecvRetransmit**: `boolean`

###### debug.disableSendNack?

> `optional` **disableSendNack**: `boolean`

###### debug.inboundPacketLoss?

> `optional` **inboundPacketLoss**: `number`

%

###### debug.outboundPacketLoss?

> `optional` **outboundPacketLoss**: `number`

%

###### debug.receiverReportDelay?

> `optional` **receiverReportDelay**: `number`

ms

##### dtls

> **dtls**: `object`

###### dtls.keys?

> `optional` **keys**: [`DtlsKeys`](../type-aliases/DtlsKeys.md)

##### ~~forceTurnTCP~~

> **forceTurnTCP**: `boolean`

###### Deprecated

Prefer turn URL transport parameters or turnTransport.

##### headerExtensions

> **headerExtensions**: `object`

###### headerExtensions.audio

> **audio**: `undefined` \| [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

###### headerExtensions.video

> **video**: `undefined` \| [`RTCRtpHeaderExtensionParameters`](RTCRtpHeaderExtensionParameters.md)[]

##### iceAdditionalHostAddresses

> **iceAdditionalHostAddresses**: `undefined` \| `string`[]

##### iceCandidatePoolSize

> **iceCandidatePoolSize**: `number`

##### iceFilterCandidatePair

> **iceFilterCandidatePair**: `undefined` \| (`pair`) => `boolean`

##### iceFilterStunResponse

> **iceFilterStunResponse**: `undefined` \| (`message`, `addr`, `protocol`) => `boolean`

If provided, is called on each STUN request.
Return `true` if a STUN response should be sent, false if it should be skipped.

##### iceInterfaceAddresses

> **iceInterfaceAddresses**: `undefined` \| [`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

##### iceLite

> **iceLite**: `boolean`

Advertise local ICE lite and operate in the controlled role.

##### icePasswordPrefix

> **icePasswordPrefix**: `undefined` \| `string`

##### icePortRange

> **icePortRange**: `undefined` \| \[`number`, `number`\]

##### iceServers

> **iceServers**: `object`[]

##### iceTransportPolicy

> **iceTransportPolicy**: `"relay"` \| `"all"`

##### iceUseIpv4

> **iceUseIpv4**: `boolean`

##### iceUseIpv6

> **iceUseIpv6**: `boolean`

##### iceUseLinkLocalAddress

> **iceUseLinkLocalAddress**: `undefined` \| `boolean`

such as google cloud run

##### maxMessageSize

> **maxMessageSize**: `number`

Advertised local SCTP max-message-size in SDP. Use 0 for unlimited.

##### midSuffix

> **midSuffix**: `boolean`

##### rtcpMuxPolicy

> **rtcpMuxPolicy**: `"require"`

##### turnTlsOptions

> **turnTlsOptions**: `undefined` \| [`TlsConnectionOptions`](../type-aliases/TlsConnectionOptions.md)

##### turnTransport

> **turnTransport**: `undefined` \| `"tcp"` \| `"tls"` \| `"udp"`

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

`EventTarget.getMaxListeners`

***

### getReceivers()

> **getReceivers**(): [`RTCRtpReceiver`](RTCRtpReceiver.md)[]

#### Returns

[`RTCRtpReceiver`](RTCRtpReceiver.md)[]

***

### getSenders()

> **getSenders**(): [`RTCRtpSender`](RTCRtpSender.md)[]

#### Returns

[`RTCRtpSender`](RTCRtpSender.md)[]

***

### getStats()

> **getStats**(`selector`?): `Promise`\<[`RTCStatsReport`](RTCStatsReport.md)\>

#### Parameters

##### selector?

`null` | [`MediaStreamTrack`](MediaStreamTrack.md)

#### Returns

`Promise`\<[`RTCStatsReport`](RTCStatsReport.md)\>

***

### getTransceivers()

> **getTransceivers**(): [`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

#### Returns

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)[]

***

### listenerCount()

> **listenerCount**\<`K`\>(`eventName`, `listener`?): `number`

Returns the number of listeners listening for the event named `eventName`.
If `listener` is provided, it will return how many times the listener is found
in the list of the listeners of the event.

#### Type Parameters

• **K**

#### Parameters

##### eventName

The name of the event being listened for

`string` | `symbol`

##### listener?

`Function`

The event handler function

#### Returns

`number`

#### Since

v3.2.0

#### Inherited from

`EventTarget.listenerCount`

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

• **K**

#### Parameters

##### eventName

`string` | `symbol`

#### Returns

`Function`[]

#### Since

v0.1.26

#### Inherited from

`EventTarget.listeners`

***

### off()

> **off**\<`K`\>(`eventName`, `listener`): `this`

Alias for `emitter.removeListener()`.

#### Type Parameters

• **K**

#### Parameters

##### eventName

`string` | `symbol`

##### listener

(...`args`) => `void`

#### Returns

`this`

#### Since

v10.0.0

#### Inherited from

`EventTarget.off`

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

• **K**

#### Parameters

##### eventName

The name of the event.

`string` | `symbol`

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v0.1.101

#### Inherited from

`EventTarget.on`

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

• **K**

#### Parameters

##### eventName

The name of the event.

`string` | `symbol`

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v0.3.0

#### Inherited from

`EventTarget.once`

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

• **K**

#### Parameters

##### eventName

The name of the event.

`string` | `symbol`

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v6.0.0

#### Inherited from

`EventTarget.prependListener`

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

• **K**

#### Parameters

##### eventName

The name of the event.

`string` | `symbol`

##### listener

(...`args`) => `void`

The callback function

#### Returns

`this`

#### Since

v6.0.0

#### Inherited from

`EventTarget.prependOnceListener`

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

• **K**

#### Parameters

##### eventName

`string` | `symbol`

#### Returns

`Function`[]

#### Since

v9.4.0

#### Inherited from

`EventTarget.rawListeners`

***

### removeAllListeners()

> **removeAllListeners**(`eventName`?): `this`

Removes all listeners, or those of the specified `eventName`.

It is bad practice to remove listeners added elsewhere in the code,
particularly when the `EventEmitter` instance was created by some other
component or module (e.g. sockets or file streams).

Returns a reference to the `EventEmitter`, so that calls can be chained.

#### Parameters

##### eventName?

`string` | `symbol`

#### Returns

`this`

#### Since

v0.1.26

#### Inherited from

`EventTarget.removeAllListeners`

***

### removeEventListener()

> **removeEventListener**(`type`, `listener`): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

#### Returns

`void`

#### Inherited from

`EventTarget.removeEventListener`

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

• **K**

#### Parameters

##### eventName

`string` | `symbol`

##### listener

(...`args`) => `void`

#### Returns

`this`

#### Since

v0.1.26

#### Inherited from

`EventTarget.removeListener`

***

### removeTrack()

> **removeTrack**(`sender`): `void`

#### Parameters

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

#### Returns

`void`

***

### restartIce()

> **restartIce**(): `void`

#### Returns

`void`

***

### setConfiguration()

> **setConfiguration**(`config`): `void`

#### Parameters

##### config

[`RTCPeerConnectionConfig`](../type-aliases/RTCPeerConnectionConfig.md)

#### Returns

`void`

***

### setLocalDescription()

#### Call Signature

> **setLocalDescription**(`sessionDescription`): `Promise`\<`void`\>

##### Parameters

###### sessionDescription

###### type

`"rollback"`

##### Returns

`Promise`\<`void`\>

#### Call Signature

> **setLocalDescription**(`sessionDescription`?): `Promise`\<[`SessionDescription`](SessionDescription.md)\>

##### Parameters

###### sessionDescription?

[`RTCLocalSessionDescriptionInit`](../interfaces/RTCLocalSessionDescriptionInit.md)

##### Returns

`Promise`\<[`SessionDescription`](SessionDescription.md)\>

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

`EventTarget.setMaxListeners`

***

### setRemoteDescription()

> **setRemoteDescription**(`sessionDescription`): `Promise`\<`void`\>

#### Parameters

##### sessionDescription

[`RTCSessionDescriptionInit`](../interfaces/RTCSessionDescriptionInit.md)

#### Returns

`Promise`\<`void`\>

***

### addAbortListener()

> `static` **addAbortListener**(`signal`, `resource`): `Disposable`

**`Experimental`**

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

`EventTarget.addAbortListener`

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

`EventEmitter`\<`DefaultEventMap`\> | `EventTarget`

##### name

`string` | `symbol`

#### Returns

`Function`[]

#### Since

v15.2.0, v14.17.0

#### Inherited from

`EventTarget.getEventListeners`

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

`EventEmitter`\<`DefaultEventMap`\> | `EventTarget`

#### Returns

`number`

#### Since

v19.9.0

#### Inherited from

`EventTarget.getMaxListeners`

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

The event name

`string` | `symbol`

#### Returns

`number`

#### Since

v0.9.12

#### Deprecated

Since v3.2.0 - Use `listenerCount` instead.

#### Inherited from

`EventTarget.listenerCount`

***

### on()

#### Call Signature

> `static` **on**(`emitter`, `eventName`, `options`?): `AsyncIterator`\<`any`[]\>

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

`string` | `symbol`

###### options?

`StaticEventEmitterIteratorOptions`

##### Returns

`AsyncIterator`\<`any`[]\>

An `AsyncIterator` that iterates `eventName` events emitted by the `emitter`

##### Since

v13.6.0, v12.16.0

##### Inherited from

`EventTarget.on`

#### Call Signature

> `static` **on**(`emitter`, `eventName`, `options`?): `AsyncIterator`\<`any`[]\>

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

`EventTarget.on`

***

### once()

#### Call Signature

> `static` **once**(`emitter`, `eventName`, `options`?): `Promise`\<`any`[]\>

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

`string` | `symbol`

###### options?

`StaticEventEmitterOptions`

##### Returns

`Promise`\<`any`[]\>

##### Since

v11.13.0, v10.16.0

##### Inherited from

`EventTarget.once`

#### Call Signature

> `static` **once**(`emitter`, `eventName`, `options`?): `Promise`\<`any`[]\>

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

`EventTarget.once`

***

### setMaxListeners()

> `static` **setMaxListeners**(`n`?, ...`eventTargets`?): `void`

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

##### eventTargets?

...(`EventEmitter`\<`DefaultEventMap`\> \| `EventTarget`)[]

Zero or more {EventTarget} or {EventEmitter} instances. If none are specified, `n` is set as the default max for all newly created {EventTarget} and {EventEmitter}
objects.

#### Returns

`void`

#### Since

v15.4.0

#### Inherited from

`EventTarget.setMaxListeners`
