[**werift**](../README.md)

***

[werift](../globals.md) / FullIntraRequest

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
