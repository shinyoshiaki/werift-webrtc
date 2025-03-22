[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / PeerConfig

# Interface: PeerConfig

## Properties

### bundlePolicy

> **bundlePolicy**: [`BundlePolicy`](../type-aliases/BundlePolicy.md)

***

### codecs

> **codecs**: `Partial`\<`object`\>

#### Type declaration

##### audio

> **audio**: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

When specifying a codec with a fixed payloadType such as PCMU,
it is necessary to set the correct PayloadType in RTCRtpCodecParameters in advance.

##### video

> **video**: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]

***

### debug

> **debug**: `Partial`\<`object`\>

#### Type declaration

##### disableRecvRetransmit

> **disableRecvRetransmit**: `boolean`

##### disableSendNack

> **disableSendNack**: `boolean`

##### inboundPacketLoss

> **inboundPacketLoss**: `number`

%

##### outboundPacketLoss

> **outboundPacketLoss**: `number`

%

##### receiverReportDelay

> **receiverReportDelay**: `number`

ms

***

### dtls

> **dtls**: `Partial`\<`object`\>

#### Type declaration

##### keys

> **keys**: [`DtlsKeys`](../type-aliases/DtlsKeys.md)

***

### forceTurnTCP

> **forceTurnTCP**: `boolean`

***

### headerExtensions

> **headerExtensions**: `Partial`\<`object`\>

#### Type declaration

##### audio

> **audio**: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]

##### video

> **video**: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]

***

### iceAdditionalHostAddresses

> **iceAdditionalHostAddresses**: `undefined` \| `string`[]

Add additional host (local) addresses to use for candidate gathering.
Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.

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

### icePasswordPrefix

> **icePasswordPrefix**: `undefined` \| `string`

***

### icePortRange

> **icePortRange**: `undefined` \| [`number`, `number`]

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

### midSuffix

> **midSuffix**: `boolean`
