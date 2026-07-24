# Changelog

## v0.24.0

### 🚀 Features & Improvements

- **ICE-TCP (RFC 6544)**: Add TCP host candidate gathering and connectivity checks in `packages/ice` / `packages/webrtc` (`TcpActiveProtocol` / `TcpPassiveProtocol`, STUN TCP framing). Chromium ↔ werift DataChannel E2E coverage included.
- **ICE-Lite server role (RFC 8445)**: Implement ICE-Lite server-side behavior; configure via `iceLite` on the peer config. E2E verifies lite werift ↔ full Chrome DataChannel.
- **TURN over TCP / TLS**: Support `turn:` / `turns:` control transports (UDP, TCP, TLS), including URI transport defaults and validation. Chrome ↔ werift relay E2E for UDP/TCP/TLS.
- **`packages/ice-server` (new)**: Sans-IO STUN (RFC 8489) / TURN (RFC 8656) protocol stack plus a Node reference server (UDP/TCP/TLS control plane, UDP relay). Chrome STUN/TURN interop harness under `packages/ice-server/chrome-e2e`.
- **W3C `RTCPeerConnection` compatibility**:
  - `currentLocalDescription` / `pendingLocalDescription` / `currentRemoteDescription` / `pendingRemoteDescription`
  - `canTrickleIceCandidates`, `sctp`
  - `setConfiguration` / `getConfiguration` round-trip (`iceServers`, `iceTransportPolicy`, `bundlePolicy`, certificates, …)
  - Broader `setLocalDescription` / `setRemoteDescription` input handling (`pranswer`, `rollback`, omitted/empty fields)
  - Standard event names for `addEventListener`
  - Legacy callback / obsolete stream APIs intentionally out of scope
- **W3C-oriented `getStats`**: Expand stats types and report building toward the WebRTC Stats model (inbound/outbound RTP, transport, ICE candidate/pair, data channel, codec, certificate, media source, …).
- **Nonstandard media (`packages/webrtc` nonstandard)**:
  - `getUserMedia` / file playback rewritten around **mediabunny** (path, Buffer, or stream for MP4/WebM)
  - Codec mismatch with negotiated/SDP settings surfaces as errors; width/height conversion removed from the API
  - Dummy Opus + VP8 media for WPT-friendly `navigator.mediaDevices.getUserMedia`
  - Existing gstreamer-based file track path removed in favor of this stack
- **RTP MP4 stack**: Migrate `packages/rtp` MP4 container/processor path from mp4box to **mediabunny**.
- **Upstream WPT tooling** (`packages/webrtc`):
  - Allowlisted WPT runner with progress output, per-case timeouts, multi-core concurrency, and reliable process cleanup
  - `npm run wpt` / `npm run wpt:coverage`, markdown progress + baseline/coverage baselines
  - Keep WPT-only strict shims in `tools/wpt-runner/*` so default API convenience (e.g. early `addIceCandidate` without `remoteDescription`) is preserved
- **Examples**: `examples/turn-loopback` — HTTPS + TURN/TLS multiplexed echo loopback (React/Vite client, Docker, Playwright chrome-e2e).
- **Docs**: README feature matrix updates (ICE-Lite server, TURN/TCP); RED example and RTP processor utilities documented; WPT submodule setup notes.

### 🐛 Bug Fixes

- **Audio RED fmtp**: Generate RED `fmtp` from the negotiated primary payload type on the same m-line (direction-filtered codecs, matching clock rate per RFC 2198); do not mutate shared PeerConnection codec config. Explicit RED parameters remain preserved when already set.
- **DataChannel ID 0**: Handle data channel ID `0` correctly.
- **ICE-TCP tests**: Fix TCP candidate tests when multiple network interfaces are present.
- **Typing**: Narrow `RTCDtlsTransport` config type.
- **E2E hygiene**: Ensure gstreamer (and similar) helper processes exit after E2E; remove unnecessary `createCandidateBuffer` workarounds once candidate buffering behavior was corrected.
- **Lint**: Resolve biome lint warnings across the workspace.

### 📦 New / packaging

- New workspace package: **`werift-ice-server`** (`packages/ice-server`, `0.0.1`).

### 🧪 Testing & tooling

- E2E: DataChannel scenarios for **ICE-Lite**, **ICE-TCP**, and **TURN relay** (UDP/TCP/TLS); TURN server fixture support under `e2e/`.
- Unit/integration coverage for peer connection, stats-related paths, nonstandard userMedia/packetizer, ICE TCP framing, ice-server protocol.
- Dependency bumps in `examples/`, `e2e/`, `loadtest/`, and ice-server chrome-e2e (ws, axios, vitest, form-data, and others).

### ⚠️ Notes

- File-based `getUserMedia` no longer accepts width/height resize options; supply media that already matches the intended dimensions/codecs.
- Prefer negotiated codec alignment for file playback; unsupported or mismatched codecs fail fast with an error.
- Upstream WPT is submodule-based: run `git submodule update --init --recursive` before `npm run wpt`.

## v0.22.3

### 🚀 Features & Improvements

- **WebM/VINT**: Implement VINT encoding/decoding functions and add tests
- **Transport**: Add `closed` property to transport classes and improve close methods
- **Exports**: Export `stats` module from `media/index.ts`
- **Performance/Refactor**:
    - Remove `lodash` dependency (replaced with native functions or lighter alternatives)
    - Remove `nano-time`, `date-fns`, `uuid` dependencies
    - Use `structuredClone` instead of `lodash/cloneDeep`
    - Replace `lodash/isEqual` with `fast-deep-equal`

### 🐛 Bug Fixes

- **Circular Dependencies**: Fix circular reference/imports in `RtcpTransportLayerFeedback` and `RtcpPacketConverter`
- **Connection**: Various connection state fixes per RFC
- **DataChannel**: Fix issues with reconfig stream on fast data channel close
- **Bundle**: Use bundle for `addTransceiver` in bundle max-compat if remote is bundled
- **Typing**: Fix uuid typing

### 📦 Dependency Updates

- Bump `undici`, `express`, `zx`, `vite`, `axios`, `form-data` and others in examples/e2e.
