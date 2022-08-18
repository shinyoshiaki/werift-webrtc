[werift](../README.md) / [Exports](../modules.md) / SrtpSession

# Class: SrtpSession

## Hierarchy

- `Session`<`SrtpContext`\>

  ↳ **`SrtpSession`**

## Table of contents

### Constructors

- [constructor](SrtpSession.md#constructor)

### Properties

- [config](SrtpSession.md#config)
- [localContext](SrtpSession.md#localcontext)
- [onData](SrtpSession.md#ondata)
- [remoteContext](SrtpSession.md#remotecontext)

### Methods

- [decrypt](SrtpSession.md#decrypt)
- [encrypt](SrtpSession.md#encrypt)
- [start](SrtpSession.md#start)

## Constructors

### constructor

• **new SrtpSession**(`config`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | `Config` |

#### Overrides

Session&lt;SrtpContext\&gt;.constructor

## Properties

### config

• **config**: `Config`

___

### localContext

• **localContext**: `SrtpContext`

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

• **remoteContext**: `SrtpContext`

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

▸ **encrypt**(`payload`, `header`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `header` | [`RtpHeader`](RtpHeader.md) |

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
