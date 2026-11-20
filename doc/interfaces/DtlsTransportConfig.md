[**werift**](../README.md)

***

[werift](../globals.md) / DtlsTransportConfig

# Interface: DtlsTransportConfig

## Properties

### debug?

> `optional` **debug?**: `Partial`\<\{ `disableRecvRetransmit`: `boolean`; `disableSendNack`: `boolean`; `inboundPacketLoss`: `number`; `outboundPacketLoss`: `number`; `receiverReportDelay`: `number`; \}\>

***

### handshakeValidation?

> `optional` **handshakeValidation?**: [`HandshakeValidation`](../enumerations/HandshakeValidation.md)

PeerConfig.dtlsHandshakeValidation (DTLS 1.2 handshake validation).

***

### helloRetryRequest?

> `optional` **helloRetryRequest?**: `boolean`

***

### protocolVersions?

> `optional` **protocolVersions?**: readonly [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

***

### warp?

> `optional` **warp?**: `object`

#### allowEarlyServerData?

> `optional` **allowEarlyServerData?**: `boolean`

#### earlyMediaPolicy?

> `optional` **earlyMediaPolicy?**: `"drop"` \| `"buffer"`

#### sendBeforeNomination?

> `optional` **sendBeforeNomination?**: `boolean`
