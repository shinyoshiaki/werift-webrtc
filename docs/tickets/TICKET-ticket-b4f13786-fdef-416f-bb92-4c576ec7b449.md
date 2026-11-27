## Problem
Downstream gifos-app reports missing Node participant audio because addTrack reuses a previously negotiated trackless sending transceiver reserved for another stream: https://github.com/nwcnwc/gifos-app/commit/4573b1a5d1834af4beb972755aafb478dbcdbe94 . Its workaround marks transceivers with negotiated sendonly/sendrecv as usedForSender.

## Current develop
In [rtpTransceiver.ts](https://github.com/shinyoshiaki/werift-webrtc/blob/develop/packages/webrtc/src/media/rtpTransceiver.ts), setCurrentDirection only sets usedForSender when sender.track exists, whereas [transceiverManager.ts](https://github.com/shinyoshiaki/werift-webrtc/blob/develop/packages/webrtc/src/transceiverManager.ts) uses !usedForSender to decide addTrack reuse. setDirection also marks the flag based on previous currentDirection, but that does not cover every negotiation path.

WebRTC addTrack requires that the sender has never been used to send, defined by whether currentDirection has ever been sendrecv or sendonly, not whether a track existed. https://w3c.github.io/webrtc-pc/#dom-rtcpeerconnection-addtrack

## Proposed fix
- Record negotiated sending-direction history independently of sender.track. Keep it sticky across subsequent recvonly/inactive and replaceTrack(null).
- Review provisional answers and rollback against WebRTC/JSEP semantics; do not accidentally lose committed history or confuse desired direction with negotiated direction.
- Preserve reuse of genuinely never-sending, eligible trackless transceivers; do not change explicit replaceTrack behavior.

## Regression tests
- Negotiate a trackless sendonly or sendrecv transceiver, then addTrack of the same kind; verify a different eligible sender/transceiver is used (or a new one is created).
- Repeat after renegotiating to inactive/recvonly and after replaceTrack(null).
- Verify a never-sending recvonly/inactive transceiver is still reusable when otherwise eligible.
- Cover local/remote answer paths and provisional answer/rollback; compare with browser behavior and verify MID/MSID routing after renegotiation.

Static inspection supports the defect; a standalone reproduction against develop has not yet been run. Related #817/#821 concern rollback of an addTrack-associated transceiver, not this reuse eligibility condition.