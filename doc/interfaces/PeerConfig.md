[werift](../README.md) / [Exports](../modules.md) / PeerConfig

# Interface: PeerConfig

## Table of contents

### Properties

- [bundlePolicy](PeerConfig.md#bundlepolicy)
- [codecs](PeerConfig.md#codecs)
- [debug](PeerConfig.md#debug)
- [dtls](PeerConfig.md#dtls)
- [headerExtensions](PeerConfig.md#headerextensions)
- [iceAdditionalHostAddresses](PeerConfig.md#iceadditionalhostaddresses)
- [iceFilterCandidatePair](PeerConfig.md#icefiltercandidatepair)
- [iceFilterStunResponse](PeerConfig.md#icefilterstunresponse)
- [iceInterfaceAddresses](PeerConfig.md#iceinterfaceaddresses)
- [icePortRange](PeerConfig.md#iceportrange)
- [iceServers](PeerConfig.md#iceservers)
- [iceTransportPolicy](PeerConfig.md#icetransportpolicy)
- [iceUseIpv4](PeerConfig.md#iceuseipv4)
- [iceUseIpv6](PeerConfig.md#iceuseipv6)
- [midSuffix](PeerConfig.md#midsuffix)

## Properties

### bundlePolicy

• **bundlePolicy**: [`BundlePolicy`](../modules.md#bundlepolicy)

___

### codecs

• **codecs**: `Partial`\<\{ `audio`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[] ; `video`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]  }\>

___

### debug

• **debug**: `Partial`\<\{ `disableRecvRetransmit`: `boolean` ; `disableSendNack`: `boolean` ; `inboundPacketLoss`: `number` ; `outboundPacketLoss`: `number` ; `receiverReportDelay`: `number`  }\>

___

### dtls

• **dtls**: `Partial`\<\{ `keys`: [`DtlsKeys`](../modules.md#dtlskeys)  }\>

___

### headerExtensions

• **headerExtensions**: `Partial`\<\{ `audio`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[] ; `video`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]  }\>

___

### iceAdditionalHostAddresses

• **iceAdditionalHostAddresses**: `undefined` \| `string`[]

Add additional host (local) addresses to use for candidate gathering.
Notably, you can include hosts that are normally excluded, such as loopback, tun interfaces, etc.

___

### iceFilterCandidatePair

• **iceFilterCandidatePair**: `undefined` \| (`pair`: [`CandidatePair`](../classes/CandidatePair.md)) => `boolean`

___

### iceFilterStunResponse

• **iceFilterStunResponse**: `undefined` \| (`message`: `Message`, `addr`: readonly [`string`, `number`], `protocol`: [`Protocol`](Protocol.md)) => `boolean`

If provided, is called on each STUN request.
Return `true` if a STUN response should be sent, false if it should be skipped.

___

### iceInterfaceAddresses

• **iceInterfaceAddresses**: `undefined` \| [`InterfaceAddresses`](../modules.md#interfaceaddresses)

___

### icePortRange

• **icePortRange**: `undefined` \| [`number`, `number`]

Minimum port and Maximum port must not be the same value

___

### iceServers

• **iceServers**: [`RTCIceServer`](../modules.md#rtciceserver)[]

___

### iceTransportPolicy

• **iceTransportPolicy**: ``"relay"`` \| ``"all"``

___

### iceUseIpv4

• **iceUseIpv4**: `boolean`

___

### iceUseIpv6

• **iceUseIpv6**: `boolean`

___

### midSuffix

• **midSuffix**: `boolean`
