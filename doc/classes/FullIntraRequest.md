[**werift**](../README.md)

***

[werift](../globals.md) / FullIntraRequest

# Class: FullIntraRequest

## Constructors

### new FullIntraRequest()

> **new FullIntraRequest**(`props`): [`FullIntraRequest`](FullIntraRequest.md)

#### Parameters

##### props

`Partial`\<[`FullIntraRequest`](FullIntraRequest.md)\> = `{}`

#### Returns

[`FullIntraRequest`](FullIntraRequest.md)

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

> `static` **deSerialize**(`data`): [`FullIntraRequest`](FullIntraRequest.md)

#### Parameters

##### data

`Buffer`

#### Returns

[`FullIntraRequest`](FullIntraRequest.md)
