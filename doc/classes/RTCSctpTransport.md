[werift](../README.md) / [Exports](../modules.md) / RTCSctpTransport

# Class: RTCSctpTransport

## Table of contents

### Constructors

- [constructor](RTCSctpTransport.md#constructor)

### Properties

- [bundled](RTCSctpTransport.md#bundled)
- [dataChannels](RTCSctpTransport.md#datachannels)
- [dtlsTransport](RTCSctpTransport.md#dtlstransport)
- [id](RTCSctpTransport.md#id)
- [mLineIndex](RTCSctpTransport.md#mlineindex)
- [mid](RTCSctpTransport.md#mid)
- [onDataChannel](RTCSctpTransport.md#ondatachannel)
- [port](RTCSctpTransport.md#port)
- [sctp](RTCSctpTransport.md#sctp)

### Methods

- [channelByLabel](RTCSctpTransport.md#channelbylabel)
- [dataChannelAddNegotiated](RTCSctpTransport.md#datachanneladdnegotiated)
- [dataChannelClose](RTCSctpTransport.md#datachannelclose)
- [dataChannelOpen](RTCSctpTransport.md#datachannelopen)
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

## Properties

### bundled

• **bundled**: `boolean` = `false`

___

### dataChannels

• **dataChannels**: `Object` = `{}`

#### Index signature

▪ [key: `number`]: [`RTCDataChannel`](RTCDataChannel.md)

___

### dtlsTransport

• **dtlsTransport**: [`RTCDtlsTransport`](RTCDtlsTransport.md)

___

### id

• `Readonly` **id**: `string`

___

### mLineIndex

• `Optional` **mLineIndex**: `number`

___

### mid

• `Optional` **mid**: `string`

___

### onDataChannel

• `Readonly` **onDataChannel**: `Event`<[[`RTCDataChannel`](RTCDataChannel.md)]\>

___

### port

• **port**: `number` = `5000`

___

### sctp

• **sctp**: `SCTP`

## Methods

### channelByLabel

▸ **channelByLabel**(`label`): `undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `label` | `string` |

#### Returns

`undefined` \| [`RTCDataChannel`](RTCDataChannel.md)

___

### dataChannelAddNegotiated

▸ **dataChannelAddNegotiated**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [`RTCDataChannel`](RTCDataChannel.md) |

#### Returns

`void`

___

### dataChannelClose

▸ **dataChannelClose**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [`RTCDataChannel`](RTCDataChannel.md) |

#### Returns

`void`

___

### dataChannelOpen

▸ **dataChannelOpen**(`channel`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `channel` | [`RTCDataChannel`](RTCDataChannel.md) |

#### Returns

`void`

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

___

### setDtlsTransport

▸ **setDtlsTransport**(`dtlsTransport`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `dtlsTransport` | [`RTCDtlsTransport`](RTCDtlsTransport.md) |

#### Returns

`void`

___

### setRemotePort

▸ **setRemotePort**(`port`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `port` | `number` |

#### Returns

`void`

___

### start

▸ **start**(`remotePort`): `Promise`<`void`\>

#### Parameters

| Name | Type |
| :------ | :------ |
| `remotePort` | `number` |

#### Returns

`Promise`<`void`\>

___

### stop

▸ **stop**(): `Promise`<`void`\>

#### Returns

`Promise`<`void`\>

___

### getCapabilities

▸ `Static` **getCapabilities**(): [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Returns

[`RTCSctpCapabilities`](RTCSctpCapabilities.md)
