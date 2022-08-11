[werift](../README.md) / [Exports](../modules.md) / PeerConfig

# Interface: PeerConfig

## Table of contents

### Properties

- [bundlePolicy](PeerConfig.md#bundlepolicy)
- [codecs](PeerConfig.md#codecs)
- [debug](PeerConfig.md#debug)
- [dtls](PeerConfig.md#dtls)
- [headerExtensions](PeerConfig.md#headerextensions)
- [icePortRange](PeerConfig.md#iceportrange)
- [iceServers](PeerConfig.md#iceservers)
- [iceTransportPolicy](PeerConfig.md#icetransportpolicy)

## Properties

### bundlePolicy

• **bundlePolicy**: [`BundlePolicy`](../modules.md#bundlepolicy)

#### Defined in

[packages/webrtc/src/peerConnection.ts:1487](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1487)

___

### codecs

• **codecs**: `Partial`<{ `audio`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[] ; `video`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]  }\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:1468](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1468)

___

### debug

• **debug**: `Partial`<{ `inboundPacketLoss`: `number` ; `outboundPacketLoss`: `number` ; `receiverReportDelay`: `number`  }\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:1488](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1488)

___

### dtls

• **dtls**: `Partial`<{ `keys`: [`DtlsKeys`](../modules.md#dtlskeys)  }\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:1484](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1484)

___

### headerExtensions

• **headerExtensions**: `Partial`<{ `audio`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[] ; `video`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]  }\>

#### Defined in

[packages/webrtc/src/peerConnection.ts:1476](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1476)

___

### icePortRange

• **icePortRange**: `undefined` \| [`number`, `number`]

Minimum port and Maximum port must not be the same value

#### Defined in

[packages/webrtc/src/peerConnection.ts:1483](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1483)

___

### iceServers

• **iceServers**: [`RTCIceServer`](../modules.md#rtciceserver)[]

#### Defined in

[packages/webrtc/src/peerConnection.ts:1481](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1481)

___

### iceTransportPolicy

• **iceTransportPolicy**: ``"relay"`` \| ``"all"``

#### Defined in

[packages/webrtc/src/peerConnection.ts:1480](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/peerConnection.ts#L1480)
