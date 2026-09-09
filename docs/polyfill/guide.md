# Polyfill usage guide

[Back to the polyfill overview](./README.md)

## Installation and lifecycle

### `installPolyfill()`

```ts
import { installPolyfill } from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [],
});

// Use RTCPeerConnection, MediaStream, and navigator.mediaDevices here.

uninstall();
```

`installPolyfill()` returns a cleanup function. The installer validates the
options before changing the target and rolls back all changes if installation
fails.

| Option | Required | Description |
| --- | --- | --- |
| `mediaRegister` | yes | An array of media registers. An empty array is valid. |
| `target` | no | Object receiving the globals. Defaults to `globalThis`. |
| `existingMediaDevices` | no | How an existing `navigator.mediaDevices` is handled. Defaults to `"overwrite"`. |
| `userAgent` | no | A non-empty string to install as `navigator.userAgent`. |

The supported `existingMediaDevices` modes are:

| Mode | Behavior |
| --- | --- |
| `"overwrite"` | Replace an existing `mediaDevices` object that has `getUserMedia()`. |
| `"throw"` | Throw instead of replacing it. The target remains unchanged. |
| `"noop"` | Keep the existing object and skip installing werift's `mediaDevices`. |

If an existing value does not provide `getUserMedia()`, the polyfill installs
its `mediaDevices` implementation regardless of the selected mode.

### Installation target

Use `target` to keep the polyfill in a sandbox rather than modifying the
process global object:

```ts
import { installPolyfill } from "werift/polyfill";

const sandbox: Record<string, unknown> = { navigator: {} };

const uninstall = installPolyfill({
  target: sandbox,
  mediaRegister: [],
});

const PeerConnection = sandbox.RTCPeerConnection;
// Pass sandbox.RTCPeerConnection to code that runs in this sandbox.

uninstall();
```

When the target has no `window`, the installer points `window` at the target.
This is useful for browser-oriented libraries that check for a window-like
global, but it does not provide a DOM.

### Cleanup and restoration

The returned function restores the previous property descriptors for the
installed globals, `navigator`, `navigator.mediaDevices`,
`navigator.userAgent`, and `window`. It also stops active tracks, closes
register-owned input, and aborts in-flight register work.

Keep the cleanup function for the whole lifetime of the media scope:

```ts
const uninstall = installPolyfill({
  mediaRegister: [/* registers */],
});

try {
  await runPeerConnection();
} finally {
  uninstall();
}
```

Built-in registers release their source when their acquired tracks are stopped.
Custom registers should bind equivalent source cleanup to the tracks they
return. The final `uninstall()` is still required to remove globals and stop
any remaining register sessions.

### User-Agent compatibility

On Node.js, when the current value is missing, blank, or matches
`Node.js/<major>`, installation supplies a Chromium 111-compatible
`navigator.userAgent`. An existing non-Node value is preserved.

Pass `userAgent` only when an explicit value is needed. It replaces even an
existing browser or sandbox value, and the previous descriptor is restored by
`uninstall()`.

This value is a compatibility hint for browser-oriented libraries that select
an implementation from the User-Agent. It does not turn werift into Chromium
and does not provide browser media capture.

## Media registers and input formats

`mediaRegister` is the bridge between `getUserMedia()` and an application
media source. Each register advertises one or both media kinds and creates
werift `MediaStreamTrack` objects when that source is selected.

### Register model

A custom register implements the following shape:

```ts
import type { MediaStreamTrack } from "werift";

interface MediaRegister {
  readonly mimeType: string;
  readonly kinds: readonly ("audio" | "video")[];
  readonly deviceId?: string;
  readonly groupId?: string;
  readonly label?: string;
  createTracks(request: {
    kind: "audio" | "video";
    deviceId: string;
    constraints: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<MediaStreamTrack[]>;
  prepare?(): Promise<void>;
  stop?(): void;
}
```

`prepare()` is used for asynchronous source setup before enumeration or media
acquisition. `stop()` is called when the owning polyfill is uninstalled.
Register-owned I/O should observe `request.signal` so uninstall can cancel it.

The `deviceId`, `groupId`, and `label` fields are exposed through
`enumerateDevices()`. If `deviceId` is omitted, the installer assigns an ID
in the form `werift-device-N`. Explicit duplicate IDs are rejected.

### Built-in register factories

| Factory | Source | Notes |
| --- | --- | --- |
| `createMp4WebmRegister()` | MP4/WebM file, bytes, or stream | Plays a container source and creates audio/video tracks found in it. Supports `loop` and per-kind codec hints. |
| `createRtpRtcpRegister()` | RTP/RTCP over UDP or a Node/Web stream | Delivers RTP and muxed RTCP directly to the track. `mimeType` is required. |
| `createEncodedBinaryRegister()` | Encoded access units over UDP or a Node/Web stream | Packetizes VP8, VP9, H.264/AVC, AV1, or Opus into RTP. |
| `createCallbackRegister()` | Application-defined source | Passes the selected kind, device ID, normalized constraints, and abort signal to `createTracks()`. |
| `createDummyRegister()` | Generated test media | Convenient audio/video source for tests and smoke examples. |

All factories accept the common `deviceId`, `groupId`, and `label` options.

### MP4/WebM playback

Choose exactly one input form:

```ts
import {
  createMp4WebmRegister,
  installPolyfill,
} from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [
    createMp4WebmRegister({
      path: "./media/clip.webm",
      loop: true,
      deviceId: "clip",
      codecs: {
        audio: "audio/opus",
        video: "video/VP8",
      },
    }),
  ],
});

const stream = await navigator.mediaDevices.getUserMedia({
  audio: { deviceId: { exact: "clip" } },
  video: { deviceId: { exact: "clip" } },
});

// Stop the source and remove the installed globals when the peer is finished.
uninstall();
```

`path` accepts a filesystem path, `binary` accepts a `Buffer`,
`ArrayBuffer`, or `ArrayBufferView`, and `stream` accepts a Node
`Readable` or a Web `ReadableStream<Uint8Array>`. The factory itself is
synchronous; file or stream setup is deferred until preparation or the first
media request.

When `codecs` is omitted, the container metadata is used. A codec hint can be
a MIME string, an RTP codec option object, or an `RTCRtpCodecParameters`
instance. An explicit hint must agree with the inspected kind's codec or the
request fails with `OverconstrainedError`.

### RTP/RTCP input

Use a UDP socket when a process such as GStreamer or FFmpeg writes RTP to a
port:

```ts
import {
  createRtpRtcpRegister,
  installPolyfill,
} from "werift/polyfill";

const uninstall = installPolyfill({
  mediaRegister: [
    createRtpRtcpRegister({
      mimeType: "video/VP8",
      udp: { address: "127.0.0.1", port: 5004 },
      payloadType: 96,
    }),
  ],
});

const stream = await navigator.mediaDevices.getUserMedia({ video: true });
// Stop the source and remove the installed globals when the peer is finished.
uninstall();
```

The source can instead be a Node `Readable` or a Web
`ReadableStream<Uint8Array>`. Stream input uses a 4-byte unsigned big-endian
length prefix for each RTP or RTCP record. UDP treats one datagram as one
record. RTP/RTCP mux is supported; RTCP packets are delivered through the
track's RTCP path.

`clockRate`, `channels`, `payloadType`, `parameters`, and
`rtcpFeedback` can be supplied when the advertised codec needs an explicit
value. If `clockRate` is omitted, Opus uses 48 kHz, other audio uses 8 kHz,
and video uses 90 kHz.

### Encoded binary input

Encoded input uses the same UDP/stream source forms, but each record is an
encoded access unit rather than an RTP packet:

```ts
import {
  createEncodedBinaryRegister,
  installPolyfill,
} from "werift/polyfill";

const register = createEncodedBinaryRegister({
  mimeType: "audio/opus",
  stream: encodedAccessUnitStream,
  clockRate: 48_000,
});
```

The register packetizes each access unit and derives RTP timestamps from the
arrival interval and codec clock rate. Input framing is still a 4-byte length
prefix for streams and one access unit per UDP datagram.

### Custom callback sources

Use `createCallbackRegister()` when the application already owns capture,
decoding, or packet production:

```ts
import {
  createCallbackRegister,
  installPolyfill,
} from "werift/polyfill";

const register = createCallbackRegister({
  mimeType: "video/VP8",
  kinds: ["video"],
  deviceId: "camera-1",
  async createTracks({ kind, constraints, signal }) {
    return createTracksFromApplicationSource({
      kind,
      constraints,
      signal,
    });
  },
});

installPolyfill({ mediaRegister: [register] });
```

`createCallbackRegister()` fills a missing track codec from `mimeType`. The
callback remains responsible for applying source-specific settings such as
resolution, frame rate, or facing mode and for rejecting settings it cannot
provide.

## Constraints and device selection

The polyfill exposes `navigator.mediaDevices.getUserMedia()` and
`enumerateDevices()` over the registered sources. It follows the familiar
audio/video constraint shape while using register metadata to choose a source.

### Request shape

```ts
const stream = await navigator.mediaDevices.getUserMedia({
  audio: {
    deviceId: { exact: "microphone-1" },
    groupId: { ideal: "room-a" },
    mimeType: { ideal: "audio/opus" },
  },
  video: {
    width: 1280,
    height: 720,
    frameRate: { ideal: 30 },
    facingMode: "user",
  },
});
```

At least one of `audio` or `video` must be truthy. `true` is normalized to
an empty constraint object. `getDisplayMedia()` is currently an alias for the
same register-backed operation; it does not provide OS display capture.

### Selection constraints

The following fields are used to select a register:

| Field | Supported values |
| --- | --- |
| `deviceId` | A string, list, `{ exact }`, or `{ ideal }` |
| `groupId` | A string, list, `{ exact }`, or `{ ideal }` |
| `mimeType` | A string, list, `{ exact }`, or `{ ideal }` |

Basic `exact` values filter candidates. Basic `ideal` values influence the
fitness distance, while `advanced` entries narrow the candidates only when an
entry still leaves at least one match. If multiple candidates have the same
fitness distance, registration order wins.

`getSupportedConstraints()` reports the three selection fields above. Other
constraint keys are not used by the built-in selector.

### Constraints passed to custom registers

The selected register receives a normalized request:

```ts
{
  kind: "video",
  deviceId: "camera-1",
  constraints: {
    width: 1280,
    height: 720,
    frameRate: 30,
    facingMode: "user",
  },
  signal,
}
```

`width`, `height`, `frameRate`, `facingMode`, and application-specific
keys are preserved for the register. The built-in registers do not resize,
re-encode, or otherwise apply those settings; a custom register must apply
them or throw `OverconstrainedError` when it cannot satisfy them.

The `signal` is aborted when the owning polyfill is uninstalled. Custom
registers should stop pending I/O and reject promptly when it is aborted.

### Enumerating devices

`enumerateDevices()` prepares the registers and returns one entry per
registered media kind. Each entry includes `deviceId`, `groupId`, `label`,
and `kind` (`audioinput` or `videoinput`).

Explicit IDs are stable for the lifetime of the register. Registers without an
ID receive generated IDs such as `werift-device-1`. Duplicate explicit IDs
are rejected during installation rather than producing ambiguous selection.

### Errors

| Error | Typical cause |
| --- | --- |
| `TypeError` | Neither media kind was requested, or installer options are invalid. |
| `NotFoundError` | No register provides the requested kind, or a file has no requested track. |
| `OverconstrainedError` | Required `deviceId`, `groupId`, `mimeType`, or source-specific setting cannot be met. |
| `NotReadableError` | A source cannot be opened, prepared, or read. |
| `AbortError` | Acquisition was cancelled by cleanup or an aborted source. |

If a register fails during preparation, it is excluded from selection for
subsequent requests during that installation. A source failure is surfaced as
`NotReadableError` when no usable register remains for the requested kind.

## TypeScript entrypoints and compatibility

### Choose the entrypoint for your `lib` configuration

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
// tsconfig with lib.dom; this block demonstrates type augmentation.
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

### Browser-shaped session descriptions

The polyfill entrypoint exports a browser-style `RTCSessionDescription`
constructor that accepts an initialization object:

```ts
const description = new RTCSessionDescription({
  type: "offer",
  sdp: offerSdp,
});
```

The core `werift` entrypoint uses its lower-level constructor form. Use the
polyfill entrypoint when integrating code that expects the browser
`{ type, sdp }` form.

### Runtime scope

The polyfill does not add OS camera or microphone capture, browser codecs,
rendering, or a browser event loop. Supply media through one or more registers
and configure signaling separately. A Node User-Agent is filled in only to
help browser-oriented libraries choose a compatible code path.
