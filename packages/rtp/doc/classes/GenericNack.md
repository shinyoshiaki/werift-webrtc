[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / GenericNack

# Class: GenericNack

## Constructors

### Constructor

> **new GenericNack**(`props?`): `GenericNack`

#### Parameters

##### props?

`Partial`\<`GenericNack`\> = `{}`

#### Returns

`GenericNack`

## Properties

### count

> `readonly` **count**: `number` = `GenericNack.count`

***

### header

> **header**: [`RtcpHeader`](RtcpHeader.md)

***

### lost

> **lost**: `number`[] = `[]`

***

### mediaSourceSsrc

> **mediaSourceSsrc**: `number`

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

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### lost

> **lost**: `number`[]

##### mediaSourceSsrc

> **mediaSourceSsrc**: `number`

##### senderSsrc

> **senderSsrc**: `number`

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): `GenericNack`

#### Parameters

##### data

`Buffer`

##### header

[`RtcpHeader`](RtcpHeader.md)

#### Returns

`GenericNack`
