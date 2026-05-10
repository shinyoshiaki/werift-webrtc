[**werift**](../README.md)

***

[werift](../globals.md) / RTCDtlsTransport

# Class: RTCDtlsTransport

## Implements

- [`DtlsTransportStats`](../interfaces/DtlsTransportStats.md)

## Constructors

### new RTCDtlsTransport()

> **new RTCDtlsTransport**(`config`, `iceTransport`, `localCertificate`?, `srtpProfiles`?): [`RTCDtlsTransport`](RTCDtlsTransport.md)

#### Parameters

##### config

[`PeerConfig`](../interfaces/PeerConfig.md)

##### iceTransport

[`RTCIceTransport`](RTCIceTransport.md)

##### localCertificate?

[`RTCCertificate`](RTCCertificate.md)

##### srtpProfiles?

(`1` \| `7`)[] = `[]`

#### Returns

[`RTCDtlsTransport`](RTCDtlsTransport.md)

## Properties

### bytesReceived

> **bytesReceived**: `number` = `0`

#### Implementation of

[`DtlsTransportStats`](../interfaces/DtlsTransportStats.md).[`bytesReceived`](../interfaces/DtlsTransportStats.md#bytesreceived)

***

### bytesSent

> **bytesSent**: `number` = `0`

#### Implementation of

[`DtlsTransportStats`](../interfaces/DtlsTransportStats.md).[`bytesSent`](../interfaces/DtlsTransportStats.md#bytessent)

***

### config

> `readonly` **config**: [`PeerConfig`](../interfaces/PeerConfig.md)

***

### dataReceiver()

> **dataReceiver**: (`buf`) => `void`

#### Parameters

##### buf

`Buffer`

#### Returns

`void`

***

### dtls?

> `optional` **dtls**: [`DtlsSocket`](DtlsSocket.md)

***

### iceTransport

> `readonly` **iceTransport**: [`RTCIceTransport`](RTCIceTransport.md)

***

### id

> **id**: `string`

***

### localCertificate?

> `optional` **localCertificate**: [`RTCCertificate`](RTCCertificate.md)

***

### onRtcp

> `readonly` **onRtcp**: [`Event`](Event.md)\<\[[`RtcpPacket`](../type-aliases/RtcpPacket.md)\]\>

***

### onRtp

> `readonly` **onRtp**: [`Event`](Event.md)\<\[[`RtpPacket`](RtpPacket.md)\]\>

***

### onStateChange

> `readonly` **onStateChange**: [`Event`](Event.md)\<\[`"closed"` \| `"new"` \| `"connected"` \| `"connecting"` \| `"failed"`\]\>

***

### packetsReceived

> **packetsReceived**: `number` = `0`

#### Implementation of

[`DtlsTransportStats`](../interfaces/DtlsTransportStats.md).[`packetsReceived`](../interfaces/DtlsTransportStats.md#packetsreceived)

***

### packetsSent

> **packetsSent**: `number` = `0`

#### Implementation of

[`DtlsTransportStats`](../interfaces/DtlsTransportStats.md).[`packetsSent`](../interfaces/DtlsTransportStats.md#packetssent)

***

### role

> **role**: [`DtlsRole`](../type-aliases/DtlsRole.md) = `"auto"`

***

### srtcp

> **srtcp**: [`SrtcpSession`](SrtcpSession.md)

***

### srtp

> **srtp**: [`SrtpSession`](SrtpSession.md)

***

### srtpStarted

> **srtpStarted**: `boolean` = `false`

***

### state

> **state**: `"closed"` \| `"new"` \| `"connected"` \| `"connecting"` \| `"failed"` = `"new"`

***

### transportSequenceNumber

> **transportSequenceNumber**: `number` = `0`

***

### localCertificate?

> `static` `optional` **localCertificate**: [`RTCCertificate`](RTCCertificate.md)

***

### localCertificatePromise?

> `static` `optional` **localCertificatePromise**: `Promise`\<[`RTCCertificate`](RTCCertificate.md)\>

## Accessors

### localParameters

#### Get Signature

> **get** **localParameters**(): [`RTCDtlsParameters`](RTCDtlsParameters.md)

##### Returns

[`RTCDtlsParameters`](RTCDtlsParameters.md)

## Methods

### getStats()

> **getStats**(): `Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

#### Returns

`Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

***

### sendData()

> `readonly` **sendData**(`data`): `Promise`\<`void`\>

#### Parameters

##### data

`Buffer`

#### Returns

`Promise`\<`void`\>

***

### sendRtcp()

> **sendRtcp**(`packets`): `Promise`\<`undefined` \| `number`\>

#### Parameters

##### packets

[`RtcpPacket`](../type-aliases/RtcpPacket.md)[]

#### Returns

`Promise`\<`undefined` \| `number`\>

***

### sendRtp()

> **sendRtp**(`payload`, `header`): `Promise`\<`number`\>

#### Parameters

##### payload

`Buffer`

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`Promise`\<`number`\>

***

### setRemoteParams()

> **setRemoteParams**(`remoteParameters`): `void`

#### Parameters

##### remoteParameters

[`RTCDtlsParameters`](RTCDtlsParameters.md)

#### Returns

`void`

***

### start()

> **start**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### startSrtp()

> **startSrtp**(): `void`

#### Returns

`void`

***

### stop()

> **stop**(): `Promise`\<`void`\>

#### Returns

`Promise`\<`void`\>

***

### updateSrtpSession()

> **updateSrtpSession**(): `void`

#### Returns

`void`

***

### SetupCertificate()

> `static` **SetupCertificate**(): `Promise`\<[`RTCCertificate`](RTCCertificate.md)\>

#### Returns

`Promise`\<[`RTCCertificate`](RTCCertificate.md)\>
