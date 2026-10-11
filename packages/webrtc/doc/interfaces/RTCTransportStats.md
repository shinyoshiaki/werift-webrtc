[**werift**](../README.md)

***

[werift](../globals.md) / RTCTransportStats

# Interface: RTCTransportStats

## Extends

- [`RTCStats`](RTCStats.md)

## Properties

### bytesReceived?

> `optional` **bytesReceived**: `number`

***

### bytesSent?

> `optional` **bytesSent**: `number`

***

### dtlsCipher?

> `optional` **dtlsCipher**: `string`

***

### dtlsRole?

> `optional` **dtlsRole**: [`RTCDtlsRole`](../type-aliases/RTCDtlsRole.md)

***

### dtlsState

> **dtlsState**: [`RTCDtlsTransportState`](../type-aliases/RTCDtlsTransportState.md)

***

### iceLocalUsernameFragment?

> `optional` **iceLocalUsernameFragment**: `string`

***

### iceRestarts?

> `optional` **iceRestarts**: `number`

***

### iceRole?

> `optional` **iceRole**: [`RTCIceRole`](../type-aliases/RTCIceRole.md)

***

### iceState?

> `optional` **iceState**: [`RTCIceTransportState`](../type-aliases/RTCIceTransportState.md)

***

### id

> **id**: `string`

#### Inherited from

[`RTCStats`](RTCStats.md).[`id`](RTCStats.md#id)

***

### localCertificateId?

> `optional` **localCertificateId**: `string`

***

### packetsReceived?

> `optional` **packetsReceived**: `number`

***

### packetsSent?

> `optional` **packetsSent**: `number`

***

### remoteCertificateId?

> `optional` **remoteCertificateId**: `string`

***

### rtcpTransportStatsId?

> `optional` **rtcpTransportStatsId**: `string`

***

### selectedCandidatePairChanges?

> `optional` **selectedCandidatePairChanges**: `number`

***

### selectedCandidatePairId?

> `optional` **selectedCandidatePairId**: `string`

***

### srtpCipher?

> `optional` **srtpCipher**: `string`

***

### timestamp

> **timestamp**: `number`

#### Inherited from

[`RTCStats`](RTCStats.md).[`timestamp`](RTCStats.md#timestamp)

***

### tlsVersion?

> `optional` **tlsVersion**: `string`

***

### type

> **type**: `"transport"`

#### Overrides

[`RTCStats`](RTCStats.md).[`type`](RTCStats.md#type)
