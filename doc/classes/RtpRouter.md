[**werift**](../README.md)

***

[werift](../globals.md) / RtpRouter

# Class: RtpRouter

## Constructors

### new RtpRouter()

> **new RtpRouter**(): [`RtpRouter`](RtpRouter.md)

#### Returns

[`RtpRouter`](RtpRouter.md)

## Accessors

### extIdUriMap

#### Get Signature

> **get** **extIdUriMap**(): `object`

Merged view for single-session callers; per-transport maps are authoritative.

##### Returns

`object`

***

### ridTable

#### Get Signature

> **get** **ridTable**(): `object`

##### Returns

`object`

***

### ssrcTable

#### Get Signature

> **get** **ssrcTable**(): `object`

##### Returns

`object`

## Methods

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

### restoreExtIdUriMaps()

> **restoreExtIdUriMaps**(`maps`): `void`

#### Parameters

##### maps

#### Returns

`void`

***

### restoreRtpSessions()

> **restoreRtpSessions**(`sessions`): `void`

#### Parameters

##### sessions

#### Returns

`void`

***

### routeRtcp()

> **routeRtcp**(`packet`, `transportId`?): `void`

#### Parameters

##### packet

[`RtcpPacket`](../type-aliases/RtcpPacket.md)

##### transportId?

`string`

#### Returns

`void`

***

### routeRtp()

> **routeRtp**(`packet`, `transportId`?): `void`

#### Parameters

##### packet

[`RtpPacket`](RtpPacket.md)

##### transportId?

`string`

#### Returns

`void`

***

### snapshotExtIdUriMaps()

> **snapshotExtIdUriMaps**(): `object`

#### Returns

`object`

***

### snapshotRtpSessions()

> **snapshotRtpSessions**(): `object`

#### Returns

`object`
