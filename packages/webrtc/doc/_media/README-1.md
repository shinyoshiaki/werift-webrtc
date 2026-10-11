# `werift/polyfill`

`werift/polyfill` is an opt-in Node.js adapter for applications that expect
browser-style WebRTC globals. It installs werift's WebRTC constructors and a
`navigator.mediaDevices` implementation backed by application-provided media
registers.

It is not a browser implementation of camera capture, codecs, rendering, or
the DOM. Applications still provide the media source and signaling that their
pipeline needs.

## Start here

- [Polyfill usage guide](./guide.md)

## Minimal example

```ts
import {
  createDummyRegister,
  installPolyfill,
} from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [createDummyRegister({ label: "test media" })],
});

try {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true });
  const [track] = stream.getVideoTracks();

  // Add the track to an RTCPeerConnection, or use it in another werift
  // media pipeline.
  track?.stop();
} finally {
  uninstall();
}
```

`mediaRegister` is required even when no media source is needed. Passing an
empty array installs a built-in empty register, so `getUserMedia()` returns a
plain live, muted track with no codec or generated RTP. The same intent can be
made explicit with `mediaRegister: [createEmptyRegister()]`.

```ts
import { createEmptyRegister, installPolyfill } from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [createEmptyRegister()],
});
const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true,
});
```

The import does not mutate globals by itself. Call `installPolyfill()` when the
application is ready to install the adapter, and call the returned function
when that scope is finished.

Use `peerConnectionConfig` to apply codec capabilities to every
polyfill-created PeerConnection, including mediasoup-client probe and transport
instances. Fixed-codec registers must match those capabilities or track
attachment throws `NotSupportedError`; they do not expand the codec list.

## Public entrypoints

| Import | Use |
| --- | --- |
| `werift` | Core werift classes and protocol helpers; no global installation |
| `werift/polyfill` | Polyfill API plus ambient werift global types for TypeScript projects without `lib.dom` |
| `werift/polyfill/dom` | The same runtime API with `lib.dom`-compatible type augmentation |

The polyfill entrypoint is intentionally separate from `werift` so existing
applications do not receive global mutations just by importing the core
package.

## What is installed

The installer provides browser-shaped globals such as
`RTCPeerConnection`, `RTCSessionDescription`, `RTCIceCandidate`,
`RTCDataChannel`, `MediaStream`, `MediaStreamTrack`, RTP sender/receiver and
transceiver classes, ICE/DTLS transport classes, `RTCTrackEvent`, and
`OverconstrainedError`. It also provides `navigator.mediaDevices` when the
selected installation mode allows it.

The available media sources are deliberately register-based. Choose the
appropriate guide above for file playback, RTP/RTCP ingestion, encoded binary
input, or a custom source.

## Related documentation

- [Browser API compatibility differences](../browser-api-compatibility.md)
- [Package API reference](https://shinyoshiaki.github.io/werift-webrtc/website/build/docs/api)
- [Runnable examples](../../examples)
