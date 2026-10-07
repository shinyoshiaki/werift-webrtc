## Summary

`RTCIceCandidate` currently exposes only:

- `candidate`
- `sdpMid`
- `sdpMLineIndex`
- `usernameFragment`

even though werift already parses and stores the full ICE candidate internally (`foundation`, component, protocol, priority, address/IP, port, candidate type, related address/port, TCP type, etc.).

As a result, consumers that need to inspect the selected candidate pair have to parse the SDP candidate string themselves.

A real-world example is OpenHarness, which uses werift for a WebRTC DataChannel transport. To determine whether the nominated pair is relayed, it currently regex-parses the local and remote candidate strings for `typ relay`:

https://github.com/autonomous-ai/openharness/blob/6aef03d565b740ab02fd4eb866bd0f3232d54991/cli/src/lib/terminalP2p.ts

This should be available directly as `candidate.type === "relay"`, matching browser `RTCIceCandidate` behavior.

## Current implementation

In `packages/webrtc/src/transport/ice.ts`, the internal `IceCandidate` already has the needed parsed fields:

```ts
export class IceCandidate {
  constructor(
    public component: number,
    public foundation: string,
    public ip: string,
    public port: number,
    public priority: number,
    public protocol: string,
    public type: string,
    ...
  ) {}
}
```

But `IceCandidate.toJSON()` converts it to `RTCIceCandidate` while keeping only the SDP string and signaling metadata:

```ts
toJSON(): RTCIceCandidate {
  return new RTCIceCandidate({
    candidate: candidateToSdp(this),
    sdpMLineIndex: this.sdpMLineIndex,
    sdpMid: this.sdpMid,
    usernameFragment: this.ufrag,
  });
}
```

And `RTCIceCandidate` itself only declares those four fields.

This also affects werift's `RTCIceTransport.getSelectedCandidatePair()`, `getLocalCandidates()`, and `getRemoteCandidates()`, because they all return the reduced `RTCIceCandidate` representation.

## Expected behavior

Match the WebRTC `RTCIceCandidate` shape more closely by exposing parsed readonly properties derived from the candidate a-line:

- `foundation`
- `component` (`"rtp"` / `"rtcp"`)
- `priority`
- `address`
- `protocol` (`"udp"` / `"tcp"`)
- `port`
- `type` (`"host"` / `"srflx"` / `"prflx"` / `"relay"`)
- `tcpType`
- `relatedAddress`
- `relatedPort`

The current WebRTC spec also defines `relayProtocol` and `url` for local srflx/relay candidates. Those require retaining the originating ICE-server metadata, so they may be implemented in the same change or separately if that keeps the patch smaller.

Spec:
https://w3c.github.io/webrtc-pc/#rtcicecandidate-interface

## Suggested implementation

1. Extend `RTCIceCandidate` with the browser-compatible parsed fields.
2. Populate them in `IceCandidate.toJSON()` without reparsing the SDP string.
3. Update `RTCIceCandidate.fromSdp()` / constructor behavior so a candidate created from an a-line exposes the same fields.
4. Preserve the current `toJSON()` signaling shape unless changing it is intentional; browser `toJSON()` should remain suitable for signaling.
5. Add tests for:
   - host / srflx / relay candidate properties;
   - TCP `tcpType`;
   - related address/port;
   - `RTCIceTransport.getSelectedCandidatePair()` returning candidates whose `type` is directly inspectable;
   - construction via `RTCIceCandidate.fromSdp()`.

## Why this matters

This is more than convenience for OpenHarness. werift now provides browser-shaped globals/polyfills, and the standard `RTCIceCandidate` API exposes these parsed properties. Keeping the data only inside the ICE-layer candidate while dropping it at the public WebRTC-layer object forces every consumer to duplicate candidate parsing and makes code written against browser WebRTC less portable.

OpenHarness is a concrete downstream example where this missing API has already produced such a workaround.