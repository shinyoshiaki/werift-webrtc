[**werift**](../README.md)

***

[werift](../globals.md) / RTCSctpTransport

# Class: RTCSctpTransport

## Constructors

### new RTCSctpTransport()

> **new RTCSctpTransport**(`port`, `maxMessageSize`, `sctpOptions`): [`RTCSctpTransport`](RTCSctpTransport.md)

#### Parameters

##### port

`number` = `5000`

##### maxMessageSize

`number` = `DEFAULT_MAX_MESSAGE_SIZE`

##### sctpOptions

`SCTPOptions` = `{}`

#### Returns

[`RTCSctpTransport`](RTCSctpTransport.md)

## Properties

### bundled

> **bundled**: `boolean` = `false`

***

### dataChannels

> **dataChannels**: `object` = `{}`

#### Index Signature

\[`key`: `number`\]: [`RTCDataChannel`](RTCDataChannel.md)

***

### dtlsTransport

> **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

***

### id

> `readonly` **id**: `string`

***

### maxMessageSize

> **maxMessageSize**: `number` = `DEFAULT_MAX_MESSAGE_SIZE`

***

### mid?

> `optional` **mid**: `string`

***

### mLineIndex?

> `optional` **mLineIndex**: `number`

***

### onDataChannel

> `readonly` **onDataChannel**: [`Event`](Event.md)\<\[[`RTCDataChannel`](RTCDataChannel.md)\]\>

***

### port

> **port**: `number` = `5000`

***

### remoteMaxMessageSize

> **remoteMaxMessageSize**: `number` = `DEFAULT_MAX_MESSAGE_SIZE`

***

### sctp

> **sctp**: `SCTP`

## Accessors

### associationActive

#### Get Signature

> **get** **associationActive**(): `boolean`

The association left its initial state (started, or established passively).

##### Returns

`boolean`

***

### transport

#### Get Signature

> **get** **transport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

## Methods

### channelByLabel()

> **channelByLabel**(`label`): `undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

#### Parameters

##### label

`string`

#### Returns

`undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

***

### dataChannelAddNegotiated()

> **dataChannelAddNegotiated**(`channel`): `void`

#### Parameters

##### channel

[`RTCDataChannel`](RTCDataChannel.md)

#### Returns

`void`

***

### dataChannelClose()

> **dataChannelClose**(`channel`): `void`

#### Parameters

##### channel

[`RTCDataChannel`](RTCDataChannel.md)

#### Returns

`void`

***

### dataChannelOpen()

> **dataChannelOpen**(`channel`): `void`

#### Parameters

##### channel

[`RTCDataChannel`](RTCDataChannel.md)

#### Returns

`void`

***

### datachannelSend()

> **datachannelSend**(`channel`, `data`): `number`

#### Parameters

##### channel

[`RTCDataChannel`](RTCDataChannel.md)

##### data

`string` | `Buffer`\<`ArrayBufferLike`\>

#### Returns

`number`

***

### ensureStarted()

> **ensureStarted**(`remotePort`): `Promise`\<`void`\>

Idempotent start: an association that is established (also passively,
from the remote INIT), handshaking or closed is not started again, so
no second INIT is sent and the state never moves back.

#### Parameters

##### remotePort

`number`

#### Returns

`Promise`\<`void`\>

***

### getCapabilities()

> **getCapabilities**(): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)

***

### resetAssociation()

> **resetAssociation**(`dtlsTransport`): `Promise`\<`void`\>

Discard the current association (ABORT, attached channels close) and
bind a new, unstarted one (on the same DTLS transport by default).
Channels still waiting for a stream ID stay queued for the next
association.

#### Parameters

##### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md) = `...`

#### Returns

`Promise`\<`void`\>

***

### setDtlsTransport()

> **setDtlsTransport**(`dtlsTransport`): `void`

#### Parameters

##### dtlsTransport

[`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### setRemoteMaxMessageSize()

> **setRemoteMaxMessageSize**(`maxMessageSize`?): `void`

#### Parameters

##### maxMessageSize?

`number`

#### Returns

`void`

***

### setRemotePort()

> **setRemotePort**(`port`): `void`

#### Parameters

##### port

`number`

#### Returns

`void`

***

### start()

> **start**(`remotePort`): `Promise`\<`void`\>

#### Parameters

##### remotePort

`number`

#### Returns

`Promise`\<`void`\>

***

### stop()

> **stop**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### getCapabilities()

> `static` **getCapabilities**(`maxMessageSize`): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Parameters

##### maxMessageSize

`number` = `DEFAULT_MAX_MESSAGE_SIZE`

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)
