[**werift**](../README.md)

***

[werift](../globals.md) / DtlsTransportConfig

# Interface: DtlsTransportConfig

## Properties

### debug?

> `optional` **debug**: `Partial`\<\{ `disableRecvRetransmit`: `boolean`; `disableSendNack`: `boolean`; `inboundPacketLoss`: `number`; `outboundPacketLoss`: `number`; `receiverReportDelay`: `number`; \}\>

***

### helloRetryRequest?

> `optional` **helloRetryRequest**: `boolean`

***

### protocolVersions?

> `optional` **protocolVersions**: readonly [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

***

### warp?

> `optional` **warp**: `object`

#### allowEarlyServerData?

> `optional` **allowEarlyServerData**: `boolean`

#### earlyMediaPolicy?

> `optional` **earlyMediaPolicy**: `"buffer"` \| `"drop"`
