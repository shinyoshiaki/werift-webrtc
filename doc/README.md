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

Refresh the committed baselines when intentionally expanding upstream coverage:

```sh
npm run wpt --workspace packages/webrtc -- --update-baseline
WPT_UPDATE_COVERAGE_BASELINE=1 npm run wpt:coverage --workspace packages/webrtc
```

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
new RTCPeerConnection(); // mLineReuse: "compatible" (default)
new RTCPeerConnection({ mLineReuse: "aggressive" }); // legacy: inactive also uses port 0
```

| `mLineReuse` | accepted `inactive` | rejected / stopped |
| --- | --- | --- |
| `"compatible"` (default) | non-zero port | port 0 |
| `"aggressive"` | port 0 | port 0 |

With `"aggressive"`, the remote side (browsers included) treats an inactive port 0 m-line as rejected, so once it is negotiated the transceiver becomes `stopped` and cannot be resumed by setting `direction` back to `"sendrecv"`. Add a new transceiver instead; it reuses that position. This differs from older werift versions. Use the default `"compatible"` if you need to pause and resume with `inactive`.

- Rejected (`transceiver.rejected`): no common codec or remote port 0. No sender/receiver pipeline, router registration, `ontrack` or TWCC is set up for it.
- Stopped: `transceiver.stop()` releases media immediately and is negotiated as port 0 in the next local offer; `transceiver.stopped` becomes `true` when the answer is applied. An answerer that calls `stop()` answers `inactive` first and negotiates the stop in its own next offer.
- Reused: after the port 0 negotiation completes, `addTransceiver()` of the same kind takes that position with a new MID and a new transceiver, so the number of m-lines does not grow. Positions that are only stopping are not reused.
- `removeTrack(sender)` only detaches the track. `sender.replaceTrack(track)` plus `transceiver.direction = "sendrecv"` resumes sending on the same sender.

See [the design note](_media/705-media-rejection-and-removetrack.md) for BUNDLE, ICE candidate and rollback details.

## Documentation

- [Website](https://shinyoshiaki.github.io/werift-webrtc/website/build/)
- [API Reference](https://shinyoshiaki.github.io/werift-webrtc/website/build/docs/api)
- [Examples](../../examples)
- [Polyfill guide](_media/README-1.md)
- [Browser API compatibility differences](_media/browser-api-compatibility.md)

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
