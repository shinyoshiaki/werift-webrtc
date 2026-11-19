[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / FullIntraRequest

# Class: FullIntraRequest

## Constructors

### Constructor

> **new FullIntraRequest**(`props?`): `FullIntraRequest`

#### Parameters

##### props?

`Partial`\<`FullIntraRequest`\> = `{}`

#### Returns

`FullIntraRequest`

## Properties

### count

> **count**: `number` = `FullIntraRequest.count`

***

### fir

> **fir**: `firEntry`[] = `[]`

***

### mediaSsrc

> **mediaSsrc**: `number`

***

### senderSsrc

> **senderSsrc**: `number`

***

### count

> `static` **count**: `number` = `4`

## Accessors

### length

#### Get Signature

> **get** **length**(): `number`

RTCP header `length` field: total packet size in 32-bit words minus 1.
Body is `serialize()`; plus 1 header word → bodyWords = bodyBytes/4.

##### Returns

`number`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`): `FullIntraRequest`

#### Parameters

##### data

`Buffer`

#### Returns

`FullIntraRequest`
