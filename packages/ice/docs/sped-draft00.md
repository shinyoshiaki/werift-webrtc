# SPED draft-00 (internal)

Package-private implementation of [draft-hancke-webrtc-sped-00](https://datatracker.ietf.org/doc/html/draft-hancke-webrtc-sped-00) under `src/sped/draft00/`.

Public enablement is **only** `RTCPeerConnection({ sped: true })` (`PeerConfig.sped`, default `false`). This package does not export codepoints, L1/L2, or an `IceOptions.sped` flag.

## Codepoints (IANA)

| Draft name | IANA name | Type |
| --- | --- | --- |
| DTLS-IN-STUN-DATA | META-DTLS-IN-STUN | `0xC070` |
| DTLS-IN-STUN-ACK | META-DTLS-IN-STUN-ACKNOWLEDGEMENT | `0xC071` |

Constants live in `src/sped/draft00/constants.ts` only.

## Session

Per ICE **generation**: `disabled | probing | active | fallback | complete`.

- **L1**: un-ACKed current DTLS flight datagrams (defensive copies). Round-robin one datagram per Binding.
- **L2**: pending CRC-32 values in receive order. A Binding advertises at most 4 (head of the queue). L2 itself may be longer.
- Handshake complete or ICE restart clears L1/L2 and resets round-robin / peerSupport.
- Peer SPED support is decided on the first **current-generation authenticated** Binding: DATA present (including empty) → supported; missing → `fallback`.
- This profile keeps embedding until DTLS handshake complete (does not switch to direct DTLS on nomination alone).

## Fallback

Unsupported peer → send the **original** L1 bytes as direct DTLS on the authenticated 5-tuple (`sendHandshakeDatagram`). Do not rebuild ClientHello.

## Wire order

ACK, then DATA, then HMAC-SHA1 `MESSAGE-INTEGRITY`, then `FINGERPRINT`. Unknown attributes keep parse order (see ice-server `Message` wire list).

## TURN / ICE2

TURN-path SPED and `MESSAGE-INTEGRITY-SHA256` on SPED Bindings are out of scope.
