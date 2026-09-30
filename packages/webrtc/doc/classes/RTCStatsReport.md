[**werift**](../README.md)

***

[werift](../globals.md) / RTCStatsReport

# Class: RTCStatsReport

RTCStatsReport is a Map-like object that holds WebRTC statistics

## Extends

- `Map`\<`string`, [`RTCStats`](../interfaces/RTCStats.md)\>

## Constructors

### new RTCStatsReport()

> **new RTCStatsReport**(`stats`?): [`RTCStatsReport`](RTCStatsReport.md)

#### Parameters

##### stats?

[`RTCStats`](../interfaces/RTCStats.md)[]

#### Returns

[`RTCStatsReport`](RTCStatsReport.md)

#### Overrides

`Map<string, RTCStats>.constructor`

## Properties

### \[toStringTag\]

> `readonly` **\[toStringTag\]**: `string`

#### Inherited from

`Map.[toStringTag]`

***

### size

> `readonly` **size**: `number`

#### Returns

the number of elements in the Map.

#### Inherited from

`Map.size`

***

### \[species\]

> `readonly` `static` **\[species\]**: `MapConstructor`

#### Inherited from

`Map.[species]`

## Methods

### \[iterator\]()

> **\[iterator\]**(): `MapIterator`\<\[`string`, [`RTCStats`](../interfaces/RTCStats.md)\]\>

Returns an iterable of entries in the map.

#### Returns

`MapIterator`\<\[`string`, [`RTCStats`](../interfaces/RTCStats.md)\]\>

#### Inherited from

`Map.[iterator]`

***

### clear()

> **clear**(): `void`

#### Returns

`void`

#### Inherited from

`Map.clear`

***

### delete()

> **delete**(`key`): `boolean`

#### Parameters

##### key

`string`

#### Returns

`boolean`

true if an element in the Map existed and has been removed, or false if the element does not exist.

#### Inherited from

`Map.delete`

***

### entries()

> **entries**(): `MapIterator`\<\[`string`, [`RTCStats`](../interfaces/RTCStats.md)\]\>

Returns an iterable of key, value pairs for every entry in the map.

#### Returns

`MapIterator`\<\[`string`, [`RTCStats`](../interfaces/RTCStats.md)\]\>

#### Inherited from

`Map.entries`

***

### forEach()

> **forEach**(`callbackfn`, `thisArg`?): `void`

Executes a provided function once per each key/value pair in the Map, in insertion order.

#### Parameters

##### callbackfn

(`value`, `key`, `map`) => `void`

##### thisArg?

`any`

#### Returns

`void`

#### Inherited from

`Map.forEach`

***

### get()

> **get**(`key`): `undefined` \| [`RTCStats`](../interfaces/RTCStats.md)

Returns a specified element from the Map object. If the value that is associated to the provided key is an object, then you will get a reference to that object and any change made to that object will effectively modify it inside the Map.

#### Parameters

##### key

`string`

#### Returns

`undefined` \| [`RTCStats`](../interfaces/RTCStats.md)

Returns the element associated with the specified key. If no element is associated with the specified key, undefined is returned.

#### Inherited from

`Map.get`

***

### has()

> **has**(`key`): `boolean`

#### Parameters

##### key

`string`

#### Returns

`boolean`

boolean indicating whether an element with the specified key exists or not.

#### Inherited from

`Map.has`

***

### keys()

> **keys**(): `MapIterator`\<`string`\>

Returns an iterable of keys in the map

#### Returns

`MapIterator`\<`string`\>

#### Inherited from

`Map.keys`

***

### set()

> **set**(`key`, `value`): `this`

Adds a new element with a specified key and value to the Map. If an element with the same key already exists, the element will be updated.

#### Parameters

##### key

`string`

##### value

[`RTCStats`](../interfaces/RTCStats.md)

#### Returns

`this`

#### Inherited from

`Map.set`

***

### values()

> **values**(): `MapIterator`\<[`RTCStats`](../interfaces/RTCStats.md)\>

Returns an iterable of values in the map

#### Returns

`MapIterator`\<[`RTCStats`](../interfaces/RTCStats.md)\>

#### Inherited from

`Map.values`

***

### groupBy()

> `static` **groupBy**\<`K`, `T`\>(`items`, `keySelector`): `Map`\<`K`, `T`[]\>

Groups members of an iterable according to the return value of the passed callback.

#### Type Parameters

• **K**

• **T**

#### Parameters

##### items

`Iterable`\<`T`\>

An iterable.

##### keySelector

(`item`, `index`) => `K`

A callback which will be invoked for each item in items.

#### Returns

`Map`\<`K`, `T`[]\>

#### Inherited from

`Map.groupBy`
