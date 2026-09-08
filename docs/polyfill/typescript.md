# TypeScript entrypoints and compatibility

## Choose the entrypoint for your `lib` configuration

| Project configuration | Import |
| --- | --- |
| Node.js TypeScript without DOM types, such as `lib: ["esnext"]` | `werift/polyfill` |
| TypeScript project that includes `lib.dom` | `werift/polyfill/dom` |

Both imports expose the same runtime functions. The difference is the global
type declaration used by TypeScript:

```ts
// tsconfig without lib.dom
import { installPolyfill } from "werift/polyfill";

const uninstall = installPolyfill({ mediaRegister: [] });
const pc = new RTCPeerConnection();
void navigator.mediaDevices.getUserMedia;
uninstall();
void pc;
```

```ts
// tsconfig with lib.dom
import { installPolyfill } from "werift/polyfill/dom";

const uninstall = installPolyfill({ mediaRegister: [] });
const track = undefined as MediaStreamTrack;
track.writeRtp;
track.writeRtcp;
track.onReceiveRtp;
track.onReceiveRtcp;
uninstall();
```

The `/dom` entrypoint keeps the standard DOM constructor types and augments
`MediaStreamTrack` with werift's packet-oriented methods and events. Neither
entrypoint installs globals merely by being imported; `installPolyfill()` is
still required.

## Browser-shaped session descriptions

The polyfill entrypoint exports a browser-style `RTCSessionDescription`
constructor that accepts an initialization object:

```ts
const description = new RTCSessionDescription({
  type: "offer",
  sdp: offerSdp,
});
```

The core `werift` entrypoint retains its existing lower-level constructor
behavior. Use the polyfill entrypoint when integrating code that expects the
browser `{ type, sdp }` form.

## Media is still application-owned

The polyfill does not add OS camera or microphone capture, browser codecs,
rendering, or a browser event loop. Supply media through one or more registers
and configure signaling separately. A Node User-Agent is filled in only to
help browser-oriented libraries choose a compatible code path.

The default User-Agent behavior preserves an existing non-Node value. Pass an
explicit `userAgent` to override it, including in a browser-like sandbox.
See [installation and cleanup](./installation.md#user-agent-compatibility) for
the restoration rules.

## Migration from the old nonstandard helper

The removed `werift/nonstandard` forms
`getUserMedia({ path | buffer | stream })` should be replaced with a media
register and the browser-shaped API:

```ts
import {
  createMp4WebmRegister,
  installPolyfill,
} from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [
    createMp4WebmRegister({ path: "./clip.mp4" }),
  ],
});

const stream = await navigator.mediaDevices.getUserMedia({
  audio: true,
  video: true,
});
```

Use [media registers](./media-registers.md) for the equivalent RTP, encoded
binary, and custom-source migrations.
