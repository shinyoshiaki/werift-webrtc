# Media registers and input formats

`mediaRegister` is the bridge between `getUserMedia()` and an application
media source. Each register advertises one or both media kinds and creates
werift `MediaStreamTrack` objects when that source is selected.

## Register model

A custom register implements the following shape:

```ts
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
`enumerateDevices()`. If `deviceId` is omitted, the installer assigns an ID in
the form `werift-device-N`. Explicit duplicate IDs are rejected.

## Built-in register factories

| Factory | Source | Notes |
| --- | --- | --- |
| `createMp4WebmRegister()` | MP4/WebM file, bytes, or stream | Plays a container source and creates audio/video tracks found in it. Supports `loop` and per-kind codec hints. |
| `createRtpRtcpRegister()` | RTP/RTCP over UDP or a Node/Web stream | Delivers RTP and muxed RTCP directly to the track. `mimeType` is required. |
| `createEncodedBinaryRegister()` | Encoded access units over UDP or a Node/Web stream | Packetizes VP8, VP9, H.264/AVC, AV1, or Opus into RTP. |
| `createCallbackRegister()` | Application-defined source | Passes the selected kind, device ID, normalized constraints, and abort signal to `createTracks()`. |
| `createDummyRegister()` | Generated test media | Convenient audio/video source for tests and smoke examples. |

All factories accept the common `deviceId`, `groupId`, and `label` options.

## MP4/WebM playback

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

## RTP/RTCP input

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

The source can instead be a Node `Readable` or a Web `ReadableStream`. Stream
input uses a 4-byte unsigned big-endian length prefix for each RTP or RTCP
record. UDP treats one datagram as one record. RTP/RTCP mux is supported; RTCP
packets are delivered through the track's RTCP path.

`clockRate`, `channels`, `payloadType`, `parameters`, and `rtcpFeedback` can
be supplied when the advertised codec needs an explicit value. If
`clockRate` is omitted, Opus uses 48 kHz, other audio uses 8 kHz, and video
uses 90 kHz.

## Encoded binary input

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

## Custom callback sources

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
