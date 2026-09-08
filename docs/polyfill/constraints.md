# Constraints and device selection

The polyfill exposes `navigator.mediaDevices.getUserMedia()` and
`enumerateDevices()` over the registered sources. It follows the familiar
audio/video constraint shape while using register metadata to choose a source.

## Request shape

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

At least one of `audio` or `video` must be truthy. `true` is normalized to an
empty constraint object. `getDisplayMedia()` is currently an alias for the
same register-backed operation; it does not provide OS display capture.

## Selection constraints

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

## Constraints passed to custom registers

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

`width`, `height`, `frameRate`, `facingMode`, and application-specific keys
are preserved for the register. The built-in registers do not resize,
re-encode, or otherwise apply those settings; a custom register must apply
them or throw `OverconstrainedError` when it cannot satisfy them.

The `signal` is aborted when the owning polyfill is uninstalled. Custom
registers should stop pending I/O and reject promptly when it is aborted.

## Enumerating devices

`enumerateDevices()` prepares the registers and returns one entry per
registered media kind. Each entry includes `deviceId`, `groupId`, `label`, and
`kind` (`audioinput` or `videoinput`).

Explicit IDs are stable for the lifetime of the register. Registers without an
ID receive generated IDs such as `werift-device-1`. Duplicate explicit IDs
are rejected during installation rather than producing ambiguous selection.

## Errors

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
