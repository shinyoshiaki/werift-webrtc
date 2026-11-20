[**werift**](../README.md)

***

[werift](../globals.md) / PeerIdentityMode

# Type Alias: PeerIdentityMode

> **PeerIdentityMode** = `"datagram-address"` \| `"authenticated-single-peer"` \| `"unpinned"`

How the association identifies the remote peer for TX/RX lifecycle.

- `"datagram-address"` — UDP 5-tuple pin after cookie/connect: datagrams
  from another source are dropped and TX goes to the pinned peer
- `"authenticated-single-peer"` — transport path is the identity (ICE);
  addressless and non-matching 5-tuples do not drop authenticated RX
- `"unpinned"` — DTLS 1.2 only: no pin. Every source is processed and TX
  follows the transport's last remote address (the behavior before the
  association pin). A DTLS 1.3 engine always uses `"datagram-address"`
  instead.
