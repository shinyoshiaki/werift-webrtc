[**werift**](../README.md)

***

[werift](../globals.md) / RtpRouter

# Class: RtpRouter

## Constructors

### new RtpRouter()

> **new RtpRouter**(): [`RtpRouter`](RtpRouter.md)

#### Returns

[`RtpRouter`](RtpRouter.md)

## Properties

### extIdUriMap

> **extIdUriMap**: `object` = `{}`

#### Index Signature

\[`id`: `number`\]: `string`

***

### midTable

> **midTable**: `object` = `{}`

#### Index Signature

\[`mid`: `string`\]: [`RTCRtpReceiver`](RTCRtpReceiver.md)

***

### ridTable

> **ridTable**: `object` = `{}`

#### Index Signature

\[`rid`: `string`\]: [`RTCRtpSender`](RTCRtpSender.md) \| [`RTCRtpReceiver`](RTCRtpReceiver.md)

***

### ssrcTable

> **ssrcTable**: `object` = `{}`

#### Index Signature

\[`ssrc`: `number`\]: [`RTCRtpSender`](RTCRtpSender.md) \| [`RTCRtpReceiver`](RTCRtpReceiver.md)

## Methods

### registerRtpReceiverByMid()

> **registerRtpReceiverByMid**(`transceiver`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`void`

***

### registerRtpReceiverByRid()

> **registerRtpReceiverByRid**(`transceiver`, `param`, `params`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### param

[`RTCRtpSimulcastParameters`](RTCRtpSimulcastParameters.md)

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

#### Returns

`void`

***

### registerRtpReceiverBySsrc()

> **registerRtpReceiverBySsrc**(`transceiver`, `params`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

##### params

[`RTCRtpReceiveParameters`](../interfaces/RTCRtpReceiveParameters.md)

#### Returns

`void`

***

### registerRtpSender()

> **registerRtpSender**(`sender`): `void`

#### Parameters

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

#### Returns

`void`

***

### routeRtcp()

> **routeRtcp**(`packet`): `void`

#### Parameters

##### packet

[`RtcpPacket`](../type-aliases/RtcpPacket.md)

#### Returns

`void`

***

### routeRtp()

> **routeRtp**(`packet`): `void`

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

#### Returns

`void`

***

### unregisterRtpReceiver()

> **unregisterRtpReceiver**(`transceiver`): `void`

#### Parameters

##### transceiver

[`RTCRtpTransceiver`](RTCRtpTransceiver.md)

#### Returns

`void`

***

### unregisterRtpSender()

> **unregisterRtpSender**(`sender`): `void`

#### Parameters

##### sender

[`RTCRtpSender`](RTCRtpSender.md)

#### Returns

`void`
