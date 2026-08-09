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

### mtu?

> `optional` **mtu**: `number`

DTLS 1.3 carrier MTU hint for handshake fragmentation (bytes).

***

### namedGroups?

> `optional` **namedGroups**: readonly [`NamedCurveAlgorithms`](../type-aliases/NamedCurveAlgorithms.md)[]

DTLS 1.3 named groups preference order (key_share).
Default: X25519 then P-256. Use `[NamedCurveAlgorithm.secp256r1_23]` for P-256 only.

***

### protocolVersions?

> `optional` **protocolVersions**: readonly [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

Protocol versions in preference order.
Default: `[DtlsVersion.V1_2]` (backward compatible).
DTLS 1.3 requires explicit opt-in.

Epic 1 supported dual pattern is **`[V1_3, V1_2]` only**.
`[V1_2, V1_3]` is rejected (fail-fast) — full 1.2-first dual with
downgrade-sentinel server semantics is out of scope for Epic 1.
Single-version lists `[V1_3]` / `[V1_2]` are always accepted.

***

### signatureHash?

> `optional` **signatureHash**: [`SignatureHash`](../type-aliases/SignatureHash.md)

***

### srtpProfiles?

> `optional` **srtpProfiles**: (`1` \| `7`)[]

***

### transport

> **transport**: [`Transport`](Transport.md)
