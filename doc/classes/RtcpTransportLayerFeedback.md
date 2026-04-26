[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RtcpTransportLayerFeedback

# Class: RtcpTransportLayerFeedback

## Constructors

### new RtcpTransportLayerFeedback()

> **new RtcpTransportLayerFeedback**(`props`): [`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

#### Parameters

• **props**: `Partial`\<[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)\> = `{}`

#### Returns

[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

## Properties

### feedback

> **feedback**: `Feedback`

***

### header

> **header**: [`RtcpHeader`](RtcpHeader.md)

***

### type

> `readonly` **type**: `205` = `RtcpTransportLayerFeedback.type`

***

### type

> `readonly` `static` **type**: `205` = `205`

## Methods

### serialize()

> **serialize**(): `Buffer`

#### Returns

`Buffer`

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): [`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)

#### Parameters

• **data**: `Buffer`

• **header**: [`RtcpHeader`](RtcpHeader.md)

#### Returns

[`RtcpTransportLayerFeedback`](RtcpTransportLayerFeedback.md)
