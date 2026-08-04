# Changelog

## v0.24.3

### 📦 Packaging / versions

- **Published dependency cleanup** (`packages/webrtc`): Drop unused monorepo package names from `werift`'s `dependencies` (`werift-common`, `werift-dtls`, `werift-ice`, `werift-rtp`, `werift-sctp`).
  - The publish layout already compiles sibling packages into `lib/` via relative `src/imports/*` paths, so those names were not required for runtime installs of `werift`.
  - Consumer-facing protocol behavior and public API are unchanged.
- **`deploy:alpha`**: After `npm publish --tag alpha`, also run `import-test` (same post-publish check as `deploy`).
- **`werift`** (`packages/webrtc`): `0.24.2` → **`0.24.3`**
- Lower-level packages keep the same published versions as v0.24.2 (`werift-common` 0.0.3, `werift-ice` 0.2.2, `werift-rtp` 0.8.9, `werift-sctp` 0.0.11, `werift-dtls` 0.5.8, `werift-ice-server` 0.0.1).

### 🧪 Testing & tooling

- E2E workspace pin updated to exercise a current alpha (`werift` `^0.24.3-alpha.0`).

### ⚠️ Notes

- Patch release: packaging/metadata only; no intentional WebRTC/ICE/DTLS/SCTP/RTP wire-format or public API behavior changes.

## v0.24.2

### 🐛 Bug Fixes

- **ICE consent freshness (RFC 7675)** (#649): Align consent-to-send monitoring with RFC 7675 so long-lived sessions against **ICE-lite** peers (e.g. OpenAI Realtime) no longer drop media after ~30s.
  - **Cadence**: Schedule the next consent Binding from the previous *request start* time at 0.8–1.2× `CONSENT_INTERVAL` (5s base), not after response completion.
  - **Expiry**: Independent 30s timer from the last valid consent response (`CONSENT_TIMEOUT`); a single request timeout no longer stops monitoring.
  - **Single-shot requests**: Consent transactions use `retransmissions: 0` with an RTT-based response wait (`consentResponseTimeoutMs`, min 500ms / default 1s) instead of a ~50ms RTO death.
  - **Authenticity**: Accept only responses from the selected-pair remote address, and require `MESSAGE-INTEGRITY` when an integrity key is set.
  - **Protocols**: UDP / ICE-TCP / TURN (`StunOverTurnProtocol`) all honor the same `TransactionRequestOptions` (TURN no longer drops `retransmissions`).
  - **ICE-lite interop**: When controlling against a remote ICE-lite selected pair, attach `USE-CANDIDATE` on consent requests (libwebrtc-style semi-aggressive nomination).
  - **On expiry**: Mark transport `failed` (not `closed`), gate application data via `consentFresh`, and leave the transport available for ICE restart.
- **ICE restart role reassignment** (#649): After consent gating made app-data depend on a fresh selected pair, Chrome-initiated ICE restart could leave both sides controlling.
  - Allow ICE role to be reassigned from offer/answer once `nominated` is cleared; keep `switchRole` force-switch for RFC 8445 role conflict.
  - E2E `ice_restart_web_trigger`: apply the restart answer via `setRemoteDescription` and flush candidates so media recovers.
- **DTLS send destination** (#648): Add optional `addr?: Address` to `DtlsSocket.send` / `TransportContext.send` and forward it to the underlying transport.
  - Avoids mis-routing application data when a shared UDP socket’s last `rinfo` changes between a sync reply and a later async send (e.g. multi-client DTLS server).

### 📦 Packaging / versions

- **`werift`** (`packages/webrtc`): `0.24.1` → **`0.24.2`**
- **`werift-dtls`** (`packages/dtls`): `0.5.7` → **`0.5.8`**
- **`werift-rtp`** (`packages/rtp`): `0.8.8` → **`0.8.9`**

## v0.24.1

### 🚀 Features & Improvements

- **Runtime dependency reduction**: Replace low-cost third-party packages with Node.js stdlib and package-local helpers across the stack (`packages/common`, `ice`, `ice-server`, `rtp`, `sctp`, `webrtc`). Public protocol behavior is unchanged.
  - Dropped runtime deps (where previously declared): `@shinyoshiaki/jspack`, `@minhducsun2002/leb128`, `aes-js`, `fast-deep-equal`, `int64-buffer`, `ip` (and related `@types/*`)
  - **common**: `random16` / `random32` via `Buffer.readUInt*BE` instead of jspack
  - **ice**: Host address selection extracted to package-private `selectAddressesFromInterfaces`; stop relying on the `ip` package for loopback filtering
  - **ice-server**: Local STUN wire IP encode/decode (`ip.ts`) using `node:net` validation
  - **rtp**: Package-private LEB128 encode helper; SRTP key derivation AES-128-ECB via `crypto.createCipheriv` instead of `aes-js`
  - **sctp / webrtc**: SCTP reconfig parameter pack/unpack rewritten with direct `Buffer` reads/writes

### 🐛 Bug Fixes

- **Published package deps**: Declare missing `debug` on `werift-dtls`, `werift-ice`, `werift-ice-server`, `werift-rtp`, and `werift-sctp` so installs outside the monorepo resolve correctly (#642).

### 📦 Packaging / versions

- **`werift`** (`packages/webrtc`): `0.24.0` → **`0.24.1`**
- Lower-level packages keep the same published versions as v0.24.0 (`werift-common` 0.0.3, `werift-ice` 0.2.2, `werift-rtp` 0.8.8, `werift-sctp` 0.0.11, `werift-dtls` 0.5.7, `werift-ice-server` 0.0.1) with dependency list cleanups as above.

### 🧪 Testing & tooling

- Unit coverage for binary helpers, ICE address selection / STUN attributes, LEB128 / AV1 paths, RTX, SRTP context, and related package tests expanded alongside the dependency swaps.
- Dev/security dependency bumps in the workspace lockfile: `shell-quote`, `js-yaml`, `markdown-it`.

### 📚 Docs

- Regenerated Typedoc under `doc/` (`RTCDtlsTransport`, `PeerConfig`, `DebugConfig`, `globals`).
- WPT progress baseline touch-up under `packages/webrtc/wpt/progress.md`.

### ⚠️ Notes

- Patch release: no intentional WebRTC/ICE/DTLS/SCTP/RTP wire-format or public API behavior changes.
- Consumers that depended on transitive installs of removed libraries (`jspack`, `leb128`, `aes-js`, `ip`, etc.) should depend on those packages directly if still needed in app code.

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
