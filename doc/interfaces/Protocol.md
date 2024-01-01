[werift](../README.md) / [Exports](../modules.md) / Protocol

# Interface: Protocol

## Table of contents

### Properties

- [close](Protocol.md#close)
- [connectionMade](Protocol.md#connectionmade)
- [localCandidate](Protocol.md#localcandidate)
- [request](Protocol.md#request)
- [responseAddr](Protocol.md#responseaddr)
- [responseMessage](Protocol.md#responsemessage)
- [sendData](Protocol.md#senddata)
- [sendStun](Protocol.md#sendstun)
- [sentMessage](Protocol.md#sentmessage)
- [type](Protocol.md#type)

## Properties

### close

• `Optional` **close**: () => `Promise`\<`void`\>

#### Type declaration

▸ (): `Promise`\<`void`\>

##### Returns

`Promise`\<`void`\>

___

### connectionMade

• **connectionMade**: (...`args`: `any`) => `Promise`\<`void`\>

#### Type declaration

▸ (`...args`): `Promise`\<`void`\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `...args` | `any` |

##### Returns

`Promise`\<`void`\>

___

### localCandidate

• `Optional` **localCandidate**: [`Candidate`](../classes/Candidate.md)

___

### request

• **request**: (`message`: `Message`, `addr`: readonly [`string`, `number`], `integrityKey?`: `Buffer`, `retransmissions?`: `any`) => `Promise`\<[`Message`, readonly [`string`, `number`]]\>

#### Type declaration

▸ (`message`, `addr`, `integrityKey?`, `retransmissions?`): `Promise`\<[`Message`, readonly [`string`, `number`]]\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `message` | `Message` |
| `addr` | readonly [`string`, `number`] |
| `integrityKey?` | `Buffer` |
| `retransmissions?` | `any` |

##### Returns

`Promise`\<[`Message`, readonly [`string`, `number`]]\>

___

### responseAddr

• `Optional` **responseAddr**: readonly [`string`, `number`]

___

### responseMessage

• `Optional` **responseMessage**: `string`

___

### sendData

• **sendData**: (`data`: `Buffer`, `addr`: readonly [`string`, `number`]) => `Promise`\<`void`\>

#### Type declaration

▸ (`data`, `addr`): `Promise`\<`void`\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `data` | `Buffer` |
| `addr` | readonly [`string`, `number`] |

##### Returns

`Promise`\<`void`\>

___

### sendStun

• **sendStun**: (`message`: `Message`, `addr`: readonly [`string`, `number`]) => `Promise`\<`void`\>

#### Type declaration

▸ (`message`, `addr`): `Promise`\<`void`\>

##### Parameters

| Name | Type |
| :------ | :------ |
| `message` | `Message` |
| `addr` | readonly [`string`, `number`] |

##### Returns

`Promise`\<`void`\>

___

### sentMessage

• `Optional` **sentMessage**: `Message`

___

### type

• **type**: `string`
