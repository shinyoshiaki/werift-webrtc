[**werift**](../README.md)

***

[werift](../globals.md) / FifoQueue

# Class: FifoQueue\<T\>

FIFO queue with amortized O(1) `shift()`.

`Array.prototype.shift()` copies the backing store once the array is large
(V8 large object space), which makes draining a long queue quadratic.
This queue keeps a head index into a plain array instead and compacts the
consumed prefix lazily, so indexed access (`at`) stays O(1).

## Type Parameters

### T

`T`

## Implements

- `Iterable`\<`T`\>

## Constructors

### Constructor

> **new FifoQueue**\<`T`\>(`items?`): `FifoQueue`\<`T`\>

#### Parameters

##### items?

`Iterable`\<`T`, `any`, `any`\>

#### Returns

`FifoQueue`\<`T`\>

## Accessors

### length

#### Get Signature

> **get** **length**(): `number`

##### Returns

`number`

## Methods

### \[iterator\]()

> **\[iterator\]**(): `Iterator`\<`T`\>

Iterates from the front. Safe against `shift()` while iterating (e.g.
across an `await`): elements removed meanwhile are skipped and iteration
continues with the current front instead of jumping over live elements.

#### Returns

`Iterator`\<`T`\>

#### Implementation of

`Iterable.[iterator]`

***

### at()

> **at**(`index`): `T` \| `undefined`

Element at `index` from the front (negative index counts from the back).

#### Parameters

##### index

`number`

#### Returns

`T` \| `undefined`

***

### clear()

> **clear**(): `void`

#### Returns

`void`

***

### filter()

> **filter**(`predicate`): `FifoQueue`\<`T`\>

Returns a new queue with the elements that satisfy `predicate`.

#### Parameters

##### predicate

(`item`, `index`) => `boolean`

#### Returns

`FifoQueue`\<`T`\>

***

### findIndex()

> **findIndex**(`predicate`): `number`

#### Parameters

##### predicate

(`item`, `index`) => `boolean`

#### Returns

`number`

***

### forEach()

> **forEach**(`callback`): `void`

#### Parameters

##### callback

(`item`, `index`) => `void`

#### Returns

`void`

***

### last()

> **last**(): `T` \| `undefined`

Last element, without removing it.

#### Returns

`T` \| `undefined`

***

### peek()

> **peek**(): `T` \| `undefined`

First element, without removing it.

#### Returns

`T` \| `undefined`

***

### push()

> **push**(...`items`): `number`

#### Parameters

##### items

...`T`[]

#### Returns

`number`

***

### shift()

> **shift**(): `T` \| `undefined`

Removes and returns the first element.

#### Returns

`T` \| `undefined`

***

### toArray()

> **toArray**(): `T`[]

#### Returns

`T`[]

***

### unshift()

> **unshift**(`item`): `number`

Puts an element back to the front of the queue.

#### Parameters

##### item

`T`

#### Returns

`number`
