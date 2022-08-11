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

#### Defined in

[packages/rtp/src/srtp/srtp.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/srtp.ts#L6)

## Properties

### config

• **config**: `Config`

#### Defined in

[packages/rtp/src/srtp/srtp.ts:6](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/srtp.ts#L6)

___

### localContext

• **localContext**: `SrtpContext`

#### Inherited from

Session.localContext

#### Defined in

[packages/rtp/src/srtp/session.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/session.ts#L16)

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

#### Defined in

[packages/rtp/src/srtp/session.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/session.ts#L18)

___

### remoteContext

• **remoteContext**: `SrtpContext`

#### Inherited from

Session.remoteContext

#### Defined in

[packages/rtp/src/srtp/session.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/session.ts#L17)

## Methods

### decrypt

▸ **decrypt**(`buf`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/srtp/srtp.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/srtp.ts#L17)

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

#### Defined in

[packages/rtp/src/srtp/srtp.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/srtp.ts#L22)

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

#### Defined in

[packages/rtp/src/srtp/session.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/rtp/src/srtp/session.ts#L22)
