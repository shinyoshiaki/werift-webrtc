# Browser API compatibility

werift provides a browser-compatible WebRTC API for Node.js. Applications can use familiar browser WebRTC primitives such as `RTCPeerConnection`, `MediaStreamTrack`, `RTCDataChannel`, offer/answer negotiation, ICE candidates, transceivers, standard events, and `getStats()` while retaining access to werift's lower-level protocol APIs.

The implementation tracks the W3C WebRTC API closely and is exercised with an allowlisted upstream Web Platform Tests (WPT) runner. This document records the remaining intentional or known differences from browser behavior so the main README can describe the normal API surface without mixing it with edge-case compatibility details.

## Remaining differences

| Area | werift behavior | Browser / W3C behavior | Reason / status |
| --- | --- | --- | --- |
| `addIceCandidate()` before `remoteDescription` | Candidates are buffered and applied after `setRemoteDescription()` | The spec rejects this ordering | Preserved for backward compatibility. The WPT runner applies a strict shim where required. |
| `bundlePolicy: "balanced"` | Accepted, then normalized to werift's `"max-compat"` behavior; `getConfiguration()` returns `"max-compat"` | Browsers preserve `"balanced"` | Compatibility input is accepted, but the internal transport model currently uses werift's existing policy. |
| `iceCandidatePoolSize` | `0` is supported; values greater than `0` are rejected | Browsers may support candidate pooling | Candidate pooling is not implemented. |
| `RTCPeerConnection.close()` | Async for historical API compatibility | Browser API is synchronous and returns `undefined` | Intentional backward-compatible return-type difference. |
| `setLocalDescription()` | Non-rollback calls return the applied `SessionDescription` | Browser API resolves `Promise<void>` | Intentional backward-compatible return-type difference. The rollback path resolves with `undefined`. |
| `RTCPeerConnection.generateCertificate()` | Not implemented as the static browser helper | Defined by the browser API | `RTCCertificate` and `RTCConfiguration.certificates` are supported directly. |
| Legacy callback overloads | Not implemented | Legacy browser forms exist historically | Intentionally out of scope. Promise-based APIs are supported. |
| `addStream`, `removeStream`, `createDTMFSender` | Not implemented | Obsolete/legacy browser APIs | Intentionally out of scope; use track, transceiver, and sender APIs instead. |

## Browser-compatible surface

The normal application-facing surface includes:

- `RTCPeerConnection` offer/answer negotiation
- `setLocalDescription()` / `setRemoteDescription()` including implicit description generation and rollback/pranswer handling
- `currentLocalDescription`, `pendingLocalDescription`, `currentRemoteDescription`, and `pendingRemoteDescription`
- `addIceCandidate()`, end-of-candidates handling, and ICE server URL arrays
- `RTCConfiguration` fields including `iceServers`, `iceTransportPolicy`, `bundlePolicy`, `rtcpMuxPolicy`, `iceCandidatePoolSize`, and `certificates`
- `canTrickleIceCandidates` and `sctp`
- tracks, senders, receivers, and transceivers
- `RTCDataChannel` with browser-style event handlers
- standard event names through `addEventListener()` / `removeEventListener()`
- `getStats()` reports for RTP, transport, ICE candidates and candidate pairs, codecs, certificates, DataChannels, and related objects

## WPT strategy

werift includes an allowlisted upstream WPT runner under `packages/webrtc`. The default public API keeps backward-compatible werift behavior where changing it would be unnecessarily disruptive, while the WPT tooling can apply strict compatibility shims for test cases that require exact browser ordering or error behavior.

Initialize the WPT submodule before running the compatibility suite:

```sh
git submodule update --init --recursive
npm run wpt --workspace packages/webrtc
npm run wpt:coverage --workspace packages/webrtc
```

## Interoperability is separate from API shape

Browser API compatibility describes the JavaScript/TypeScript interface. Wire-level interoperability is validated separately through repository browser E2E tests, community Safari reports, and the independent [`sipsorcery/webrtc-interop`](https://github.com/sipsorcery/webrtc-interop) matrices.
