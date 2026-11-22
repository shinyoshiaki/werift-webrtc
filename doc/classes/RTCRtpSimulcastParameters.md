[**werift**](../README.md)

***

[werift](../globals.md) / RTCRtpSimulcastParameters

# Class: RTCRtpSimulcastParameters

## Constructors

### Constructor

> **new RTCRtpSimulcastParameters**(`props`): `RTCRtpSimulcastParameters`

#### Parameters

##### props

`RTCRtpSimulcastParameters`

#### Returns

`RTCRtpSimulcastParameters`

## Properties

### direction

> **direction**: `"send"` \| `"recv"`

***

### restrictions?

> `optional` **restrictions?**: `string`

`a=rid` restrictions after the direction, RFC 8851
(tests/sdp.test.ts "a=rid の方向と制約を分けて読み、書き戻すと元の行になる").

***

### rid

> **rid**: `string`
