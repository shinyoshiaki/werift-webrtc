[**werift**](../README.md)

***

[werift](../globals.md) / TransceiverMediaSnapshot

# Interface: TransceiverMediaSnapshot

## Properties

### codecs

> **codecs**: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

***

### currentDirection

> **currentDirection**: `null` \| [`CurrentDirection`](../type-aliases/CurrentDirection.md)

***

### direction

> **direction**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### dtlsTransport?

> `optional` **dtlsTransport**: [`RTCDtlsTransport`](../classes/RTCDtlsTransport.md)

***

### headerExtensions

> **headerExtensions**: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]

***

### mid

> **mid**: `null` \| `string`

***

### mLineIndex

> **mLineIndex**: `undefined` \| `number`

***

### offerDirection

> **offerDirection**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### receiver

> **receiver**: [`RtpReceiverMediaSnapshot`](RtpReceiverMediaSnapshot.md)

***

### rejected

> **rejected**: `boolean`

***

### sender

> **sender**: [`RtpSenderMediaSnapshot`](RtpSenderMediaSnapshot.md)

***

### transceiver

> **transceiver**: [`RTCRtpTransceiver`](../classes/RTCRtpTransceiver.md)

***

### usedForSender

> **usedForSender**: `boolean`
