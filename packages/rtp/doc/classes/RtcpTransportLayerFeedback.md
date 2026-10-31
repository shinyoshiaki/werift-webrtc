[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtcpTransportLayerFeedback

# Class: RtcpTransportLayerFeedback

## Constructors

### Constructor

> **new RtcpTransportLayerFeedback**(`props?`): `RtcpTransportLayerFeedback`

#### Parameters

##### props?

`Partial`\<`RtcpTransportLayerFeedback`\> = `{}`

#### Returns

`RtcpTransportLayerFeedback`

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

> `readonly` `static` **type**: `205` = `RtcpTransportLayerFeedbackType`

## Methods

### serialize()

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): `RtcpTransportLayerFeedback`

#### Parameters

##### data

`Buffer`

##### header

[`RtcpHeader`](RtcpHeader.md)

#### Returns

`RtcpTransportLayerFeedback`
