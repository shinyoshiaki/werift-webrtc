[**werift**](../README.md)

***

[werift](../globals.md) / PromiseQueue

# Class: PromiseQueue

## Constructors

### new PromiseQueue()

> **new PromiseQueue**(): [`PromiseQueue`](PromiseQueue.md)

#### Returns

[`PromiseQueue`](PromiseQueue.md)

## Properties

### queue

> **queue**: `object`[] = `[]`

#### done()

> **done**: (...`args`) => `void`

##### Parameters

###### args

...`any`[]

##### Returns

`void`

#### failed()

> **failed**: (...`args`) => `void`

##### Parameters

###### args

...`any`[]

##### Returns

`void`

#### promise()

> **promise**: () => `Promise`\<`unknown`\>

##### Returns

`Promise`\<`unknown`\>

***

### running

> **running**: `boolean` = `false`

## Methods

### cancel()

> **cancel**(): `void`

#### Returns

`void`

***

### push()

> **push**\<`T`\>(`promise`): `Promise`\<`T`\>

#### Type Parameters

• **T**

#### Parameters

##### promise

() => `Promise`\<`T`\>

#### Returns

`Promise`\<`T`\>
