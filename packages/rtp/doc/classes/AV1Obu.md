[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / AV1Obu

# Class: AV1Obu

## Constructors

### new AV1Obu()

> **new AV1Obu**(): [`AV1Obu`](AV1Obu.md)

#### Returns

[`AV1Obu`](AV1Obu.md)

## Properties

### obu\_extension\_flag

> **obu\_extension\_flag**: `number`

***

### obu\_forbidden\_bit

> **obu\_forbidden\_bit**: `number`

***

### obu\_has\_size\_field

> **obu\_has\_size\_field**: `number`

***

### obu\_reserved\_1bit

> **obu\_reserved\_1bit**: `number`

***

### obu\_type

> **obu\_type**: `OBU_TYPE`

***

### payload

> **payload**: `Buffer`

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`buf`): [`AV1Obu`](AV1Obu.md)

#### Parameters

• **buf**: `Buffer`

#### Returns

[`AV1Obu`](AV1Obu.md)
