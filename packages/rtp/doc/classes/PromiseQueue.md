[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / PromiseQueue

# Class: PromiseQueue

## Constructors

### Constructor

> **new PromiseQueue**(): `PromiseQueue`

#### Returns

`PromiseQueue`

## Properties

### queue

> **queue**: `object`[] = `[]`

#### done

> **done**: (...`args`) => `void`

##### Parameters

###### args

...`any`[]

##### Returns

`void`

#### failed

> **failed**: (...`args`) => `void`

##### Parameters

###### args

...`any`[]

##### Returns

`void`

#### promise

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

##### T

`T`

#### Parameters

##### promise

() => `Promise`\<`T`\>

#### Returns

`Promise`\<`T`\>
