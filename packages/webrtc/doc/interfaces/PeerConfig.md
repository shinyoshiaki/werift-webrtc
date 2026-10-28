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

> **debug**: [`DebugConfig`](../type-aliases/DebugConfig.md)

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

> **iceAdditionalHostAddresses**: `string`[] \| `undefined`

Add additional host (local) addresses to use for candidate gathering.
Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.

***

### iceCandidatePoolSize

> **iceCandidatePoolSize**: `number`

***

### iceFilterCandidatePair

> **iceFilterCandidatePair**: ((`pair`) => `boolean`) \| `undefined`

***

### iceFilterStunResponse

> **iceFilterStunResponse**: ((`message`, `addr`, `protocol`) => `boolean`) \| `undefined`

If provided, is called on each STUN request.
Return `true` if a STUN response should be sent, false if it should be skipped.

***

### iceInterfaceAddresses

> **iceInterfaceAddresses**: [`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md) \| `undefined`

***

### iceLite

> **iceLite**: `boolean`

Advertise local ICE lite and operate in the controlled role.

***

### icePasswordPrefix

> **icePasswordPrefix**: `string` \| `undefined`

***

### icePortRange

> **icePortRange**: \[`number`, `number`\] \| `undefined`

Minimum port and Maximum port must not be the same value

***

### iceServers

> **iceServers**: [`RTCIceServer`](../type-aliases/RTCIceServer.md)[]

***

### iceStunGatherTimeout

> **iceStunGatherTimeout**: `number` \| `undefined`

Seconds to wait for server-reflexive candidates while gathering.
Defaults to 5 when undefined.

***

### iceTcpPassive

> **iceTcpPassive**: `boolean`

Gather passive (listening) TCP host candidates. Defaults to true.

***

### iceTransportPolicy

> **iceTransportPolicy**: `"relay"` \| `"all"`

***

### iceTurnConnectTimeout

> **iceTurnConnectTimeout**: `number` \| `undefined`

Seconds to wait for a TURN TCP/TLS connection to be established.
Defaults to 8 when undefined.

***

### iceUseIpv4

> **iceUseIpv4**: `boolean`

***

### iceUseIpv6

> **iceUseIpv6**: `boolean`

***

### iceUseLinkLocalAddress

> **iceUseLinkLocalAddress**: `boolean` \| `undefined`

such as google cloud run

***

### iceUseTcp

> **iceUseTcp**: `boolean`

***

### maxMessageSize

> **maxMessageSize**: `number`

Advertised local SCTP max-message-size in SDP. Use 0 for unlimited.

***

### midSuffix

> **midSuffix**: `boolean`

***

### mLineReuse

> **mLineReuse**: [`MLineReuse`](../type-aliases/MLineReuse.md)

How local SDP marks inactive / stopped m-lines. Cannot be changed after construction.
- `"compatible"` (default): an accepted `inactive` m-line keeps a non-zero port.
  Only rejected (no common codec / remote port 0) or stopped m-lines use port 0,
  and only those negotiated port 0 positions are reused by new transceivers.
- `"aggressive"`: legacy behavior. `inactive` m-lines are also written with port 0.

***

### nackRetryWindowMs

> **nackRetryWindowMs**: `number`

Maximum time to request missing RTP packets. Defaults to the historical retry window (~55 ms).

***

### pendingRtp

> **pendingRtp**: `NonNullable`\<`boolean` \| [`PendingRtpOptions`](../type-aliases/PendingRtpOptions.md) \| `undefined`\>

Queue outbound RTP on each sender until DTLS is connected.
Disabled by default. Pass `true` or `{ enabled: true, maxLength }` to buffer.

***

### rtcpMuxPolicy

> **rtcpMuxPolicy**: `"require"`

***

### rtpHistorySize

> **rtpHistorySize**: `number`

Number of recent RTP packets retained by each sender for retransmission. Defaults to 128.

***

### sctp

> **sctp**: `object`

SCTP outbound packet MTU used for DATA chunk fragmentation.

#### mtu

> **mtu**: `number`

***

### turnTlsOptions

> **turnTlsOptions**: [`TlsConnectionOptions`](../type-aliases/TlsConnectionOptions.md) \| `undefined`

***

### turnTransport

> **turnTransport**: `"tcp"` \| `"tls"` \| `"udp"` \| `undefined`

***

### turnUdpFamily

> **turnUdpFamily**: `4` \| `6` \| `undefined`

Preferred IP family of the TURN/UDP socket, applied only when the TURN
server is a hostname. Ignored for an IP literal server, whose own family
always selects the socket. Defaults to 4 when undefined.
