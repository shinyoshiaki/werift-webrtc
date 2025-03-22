[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCSctpTransport

# Class: RTCSctpTransport

## Constructors

### new RTCSctpTransport()

> **new RTCSctpTransport**(`port`): [`RTCSctpTransport`](RTCSctpTransport.md)

#### Parameters

• **port**: `number` = `5000`

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

### mLineIndex?

> `optional` **mLineIndex**: `number`

***

### mid?

> `optional` **mid**: `string`

***

### onDataChannel

> `readonly` **onDataChannel**: [`Event`](Event.md)\<[[`RTCDataChannel`](RTCDataChannel.md)]\>

***

### port

> **port**: `number` = `5000`

***

### sctp

> **sctp**: `SCTP`

## Methods

### channelByLabel()

> **channelByLabel**(`label`): `undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

#### Parameters

• **label**: `string`

#### Returns

`undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

***

### dataChannelAddNegotiated()

> **dataChannelAddNegotiated**(`channel`): `void`

#### Parameters

• **channel**: [`RTCDataChannel`](RTCDataChannel.md)

#### Returns

`void`

***

### dataChannelClose()

> **dataChannelClose**(`channel`): `void`

#### Parameters

• **channel**: [`RTCDataChannel`](RTCDataChannel.md)

#### Returns

`void`

***

### dataChannelOpen()

> **dataChannelOpen**(`channel`): `void`

#### Parameters

• **channel**: [`RTCDataChannel`](RTCDataChannel.md)

#### Returns

`void`

***

### datachannelSend()

> **datachannelSend**(`channel`, `data`): `void`

#### Parameters

• **channel**: [`RTCDataChannel`](RTCDataChannel.md)

• **data**: `string` \| `Buffer`

#### Returns

`void`

***

### setDtlsTransport()

> **setDtlsTransport**(`dtlsTransport`): `void`

#### Parameters

• **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Returns

`void`

***

### setRemotePort()

> **setRemotePort**(`port`): `void`

#### Parameters

• **port**: `number`

#### Returns

`void`

***

### start()

> **start**(`remotePort`): `Promise`\<`void`\>

#### Parameters

• **remotePort**: `number`

#### Returns

`Promise`\<`void`\>

***

### stop()

> **stop**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### getCapabilities()

> `static` **getCapabilities**(): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)
