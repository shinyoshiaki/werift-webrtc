[**werift**](../README.md)

***

[werift](../globals.md) / RTCSctpTransport

# Class: RTCSctpTransport

## Constructors

### Constructor

> **new RTCSctpTransport**(`port?`, `maxMessageSize?`, `sctpOptions?`): `RTCSctpTransport`

#### Parameters

##### port?

`number` = `5000`

##### maxMessageSize?

`number` = `DEFAULT_MAX_MESSAGE_SIZE`

##### sctpOptions?

`SCTPOptions` = `{}`

#### Returns

`RTCSctpTransport`

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

> **maxMessageSize**: `number`

***

### mid?

> `optional` **mid?**: `string`

***

### mLineIndex?

> `optional` **mLineIndex?**: `number`

***

### onDataChannel

> `readonly` **onDataChannel**: [`Event`](Event.md)\<\[[`RTCDataChannel`](RTCDataChannel.md)\]\>

***

### onstatechange?

> `optional` **onstatechange?**: () => `void`

#### Returns

`void`

***

### onStateChange

> `readonly` **onStateChange**: [`Event`](Event.md)\<\[[`RTCSctpTransportState`](../type-aliases/RTCSctpTransportState.md)\]\>

***

### port

> **port**: `number`

***

### remoteMaxMessageSize

> **remoteMaxMessageSize**: `number` = `DEFAULT_MAX_MESSAGE_SIZE`

***

### sctp

> **sctp**: `SCTP`

***

### state

> **state**: [`RTCSctpTransportState`](../type-aliases/RTCSctpTransportState.md) = `"connecting"`

`connecting` until the association is established, then `connected`;
`closed` once the association closed (the peer ended it, or the DTLS
transport closed / failed). [RTCSctpTransport.stop](#stop) (e.g.
`RTCPeerConnection.close()`) moves to `closed` without statechange.
A new association (renegotiation) starts again from `connecting`.

## Accessors

### transport

#### Get Signature

> **get** **transport**(): [`RTCDtlsTransport`](RTCDtlsTransport.md)

##### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

## Methods

### addEventListener()

> **addEventListener**(`type`, `listener`, `options?`): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

##### options?

`boolean` \| \{ `once?`: `boolean`; \}

#### Returns

`void`

***

### channelByLabel()

> **channelByLabel**(`label`): [`RTCDataChannel`](RTCDataChannel.md) \| `undefined`

#### Parameters

##### label

`string`

#### Returns

[`RTCDataChannel`](RTCDataChannel.md) \| `undefined`

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

`string` \| `Buffer`\<`ArrayBufferLike`\>

#### Returns

`number`

***

### getCapabilities()

> **getCapabilities**(): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)

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

> **setRemoteMaxMessageSize**(`maxMessageSize?`): `void`

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

> `static` **getCapabilities**(`maxMessageSize?`): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Parameters

##### maxMessageSize?

`number` = `DEFAULT_MAX_MESSAGE_SIZE`

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)
