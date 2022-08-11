[werift](../README.md) / [Exports](../modules.md) / RTCSctpTransport

# Class: RTCSctpTransport

## Table of contents

### Constructors

- [constructor](RTCSctpTransport.md#constructor)

### Properties

- [bundled](RTCSctpTransport.md#bundled)
- [dataChannelId](RTCSctpTransport.md#datachannelid)
- [dataChannelQueue](RTCSctpTransport.md#datachannelqueue)
- [dataChannels](RTCSctpTransport.md#datachannels)
- [dtlsTransport](RTCSctpTransport.md#dtlstransport)
- [eventDisposer](RTCSctpTransport.md#eventdisposer)
- [id](RTCSctpTransport.md#id)
- [mLineIndex](RTCSctpTransport.md#mlineindex)
- [mid](RTCSctpTransport.md#mid)
- [onDataChannel](RTCSctpTransport.md#ondatachannel)
- [port](RTCSctpTransport.md#port)
- [sctp](RTCSctpTransport.md#sctp)

### Accessors

- [isServer](RTCSctpTransport.md#isserver)

### Methods

- [channelByLabel](RTCSctpTransport.md#channelbylabel)
- [dataChannelAddNegotiated](RTCSctpTransport.md#datachanneladdnegotiated)
- [dataChannelClose](RTCSctpTransport.md#datachannelclose)
- [dataChannelFlush](RTCSctpTransport.md#datachannelflush)
- [dataChannelOpen](RTCSctpTransport.md#datachannelopen)
- [datachannelReceive](RTCSctpTransport.md#datachannelreceive)
- [datachannelSend](RTCSctpTransport.md#datachannelsend)
- [setDtlsTransport](RTCSctpTransport.md#setdtlstransport)
- [setRemotePort](RTCSctpTransport.md#setremoteport)
- [start](RTCSctpTransport.md#start)
- [stop](RTCSctpTransport.md#stop)
- [getCapabilities](RTCSctpTransport.md#getcapabilities)

## Constructors

### constructor

• **new RTCSctpTransport**(`port?`)

#### Parameters

| Name | Type | Default value |
| :------ | :------ | :------ |
| `port` | `number` | `5000` |

#### Defined in

[packages/webrtc/src/transport/sctp.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L42)

## Properties

### bundled

• **bundled**: `boolean` = `false`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L35)

___

### dataChannelId

• `Private` `Optional` **dataChannelId**: `number`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L39)

___

### dataChannelQueue

• `Private` **dataChannelQueue**: [[`RTCDataChannel`](RTCDataChannel.md), `number`, `Buffer`][] = `[]`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L38)

___

### dataChannels

• **dataChannels**: `Object` = `{}`

#### Index signature

▪ [key: `number`]: [`RTCDataChannel`](RTCDataChannel.md)

#### Defined in

[packages/webrtc/src/transport/sctp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L36)

___

### dtlsTransport

• **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Defined in

[packages/webrtc/src/transport/sctp.ts:27](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L27)

___

### eventDisposer

• `Private` **eventDisposer**: () => `void`[] = `[]`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L40)

___

### id

• `Readonly` **id**: `string`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L31)

___

### mLineIndex

• `Optional` **mLineIndex**: `number`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L34)

___

### mid

• `Optional` **mid**: `string`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L33)

___

### onDataChannel

• `Readonly` **onDataChannel**: `default`<[[`RTCDataChannel`](RTCDataChannel.md)]\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L30)

___

### port

• **port**: `number` = `5000`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L42)

___

### sctp

• **sctp**: `SCTP`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:28](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L28)

## Accessors

### isServer

• `Private` `get` **isServer**(): `boolean`

#### Returns

`boolean`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:95](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L95)

## Methods

### channelByLabel

▸ **channelByLabel**(`label`): `undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `label` | `string` |

#### Returns

`undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

#### Defined in

[packages/webrtc/src/transport/sctp.ts:99](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L99)

___

### dataChannelAddNegotiated

▸ **dataChannelAddNegotiated**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [`RTCDataChannel`](RTCDataChannel.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:212](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L212)

___

### dataChannelClose

▸ **dataChannelClose**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [`RTCDataChannel`](RTCDataChannel.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:353](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L353)

___

### dataChannelFlush

▸ `Private` **dataChannelFlush**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:269](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L269)

___

### dataChannelOpen

▸ **dataChannelOpen**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [`RTCDataChannel`](RTCDataChannel.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:227](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L227)

___

### datachannelReceive

▸ `Private` **datachannelReceive**(`streamId`, `ppId`, `data`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `streamId` | `number` |
| `ppId` | `number` |
| `data` | `Buffer` |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:103](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L103)

___

### datachannelSend

▸ **datachannelSend**(`channel`, `data`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [`RTCDataChannel`](RTCDataChannel.md) |
| `data` | `string` \| `Buffer` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:313](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L313)

___

### setDtlsTransport

▸ **setDtlsTransport**(`dtlsTransport`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `dtlsTransport` | [`RTCDtlsTransport`](RTCDtlsTransport.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L44)

___

### setRemotePort

▸ **setRemotePort**(`port`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `port` | `number` |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/transport/sctp.ts:333](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L333)

___

### start

▸ **start**(`remotePort`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `remotePort` | `number` |

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:337](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L337)

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

#### Defined in

[packages/webrtc/src/transport/sctp.ts:348](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L348)

___

### getCapabilities

▸ `Static` **getCapabilities**(): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Defined in

[packages/webrtc/src/transport/sctp.ts:329](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/sctp.ts#L329)
