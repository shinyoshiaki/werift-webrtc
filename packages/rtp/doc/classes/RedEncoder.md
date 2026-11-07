[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RedEncoder

# Class: RedEncoder

## Constructors

### Constructor

> **new RedEncoder**(`distance?`): `RedEncoder`

#### Parameters

##### distance?

`number` = `1`

#### Returns

`RedEncoder`

## Properties

### cacheSize

> **cacheSize**: `number` = `10`

***

### distance

> **distance**: `number`

## Methods

### build()

> **build**(): [`Red`](Red.md)

#### Returns

[`Red`](Red.md)

***

### push()

> **push**(`payload`): `void`

#### Parameters

##### payload

###### block

`Buffer`

###### blockPT

`number`

###### timestamp

`number`

#### Returns

`void`

***

### serializedLengthWith()

> **serializedLengthWith**(`payload`): `number`

Serialized RED payload length if `payload` were pushed now, without
changing this encoder (a pacer needs the size before the packet is
committed).

#### Parameters

##### payload

###### block

`Buffer`

###### blockPT

`number`

###### timestamp

`number`

#### Returns

`number`
