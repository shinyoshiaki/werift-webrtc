[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / PictureLossIndication

# Class: PictureLossIndication

## Constructors

### Constructor

> **new PictureLossIndication**(`props?`): `PictureLossIndication`

#### Parameters

##### props?

`Partial`\<`PictureLossIndication`\> = `{}`

#### Returns

`PictureLossIndication`

## Properties

### count

> **count**: `number` = `PictureLossIndication.count`

***

### length

> **length**: `number` = `2`

***

### mediaSsrc

> **mediaSsrc**: `number`

***

### senderSsrc

> **senderSsrc**: `number`

***

### count

> `static` **count**: `number` = `1`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`): `PictureLossIndication`

#### Parameters

##### data

`Buffer`

#### Returns

`PictureLossIndication`
