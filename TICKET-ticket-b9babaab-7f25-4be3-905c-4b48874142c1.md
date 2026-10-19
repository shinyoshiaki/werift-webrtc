## Summary

`RTCPeerConnection({ iceServers })` accepts the WebRTC `RTCIceServer[]` shape, including multiple servers and multiple URLs, but werift currently keeps only the first STUN URL and the first TURN URL.

Additional configured STUN/TURN endpoints are silently ignored, so they cannot provide redundancy/failover.

## Current behavior

`packages/webrtc/src/utils.ts::parseIceServers()` reduces the complete `iceServers` list into a single:

```ts
{
  stunServer?: Address;
  turnServer?: Address;
  turnUsername?: string;
  turnPassword?: string;
  turnTransport?: "udp" | "tcp" | "tls";
}
```

and only assigns each kind once:

```ts
if (!options.stunServer && parsed.kind === "stun") {
  options.stunServer = parsed.address;
}

if (!options.turnServer && parsed.kind === "turn") {
  options.turnServer = parsed.address;
  ...
}
```

The ICE `Connection` also exposes singular `stunServer` / `turnServer` fields.

## Downstream verification

Alcove added four local counting STUN/TURN endpoints and constructed a real werift `RTCPeerConnection` with multiple configured URLs.

During gathering:

- only the first STUN endpoint received a Binding request;
- only the first TURN endpoint received an Allocate request;
- later configured endpoints were never contacted.

The downstream test and documentation are in:

https://github.com/georgetown-mdi/alcove/pull/2255

They currently document the limitation and deliberately enroll credentials only for the first TURN server because werift will not contact the rest.

## Why this matters

Applications commonly provide multiple ICE servers for:

- regional TURN redundancy;
- provider failover;
- UDP/TCP/TLS alternatives;
- migration between TURN services;
- temporary relay outages.

Silently discarding all but the first server means an otherwise valid RTCConfiguration can fail even when a later server is reachable.

This is distinct from TURN `300 Try Alternate` handling (#715): this issue concerns multiple servers explicitly configured by the application.

## Expected behavior

All valid configured STUN/TURN URLs should participate in gathering according to WebRTC ICE-server configuration semantics.

At minimum, the API should not silently imply multi-server support while discarding later entries.

## Suggested implementation direction

The lower-level ICE configuration likely needs to move from singular `stunServer` / `turnServer` fields to collections, including per-TURN-server credentials and transport options.

Please preserve:

- per-`RTCIceServer` username/credential association;
- URLs arrays within one `RTCIceServer`;
- multiple separate `RTCIceServer` entries;
- TURN UDP/TCP/TLS variants;
- `setConfiguration()` and ICE-restart behavior.

## Suggested tests

Use independent local counting endpoints and verify:

1. Two STUN URLs both receive Binding requests.
2. Two TURN URLs both receive Allocate requests (or a documented candidate-gathering/failover strategy).
3. Credentials stay associated with the correct TURN server.
4. An unreachable first server does not prevent a reachable later server from producing candidates.

Confirmed in current upstream develop as of 2026-10-17.