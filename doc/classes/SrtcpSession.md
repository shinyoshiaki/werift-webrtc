[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / SrtcpSession

# Class: SrtcpSession

## Extends

- `Session`\<`SrtcpContext`\>

## Constructors

### new SrtcpSession()

> **new SrtcpSession**(`config`): [`SrtcpSession`](SrtcpSession.md)

#### Parameters

• **config**: `Config`

#### Returns

[`SrtcpSession`](SrtcpSession.md)

#### Overrides

`Session<SrtcpContext>.constructor`

## Properties

### config

> **config**: `Config`

***

### localContext

> **localContext**: `SrtcpContext`

#### Inherited from

`Session.localContext`

***

### onData()?

> `optional` **onData**: (`buf`) => `void`

#### Parameters

• **buf**: `Buffer`

#### Returns

`void`

#### Inherited from

`Session.onData`

***

### remoteContext

> **remoteContext**: `SrtcpContext`

#### Inherited from

`Session.remoteContext`

## Methods

### decrypt()

> **decrypt**(`buf`): `Buffer`

#### Parameters

• **buf**: `Buffer`

#### Returns

`Buffer`

***

### encrypt()

> **encrypt**(`rawRtcp`): `Buffer`

#### Parameters

• **rawRtcp**: `Buffer`

#### Returns

`Buffer`

***

### start()

> **start**(`localMasterKey`, `localMasterSalt`, `remoteMasterKey`, `remoteMasterSalt`, `profile`): `void`

#### Parameters

• **localMasterKey**: `Buffer`

• **localMasterSalt**: `Buffer`

• **remoteMasterKey**: `Buffer`

• **remoteMasterSalt**: `Buffer`

• **profile**: `number`

#### Returns

`void`

#### Inherited from

`Session.start`
