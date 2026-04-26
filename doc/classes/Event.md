[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / Event

# Class: Event\<T\>

## Type Parameters

• **T** *extends* `any`[]

## Constructors

### new Event()

> **new Event**\<`T`\>(): [`Event`](Event.md)\<`T`\>

#### Returns

[`Event`](Event.md)\<`T`\>

## Properties

### ended

> **ended**: `boolean` = `false`

***

### onended()?

> `optional` **onended**: () => `void`

#### Returns

`void`

## Accessors

### length

> `get` **length**(): `number`

#### Returns

`number`

***

### returnListener

> `get` **returnListener**(): `object`

#### Returns

`object`

##### asPromise()

> **asPromise**: (`timeLimit`?) => `Promise`\<`T`\>

###### Parameters

• **timeLimit?**: `number`

###### Returns

`Promise`\<`T`\>

##### once()

> **once**: (`execute`, `complete`?, `error`?) => `void`

###### Parameters

• **execute**: `EventExecute`\<`T`\>

• **complete?**: `EventComplete`

• **error?**: `EventError`

###### Returns

`void`

##### subscribe()

> **subscribe**: (`execute`, `complete`?, `error`?) => `object`

###### Parameters

• **execute**: `EventExecute`\<`T`\>

• **complete?**: `EventComplete`

• **error?**: `EventError`

###### Returns

`object`

###### disposer()

> **disposer**: (`disposer`) => `void`

###### Parameters

• **disposer**: [`EventDisposer`](EventDisposer.md)

###### Returns

`void`

###### unSubscribe()

> **unSubscribe**: () => `void`

###### Returns

`void`

***

### returnTrigger

> `get` **returnTrigger**(): `object`

#### Returns

`object`

##### complete()

> **complete**: () => `void`

###### Returns

`void`

##### error()

> **error**: (`e`) => `void`

###### Parameters

• **e**: `any`

###### Returns

`void`

##### execute()

> **execute**: (...`args`) => `void`

###### Parameters

• ...**args**: `T`

###### Returns

`void`

## Methods

### allUnsubscribe()

> **allUnsubscribe**(): `void`

#### Returns

`void`

***

### asPromise()

> **asPromise**(`timeLimit`?): `Promise`\<`T`\>

#### Parameters

• **timeLimit?**: `number`

#### Returns

`Promise`\<`T`\>

***

### complete()

> **complete**(): `void`

#### Returns

`void`

***

### error()

> **error**(`e`): `void`

#### Parameters

• **e**: `any`

#### Returns

`void`

***

### execute()

> **execute**(...`args`): `void`

#### Parameters

• ...**args**: `T`

#### Returns

`void`

***

### once()

> **once**(`execute`, `complete`?, `error`?): `void`

#### Parameters

• **execute**: `EventExecute`\<`T`\>

• **complete?**: `EventComplete`

• **error?**: `EventError`

#### Returns

`void`

***

### onerror()

> **onerror**(`e`): `void`

#### Parameters

• **e**: `any`

#### Returns

`void`

***

### queuingSubscribe()

> **queuingSubscribe**(`execute`, `complete`?, `error`?): `object`

#### Parameters

• **execute**: `PromiseEventExecute`\<`T`\>

• **complete?**: `EventComplete`

• **error?**: `EventError`

#### Returns

`object`

##### disposer()

> **disposer**: (`disposer`) => `void`

###### Parameters

• **disposer**: [`EventDisposer`](EventDisposer.md)

###### Returns

`void`

##### unSubscribe()

> **unSubscribe**: () => `void`

###### Returns

`void`

***

### subscribe()

> **subscribe**(`execute`, `complete`?, `error`?): `object`

#### Parameters

• **execute**: `EventExecute`\<`T`\>

• **complete?**: `EventComplete`

• **error?**: `EventError`

#### Returns

`object`

##### disposer()

> **disposer**: (`disposer`) => `void`

###### Parameters

• **disposer**: [`EventDisposer`](EventDisposer.md)

###### Returns

`void`

##### unSubscribe()

> **unSubscribe**: () => `void`

###### Returns

`void`

***

### watch()

> **watch**(`cb`, `timeLimit`?): `Promise`\<`T`\>

#### Parameters

• **cb**

• **timeLimit?**: `number`

#### Returns

`Promise`\<`T`\>
