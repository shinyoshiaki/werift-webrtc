[werift-rtp](../README.md) / [Exports](../modules.md) / SrtcpSession

# Class: SrtcpSession

## Hierarchy

- `Session`\<`SrtcpContext`\>

  ↳ **`SrtcpSession`**

## Table of contents

### Constructors

- [constructor](SrtcpSession.md#constructor)

### Properties

- [config](SrtcpSession.md#config)
- [localContext](SrtcpSession.md#localcontext)
- [onData](SrtcpSession.md#ondata)
- [remoteContext](SrtcpSession.md#remotecontext)

### Methods

- [decrypt](SrtcpSession.md#decrypt)
- [encrypt](SrtcpSession.md#encrypt)
- [start](SrtcpSession.md#start)

## Constructors

### constructor

• **new SrtcpSession**(`config`): [`SrtcpSession`](SrtcpSession.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | `Config` |

#### Returns

[`SrtcpSession`](SrtcpSession.md)

#### Overrides

Session\&lt;SrtcpContext\&gt;.constructor

## Properties

### config

• **config**: `Config`

___

### localContext

• **localContext**: `SrtcpContext`

#### Inherited from

Session.localContext

___

### onData

• `Optional` **onData**: (`buf`: `Buffer`) => `void`

#### Type declaration

▸ (`buf`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

##### Returns

`void`

#### Inherited from

Session.onData

___

### remoteContext

• **remoteContext**: `SrtcpContext`

#### Inherited from

Session.remoteContext

## Methods

### decrypt

▸ **decrypt**(`buf`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`Buffer`

___

### encrypt

▸ **encrypt**(`rawRtcp`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawRtcp` | `Buffer` |

#### Returns

`Buffer`

___

### start

▸ **start**(`localMasterKey`, `localMasterSalt`, `remoteMasterKey`, `remoteMasterSalt`, `profile`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `localMasterKey` | `Buffer` |
| `localMasterSalt` | `Buffer` |
| `remoteMasterKey` | `Buffer` |
| `remoteMasterSalt` | `Buffer` |
| `profile` | `number` |

#### Returns

`void`

#### Inherited from

Session.start
