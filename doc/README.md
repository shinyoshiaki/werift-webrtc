**werift**

***

# werift

werift (**We**b**R**TC **I**mplementation **f**or **T**ypeScript) is a WebRTC implementation for Node.js written in TypeScript with a browser-compatible WebRTC API.

For the project overview, current features, examples, architecture, and interoperability information, see the [repository README](_media/README.md).

## Install

```sh
npm install werift
```

## Browser-compatible WebRTC API

werift is designed so application code can use the familiar browser WebRTC model in Node.js: `RTCPeerConnection`, tracks and transceivers, `RTCDataChannel`, standard events, ICE configuration, offer/answer negotiation, and `getStats()`.

A small number of intentional or known edge-case differences remain for backward compatibility or unsupported legacy APIs. See [Browser API compatibility](_media/browser-api-compatibility.md) for those differences and the WPT strategy used to track exact browser behavior.

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

WPT reports use `v8-to-istanbul` directly to retain the V8 metrics used by the committed coverage baseline, independently of Vitest's AST-based coverage provider. Only observed TypeScript sources and source-mapped lines are measured.

`npm run wpt` runs every upstream `webrtc/` file and fails only on a regression against `wpt/baseline.json`: a baseline subtest that reports a lower status, or that a file which ran does not report (a whole-file timeout keeps the subtests that finished before it). The per-file timeouts are short, so a target whose regressions are all timeouts is rerun once, one at a time with 4x timeouts, and judged by the rerun (listed under "Rerun after timeout-only regressions"); a FAIL is never rerun. Every `RTCPeerConnection` is created with the browser-compatible configuration of [Compatibility options](#compatibility-options).

The baseline lists the subtests that passed in every one of repeated full runs, minus the targets `wpt/allowlist.json` keeps out of the gate (`enabled: false`, `baselineExclusions`). Refresh it from saved runs, then the coverage baseline:

```sh
# from packages/webrtc: save coverage/webrtc-wpt/results.json after each full run (10 runs recommended)
for i in $(seq 1 10); do npm run wpt; cp ../../coverage/webrtc-wpt/results.json /tmp/wpt-$i.json; done
npm run wpt:stable-baseline -- /tmp/wpt-*.json
WPT_UPDATE_COVERAGE_BASELINE=1 npm run wpt:coverage
```

`npm run wpt -- --update-baseline` records the PASS subtests of a single run.

## Rejected, stopped and reused m-lines

A remote offer can contain audio/video sections that the local `codecs` cannot handle. `setRemoteDescription()` still succeeds and the answer rejects only those sections with port 0 at the same position (Issue #705). For example, an audio-only peer can answer a browser offer that bundles video without adding VP8:

```ts
const pc = new RTCPeerConnection({
  codecs: { audio: [useOPUS()], video: [] },
});
await pc.setRemoteDescription(browserOffer); // audio + video in BUNDLE
await pc.setLocalDescription(await pc.createAnswer()); // video: m=video 0 ...
```

`mLineReuse` selects how inactive and stopped m-lines are written. It is fixed at construction time.

```ts
new RTCPeerConnection(); // mLineReuse: "standard" (default, as JSEP and browsers)
new RTCPeerConnection({ mLineReuse: "aggressive" }); // before v0.25.0: inactive also uses port 0
```

| `mLineReuse` | accepted `inactive` | rejected / stopped |
| --- | --- | --- |
| `"standard"` (default) | non-zero port | port 0 |
| `"aggressive"` | port 0 | port 0 |

The v0.27.0 name `"compatible"` (= `"standard"`) is still accepted (see [Compatibility options](#compatibility-options)).

With `"aggressive"`, the remote side (browsers included) treats an inactive port 0 m-line as rejected, so once it is negotiated the transceiver becomes `stopped` and cannot be resumed by setting `direction` back to `"sendrecv"`. Add a new transceiver instead; it reuses that position. This differs from older werift versions. Use the default `"standard"` if you need to pause and resume with `inactive`.

In `"standard"`, `inactive` m-lines are kept and not reused. To reuse an m-line position, release it explicitly: call `transceiver.stop()` on the side that owns the track (in the browser, after `pc.removeTrack(sender)`) and renegotiate. The m-line is negotiated as port 0 and both sides stop it, then the next `addTransceiver()` / `addTrack()` of the same kind (browser or werift) takes that position with a new MID, so the number of m-lines does not grow. Choose `"aggressive"` only when you cannot change the remote side to call `stop()`.

- Rejected (`transceiver.rejected`): no common codec or remote port 0. No sender/receiver pipeline, router registration, `ontrack` or TWCC is set up for it.
- Stopped: `transceiver.stop()` releases media immediately and is negotiated as port 0 in the next local offer; `transceiver.stopped` becomes `true` when the answer is applied. An answerer that calls `stop()` answers `inactive` first and negotiates the stop in its own next offer.
- Reused: after the port 0 negotiation completes, `addTransceiver()` of the same kind takes that position with a new MID and a new transceiver, so the number of m-lines does not grow. Positions that are only stopping are not reused.
- `removeTrack(sender)` only detaches the track. `sender.replaceTrack(track)` plus `transceiver.direction = "sendrecv"` resumes sending on the same sender.

See [the design note](_media/705-media-rejection-and-removetrack.md) for BUNDLE, ICE candidate and rollback details.

`transceiverPairing` selects which local transceiver a remote offer's m-section is paired with when no transceiver has its MID yet (Issue #816). It is fixed at construction time.

```ts
new RTCPeerConnection(); // transceiverPairing: "byKind" (default, werift up to v0.27.0)
new RTCPeerConnection({ transceiverPairing: "standard" }); // RFC 8829 section 5.10, as browsers
```

| `transceiverPairing` | an unassociated transceiver of the same kind paired with the offer | glare (perfect negotiation) |
| --- | --- | --- |
| `"byKind"` (default) | any one of the same kind, whatever created it (the one at the same m-line index first) | the remote offer can take over your `addTransceiver()` transceiver, and its direction becomes the negotiated one (e.g. `"sendonly"` becomes `"sendrecv"`) |
| `"standard"` | only one `addTrack()` created (or a remote one `addTrack()` reused that a rollback kept), and only for a `sendrecv` / `recvonly` m-section (a `sendonly` / `inactive` one gets a new transceiver, RFC 8829 5.10). One `addTransceiver()` created is never paired, with or without a track, also after `replaceTrack()` or a later `addTrack()` reused it: the offer gets a new transceiver and the local one keeps its `direction` and `mid === null` until your next offer negotiates it (`negotiationneeded` fires after the answer). | the direction you gave `addTransceiver()` (e.g. `"sendonly"`) is kept |

Use `"standard"` for the perfect negotiation pattern and for code written for browsers. An answerer that calls `addTransceiver()` before `setRemoteDescription(offer)` and relies on the pairing changes as follows under `"standard"`:

- Send and receive on the offered m-line: use `pc.addTrack(track)` instead (it is paired under `"standard"` too), or, after `setRemoteDescription()`, set `direction` on the transceiver the offer created (`pc.getTransceivers()`, `ontrack` or `onRemoteTransceiverAdded`) and call `sender.replaceTrack(track)` on it.

```ts
pc.onRemoteTransceiverAdded.subscribe((transceiver) => {
  transceiver.direction = "sendrecv";
  transceiver.onTrack.subscribe((track) => transceiver.sender.replaceTrack(track));
});
await pc.setRemoteDescription(offer);
await pc.setLocalDescription(await pc.createAnswer());
```

- A receive-only transceiver with a fixed direction created before the offer: set `direction` on the transceiver the offer created instead.

These patterns work under both values.

## Compatibility options

Where werift's own behavior differs from the specifications and browsers, a constructor option selects it. Each one takes `"standard"`, the behavior the specifications (W3C WebRTC, JSEP, the RTP RFCs) define and browsers implement, and a value naming werift's own behavior, kept so existing werift applications keep working:

| Option | Default | werift's own value | `"standard"` | `setConfiguration()` | Old names still accepted |
| --- | --- | --- | --- | --- | --- |
| `certificateScope` | `"process"` | `"process"`: one default DTLS certificate shared by the process | a certificate per `RTCPeerConnection` | fixed | `"peerConnection"` (= `"standard"`) |
| `mLineReuse` | `"standard"` | `"aggressive"`: an accepted `inactive` m-line uses port 0, so its position is reused | an accepted `inactive` m-line keeps its port | fixed | `"compatible"` (= `"standard"`) |
| `transceiverPairing` | `"byKind"` | `"byKind"`: a remote offer takes any unassociated transceiver of its kind | JSEP 5.10: only one `addTrack()` created | fixed | — |
| `keyFrameRequestRouting` | `"fallback"` | `"fallback"`: a PLI / FIR for an unknown SSRC falls back to the RTX owner or the only video sender | not delivered (RFC 4585 / RFC 5104) | changeable | `"compatible"` (= `"fallback"`), `"strict"` (= `"standard"`) |

Any other value is a `TypeError`, and changing a fixed option is an `InvalidModificationError`. An old name is read as its current name (`getConfiguration()` returns the current name). `CompatibilityOptionValues` lists the values of every option.

`compatibility: "standard"` sets all of them to `"standard"` at once, and `compatibility` cannot be changed after construction. An option given explicitly always takes precedence over it: a value given in the same configuration (an old name included) is kept, and `setConfiguration()` handles the options as without `compatibility` (only `keyFrameRequestRouting` may change). An option given as `undefined` is filled with `"standard"`:

```ts
new RTCPeerConnection({ compatibility: "standard" }); // every option above is "standard"
new RTCPeerConnection({ compatibility: "standard", certificateScope: "process" }); // all but certificateScope
```

Two more defaults differ from a browser: the default `iceServers` is a public STUN server (`stun:stun.l.google.com:19302`, a browser's default is `[]`), and `iceUseDefaultStunServer: true` (default) also uses that server when `iceServers` has no STUN URL. `bundlePolicy: "balanced"` is read as `"max-compat"` (no browser-equivalent value). For code written for browsers (for example with `werift/polyfill` and its `peerConnectionConfig`), create connections with:

```ts
new RTCPeerConnection({
  compatibility: "standard",
  iceServers: [], // or your own STUN / TURN servers
  iceUseDefaultStunServer: false,
});
```

The upstream WPT runner (`npm run wpt`) creates every `RTCPeerConnection` with this configuration (`tools/wpt-runner/browserConfig.ts`).

## Documentation

- [Website](https://shinyoshiaki.github.io/werift-webrtc/website/build/)
- [API Reference](https://shinyoshiaki.github.io/werift-webrtc/website/build/docs/api)
- [Examples](_media/examples)
- [Polyfill guide](_media/README-1.md)
- [Browser API compatibility differences](_media/browser-api-compatibility.md)

## TWCC send-side bandwidth estimation

[TWCC](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01) provides transport-wide feedback; the **estimation algorithm is pluggable**.

| API | Role |
| --- | --- |
| `new RTCPeerConnection({ bandwidthEstimator })` | Per-sender default: `"lightweight"` (default), `"gcc"`, `false` / `"none"` (disabled), or `() => BandwidthEstimator` |
| `RTCRtpSender.senderBWE` | **Getter** for active `BandwidthEstimator`. Replace only via setter. |
| `RTCRtpSender.setBandwidthEstimator(impl)` | Swap algorithm instance on one sender (e.g. `new GccBandwidthEstimator()`) |
| **`sender.onAvailableBitrate`** | **bps**; fires only when the recommended bitrate **changes**. Survives estimator swap — prefer this for apps. |
| `sender.pacingBitrateBps` | Effective send rate including active GCC probe target. Lightweight / disabled do not pace. |
| `sender.onProbeClusterConfig` | Probe cluster targets (GCC fires; lightweight / disabled never do) |

GCC send-path hooks (`process`, `setRoundTripTime`, probe padding, pacing) live on `BandwidthEstimator`. `LightweightBandwidthEstimator` and `DisabledBandwidthEstimator` implement them as no-ops so `RTCRtpSender` does not import GCC. Transport-wide sequence is a monotonic counter on `RTCDtlsTransport` (`transportSequenceNumber` is the 16-bit wire view). `RTCDtlsTransport.sendRtp` still returns `Promise<number>`; use `sendRtpWithMeta` for ICE-enqueue time.

- Lightweight / disabled (the default) write RTP straight through, as before the abstraction: no send FIFO, no pacing, no padding.
- GCC uses a bounded per-sender send FIFO (stale video drop / audio latency cap). Probe padding yields to queued media.
- Padding is padding-only RTP on the **RTX** SSRC, so media sequence numbers are never shifted. Without negotiated RTX, no padding is sent and probes use media only (`GCC_KNOWN_DIFFERENCES`).
- Every estimator reads TWCC through `TwccFeedbackAdapter`. Each sent packet is counted as received at most once, including duplicate and reordered feedback.

```ts
import {
  GccBandwidthEstimator,
  type LightweightBandwidthEstimator,
} from "werift";

// Connection-wide default (each RTCRtpSender gets its own instance):
const pc = new RTCPeerConnection({
  bandwidthEstimator: "gcc",
  // bandwidthEstimator: false, // disable send-side BWE
  // bandwidthEstimator: () => new GccBandwidthEstimator(800_000),
});

// Recommended: sender-level event (survives setBandwidthEstimator).
sender.onAvailableBitrate.subscribe((bps) => {
  // drive encoder / simulcast layer selection (bps, change-only)
});

// Optional: switch one sender to Google Congestion Control.
sender.setBandwidthEstimator(new GccBandwidthEstimator());
// During probes (GCC only — lightweight / disabled are unpaced):
// - sender.pacingBitrateBps is raised to the probe target
// - RTCRtpSender paces with a token-bucket and injects RTX padding when media
//   alone cannot fill the probe cluster (see maybeInjectProbePadding)
sender.onProbeClusterConfig.subscribe((cfg) => {
  // optional: raise encoder toward cfg.targetBps for the cluster duration
});

// Lightweight-only (default estimator) congestion score:
const lightweight = sender.senderBWE as LightweightBandwidthEstimator;
lightweight.onCongestionScore.subscribe((score) => { /* … */ });
```

Until TWCC is negotiated and enough samples arrive, `availableBitrate` may stay `0`.
`MediaStreamTrack.onReceiveRtp` delivers wire packets by default, including padding-only RTP as `{ type: "padding" }`. Set `filterProbePaddingOnReceiveRtp: true` only when a consumer needs GCC/SFU-style media-only sequence compaction.

**Scope notes (ticket constraints / known differences):**

- Transport-wide sequence numbers, `ReceiverTWCC`, and TWCC RTCP delivery are **per DTLS transport**. Each `RTCRtpSender` still has its own `BandwidthEstimator`; feedback is fanned out and each estimator matches only its own `SentInfo`. Transport-level GCC/pacer allocation is a non-goal.
- `sender.senderBWE.onCongestion` / `onCongestionScore` remain a **one-release TypeScript compatibility surface**. They fire only on `LightweightBandwidthEstimator`; GCC/disabled expose no-op Events. Prefer `sender.senderBWE as LightweightBandwidthEstimator` or `isLightweightBandwidthEstimator`.
- GCC follows libwebrtc goog_cc as a reference, but does not aim for a 1:1 match. Tests check GCC behavior in a simulated bottleneck: it backs off under congestion and loss, ramps up with probes, and backs off when feedback stops. They do not pin libwebrtc's exact order of operations or boundary values. `GCC_KNOWN_DIFFERENCES` (`GccBandwidthEstimator.knownDifferences`) lists known gaps (no REMB, lightweight pacer, float/clock drift, etc.) for reference.
- Bottleneck simulations are **CI-excluded**: `cd packages/webrtc && npm run test:sim`, and `cd e2e && npm run test:sim` (Chrome). Run them before merging GCC/TWCC changes.

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

The outbound SCTP packet MTU can be configured independently from the
negotiated DataChannel message-size limit:

```typescript
const peerConnection = new RTCPeerConnection({
  sctp: { mtu: 1052 },
});
```

`sctp.mtu` defaults to 1191 bytes (a maximum DATA payload of 1160 bytes per
fragment). It cannot be changed to a different value after the SCTP transport
has been created.

## Current implementation highlights

- Browser-compatible `RTCPeerConnection` API and standard WebRTC events
- STUN and TURN relay support, including TURN control transports over UDP, TCP, and TLS
- Full ICE, trickle ICE, ICE-Lite support/interoperability, ICE restart, and ICE-TCP
- DTLS-SRTP, SRTP, and SRTCP
- DataChannel over SCTP/DTLS
- Media sendonly / recvonly / sendrecv and multiple tracks
- RTP/RTCP feedback including SR/RR, PLI, REMB, Generic NACK, and Transport-Wide CC
- RTX and RED
- Receive-side simulcast
- Sender-side bandwidth estimation
- Browser-compatible `getStats()` reporting
- Compatibility validation backed by an allowlisted upstream WPT runner

See the [repository README](_media/README.md#protocol-coverage-at-a-glance) for the broader feature checklist.

## Interoperability

The repository contains Chromium-focused browser E2E tests and a Firefox test runner. Safari interoperability is also community-verified: users have reported extensive real-world use with Safari in [Issue #346](https://github.com/shinyoshiaki/werift-webrtc/issues/346). Safari is not currently part of the automated browser E2E matrix, so this is community validation rather than a CI guarantee.

werift also participates in the independent [`sipsorcery/webrtc-interop`](https://github.com/sipsorcery/webrtc-interop) Peer Connection and Data Channel Echo matrices.

## Roadmap

Current work is focused on:

- improving documentation and WPT coverage
- closing remaining documented browser API edge-case differences
- simulcast send support
- additional cipher suites
- richer WebRTC statistics coverage
- continued unit, E2E, interoperability, and long-running reliability testing

## References

- [aiortc](https://github.com/aiortc/aiortc)
- [Pion WebRTC](https://github.com/pion/webrtc)
- [sipsorcery/webrtc-interop](https://github.com/sipsorcery/webrtc-interop)
