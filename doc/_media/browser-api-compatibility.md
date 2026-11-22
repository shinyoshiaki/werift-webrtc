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
| `RTCPeerConnection.generateCertificate()` | Not implemented as the static browser helper | Defined by the browser API | `RTCCertificate` and `RTCConfiguration.certificates` are supported directly. Without `certificates`, werift reuses one process-wide certificate by default; set `certificateScope: "standard"` (up to v0.27.0: `"peerConnection"`) to generate one per `RTCPeerConnection`, as browsers do. See "Compatibility options" in `packages/webrtc/README.md` for the other options that differ from browsers. |
| `RTCDataChannel.binaryType` default | `"nodebuffer"` from the core `werift` entry point: binary messages are Node.js `Buffer`s. `werift/polyfill` (and the WPT runner) use `"arraybuffer"`; `PeerConfig.dataChannelBinaryType` chooses it per connection | `"arraybuffer"`; only `"arraybuffer"` / `"blob"` exist | Existing Node.js applications expect `Buffer`s. `"nodebuffer"` is a werift extension (the name of the `ws` library's value), so werift's `binaryType` type is not assignable to `lib.dom`'s `BinaryType` (the other way round is). `channel.onMessage` always receives `Buffer` / string. |
| `bufferedamountlow` timing | Fired synchronously when sent data completes and `bufferedAmount` crosses `bufferedAmountLowThreshold` (`bufferedAmountLow`, `onbufferedamountlow`, then the listeners) | Fired from a queued task | Keeps the timing of the existing `bufferedAmountLow` event and of werift's other DataChannel events; `bufferedAmount` read in the handler is the value at the crossing. Data discarded unsent fires nothing, as in the spec. On a closing / closed channel (`channel.close()`, `pc.close()`) it stays in `bufferedAmount` (reduced only by sent bytes, not reset on close); a channel that outlives a rollback of its SCTP transport releases the bytes it can no longer send, so its `bufferedAmount` can drain. |
| `bufferedamountlow` event object | One `Event` goes to `onbufferedamountlow` and to the `"bufferedamountlow"` listeners. Guaranteed: `type` (`"bufferedamountlow"`), `target` (the channel), `currentTarget` (the channel during the notification, `null` after it) | Dispatched through the DOM, which also sets `isTrusted`, `eventPhase`, `composedPath()` and honors `stopImmediatePropagation()` | werift notifies without a DOM `EventTarget` dispatch, so `isTrusted` is `false`, `eventPhase` stays `0`, `composedPath()` is empty and `stopImmediatePropagation()` does not stop later listeners; these are not guaranteed. The `target` of the `open` / `close` / `message` / `error` events is an existing limitation outside this change. |
| `new RTCSessionDescription(sdp, type)` | Accepted next to the W3C `new RTCSessionDescription({ type, sdp })`, also through the `werift/polyfill` global (the same class) | Only the dictionary form; a string argument is a `TypeError` | Backward compatibility with earlier werift versions. `toJSON()` returns `{ sdp, type }`. |
| `createOffer()` / `createAnswer()` result | Resolves with werift's `RTCSessionDescription` (with `toSdp()` / `toJSON()`), so it is `instanceof RTCSessionDescription` | Resolves with a plain `RTCSessionDescriptionInit` dictionary | Backward-compatible return type. The WPT runner returns the dictionary. |
| Legacy callback overloads | Not implemented | Legacy browser forms exist historically | Intentionally out of scope. Promise-based APIs are supported. |
| `addStream`, `removeStream`, `createDTMFSender` | Not implemented | Obsolete/legacy browser APIs | Intentionally out of scope; use track, transceiver, and sender APIs instead. |

## WebIDL value conversion

The browser-compatible entry points convert their arguments with the WebIDL rules, so values that are not plain strings behave as in browsers:

| Input | `channel.binaryType = value` (enum attribute) | `new RTCSessionDescription({ sdp })` (`DOMString sdp = ""`) | `new RTCSessionDescription({ type })` (required enum) |
| --- | --- | --- | --- |
| `undefined` | ignored | `""` | `TypeError` (required) |
| `null`, a number, a bigint | ignored (`"null"`, `"234"`, `"54"` are not values) | `"null"`, `"234"`, `"54"` | `TypeError` |
| an object with `toString()` | its string, if valid | its string | its string, if valid |
| a Symbol, or a throwing `toString()` | the exception (value unchanged) | the exception | the exception |
| an invalid string | ignored, no exception | the string | `TypeError` |

The dictionary members are read once each, `sdp` before `type`; `undefined` / `null` is an empty dictionary (so `type` is missing) and any other non-object is a `TypeError`. A second argument after a dictionary is ignored; only a string first argument selects werift's `(sdp, type)` form. Invalid `binaryType` values are ignored rather than throwing `SyntaxError`, as the enum-typed IDL and the pinned upstream WPT `webrtc/RTCDataChannel-binaryType.window.js` require (`Setting binaryType to '…' should be ignored`). `PeerConfig.dataChannelBinaryType` is werift's own option and still rejects an invalid value with `TypeError`.

## Browser-compatible surface

The normal application-facing surface includes:

- `RTCPeerConnection` offer/answer negotiation
- `setLocalDescription()` / `setRemoteDescription()` including implicit description generation and rollback/pranswer handling
- `currentLocalDescription`, `pendingLocalDescription`, `currentRemoteDescription`, and `pendingRemoteDescription`
- `addIceCandidate()`, end-of-candidates handling, and ICE server URL arrays
- `RTCConfiguration` fields including `iceServers`, `iceTransportPolicy`, `bundlePolicy`, `rtcpMuxPolicy`, `iceCandidatePoolSize`, and `certificates`
- `canTrickleIceCandidates` and `sctp`
- tracks, senders, receivers, and transceivers
- `RTCDataChannel` with browser-style event handlers, including `onbufferedamountlow`, and `binaryType` (`"arraybuffer"` / `"blob"`, plus werift's `"nodebuffer"`)
- `RTCSessionDescription` with the W3C `{ type, sdp }` constructor and `toJSON()`; `werift/polyfill` installs the same class, so `instanceof` holds for descriptions werift creates
- standard event names through `addEventListener()` / `removeEventListener()`
- `getStats()` reports for RTP, transport, ICE candidates and candidate pairs, codecs, certificates, DataChannels, and related objects

## WPT strategy

werift includes an allowlisted upstream WPT runner under `packages/webrtc`. The default public API keeps backward-compatible werift behavior where changing it would be unnecessarily disruptive, while the WPT tooling can apply strict compatibility shims for test cases that require exact browser ordering or error behavior.

The runner executes every upstream `webrtc/**/*.html` file and the `*.window.js` / `*.any.js` files listed in `packages/webrtc/wpt/allowlist.json` (as the window-scope page wptserve generates); the other upstream JavaScript tests need BFCache, idlharness or large-buffer support the runner does not have.

Initialize the WPT submodule before running the compatibility suite:

```sh
git submodule update --init --recursive
npm run wpt --workspace packages/webrtc
npm run wpt:coverage --workspace packages/webrtc
```

## Interoperability is separate from API shape

Browser API compatibility describes the JavaScript/TypeScript interface. Wire-level interoperability is validated separately through repository browser E2E tests, community Safari reports, and the independent [`sipsorcery/webrtc-interop`](https://github.com/sipsorcery/webrtc-interop) matrices.

ICE wire defaults stay browser-interoperable: local descriptions advertise `a=ice-options:trickle` (add `ice2` with `iceOptionIce2: true`), and connectivity checks carry STUN `MESSAGE-INTEGRITY` (SHA-1). `iceMessageIntegrity: "sha256" | "both"` adds `MESSAGE-INTEGRITY-SHA256` (RFC 8489), which browsers do not implement for ICE, so use it only with peers known to support it. Responses always match the integrity algorithm of the request. `remoteIceOptionIce2` is a werift extension next to `canTrickleIceCandidates`.
