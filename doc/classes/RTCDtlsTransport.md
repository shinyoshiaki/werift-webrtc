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

###### debug?

`Partial`\<\{ `disableRecvRetransmit`: `boolean`; `disableSendNack`: `boolean`; `inboundPacketLoss`: `number`; `outboundPacketLoss`: `number`; `receiverReportDelay`: `number`; \}\>

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

> `readonly` **config**: `object`

#### debug?

> `optional` **debug**: `Partial`\<\{ `disableRecvRetransmit`: `boolean`; `disableSendNack`: `boolean`; `inboundPacketLoss`: `number`; `outboundPacketLoss`: `number`; `receiverReportDelay`: `number`; \}\>

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

### iceRoleAtStart?

> `optional` **iceRoleAtStart**: `"unknown"` \| `"controlling"` \| `"controlled"`

Internal: the ICE role when the handshake started. werift sets the ICE role at
every offer / answer, so an SCTP association that starts later on this
transport takes its client / server side from here, as both peers agreed
on it when they started DTLS.

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

### onstatechange()?

> `optional` **onstatechange**: () => `void`

#### Returns

`void`

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

Wire 16-bit TWCC sequence (low bits of [transportSequenceNumberExtended](RTCDtlsTransport.md#transportsequencenumberextended)).

***

### transportSequenceNumberExtended

> **transportSequenceNumberExtended**: `number` = `0`

Monotonic transport-wide sequence allocated at ICE enqueue time.
Never wraps in JS Number. [transportSequenceNumber](RTCDtlsTransport.md#transportsequencenumber) is the wire
16-bit view (`extended & 0xffff`).

***

### localCertificate?

> `static` `optional` **localCertificate**: [`RTCCertificate`](RTCCertificate.md)

***

### localCertificatePromise?

> `static` `optional` **localCertificatePromise**: `Promise`\<[`RTCCertificate`](RTCCertificate.md)\>

## Accessors

### hasRemoteParameters

#### Get Signature

> **get** **hasRemoteParameters**(): `boolean`

Internal: whether a description gave this transport the peer's DTLS parameters.

##### Returns

`boolean`

***

### localParameters

#### Get Signature

> **get** **localParameters**(): [`RTCDtlsParameters`](RTCDtlsParameters.md)

##### Returns

[`RTCDtlsParameters`](RTCDtlsParameters.md)

## Methods

### addEventListener()

> **addEventListener**(`type`, `listener`, `options`?): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

##### options?

`boolean` | \{ `once`: `boolean`; \}

#### Returns

`void`

***

### allocateTransportWideSequence()

> **allocateTransportWideSequence**(): `object`

Allocate the next transport-wide sequence at send time.
Call immediately before DTLS/ICE enqueue so BUNDLE senders cannot
reserve a TSN then wait in a per-sender pacer.

#### Returns

`object`

##### extended

> **extended**: `number`

##### wire

> **wire**: `number`

***

### dispatchEvent()

> **dispatchEvent**(`event`): `boolean`

#### Parameters

##### event

`Event`

#### Returns

`boolean`

***

### getStats()

> **getStats**(`timestamp`): `Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

#### Parameters

##### timestamp

`number` = `...`

#### Returns

`Promise`\<[`RTCStats`](../interfaces/RTCStats.md)[]\>

***

### removeEventListener()

> **removeEventListener**(`type`, `listener`): `void`

#### Parameters

##### type

`string`

##### listener

(...`args`) => `void`

#### Returns

`void`

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

Encrypt RTP and enqueue on ICE. Returns on-wire size.
Send-time metadata: [sendRtpWithMeta](RTCDtlsTransport.md#sendrtpwithmeta).

#### Parameters

##### payload

`Buffer`

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`Promise`\<`number`\>

***

### sendRtpWithMeta()

> **sendRtpWithMeta**(`payload`, `header`): `Promise`\<[`DtlsSendRtpResult`](../type-aliases/DtlsSendRtpResult.md)\>

Encrypt RTP and enqueue on ICE, capturing the clock immediately before
the ICE write (RFC 8888). Prefer [sendRtp](RTCDtlsTransport.md#sendrtp) unless send time is needed.

#### Parameters

##### payload

`Buffer`

##### header

[`RtpHeader`](RtpHeader.md)

#### Returns

`Promise`\<[`DtlsSendRtpResult`](../type-aliases/DtlsSendRtpResult.md)\>

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
