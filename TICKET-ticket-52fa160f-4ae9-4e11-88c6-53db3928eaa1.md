## Summary

werift implicitly uses `stun.l.google.com:19302` whenever no explicit STUN URL is present, including when the application configured a TURN-only `RTCConfiguration.iceServers`.

This differs from the WebRTC API contract, where `RTCConfiguration.iceServers` defaults to an empty sequence, and it can cause unexpected external network traffic / public-address disclosure.

The behavior is still present in `werift@0.25.1`.

Downstream verification:
- Georgetown MDI / Alcove PR #2331: https://github.com/georgetown-mdi/alcove/pull/2331

Their integration test hooks the real DNS lookup path and confirms that a TURN-only configuration still resolves werift's built-in Google STUN host.

## Current 0.25.1 behavior

`packages/ice/src/ice.ts`:

```ts
private applyStunTurnServersFromOptions() {
  this.stunServer =
    validateAddress(this.options.stunServer) ?? DEFAULT_STUN_SERVER;
  this.turnServer = validateAddress(this.options.turnServer);
}
```

So all of these result in the built-in Google STUN server being used:

```ts
new RTCPeerConnection()
new RTCPeerConnection({ iceServers: [] })
new RTCPeerConnection({
  iceServers: [{
    urls: "turn:turn.example.com:3478",
    username: "u",
    credential: "p",
  }],
})
```

A caller cannot express the normal WebRTC meanings of:
- no external ICE servers / host candidates only;
- TURN-only server configuration without also contacting an unrelated public STUN server.

## WebRTC API semantics

The W3C WebRTC specification defines:

`RTCConfiguration.iceServers` as a sequence defaulting to `[]`.

https://www.w3.org/TR/webrtc/#dom-rtcconfiguration-iceservers

JSEP also describes the PeerConnection constructor as using the STUN/TURN servers **specified by the application**.

https://www.rfc-editor.org/rfc/rfc8829.html#section-4.1.1

An implementation-wide implicit public STUN endpoint is surprising for a WebRTC-compatible API, especially when an explicit TURN-only server list was supplied.

## Impact

- unexpected DNS and STUN traffic to Google;
- public IP / session metadata disclosed to a server the application did not configure;
- TURN-only/privacy-sensitive deployments cannot represent their intended policy;
- host-only operation currently needs an artificial unreachable STUN entry and waits for its timeout.

This is not content leakage and is not being reported as a CVE. It is a configuration/privacy/spec-compatibility issue.

## Expected behavior

For `RTCPeerConnection`:

1. `iceServers: []` should mean no configured STUN/TURN servers;
2. TURN-only configuration should use only the configured TURN server(s);
3. an explicit STUN URL should be used when supplied;
4. if a built-in convenience STUN server is desired for backwards compatibility, it should be explicit/opt-in rather than silently injected into WebRTC `RTCConfiguration`.

The lower-level ICE API may keep a convenience default if desired, but the WebRTC-facing API should preserve the application's `iceServers` semantics.

## Suggested tests

- `RTCPeerConnection({ iceServers: [] })`: no external STUN DNS lookup / Binding request.
- TURN-only `iceServers`: TURN Allocate occurs, Google STUN is never resolved/contacted.
- Explicit STUN: only the configured STUN endpoint is contacted.
- `getConfiguration().iceServers` and actual network behavior agree.
- `setConfiguration()` / ICE restart preserve the same semantics.

## Duplicate check

I searched existing issues for default/built-in Google STUN, TURN-only configuration, and `iceServers` privacy behavior and did not find an issue tracking this behavior.

#755 is related to multiple configured STUN/TURN URLs being silently ignored, but is a separate problem.