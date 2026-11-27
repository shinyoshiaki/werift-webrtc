[**werift**](../README.md)

***

[werift](../globals.md) / RTCDataChannelBinaryType

# Enumeration: RTCDataChannelBinaryType

The form a received binary message takes in `onmessage` and the
`"message"` event (W3C `RTCDataChannel.binaryType`).
- `"nodebuffer"`: a Node.js `Buffer` (werift extension, the core default;
  named after the `ws` library's value).
- `"arraybuffer"`: an `ArrayBuffer` (the W3C default, used by
  `werift/polyfill`).
- `"blob"`: a `Blob`.

Text messages are always strings. [RTCDataChannel.onMessage](../classes/RTCDataChannel.md#onmessage-1) always
receives a `Buffer` or a string.

## Enumeration Members

### arraybuffer

> **arraybuffer**: `"arraybuffer"`

***

### blob

> **blob**: `"blob"`

***

### nodebuffer

> **nodebuffer**: `"nodebuffer"`
