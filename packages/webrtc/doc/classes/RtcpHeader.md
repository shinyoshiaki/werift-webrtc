[**werift**](../README.md)

***

[werift](../globals.md) / RtcpHeader

# Class: RtcpHeader

## Constructors

### Constructor

> **new RtcpHeader**(`props?`): `RtcpHeader`

#### Parameters

##### props?

`Partial`\<`RtcpHeader`\> = `{}`

#### Returns

`RtcpHeader`

## Properties

### count

> **count**: `number` = `0`

***

### length

> **length**: `number` = `0`

このパケットの長さは、ヘッダーと任意のパディングを含む32ビットワードから 1を引いたものである

***

### padding

> **padding**: `boolean` = `false`

***

### type

> **type**: `number` = `0`

***

### version

> **version**: `number` = `2`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`buf`): `RtcpHeader`

#### Parameters

##### buf

`Buffer`

#### Returns

`RtcpHeader`

***

### serialize()

> `static` **serialize**(`type`, `count`, `payload`, `length`): `Buffer`\<`ArrayBuffer`\>

#### Parameters

##### type

`number`

##### count

`number`

##### payload

`Buffer`

##### length

`number`

#### Returns

`Buffer`\<`ArrayBuffer`\>
