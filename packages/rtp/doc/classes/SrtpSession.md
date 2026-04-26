[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / SrtpSession

# Class: SrtpSession

## Extends

- `Session`\<`SrtpContext`\>

## Constructors

### new SrtpSession()

> **new SrtpSession**(`config`): [`SrtpSession`](SrtpSession.md)

#### Parameters

• **config**: `Config`

#### Returns

[`SrtpSession`](SrtpSession.md)

#### Overrides

`Session<SrtpContext>.constructor`

## Properties

### config

> **config**: `Config`

***

### localContext

> **localContext**: `SrtpContext`

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

> **remoteContext**: `SrtpContext`

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

> **encrypt**(`payload`, `header`): `Buffer`

#### Parameters

• **payload**: `Buffer`

• **header**: [`RtpHeader`](RtpHeader.md)

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
