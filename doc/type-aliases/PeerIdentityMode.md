[**werift**](../README.md)

***

[werift](../globals.md) / PeerIdentityMode

# Type Alias: PeerIdentityMode

> **PeerIdentityMode**: `"datagram-address"` \| `"authenticated-single-peer"`

How the association identifies the remote peer for TX/RX lifecycle.
Shared by DTLS 1.2 association (Options) and DTLS 1.3 engine.

- `"datagram-address"` — UDP 5-tuple pin after cookie/connect
- `"authenticated-single-peer"` — transport path is the identity (ICE);
  addressless and non-matching 5-tuples do not drop authenticated RX
