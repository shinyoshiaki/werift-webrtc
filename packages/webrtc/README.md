# werift

werift (**We**b**R**TC **I**mplementation **f**or **T**ypeScript) is a WebRTC implementation for Node.js written in TypeScript with a browser-compatible WebRTC API.

For the project overview, current features, examples, architecture, and interoperability information, see the [repository README](../../README.md).

## Install

```sh
npm install werift
```

## Browser-compatible WebRTC API

werift is designed so application code can use the familiar browser WebRTC model in Node.js: `RTCPeerConnection`, tracks and transceivers, `RTCDataChannel`, standard events, ICE configuration, offer/answer negotiation, and `getStats()`.

A small number of intentional or known edge-case differences remain for backward compatibility or unsupported legacy APIs. See [Browser API compatibility](../../docs/browser-api-compatibility.md) for those differences and the WPT strategy used to track exact browser behavior.

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
- [Browser API compatibility differences](../../docs/browser-api-compatibility.md)

## TWCC send-side bandwidth estimation

[TWCC](https://datatracker.ietf.org/doc/html/draft-holmer-rmcat-transport-wide-cc-extensions-01) provides transport-wide feedback; the **estimation algorithm is pluggable**.

| API | Role |
| --- | --- |
| `RTCRtpSender.senderBWE` | **Getter** for active `BandwidthEstimator` (default: legacy). Replace only via setter. |
| `RTCRtpSender.setBandwidthEstimator(impl)` | Swap algorithm instance (e.g. `new GccBandwidthEstimator()`) |
| **`sender.onAvailableBitrate`** | **bps**; fires only when the recommended bitrate **changes**. Survives estimator swap — prefer this for apps. |
| `sender.pacingBitrateBps` | Effective send rate including active GCC probe target (`ProbePacingController`) |
| `sender.onProbeClusterConfig` | GCC probe cluster targets for pacing / encoder ramp |
| `isProbePacingController(e)` | Type guard for probe/pacing hooks (not on common interface) |
| `isRoundTripTimeConsumer(e)` | Type guard for raw RTCP RTT → AIMD (GCC only; not on common interface) |
| `isBandwidthEstimatorProcessor(e)` | Type guard for pin ProcessInterval-style `process(nowMs)` (GCC RTT backoff) |

```ts
import {
  GccBandwidthEstimator,
  type SenderBandwidthEstimator,
} from "werift";

// Recommended: sender-level event (survives setBandwidthEstimator).
sender.onAvailableBitrate.subscribe((bps) => {
  // drive encoder / simulcast layer selection (bps, change-only)
});

// Optional: switch to Google Congestion Control (trendline + loss + probe).
sender.setBandwidthEstimator(new GccBandwidthEstimator());
// During probes (GCC / ProbePacingController only — legacy is unpaced):
// - sender.pacingBitrateBps is raised to the probe target
// - RTCRtpSender paces with a token-bucket and injects RTP padding when media
//   alone cannot fill the probe cluster (see maybeInjectProbePadding)
sender.onProbeClusterConfig.subscribe((cfg) => {
  // optional: raise encoder toward cfg.targetBps for the cluster duration
});

// Legacy-only (default estimator) congestion score:
const legacy = sender.senderBWE as SenderBandwidthEstimator;
legacy.onCongestionScore.subscribe((score) => { /* … */ });
```

Until TWCC is negotiated and enough samples arrive, `availableBitrate` may stay `0`.

**Scope notes (ticket constraints / known differences):**

- Transport-wide sequence numbers are allocated on the shared DTLS transport; each `RTCRtpSender` still has its **own** `BandwidthEstimator`. With multiple senders, feedback covers the whole transport while estimates remain per-sender (intentional; transport-level BWE / REMB are non-goals here).
- GCC is structure-compatible with libwebrtc goog_cc, not bit-identical. See `GccBandwidthEstimator.knownDifferences` / `GCC_KNOWN_DIFFERENCES` for intentional gaps (no REMB, lightweight pacer, float/clock drift, etc.).
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

See the [repository README](../../README.md#protocol-coverage-at-a-glance) for the broader feature checklist.

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