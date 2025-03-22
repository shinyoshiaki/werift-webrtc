[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RtcpPayloadSpecificFeedback

# Class: RtcpPayloadSpecificFeedback

## Constructors

### new RtcpPayloadSpecificFeedback()

> **new RtcpPayloadSpecificFeedback**(`props`): [`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)

#### Parameters

• **props**: `Partial`\<[`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)\> = `{}`

#### Returns

[`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)

## Properties

### feedback

> **feedback**: `Feedback`

***

### type

> `readonly` **type**: `206` = `RtcpPayloadSpecificFeedback.type`

***

### type

> `readonly` `static` **type**: `206` = `206`

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): [`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)

#### Parameters

• **data**: `Buffer`

• **header**: [`RtcpHeader`](RtcpHeader.md)

#### Returns

[`RtcpPayloadSpecificFeedback`](RtcpPayloadSpecificFeedback.md)
