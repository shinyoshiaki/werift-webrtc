[**werift**](../README.md)

***

[werift](../globals.md) / RTCPeerConnectionConfig

# Type Alias: RTCPeerConnectionConfig

> **RTCPeerConnectionConfig** = `Partial`\<`Omit`\<[`PeerConfig`](../interfaces/PeerConfig.md), `"bundlePolicy"` \| `"rtcpMuxPolicy"` \| `"iceCandidatePoolSize"` \| `"certificates"` \| `"sctp"` \| `"certificateScope"` \| `"mLineReuse"` \| `"keyFrameRequestRouting"`\>\> & `RTCPeerConnectionRTCConfiguration` & `object`

## Type Declaration

### certificateScope?

> `optional` **certificateScope?**: [`CertificateScope`](CertificateScope.md) \| [`DeprecatedCertificateScope`](DeprecatedCertificateScope.md)

See [PeerConfig.certificateScope](../interfaces/PeerConfig.md#certificatescope).

### keyFrameRequestRouting?

> `optional` **keyFrameRequestRouting?**: [`KeyFrameRequestRouting`](KeyFrameRequestRouting.md) \| [`DeprecatedKeyFrameRequestRouting`](DeprecatedKeyFrameRequestRouting.md)

See [PeerConfig.keyFrameRequestRouting](../interfaces/PeerConfig.md#keyframerequestrouting).

### mLineReuse?

> `optional` **mLineReuse?**: [`MLineReuse`](MLineReuse.md) \| [`DeprecatedMLineReuse`](DeprecatedMLineReuse.md)

See [PeerConfig.mLineReuse](../interfaces/PeerConfig.md#mlinereuse).

### sctp?

> `optional` **sctp?**: [`RTCSctpConfiguration`](../interfaces/RTCSctpConfiguration.md)
