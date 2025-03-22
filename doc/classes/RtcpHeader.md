[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RtcpHeader

# Class: RtcpHeader

## Constructors

### new RtcpHeader()

> **new RtcpHeader**(`props`): [`RtcpHeader`](RtcpHeader.md)

#### Parameters

• **props**: `Partial`\<[`RtcpHeader`](RtcpHeader.md)\> = `{}`

#### Returns

[`RtcpHeader`](RtcpHeader.md)

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

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`buf`): [`RtcpHeader`](RtcpHeader.md)

#### Parameters

• **buf**: `Buffer`

#### Returns

[`RtcpHeader`](RtcpHeader.md)
