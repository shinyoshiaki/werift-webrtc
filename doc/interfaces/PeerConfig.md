[**werift**](../README.md)

***

[werift](../globals.md) / PeerConfig

# Interface: PeerConfig

## Properties

### bundlePolicy

> **bundlePolicy**: [`BundlePolicy`](../type-aliases/BundlePolicy.md)

***

### certificates

> **certificates**: [`RTCCertificate`](../classes/RTCCertificate.md)[]

***

### codecs

> **codecs**: `Partial`\<\{ `audio`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]; `video`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]; \}\>

***

### debug

> **debug**: `Partial`\<\{ `disableRecvRetransmit`: `boolean`; `disableSendNack`: `boolean`; `inboundPacketLoss`: `number`; `outboundPacketLoss`: `number`; `receiverReportDelay`: `number`; \}\>

***

### dtls

> **dtls**: `Partial`\<\{ `keys`: [`DtlsKeys`](../type-aliases/DtlsKeys.md); \}\>

***

### ~~forceTurnTCP~~

> **forceTurnTCP**: `boolean`

#### Deprecated

Prefer turn URL transport parameters or turnTransport.

***

### headerExtensions

> **headerExtensions**: `Partial`\<\{ `audio`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]; `video`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]; \}\>

***

### iceAdditionalHostAddresses

> **iceAdditionalHostAddresses**: `undefined` \| `string`[]

Add additional host (local) addresses to use for candidate gathering.
Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.

***

### iceCandidatePoolSize

> **iceCandidatePoolSize**: `number`

***

### iceFilterCandidatePair

> **iceFilterCandidatePair**: `undefined` \| (`pair`) => `boolean`

***

### iceFilterStunResponse

> **iceFilterStunResponse**: `undefined` \| (`message`, `addr`, `protocol`) => `boolean`

If provided, is called on each STUN request.
Return `true` if a STUN response should be sent, false if it should be skipped.

***

### iceInterfaceAddresses

> **iceInterfaceAddresses**: `undefined` \| [`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

***

### iceLite

> **iceLite**: `boolean`

Advertise local ICE lite and operate in the controlled role.

***

### icePasswordPrefix

> **icePasswordPrefix**: `undefined` \| `string`

***

### icePortRange

> **icePortRange**: `undefined` \| \[`number`, `number`\]

Minimum port and Maximum port must not be the same value

***

### iceServers

> **iceServers**: [`RTCIceServer`](../type-aliases/RTCIceServer.md)[]

***

### iceTransportPolicy

> **iceTransportPolicy**: `"relay"` \| `"all"`

***

### iceUseIpv4

> **iceUseIpv4**: `boolean`

***

### iceUseIpv6

> **iceUseIpv6**: `boolean`

***

### iceUseLinkLocalAddress

> **iceUseLinkLocalAddress**: `undefined` \| `boolean`

such as google cloud run

***

### maxMessageSize

> **maxMessageSize**: `number`

Advertised local SCTP max-message-size in SDP. Use 0 for unlimited.

***

### midSuffix

> **midSuffix**: `boolean`

***

### rtcpMuxPolicy

> **rtcpMuxPolicy**: `"require"`

***

### turnTlsOptions

> **turnTlsOptions**: `undefined` \| [`TlsConnectionOptions`](../type-aliases/TlsConnectionOptions.md)

***

### turnTransport

> **turnTransport**: `undefined` \| `"tcp"` \| `"tls"` \| `"udp"`
