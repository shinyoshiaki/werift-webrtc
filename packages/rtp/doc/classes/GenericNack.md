[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / GenericNack

# Class: GenericNack

## Constructors

### new GenericNack()

> **new GenericNack**(`props`): [`GenericNack`](GenericNack.md)

#### Parameters

• **props**: `Partial`\<[`GenericNack`](GenericNack.md)\> = `{}`

#### Returns

[`GenericNack`](GenericNack.md)

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

> **serialize**(): `Buffer`

#### Returns

`Buffer`

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

> `static` **deSerialize**(`data`, `header`): [`GenericNack`](GenericNack.md)

#### Parameters

• **data**: `Buffer`

• **header**: [`RtcpHeader`](RtcpHeader.md)

#### Returns

[`GenericNack`](GenericNack.md)
