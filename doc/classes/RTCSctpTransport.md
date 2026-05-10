[**werift**](../README.md)

***

[werift](../globals.md) / RTCSctpTransport

# Class: RTCSctpTransport

## Constructors

### new RTCSctpTransport()

> **new RTCSctpTransport**(`port`, `maxMessageSize`): [`RTCSctpTransport`](RTCSctpTransport.md)

#### Parameters

##### port

`number` = `5000`

##### maxMessageSize

`number` = `DEFAULT_MAX_MESSAGE_SIZE`

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

### getCapabilities()

> **getCapabilities**(): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)

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
