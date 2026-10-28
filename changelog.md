# Changelog

## Unreleased

### ⚠️ Breaking changes

- **`werift-dtls`: `CipherContext.localPrivateKey` is now a Node `KeyObject`** instead of the `@fidm/x509` `PrivateKey`. Replace `localPrivateKey.toPEM()` with `localPrivateKey.export({ type: "pkcs8", format: "pem" })`; replace `localPrivateKey.sign(data, hash)` with `createSign(hash).update(data).sign(localPrivateKey)`.
- **werift logging no longer follows the application's `debug` package instance.** Use `debug.enable("werift*")` or `debug.disable()` from `werift`, or set `DEBUG=werift*` before startup. The built-in logger does not implement `DEBUG_HIDE_DATE`, `DEBUG_DEPTH`, `DEBUG_SHOW_HIDDEN`, `logger.extend()`, `logger.log`, `debug.log`, `debug.formatters`, `logger.destroy()`, `logger.color`, `useColors`, or `inspectOpts`. In browsers, `localStorage.debug` is still read at load time.

### Fixes

- **`packages/webrtc`: audio codecs that negotiate generic RTCP `nack` now use the receiver NACK handler**, and debug packet loss percentages now drop the configured percentage. `DebugConfig.burstLoss` adds deterministic periodic bursts. `PeerConfig.nackRetryWindowMs` controls receiver retry time (default ~55 ms); `rtpHistorySize` controls sender history (default 128), and `RTCRtpSender.retransmit()` supports application-layer NACK. Defaults preserve the existing retry and history windows.
- **RTP relay state no longer moves backwards for delayed retransmissions**; `RTCRtpSender` keeps its latest sequence/timestamp state while still forwarding CSRC values.

### Examples

- Added `examples/mediachannel/latency_budget/`, a werift + Chrome Encoded Transform / WebCodecs audio latency-budget demo with retransmission, burst replay, and interrupt controls.

- PEM passed to `dtls.keys` / `RTCCertificate` / `CipherContext` may still be indented (for example inside an indented template literal), as it was with `@fidm/x509`. `werift-dtls` exports the `normalizePem()` helper used for this.

### Dependencies

- Removed `debug`, `tweetnacl`, `@noble/curves`, and `@fidm/x509`; logger behavior now lives in `werift-common`, and X25519, P-256, certificate parsing, and signing use `node:crypto`.
- Removed `@peculiar/x509` (and with it `reflect-metadata`, `tsyringe`, and the `@peculiar/asn1-*` packages). `CipherContext.createSelfSignedCertificateWithKey()` / `createSelfSignedCertificate()` now generate keys with `node:crypto` and build the X.509 v3 certificate with a small internal DER encoder in `werift-common` (`src/asn1.ts`, not part of the public exports). The certificate contents are unchanged: same subject / issuer, random 64-bit serial, 10-year validity, ECDSA P-256 or RSA 2048 with SHA-256, no extensions.
- Updated `mediabunny` to 1.62.x.
- Updated the TypeScript, Biome, Vitest, TypeDoc, Knip, npm-run-all2, Playwright, Vite, React, and example dependencies. TypeScript remains on 6.0.x because TypeDoc 0.28 does not support TypeScript 7; `@types/node` remains on 22.x to match the supported Node runtime.
- Removed `ts-node`, `ts-node-dev`, and `tsx`. Repository scripts now run TypeScript with Node.js itself (`--experimental-transform-types` plus the `tools/node-ts/register.mjs` resolve hook for extensionless imports); local development requires Node.js 22.18.0 or later (`devEngines`). Published package `engines` are unchanged.
- Removed `organize-imports-cli` unused-import scripts in favor of Biome 2.
- `werift-rtp` keeps `buffer` and its `import "buffer"` side effect so browser bundlers can provide `Buffer`; a Chromium smoke test (`npm run test:browser --workspace packages/rtp`) now covers the main entry bundled with Vite and `vite-plugin-node-polyfills`.

## v0.25.2

### ⚠️ Breaking changes

- **`werift-sctp`: `SCTP.outboundQueue` is now a `FifoQueue<DataChunk>` instead of `DataChunk[]`**: the field is `readonly` and has no array-compatibility layer. `FifoQueue` is exported from `werift-common` and re-exported from `werift-sctp`. Migration: use `outboundQueue.length`, `peek()`, `at(i)`, `last()`, `toArray()` or `for...of` instead of array indexing / array methods, and do not reassign the field. Reason: draining a large queue with `Array.prototype.shift()` was quadratic and contributed to the DataChannel burst slowdown below.

### 🐛 Bug Fixes

- **Large `RTCDataChannel.send()` bursts no longer slow down quadratically or starve the event loop** (`werift-sctp`, `packages/webrtc`): queuing thousands of messages at once took time growing with the square of the queue length (2,000 × 1 KB: ~12 s, 5,000: minutes) and blocked the event loop for seconds per SACK, long enough to lose ICE consent mid-transfer.
  - `SCTP.send()` now resolves when its own last chunk is handed to the network (moved from the outbound queue to the sent queue) instead of waiting until the whole outbound queue drains. Previously every pending `send()` waited on the `flush` event, so each transmit woke all N waiters and each re-subscribed with an O(N) unsubscribe.
  - Pending `send()` calls settle when the association closes instead of staying pending forever.
  - The SCTP sent / outbound queues and the DataChannel send queue use `FifoQueue` (amortized O(1) `shift()`).
  - `RTCSctpTransport` hands queued DataChannel messages to SCTP in a single synchronous pass instead of starting one concurrent flush loop per `send()`. `bufferedAmount` now decreases per message as it is transmitted (previously only after the whole SCTP outbound queue drained), so `bufferedamountlow` fires during a burst. Messages not yet handed to SCTP are discarded when the transport stops.

### 🧪 Testing & tooling

- **CI**: GitHub Actions tests (`nodejs.yml`) now run on every pull request. Dependency bumps: `vite`, `markdown-it` 14.3.3, `follow-redirects` 1.16.1, `source-map-js` 1.2.2, `shell-quote` 1.12.0.
- **Chrome E2E for packages/rtp Packetizer / Depacketizer** (`e2e`):
  - Scenario A (Chrome → `packages/rtp` depacketize), B (fixture demux → `packages/rtp` Packetizer → Chrome), C (repacketize loop; VP8 required).
  - Codecs: VP8, H.264, Opus (P0), VP9, AV1 (P1). H.264 accepts black frames (delivery + de/packetize only).
  - Committed fixtures under `e2e/fixtures/media/`; CI does not require GStreamer. Generator: `e2e/tools/generateCodecFixtures.sh`.
  - **SDP `video/AV1`**: add `useAV1()`; keep `useAV1X()` as legacy. `findCodecByMimeType` treats AV1 ↔ AV1X as aliases.
- **Chrome E2E for werift VP8 sources** (`e2e/tests/mediachannel/vp8Playback.test.ts`): file playback (`createFileMediaPlayer`, the polyfill MP4/WebM engine) and `dummyMedia` VP8 → Chrome. Asserts decode/playback (`framesDecoded` across a loop, `keyFramesDecoded`, frame size, `<video>` time advancing) and the sent X/I/M + PictureID continuity.

### 🐛 Fixes (review follow-ups)

- **AV1 Chrome RTP playback**: the packetizer packs up to three OBU elements per packet (W=1..3), aggregates the Sequence Header with the start of its frame, and omits internal `obu_size` fields so Chrome decodes the temporal unit correctly. W=0 payloads are still accepted by the depacketizer.
- **H.264 `isKeyframe`** (RFC 6184 §5.7.1 / §5.8): the 2nd octet is read as an FU header only for FU-A / FU-B. A non-IDR STAP-A whose first NALU size upper byte has low 5 bits = 5 (e.g. size `0x05xx`) is no longer reported as a keyframe; STAP-A is a keyframe only when it aggregates an IDR slice (new `H264RtpPayload.aggregatedNalUnitTypes`). This affects `dePacketizeRtpPackets`, `waitForKeyframe` in the depacketizer, and WebM / MP4 key samples.
  - **Minor breaking (types)**: `H264RtpPayload.s` / `e` / `r` / `nalUnitPayloadType` are now `number | undefined` and are left `undefined` for non-FU packets.
- **VP8 payload descriptor now carries PictureID** (`packages/webrtc` file playback / encoded-binary / dummy media, `packages/rtp` `Vp8Packetizer`): werift-generated VP8 RTP uses the browser single-layer form `X=1, I=1, M=1` + 15-bit PictureID (4 octets; `90 80 ..` on the first fragment, `80 80 ..` on continuations; L/T/K unset). PictureID starts random (dummy media: deterministic per source), advances once per frame and wraps at `0x7fff`; file playback keeps it continuous across `loop`. Fragment size is `maxPayloadSize - 4`, so payloads stay within `maxPayloadSize`. Previously the 1-octet `X=0` descriptor was dropped by mediasoup ≤ 3.19.2 (before versatica/mediasoup#1612), which could not detect its keyframes, so subscribers received nothing; it now works on those versions without upgrading the SFU. Code that assumed a 1-octet descriptor must parse X/I/M (e.g. `Vp8RtpPayload`). `packages/rtp` `Vp8Packetizer` accepts `pictureId` to set the initial value; `createVp8PayloadDescriptor()` is exported.

- **File playback VP8 PictureID no longer resets at the first `loop`** (`packages/webrtc` `createFileMediaPlayer`): the per-track packetizer was recreated whenever `RTCRtpSender` assigned a new (equivalent) codec object or filled in the payload type after playback started, restarting PictureID at a random value. It is now reused unless mime type / clock rate / channels / fmtp change.
- **Dummy media VP8 is decodable** (`packages/webrtc` `dummyMedia` / `createDummyRegister()`): the previous synthetic keyframe (2x2 header with an empty first partition) was rejected by libvpx, so Chrome decoded 0 frames and kept sending PLI. It now sends a libvpx-encoded 16x16 black keyframe plus an error-resilient delta frame.
- **AAC (RFC 3640 §3.2.3.1)**: every fragment now carries its AU Header Section; the depacketizer strips it from continuations and validates AU-size. Multi-AU splits give each packet a distinct timestamp (`auDurationInSamples`, default 1024). Extended CTS/DTS headers accept non-16-bit lengths with trailing padding.
- **H.264 / H.265**: length-prefixed input whose prefix looks like a start code (e.g. length 300 = `00 00 01 2c`) is no longer misread as Annex-B.
- **AV1**: adjacent fragmented OBUs are no longer merged; boundaries come from Z/Y.
- **Audio marker** (G.711 / G.722 / Opus): marker is set only on the first packet of a talkspurt (`startTalkspurt()` to re-arm), per RFC 3551 §4.1 / RFC 7587 §4.1.
- **H.264 / H.265 input layout**: new `inputFormat: "auto" | "annexb" | "length-prefixed"` on the packetizers and `split*NalUnits`. `auto` (default) treats a leading start code as Annex-B (a 3-byte `00 00 01 HH` is otherwise indistinguishable from a 4-byte length `0x1HH`); pass `"length-prefixed"` for MP4/MKV samples. Supersedes the earlier length-first heuristic, which corrupted 3-byte-start-code NALs.
- **telephone-event**: `event` / `volume` / `duration` outside 0–255 / 0–63 / 0–0xFFFF now throw `RangeError` instead of being masked (RFC 4733 §2.5.1.3: split longer events).
- **AAC**: a complete AU arriving while a fragment is pending drops the stale fragment instead of throwing. **H.265 FU** with S=E=1 is rejected.
- **H.265 PACI** (type 50) is rejected explicitly; **AV1 W=0** payloads are parsed; H.264/H.265 packetizers insert missing parameter sets after a leading AUD, not before it.
- **AV1 N bit** (RFC 9628 §4.4): `Av1Packetizer` no longer sets N on every keyframe. N is set when `startsNewCodedVideoSequence` is `true`, or by default for a keyframe whose temporal unit contains a Sequence Header OBU; mid-sequence keyframes keep N=0.
- **H.264 Annex-B split** no longer drops NAL types ≥ 14 (prefix NAL, subset SPS, slice extension, ...); RFC 6184 §5.6 carries types 1–23 as Single NAL / FU-A.
- **`useH264()`** now returns `video/H264` (uppercase, as Chrome expects); codec names are compared case-insensitively.
- **AV1 ↔ AV1X** normalization now applies to SDP answer, codec matching, and file playback validation, not only `findCodecByMimeType`.
- **AV1 packetizer → Chrome**: `Av1Packetizer` drops Temporal Delimiter OBUs, clears `obu_has_size_field` on RTP OBU elements, and packs up to three OBU elements per packet (W=1..3), splitting OBUs across packet boundaries like libwebrtc. Without a dependency descriptor libwebrtc treats Z=0 / Y=0 as frame start / end, so the previous one-OBU-per-packet layout split a temporal unit into two frames and Chrome 155 never rendered it.

- **fMP4 muxer no longer loops forever when video dimensions are undefined** (`packages/rtp` `Mp4Container` / `MP4Processor`): a video config without `codedWidth` / `codedHeight` now reaches the "missing coded video dimensions" guard. When `Track.width` / `height` are not both positive integers, the coded size, `avcC`, and display aspect ratio (coded size × SAR, exact integers) come from the SPS of the first usable keyframe; if they cannot be resolved the keyframe is skipped and the muxer waits for the next one.

### 🔧 Maintenance

- **userMedia packetizer consolidated into `packages/rtp`** (`packages/webrtc/src/nonstandard/userMedia/packetizer.ts`): the webrtc-local VP8 / VP9 / AV1 / H.264 / Opus packetizers, `BasePacketizer`, and the AV1 / H.264 split and avcC helpers are removed. `createPacketizer` now adapts mediabunny `EncodedPacket` onto the `packages/rtp` packetizers. New `parseAvcDecoderConfigurationRecord` in `packages/rtp` replaces the avcC parsers duplicated in webrtc and `e2e`.
  - Kept: Opus marker on every packet, AV1 N=1 on every key packet, packetization-mode≠1 rejection.
  - Changed on the wire (from `packages/rtp`): H.264 keyframe SPS/PPS go in one STAP-A and only missing parameter-set types are prepended; AVCC samples with avcC are split as length-prefixed; AV1 follows the aggregation above; Opus packets over 1200 bytes throw instead of being sent oversize; a truncated avcC throws.

### 🚀 Features & Improvements

- **Real-time RTP media clock** (`packages/rtp`): `RtpMediaTimeline` (deterministic, drift-free timestamps from a frame index, fractional frame durations), `RtpMediaClock` (monotonic scheduler with `skip` / `delay` stall policies, pause / resume), and `RtpMediaPacer` (variable-frame-rate / streaming sources paced by `pts` with an optional `latencyMs` jitter buffer). `RtpBuilder` is wall-clock aware (`RtpBuilderProps` / `RtpBuilderCreateOptions`). Example: `packages/rtp/examples/node/pacer/ffmpeg-vfr-stream.ts`.
- **werift-rtp existing-codec packetizers** (`packages/rtp`): Add package-local packetizers for codecs that previously only had depacketizers (non-WebRTC / SIP / RTSP).
  - **VP8** (RFC 7741): `Vp8Packetizer` — X/I/M descriptor with 15-bit PictureID (`S`/`PID`, same as browser single-layer senders), MTU fragmentation, final marker.
  - **VP9** (RFC 9628): `Vp9Packetizer` — `B`/`E`/`P` minimal descriptor; key/delta via options.
  - **AV1** (AV1 RTP): `Av1Packetizer` + `splitAv1Obus` / `createAv1AggregationHeader` — OBU aggregation (W=1..3), Z/Y/N, final marker.
  - **Opus** (RFC 7587): `OpusPacketizer` — raw one-packet RTP; rejects `maxPayloadSize` overrun (no TOC-blind split).
  - **H.264** (RFC 6184 mode=1): `H264Packetizer` — Single NAL / **STAP-A** (SPS+PPS preferred on keyframe) / FU-A; Annex-B and length-prefixed input.
  - Specs: `docs/rfc/rfc7741.txt`, `rfc6184.txt`, `rfc7587.txt`, `rfc9628.txt`, `av1-rtp-spec.html`.
  - Example codecs: `vp8` / `vp9` / `av1` / `opus` / `h264` in `packages/rtp/examples/node/rtp_over_udp/`.
  - **GStreamer test vectors**: `vector_vp8` / `vp9` / `h264` / `opus` (real encoders + rtppay) and synthetic `vector_av1`; generator baseline + GST overwrite; tests load committed binaries.
- **werift-rtp codec coverage** (`packages/rtp`): Add package-local packetizers and expanded depacketizers for non-WebRTC / SIP / RTSP reuse.
  - **H.265 / HEVC** (RFC 7798): `H265RtpPayload` + `H265Packetizer` — single NAL, AP (Type 48), FU (Type 49), Annex-B and length-prefixed input, IRAP keyframe detection, optional parameter-set AP on keyframes.
  - **G.711**: `PcmuRtpPayload` / `PcmaRtpPayload` + packetizers; static PT 0 / 8, clock 8000 Hz (RFC 3551).
  - **G.722**: `G722RtpPayload` + `G722Packetizer`; static PT 9, **RTP clock 8000 Hz** (RFC 3551 §4.5.2).
  - **AAC-hbr** (RFC 3640): `AacHbrRtpPayload` + `AacHbrPacketizer`; registry name `MPEG4-GENERIC`; AU Header Section validation; MTU fragmentation (every fragment repeats the AU Header Section).
  - **telephone-event** (RFC 4733): `TelephoneEventRtpPayload` (serialize/deSerialize) + `TelephoneEventPacketizer`; marker on event start; not frame-aggregated in `dePacketizeRtpPackets`.
  - **PacketizerBase** in `codec/base.ts` (sequence/`random16`, MTU default 1200, marker left to codecs).
  - Registry: `depacketizerCodecs` / `dePacketizeRtpPackets` gain `H265`, `PCMU`, `PCMA`, `G722`, `MPEG4-GENERIC`.
  - Example: `packages/rtp/examples/node/rtp_over_udp/` (Node UDP peer round-trip).
  - Vector tooling: `packages/rtp/tools/generateVectors/`; RFCs `docs/rfc/rfc3551.txt`, `rfc3640.txt`, `rfc4733.txt`, `rfc7798.txt`.
- **werift codec helpers** (`packages/webrtc`): `usePCMA` (PT 8 / 8000), `useG722` (PT 9 / 8000). Not added to `supportedCodecs` (negotiation still opt-in).

## v0.25.1

### 🔧 Maintenance

- **Removed the `binary-data` runtime dependency** (#756): the `binary-data` package is ported to TypeScript as `packages/common/src/binaryData.ts` (exported from `werift-common`) and used by `werift-dtls` for DTLS record / handshake encoding. `werift-dtls` and `werift` no longer depend on the `binary-data` npm package. Wire formats are unchanged.

## v0.25.0

### ⚠️ Breaking changes

- **`werift/polyfill` fixed-codec sources no longer expand `RTCPeerConnection` codec capability implicitly** (#729): A track from a polyfill `MediaRegister` (MP4/WebM, callback, RTP/RTCP, encoded binary) now treats its codec as a hard constraint — `addTrack()` / `addTransceiver()` throws `NotSupportedError` instead of silently adding the codec to the PeerConnection capability. The public `adoptSenderTrackCodec` helper was removed. Plain, non-polyfill `MediaStreamTrack`s (e.g. ordinary live sources) are unaffected.
- **Removed `getUserMedia({ path | buffer | stream })` from `werift/nonstandard`** (#729). File playback now goes through `werift/polyfill`: `installPolyfill({ mediaRegister: [createMp4WebmRegister({ path })] })` then `navigator.mediaDevices.getUserMedia({ audio: true, video: true })`.
- **m-line reuse behavior changed, default `PeerConfig.mLineReuse: "compatible"`** (#705, #721): Accepted `inactive` m-lines now keep port 9 instead of port 0, and `addTransceiver()` / `addTrack()` no longer take over an `inactive` m-line left by `removeTrack()` — only a position whose port 0 stop/rejection has been negotiated is reused (with a new MID). **To keep the pre-v0.25 behavior, set `mLineReuse: "aggressive"`.** Note that in `"aggressive"` mode a negotiated inactive m-line becomes permanently stopped and cannot resume with `direction = "sendrecv"`, so pause/resume (mute/unmute, hold/resume) workflows should stay on `"compatible"`. See the `PeerConfig.mLineReuse` entry under Features for the full compatibility matrix.

### 🚀 Features

- **`PeerConfig.turnUdpFamily`** (#726, #731): preferred TURN/UDP socket family (`"udp4"` / `"udp6"`) for hostname TURN servers, passed through `RTCIceGatherer` to `IceOptions.turnUdpFamily` and propagated by `setConfiguration()` before the next gathering. Defaults to `undefined` (`udp4`), so existing configurations are unchanged. An IP-literal server address still selects the UDP socket family directly; a conflicting `turnUdpFamily` is ignored with a debug log instead of making the configured server unreachable.
- **Polyfill codec integration** (#729): `installPolyfill()` accepts `peerConnectionConfig`, and `RTCRtpTransceiver.setCodecPreferences()` now filters and orders codecs independently from fixed-source constraints.
- **Empty media tracks for `werift/polyfill`** (#729): `mediaRegister: []` now lets `getUserMedia()` return plain audio/video tracks instead of `NotFoundError`, and the new `createEmptyRegister()` exposes the same no-RTP, codec-unset behavior explicitly.
- **Configurable SCTP outbound MTU** (#708, #716): `SCTP` and `RTCPeerConnection({ sctp: { mtu } })` now accept an outbound packet MTU. The default is 1191 bytes, changing DATA fragmentation and congestion-control units from a 1200-byte payload to 1160 bytes (maximum serialized DATA packet: 1188 bytes).
- **`werift/polyfill`** (#689): Opt-in installer that puts werift WebRTC constructors on `globalThis` (or a `target` sandbox) and implements `navigator.mediaDevices.getUserMedia` via `mediaRegister` (MP4/WebM, RTP/RTCP, encoded binary, or `createCallbackRegister`).
- **`PeerConfig.mLineReuse`** (#705, #721): `"compatible"` (default) keeps accepted `inactive` m-lines on a non-zero port and uses port 0 only for rejected / stopped m-lines; `"aggressive"` keeps the legacy inactive port 0. The value is validated on construction and cannot be changed by `setConfiguration()`.
- **`RTCRtpTransceiver.stop()` and m-line reuse** (#705, #721): `stop()` is idempotent, releases the sender / receiver / router registrations immediately, and negotiates port 0 in the next local offer. A new `addTransceiver()` reuses a port 0 position of the same kind only after the rejection has been negotiated, with a new MID and a new transceiver.

### 🐛 Bug Fixes

- **TURN hostname resolution matches the bound UDP socket family** (`werift-ice`, #731): `TurnProtocol.request` now resolves the server hostname with the same family preference as the `udp4` socket `createTurnClient` binds. Previously, a dual-stack resolver that answered IPv6 first (e.g. `turn.cloudflare.com`) sent every `Allocate` to an address the socket could not reach, so the transaction retransmitted for ~6.4 s, timed out, and gathering silently fell back to TURN over TCP, holding `setLocalDescription` for the whole wait.
- **TURN server endpoint pinned and taken from the transport** (`werift-ice`, #725, #726, #731): `Transport` gains optional public `addressFamily` / `remoteAddress` fields (reported by `UdpTransport`, `TcpTransport`, `TlsTransport`); STUN and TURN read these instead of casting to `UdpTransport`'s private socket type. `TurnProtocol` resolves and pins one concrete server endpoint on the first request instead of re-resolving per request, which could previously drift to a different address.
- **IPv6 TURN/STUN transaction addresses compared in canonical form** (`werift-ice`, #731): an IPv6 literal server written in non-canonical notation (e.g. `0:0:0:0:0:0:0:1`) never matched the socket-reported source address, so valid responses were dropped until the transaction timed out.
- **ICE-TCP: both agents now select the same TCP connection** (`werift-ice`, #721): the controlling agent no longer attaches `USE-CANDIDATE` to every TCP connectivity check (aggressive nomination). It waits until every higher-priority TCP pair has finished its check, then nominates the highest-priority valid TCP pair with a separate `USE-CANDIDATE` check (RFC 8445 regular nomination). Before this change, the two agents could each pick a different TCP connection and then close the connection the peer had picked while pruning, so the first `send()` failed with `EPIPE` / `ECONNRESET`. UDP and relay pairs, and connections to ICE-lite peers, keep their current nomination behavior.
- **ICE-TCP connectivity check timeout** (`werift-ice`, #721): TCP checks are still sent once without retransmission (RFC 5389 §7.2.2), but the response timeout is now `TCP_CHECK_RESPONSE_TIMEOUT_MS` (3 s) instead of 50 ms, and that timeout also covers the TCP connect. A refused TCP connect or a failed write fails the check immediately instead of waiting for the timeout.
- **ICE-TCP selected connection loss** (`werift-ice`, #721): a TCP socket that is already closed is discarded before reuse, and a failed write discards the socket and rejects `send()` with the socket error. When the selected TCP connection closes, the agent moves to `failed` right away (the same end state as a consent expiry) instead of waiting 30 s for consent to expire.
- **`NodeTurnServer.listen()` bind conflict** (`werift-ice-server`, #721): with `port: 0`, UDP and TCP share one port number that UDP picks. If that number is already in use for TCP, `listen()` now picks a new number (up to 10 attempts) instead of failing with `EADDRINUSE`. If `listen()` fails, it now closes any socket it has already opened and resets its state.
- **Reject unsupported RTP m-lines in the answer instead of throwing** (#705, #721): `setRemoteDescription()` no longer fails with `negotiate codecs failed.` when an audio/video section has no common codec. The answer keeps the m-line count, order, MID, type and proto, and rejects only that section with port 0 and one offered fmt token. Audio-only peers no longer need to add VP8 to accept a browser offer that bundles video.
  - The answer BUNDLE group contains only accepted offered members; an offerer-tagged section rejected in the initial answer moves the tag to the first accepted member, and a fully rejected group is omitted. An established tag is kept.
  - Accepted m-lines outside the offered BUNDLE group get their own transport and ICE credentials, including with `bundlePolicy: "max-bundle"`. A re-offer that moves an established BUNDLE member out of its group or splits the members into different groups is rejected with `InvalidAccessError` before any state changes. For a remote offer, transport ownership follows only the offered BUNDLE groups regardless of `bundlePolicy` (`max-bundle` affects only local offers): each offered group gets its own transport, and m-lines outside any group (including an offer without BUNDLE) get independent transports. ICE / DTLS parameters come from the first accepted member of a group, not from a codec-rejected tag. A new independent transport gathers its own ICE candidates even when an established BUNDLE is connected, and each transport takes the DTLS role from the `a=setup` of the m-lines it serves. As an offerer, a remote answer that moves m-lines sharing one offered transport out of a common BUNDLE group with different ICE credentials is rejected with `InvalidAccessError` before any state changes. Local trickle candidates carry the MID / index of the accepted section that owns the ICE transport (not always m-line 0); remote candidates for rejected sections are recorded without throwing. SCTP before RTP keeps the original indexes.
  - A non-zero remote answer / pranswer without a common codec is rejected with `InvalidAccessError` before any state changes. An unsupported re-offer keeps the existing track and RTP pipeline while pending and after rollback, and is released only when the port 0 answer is applied.
  - `removeTrack()` detaches the track without stopping the sender, so the same sender can resume. `addTrack()` reuses only unsent, non-stopped, non-rejected senders. Re-offers no longer fire `ontrack` again for an already receiving transceiver, and remote-initiated stops do not fire `negotiationneeded`.
  - `negotiationneeded` is coalesced: changes in the same tick (including `removeTrack()`) fire it once, and an event queued before a local offer that already covers the change is dropped once that offer is answered. This avoids duplicate offers and `InvalidStateError` in `onnegotiationneeded`-driven signaling.
  - A local transceiver that reserved a stopped position before its own offer releases the reservation when a remote offer reuses that position (e.g. with another kind), and is appended in the next offer instead of taking the remote MID.
  - Design note: `docs/design/705-media-rejection-and-removetrack.md`.
- **Received audio RED tracks labeled with the delivered primary codec** (`packages/webrtc`, #729): `RTCRtpReceiver` unwraps audio RED and delivers primary (e.g. Opus) packets to the track, but the remote track's codec was set to the first negotiated codec (`audio/red`). With fixed-source constraints this made `replaceTrack()` reject echoing a received RED track back on a RED sender (`InvalidModificationError`), breaking the `red-record-gst` and `red-sendrecv` example e2e flows. Remote audio tracks are now labeled with the primary codec referenced by RED (or the first primary codec) on creation and on codec resync.

## v0.24.4

### 🐛 Bug Fixes

- **TURN CreatePermission / ChannelBind peer isolation** (#667, #668): Fix `TurnProtocol` so a rejected peer no longer poisons later peers on the same TURN allocation.
  - Per-peer in-flight maps and success-only caches (permission by IP, channel by IP+port); allocation-global shared Promise poison removed.
  - Serial queues keep a resolved tail so one peer’s rejection is not re-thrown to the next.
  - Failed ChannelBind rolls back provisional mapping; failed channel numbers are not reused; channel refresh deadlines are per channel.
  - ICE connectivity checks can fail a high-priority rejected remote first and still nominate a later valid `relay ↔ relay` pair and exchange data.
- **PeerConnection close / Event cleanup** (#665): On `close()`, complete public `Event`s (including `connectionStateChange` / `onNegotiationneeded`) so subscribers and closures do not retain the peer; `Event.allUnsubscribe` is idempotent after `complete()` instead of throwing.

### 🧪 Testing & tooling

- **Memleak harness** (`packages/webrtc`, #665): Opt-in heap-snapshot scenarios for major use cases (`npm run memleak`, Node 24+); not part of default CI.
- **pion TURN interop** (`packages/ice`, #667): Opt-in Docker integration via `npm run test:pion-turn` / `PION_TURN_HOST`; unit isolation tests for permission/channel peer isolation.
- Design note: `docs/design/allocation-peer-isolation.md` (before/after sequences).

### 📦 Packaging / versions

- **`werift`** (`packages/webrtc`): `0.24.3` → **`0.24.4`**
- **`werift-ice`** (`packages/ice`): `0.2.2` → **`0.2.3`**
- Other lower-level packages unchanged (`werift-common` 0.0.3, `werift-rtp` 0.8.9, `werift-sctp` 0.0.11, `werift-dtls` 0.5.8, `werift-ice-server` 0.0.1).

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
