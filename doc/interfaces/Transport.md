[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / Transport

# Interface: Transport

## Properties

### close()

> **close**: () => `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### onData()

> **onData**: (`data`, `addr`) => `void`

#### Parameters

• **data**: `Buffer`

• **addr**: readonly [`string`, `number`]

#### Returns

`void`

***

### send()

> **send**: (`data`, `addr`) => `Promise`\<`void`\>

#### Parameters

• **data**: `Buffer`

• **addr**: readonly [`string`, `number`]

#### Returns

`Promise`\<`void`\>

***

### type

> **type**: `string`
