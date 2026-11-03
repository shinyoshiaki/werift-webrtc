[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / RtcpPayloadSpecificFeedback

# Class: RtcpPayloadSpecificFeedback

## Constructors

### Constructor

> **new RtcpPayloadSpecificFeedback**(`props?`): `RtcpPayloadSpecificFeedback`

#### Parameters

##### props?

`Partial`\<`RtcpPayloadSpecificFeedback`\> = `{}`

#### Returns

`RtcpPayloadSpecificFeedback`

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

> **serialize**(): `Buffer`\<`ArrayBuffer`\>

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### deSerialize()

> `static` **deSerialize**(`data`, `header`): `RtcpPayloadSpecificFeedback`

#### Parameters

##### data

`Buffer`

##### header

[`RtcpHeader`](RtcpHeader.md)

#### Returns

`RtcpPayloadSpecificFeedback`
