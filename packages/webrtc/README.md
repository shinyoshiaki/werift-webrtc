# werift

werift (**We**b**R**TC **I**mplementation **f**or **T**ypeScript) is a WebRTC implementation for Node.js written in TypeScript.

For the project overview, current features, examples, architecture, and interoperability information, see the [repository README](../../README.md).

## Install

```sh
npm install werift
```

## Development setup

Initialize the pinned upstream WPT checkout before running the package-level WPT tooling:

```sh
git submodule update --init --recursive
```

Run the allowlisted upstream WPT subset and coverage from the repository root or from this package:

```sh
npm run wpt --workspace packages/webrtc
npm run wpt:coverage --workspace packages/webrtc
```

Refresh the committed baselines when intentionally expanding upstream coverage:

```sh
npm run wpt --workspace packages/webrtc -- --update-baseline
WPT_UPDATE_COVERAGE_BASELINE=1 npm run wpt:coverage --workspace packages/webrtc
```

## Documentation

- [Website](https://shinyoshiaki.github.io/werift-webrtc/website/build/)
- [API Reference](https://shinyoshiaki.github.io/werift-webrtc/website/build/docs/api)
- [Examples](../../examples)

## Demos

### MediaChannel

From the repository root:

```sh
npm run media
```

Open:

https://shinyoshiaki.github.io/werift-webrtc/examples/mediachannel/pubsub/answer

Use the browser console and `chrome://webrtc-internals/` for inspection.

### DataChannel

From the repository root:

```sh
npm run datachannel
```

Open:

https://shinyoshiaki.github.io/werift-webrtc/examples/datachannel/answer

## Current implementation highlights

- STUN and TURN relay support, including TURN control transports over UDP, TCP, and TLS
- Full ICE, trickle ICE, ICE-Lite support/interoperability, ICE restart, and ICE-TCP
- DTLS-SRTP, SRTP, and SRTCP
- DataChannel over SCTP/DTLS
- Media sendonly / recvonly / sendrecv and multiple tracks
- RTP/RTCP feedback including SR/RR, PLI, REMB, Generic NACK, and Transport-Wide CC
- RTX and RED
- Receive-side simulcast
- Sender-side bandwidth estimation
- W3C-oriented `getStats()` reporting
- W3C compatibility work backed by an allowlisted upstream WPT runner

See the [repository README](../../README.md#protocol-coverage-at-a-glance) for the broader feature checklist.

## Interoperability

The repository contains Chromium-focused browser E2E tests and a Firefox test runner. Safari interoperability is also community-verified: users have reported extensive real-world use with Safari in [Issue #346](https://github.com/shinyoshiaki/werift-webrtc/issues/346). Safari is not currently part of the automated browser E2E matrix, so this is community validation rather than a CI guarantee.

werift also participates in the independent [`sipsorcery/webrtc-interop`](https://github.com/sipsorcery/webrtc-interop) Peer Connection and Data Channel Echo matrices.

## RTCPeerConnection W3C compatibility notes

API reference markdown can be regenerated with:

```sh
cd packages/webrtc && npm run doc
```

The implementation intentionally keeps some historical werift behavior where changing it would be backward-incompatible. The WPT runner can apply stricter compatibility shims where noted.

| Status | API | Notes |
| --- | --- | --- |
| Added | `currentLocalDescription`, `pendingLocalDescription`, `currentRemoteDescription`, `pendingRemoteDescription`, `canTrickleIceCandidates`, `sctp` | Public getters expose W3C-style pending/current description, SCTP, and can-trickle state. |
| Added | `setLocalDescription()` input compatibility | Accepts omitted `type`, empty `sdp`, and provisional `pranswer`. |
| Added | `setRemoteDescription()` input compatibility | Accepts `pranswer` and `rollback`, updating pending/current descriptions accordingly. |
| Added with backward-compatible difference | `addIceCandidate()` | Accepts omitted input, `null`, and `{ candidate: "" }` as end-of-candidates; validates `sdpMid` / `sdpMLineIndex` / `usernameFragment`; updates the matching remote m-section; and rejects malformed candidate strings. The public API preserves werift's historical behavior of buffering candidates received before `remoteDescription`; the WPT runner uses a strict shim where spec-style pre-SRD rejection is required. |
| Added | `RTCConfiguration` compatibility | Accepts `iceServers`, `iceTransportPolicy`, `bundlePolicy`, `rtcpMuxPolicy: "require"`, `iceCandidatePoolSize: 0`, and `certificates`; `setConfiguration(getConfiguration())` round-trips without changing certificates. |
| Deferred | `bundlePolicy: "balanced"` round-trip | `"balanced"` is accepted for input compatibility but normalized to werift's `"max-compat"` behavior, so `getConfiguration()` returns `"max-compat"`. |
| Added | `RTCIceServer.urls: string \| string[]` | Arrays are accepted and parsed in order. |
| Added | Standard event names | `signalingstatechange`, `iceconnectionstatechange`, `icegatheringstatechange`, `connectionstatechange`, `negotiationneeded`, `icecandidate`, `track`, and `datachannel` are emitted for `addEventListener`. |
| Not implemented | Legacy callback overloads | Intentionally out of scope as legacy browser APIs. |
| Not implemented | `addStream`, `removeStream`, `createDTMFSender` | Obsolete APIs; use track/transceiver/sender APIs instead. |
| Deferred | `close()` return type | Remains async for backward compatibility even though the W3C API is synchronous. |
| Deferred | `setLocalDescription()` return type | Non-rollback calls still return the applied `SessionDescription` instead of `Promise<void>` for backward compatibility; local rollback resolves with `undefined`. |
| Compatible | `setRemoteDescription()` return type | Resolves `Promise<void>` like the W3C API. |
| Deferred | `RTCPeerConnection.generateCertificate()` | `RTCCertificate` and `RTCConfiguration.certificates` are supported, but the static W3C helper is not implemented. |

## Roadmap

Current work is focused on:

- improving documentation and WPT coverage
- closing remaining browser `RTCPeerConnection` API compatibility gaps
- simulcast send support
- additional cipher suites
- richer WebRTC statistics coverage
- continued unit, E2E, interoperability, and long-running reliability testing

## References

- [aiortc](https://github.com/aiortc/aiortc)
- [Pion WebRTC](https://github.com/pion/webrtc)
- [sipsorcery/webrtc-interop](https://github.com/sipsorcery/webrtc-interop)
