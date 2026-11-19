[**werift**](../README.md)

***

[werift](../globals.md) / SrtcpSession

# Class: SrtcpSession

## Extends

- `Session`\<`SrtcpContext`\>

## Constructors

### Constructor

> **new SrtcpSession**(`config`): `SrtcpSession`

#### Parameters

##### config

`Config`

#### Returns

`SrtcpSession`

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

### onData?

> `optional` **onData?**: (`buf`) => `void`

#### Parameters

##### buf

`Buffer`

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

> **decrypt**(`buf`): `Buffer`\<`ArrayBufferLike`\>

#### Parameters

##### buf

`Buffer`

#### Returns

`Buffer`\<`ArrayBufferLike`\>

***

### encrypt()

> **encrypt**(`rawRtcp`): `Buffer`\<`ArrayBufferLike`\>

#### Parameters

##### rawRtcp

`Buffer`

#### Returns

`Buffer`\<`ArrayBufferLike`\>

***

### start()

> **start**(`localMasterKey`, `localMasterSalt`, `remoteMasterKey`, `remoteMasterSalt`, `profile`): `void`

#### Parameters

##### localMasterKey

`Buffer`

##### localMasterSalt

`Buffer`

##### remoteMasterKey

`Buffer`

##### remoteMasterSalt

`Buffer`

##### profile

`number`

#### Returns

`void`

#### Inherited from

`Session.start`
