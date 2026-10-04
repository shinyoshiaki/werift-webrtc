## Summary

`RTCSctpTransport.dataChannelOpen()` loses the DCEP unordered bit when a DataChannel is both unordered and partially reliable.

For:

- `ordered: false, maxRetransmits: N`
- `ordered: false, maxPacketLifeTime: N`

werift currently advertises DCEP channel types `0x01` / `0x02` instead of `0x81` / `0x82`.

This makes the remote peer construct the channel as **ordered**, even though the local channel is configured as unordered.

## Current implementation

In `packages/webrtc/src/transport/sctp.ts`:

```ts
let channelType = DATA_CHANNEL_RELIABLE;

if (!channel.ordered) {
  channelType = 0x80;
}
if (channel.maxRetransmits !== null) {
  channelType = 1;
  reliability = channel.maxRetransmits;
} else if (channel.maxPacketLifeTime !== null) {
  channelType = 2;
  reliability = channel.maxPacketLifeTime;
}
```

The second branch overwrites the high-order unordered bit set by the first branch.

The correct constants already exist in `packages/webrtc/src/const.ts`:

```ts
DATA_CHANNEL_RELIABLE_UNORDERED = 0x80
DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED = 0x81
DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED = 0x82
```

The receive path also interprets the high bit correctly:

```ts
ordered: (channelType & 0x80) === 0
```

so this is specifically an OPEN-message encoding bug.

## Expected behavior

Per RFC 8832, the DCEP channel types are:

| Configuration | Channel Type |
|---|---:|
| reliable ordered | `0x00` |
| retransmit-limited ordered | `0x01` |
| lifetime-limited ordered | `0x02` |
| reliable unordered | `0x80` |
| retransmit-limited unordered | `0x81` |
| lifetime-limited unordered | `0x82` |

RFC 8832: https://www.rfc-editor.org/rfc/rfc8832.html

## Reproduction / downstream evidence

PrismarineJS/node-nethernet found this while validating werift 0.24.4 against native WebRTC implementations.

Their current workaround mutates the queued DCEP OPEN packet:

```js
if (!channel.ordered) {
  const [, , open] = this.sctpTransport.dataChannelQueue.find(
    ([queued]) => queued === channel
  )
  open[1] |= 0x80
}
```

Downstream reference:
https://github.com/PrismarineJS/node-nethernet/pull/28

Their interoperability matrix verifies ordered/unordered and reliability settings across werift/native peers on Linux, macOS and Windows.

## Suggested fix

Preserve the unordered bit while selecting the reliability mode, ideally using the existing constants rather than raw numeric literals.

For example, conceptually:

```ts
if (channel.maxRetransmits !== null) {
  channelType = channel.ordered
    ? DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT
    : DATA_CHANNEL_PARTIAL_RELIABLE_REXMIT_UNORDERED;
} else if (channel.maxPacketLifeTime !== null) {
  channelType = channel.ordered
    ? DATA_CHANNEL_PARTIAL_RELIABLE_TIMED
    : DATA_CHANNEL_PARTIAL_RELIABLE_TIMED_UNORDERED;
} else {
  channelType = channel.ordered
    ? DATA_CHANNEL_RELIABLE
    : DATA_CHANNEL_RELIABLE_UNORDERED;
}
```

## Tests

Please add coverage for all six DCEP channel types, especially:

1. `ordered: false, maxRetransmits: 0` emits `0x81`
2. `ordered: false, maxPacketLifeTime: N` emits `0x82`
3. a werift peer receiving those OPEN messages exposes `ordered === false`
4. browser/native interop preserves unordered semantics

This appears to affect current `develop` as well as werift 0.24.4.