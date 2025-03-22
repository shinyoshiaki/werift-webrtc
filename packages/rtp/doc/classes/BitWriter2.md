[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / BitWriter2

# Class: BitWriter2

## Constructors

### new BitWriter2()

> **new BitWriter2**(`bitLength`): [`BitWriter2`](BitWriter2.md)

各valueがオクテットを跨いではならない

#### Parameters

• **bitLength**: `number`

Max 32bit

#### Returns

[`BitWriter2`](BitWriter2.md)

## Properties

### offset

> **offset**: `bigint`

## Accessors

### buffer

> `get` **buffer**(): `Buffer`

#### Returns

`Buffer`

***

### value

> `get` **value**(): `number`

#### Returns

`number`

## Methods

### set()

> **set**(`value`, `size`): [`BitWriter2`](BitWriter2.md)

#### Parameters

• **value**: `number`

• **size**: `number` = `1`

#### Returns

[`BitWriter2`](BitWriter2.md)
