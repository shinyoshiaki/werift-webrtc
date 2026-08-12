[**werift**](../README.md)

***

[werift](../globals.md) / PeerIdentityMode

# Type Alias: PeerIdentityMode

> **PeerIdentityMode**: `"datagram-address"` \| `"authenticated-single-peer"`

How the DTLS association identifies the remote peer for TX/RX lifecycle.

- `"datagram-address"` — classic UDP return-routability: pin the 5-tuple after
  cookie/connect; RX from other addresses is dropped; addressless RX is not
  accepted once pinned.
- `"authenticated-single-peer"` — the transport path already authenticates a
  single peer (ICE / equivalent). Addressless RX is valid; a UDP pin is
  optional TX convenience, not the authentication boundary.

Distinct from [Options.addressValidation](../interfaces/Options.md#addressvalidation) (HelloVerify / cookie policy).
