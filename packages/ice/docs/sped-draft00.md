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
- **L2**: pending CRC-32 values in receive order, **deduplicated**. A Binding advertises at most 4 (head of the queue) and then **consumes** those entries; remainder is carried to the next Binding. Duplicate DATA still reaches DTLS inject (replay), but does not grow L2.
- Handshake complete or ICE restart clears L1/L2 and resets round-robin / peerSupport. Restart while DTLS is still `connecting` reseeds the current flight into the new generation L1; restart after DTLS `connected` marks SPED `complete` and returns the carrier to internal retransmission.
- Incoming authenticated Bindings and `inject` are dropped when `generation` does not match the live session (ICE restart must not apply a stale handshake). In-flight connectivity-check transactions are abandoned, and `checkStart` ignores responses after a generation / checkList mismatch.
- Extra L1 carry Bindings (`flushSpedCarry`) are Full-ICE only: ICE-Lite never originates Binding Requests, carry is suppressed while an incoming Binding is being answered, and a timed-out carry does not immediately re-arm.
- Direct DTLS on `IceSpedTransport` is taken only from the internal datagram event (`connectionDatagramEvent`, not a public `Connection` member) when the context is authenticated, current-generation, and the source matches the pair 5-tuple. Authentication matches handshake send: nominated / SUCCEEDED / Binding Response received / **Binding Request received** (WAITING pair after an authenticated request). Public `onData(Buffer)` is unchanged.
- DTLS error, DTLS close during handshake, ICE `failed` / `closed`, and `Connection.close` call `SpedRuntime.abort()`: `state = disabled`, L1/L2/round-robin cleared, pending injects invalidated, carrier timers cancelled, `embedding === false`. ICE restart `reset()` returns to `probing`.
- Peer SPED support is decided on the first **current-generation authenticated** Binding: DATA present (including empty) → supported; missing → `fallback`.
- This profile keeps embedding until DTLS handshake complete (does not switch to direct DTLS on nomination alone).

## Fallback

Unsupported peer → send the **original** L1 bytes as direct DTLS on the authenticated 5-tuple. Do not rebuild ClientHello.

## Wire order

ACK, then DATA, then HMAC-SHA1 `MESSAGE-INTEGRITY`, then `FINGERPRINT`. Unknown attributes keep parse order (see ice-server `Message` wire list).

## TURN / ICE2

TURN-path SPED and `MESSAGE-INTEGRITY-SHA256` on SPED Bindings are out of scope.
