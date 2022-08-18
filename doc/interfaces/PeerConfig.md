[werift](../README.md) / [Exports](../modules.md) / PeerConfig

# Interface: PeerConfig

## Table of contents

### Properties

- [bundlePolicy](PeerConfig.md#bundlepolicy)
- [codecs](PeerConfig.md#codecs)
- [debug](PeerConfig.md#debug)
- [dtls](PeerConfig.md#dtls)
- [headerExtensions](PeerConfig.md#headerextensions)
- [iceInterfaceAddresses](PeerConfig.md#iceinterfaceaddresses)
- [icePortRange](PeerConfig.md#iceportrange)
- [iceServers](PeerConfig.md#iceservers)
- [iceTransportPolicy](PeerConfig.md#icetransportpolicy)

## Properties

### bundlePolicy

• **bundlePolicy**: [`BundlePolicy`](../modules.md#bundlepolicy)

___

### codecs

• **codecs**: `Partial`<{ `audio`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[] ; `video`: [`RTCRtpCodecParameters`](../classes/RTCRtpCodecParameters.md)[]  }\>

___

### debug

• **debug**: `Partial`<{ `disableRecvRetransmit`: `boolean` ; `disableSendNack`: `boolean` ; `inboundPacketLoss`: `number` ; `outboundPacketLoss`: `number` ; `receiverReportDelay`: `number`  }\>

___

### dtls

• **dtls**: `Partial`<{ `keys`: [`DtlsKeys`](../modules.md#dtlskeys)  }\>

___

### headerExtensions

• **headerExtensions**: `Partial`<{ `audio`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[] ; `video`: [`RTCRtpHeaderExtensionParameters`](../classes/RTCRtpHeaderExtensionParameters.md)[]  }\>

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
