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

## DTLS 1.3 opt-in

Default `new RTCPeerConnection()` still uses DTLS 1.2 only. DTLS 1.3 is an explicit opt-in via `dtls.protocolVersions`. SPED (DTLS handshake in ICE Binding) is a separate opt-in via `sped: true` (default false) and requires DTLS 1.3 at `connect()`.

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

## SPED opt-in

`PeerConfig.sped` defaults to `false`: ICE completes, then DTLS starts. Set `sped: true` together with DTLS 1.3 so this PeerConnection embeds the DTLS 1.3 handshake in authenticated ICE Binding attributes (`0xC070` / `0xC071`). `connect()` throws if `sped` is true and `dtls.protocolVersions` does not include `"1.3"`. `sped: true` cannot be combined with `dtls.helloRetryRequest: true` (SPED uses ICE-authenticated address validation, not a DTLS cookie).

WARP early server traffic is separately and explicitly enabled with
`warp: { allowEarlyServerData: true }`. It requires both `sped: true` and DTLS
1.3. Inbound application data and media remain hidden until the SDP
fingerprint matches. Pre-authentication encrypted media is dropped by default;
set `warp.earlyMediaPolicy` to `"buffer"` to retain up to 256 packets / 256 KiB
for at most two seconds.

`close()` can interrupt the DTLS handshake with or without DataChannels.
Revoking early sending with `setConfiguration({ warp: {
allowEarlyServerData: false } })` cancels unfinished SCTP starts of the DTLS
server. A cancelled association stays closed even if an in-flight send
completes later; a retry uses a fresh association. Once COOKIE_ECHO or
COOKIE_ACK has been handed to DTLS the peer may already be established, so the
start is no longer cancelled: a send that fails afterwards counts as packet
loss and SCTP retransmits (immediately on cancel/revoke and when DTLS
connects) on the same association.

```ts
const pc = new RTCPeerConnection({
  sped: true,
  dtls: { protocolVersions: [DtlsVersion.V1_3] },
});
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

WPT reports use `v8-to-istanbul` directly to retain the V8 metrics used by the committed coverage baseline, independently of Vitest's AST-based coverage provider. Only observed TypeScript sources and source-mapped lines are measured.

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

In `"compatible"`, `inactive` m-lines are kept and not reused. To reuse an m-line position, release it explicitly: call `transceiver.stop()` on the side that owns the track (in the browser, after `pc.removeTrack(sender)`) and renegotiate. The m-line is negotiated as port 0 and both sides stop it, then the next `addTransceiver()` / `addTrack()` of the same kind (browser or werift) takes that position with a new MID, so the number of m-lines does not grow. Choose `"aggressive"` only when you cannot change the remote side to call `stop()`.

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
