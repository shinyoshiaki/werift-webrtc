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

## DTLS 1.3 opt-in

Default `new RTCPeerConnection()` still uses DTLS 1.2 only. DTLS 1.3 is an explicit opt-in and is independent of SPED (this package does not enable SPED).

On the ICE-selected path, DTLS 1.3 omits the HelloRetryRequest cookie exchange by default so the handshake does not pay an extra RTT. Set `dtls.helloRetryRequest: true` only when you want a cookie-bearing HRR. Group-only HRR for `key_share` correction is unrelated and may still be sent.

```ts
import { DtlsVersion, RTCPeerConnection } from "werift";

// DTLS 1.3 only
const dtls13 = new RTCPeerConnection({
  dtls: { protocolVersions: [DtlsVersion.V1_3] },
});

// DTLS 1.3 preferred, DTLS 1.2 fallback
const dual = new RTCPeerConnection({
  dtls: {
    protocolVersions: [DtlsVersion.V1_3, DtlsVersion.V1_2],
  },
});

// Cookie HRR (adds 1 RTT; not the WebRTC default)
const cookieHrr = new RTCPeerConnection({
  dtls: {
    protocolVersions: [DtlsVersion.V1_3],
    helloRetryRequest: true,
  },
});
```

`getStats()` transport `tlsVersion` is `"DTLS 1.2"` or `"DTLS 1.3"`. Successful DTLS 1.3 reports `dtlsCipher` `"TLS_AES_128_GCM_SHA256"`.

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