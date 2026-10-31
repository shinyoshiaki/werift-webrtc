[**werift**](../README.md)

***

[werift](../globals.md) / RTCIceCandidateFields

# Interface: RTCIceCandidateFields

The readonly fields `RTCIceCandidate` exposes from its candidate a-line.

Validity contract shared by every path that produces them
(`new RTCIceCandidate(init)`, `RTCIceCandidate.fromSdp()`,
`IceCandidate.fromJSON()` / `IceCandidate.toJSON()` and therefore the
`icecandidate` event and `RTCIceTransport.getSelectedCandidatePair()` /
`getLocalCandidates()` / `getRemoteCandidates()`).

1. Grammar (RFC 8839 §5.1). The attribute value, with at most one leading
   `candidate:` removed, is split on single spaces; an empty token
   (leading / trailing / repeated space) or a token containing other
   whitespace is invalid. Elements:

   | element | valid when |
   | --- | --- |
   | foundation | 1-32 `ice-char` (`A-Z a-z 0-9 + /`) |
   | component-id | integer 1-256 |
   | transport | non-empty token |
   | priority | integer 1-2^31-1 (RFC 8445 §5.1.2) |
   | connection-address | IPv4, IPv6 or FQDN (includes mDNS `.local`); a dotted all-digit name must be IPv4 |
   | port | integer 0-65535 |
   | `typ` + candidate-types | the literal `typ` followed by a non-empty token |
   | `raddr` | connection-address |
   | `rport` | integer 0-65535 |
   | `tcptype` | `active` / `passive` / `so` |
   | `generation` | non-negative integer |
   | other extension attributes | name and value tokens, in pairs (`network-id`, `network-cost`, `ufrag`, ...) |

   A grammar violation makes the candidate unparsable: every field is `null`
   and `IceCandidate.fromJSON()` returns `undefined`, so
   `addIceCandidate()` rejects with `OperationError`.
2. Mapping to the W3C attributes (constructor steps 4.2 / 4.3). If a parsed
   value cannot be represented by its attribute, parsing is aborted and every
   field is `null`: component-id other than 1 (`rtp`) / 2 (`rtcp`) (e.g. 3 is
   valid RFC 8839 but has no `RTCIceComponent`), transport other than
   `udp` / `tcp` (case-insensitive), or a candidate type other than
   `host` / `srflx` / `prflx` / `relay`.
3. `tcpType` alone is `null` when `protocol` is not `tcp`
   (it is "null if protocol is not tcp", not an invalid value).
   `relatedAddress` / `relatedPort` are `null` when absent.

4. Candidates werift holds as typed values (`IceCandidate.toJSON()`, used by
   the `icecandidate` event and the `RTCIceTransport` getters) are checked
   with the same element validators instead of reparsing the string. a=candidate
   lines of a remote description keep using the description parser; for
   those the fields are validated from the values the ICE agent uses.

Not adopted: the W3C constructor TypeError when both `sdpMid` and
`sdpMLineIndex` are null (werift keeps its convenience behavior; strict
checks belong in the WPT runner wrappers). `relayProtocol` and `url` are not
implemented.

## Properties

### address

> **address**: `string` \| `null`

***

### component

> **component**: [`RTCIceComponent`](../type-aliases/RTCIceComponent.md) \| `null`

***

### foundation

> **foundation**: `string` \| `null`

***

### port

> **port**: `number` \| `null`

***

### priority

> **priority**: `number` \| `null`

***

### protocol

> **protocol**: [`RTCIceProtocol`](../type-aliases/RTCIceProtocol.md) \| `null`

***

### relatedAddress

> **relatedAddress**: `string` \| `null`

***

### relatedPort

> **relatedPort**: `number` \| `null`

***

### tcpType

> **tcpType**: [`RTCIceTcpCandidateType`](../type-aliases/RTCIceTcpCandidateType.md) \| `null`

***

### type

> **type**: [`RTCIceCandidateType`](../type-aliases/RTCIceCandidateType.md) \| `null`
