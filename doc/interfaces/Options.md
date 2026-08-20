[**werift**](../README.md)

***

[werift](../globals.md) / Options

# Interface: Options

## Properties

### addressValidation?

> `optional` **addressValidation**: `"dtls-cookie"` \| `"ice-authenticated"` \| `"none"`

Address validation policy for the server.
Default for generic DTLS: `"dtls-cookie"`.
WebRTC ICE-authenticated peers use `"ice-authenticated"` (Epic 2/3).

***

### cert?

> `optional` **cert**: `string`

***

### certificateRequest?

> `optional` **certificateRequest**: `boolean`

***

### extendedMasterSecret?

> `optional` **extendedMasterSecret**: `boolean`

***

### key?

> `optional` **key**: `string`

***

### maxEarlyAppDataBytes?

> `optional` **maxEarlyAppDataBytes**: `number`

Max bytes of epoch-3 application data buffered before `onConnect`.
Default 256 KiB. Raise together with `maxEarlyAppDataRecords` when
buffering larger DataChannel messages.

***

### maxEarlyAppDataRecords?

> `optional` **maxEarlyAppDataRecords**: `number`

Max epoch-3 application-data records buffered before `onConnect`
(UDP reorder / 0.5-RTT early server data).
Default 256 — sized for WebRTC DataChannel (64 KiB `maxMessageSize`
plus SCTP control and reorder burst). Override to match a larger
DataChannel `maxMessageSize`.

***

### mtu?

> `optional` **mtu**: `number`

DTLS 1.3 carrier MTU hint for handshake fragmentation (bytes).

***

### namedGroups?

> `optional` **namedGroups**: readonly [`NamedCurveAlgorithms`](../type-aliases/NamedCurveAlgorithms.md)[]

DTLS 1.3 named groups preference order (key_share).
Default: X25519 then P-256. Use `[NamedCurveAlgorithm.secp256r1_23]` for P-256 only.

***

### peerIdentityMode?

> `optional` **peerIdentityMode**: [`PeerIdentityMode`](../type-aliases/PeerIdentityMode.md)

Peer-identity policy for association TX/RX lifecycle.
Default (when omitted): inferred as `"authenticated-single-peer"` when
`transport.peerAuthenticated` or `addressValidation: "ice-authenticated"`,
otherwise `"datagram-address"`.

Prefer setting this explicitly for custom carriers / ICE so call sites do
not depend on inference.

***

### protocolVersions?

> `optional` **protocolVersions**: readonly [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

Protocol versions in **preference order** (first = highest priority).
Default: `[DtlsVersion.V1_2]` (backward compatible).
DTLS 1.3 requires explicit opt-in.

Supported configurations:
- `[V1_2]` — DTLS 1.2 only (default)
- `[V1_3]` — DTLS 1.3 only
- `[V1_3, V1_2]` — prefer DTLS 1.3; fall back to 1.2-only peers

`[V1_2, V1_3]` is normalized to `[V1_3, V1_2]`. A 1.2-first dual is not
viable under RFC 8446/9147 downgrade protection (DOWNGRD): dual×dual peers
cannot complete a deliberate 1.2 selection without aborting.

Both roles use the same association version-selection semantics:
first local preference that appears in the peer's supported set.
ClientHello `supported_versions` is advertised in this order.

***

### signatureHash?

> `optional` **signatureHash**: [`SignatureHash`](../type-aliases/SignatureHash.md)

***

### srtpProfiles?

> `optional` **srtpProfiles**: (`1` \| `7`)[]

***

### transport

> **transport**: [`Transport`](Transport.md)
