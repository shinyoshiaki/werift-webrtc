# Install, target, and cleanup

## `installPolyfill()`

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

## Installation target

Use `target` to keep the polyfill in a sandbox rather than modifying the
process global object:

```ts
const sandbox = { navigator: {} as Record<string, unknown> };

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

## Cleanup and restoration

The returned function restores the previous property descriptors for the
installed globals, `navigator`, `navigator.mediaDevices`, `navigator.userAgent`,
and `window`. It also stops active tracks, closes register-owned input, and
aborts in-flight register work.

Keep the cleanup function for the whole lifetime of the media scope. A
`try`/`finally` block is the simplest pattern:

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

## User-Agent compatibility

On Node.js, when the current value is missing, blank, or matches
`Node.js/<major>`, installation supplies a Chromium 111-compatible
`navigator.userAgent`. An existing non-Node value is preserved.

Pass `userAgent` only when an explicit value is needed. It replaces even an
existing browser or sandbox value, and the previous descriptor is restored by
`uninstall()`.

This value is a compatibility hint for browser-oriented libraries that select
an implementation from the User-Agent. It does not turn werift into Chromium
and does not provide browser media capture.
