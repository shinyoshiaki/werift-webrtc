## Summary

Changing `iceServers` after ICE gathering has started/completed does not correctly affect the next public ICE restart.

The updated servers are stored in PeerConnection config, but the live ICE Connection keeps the old TURN server/username/password. Calling public `restartIce()` and then `createOffer()` resets the gatherer but does not re-apply the latest PeerConnection ICE configuration, so the new gathering phase can reuse stale TURN credentials.

This is a production problem for short-lived TURN credentials.

Downstream reproduction/workaround:
https://github.com/georgetown-mdi/alcove/pull/1678

## Current behavior

`RTCPeerConnection.setConfiguration()` only propagates `iceServers` to transports whose gathering state is already `"new"`:

```ts
if (
  isReconfiguration &&
  this.secureManager &&
  normalizedConfig.iceServers !== undefined
) {
  this.secureManager.updateIceServers();
}
```

and `SecureTransportManager.updateIceServers()` skips any gatherer that has already started/completed:

```ts
if (iceTransport.gatheringState === "new") {
  iceTransport.setIceServers(options);
}
```

The existing test explicitly verifies that after gathering is complete, `setConfiguration({ iceServers })` updates PeerConfig but leaves the live Connection unchanged and does **not** set `needRestart`.

Public `restartIce()` only sets:

```ts
this.needRestart = true;
```

Then `createOffer()` calls:

```ts
this.secureManager.restartIce();
```

but `SecureTransportManager.restartIce()` only restarts each transport; it does not re-apply `this.config.iceServers` after gatheringState becomes `"new"`.

So the common sequence:

```ts
pc.setConfiguration({ iceServers: freshTurnCredentials });
pc.restartIce();
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

can gather against the old TURN credential.

The current test that demonstrates successful post-restart replacement calls the private/internal `secureManager.restartIce()` first and only then calls `setConfiguration()`; that ordering is not the normal public API flow.

## Standards mismatch

JSEP (RFC 9429 §4.1.18) states that changing STUN/TURN servers after gathering has started or completed affects the **next gathering phase** and sets the "needs-ice-restart" bit so the next `createOffer()` generates new ICE credentials and gathers from the new servers.

Current werift behavior preserves the new config but neither marks restart-needed from `setConfiguration()` nor guarantees that public `restartIce() -> createOffer()` stages the new servers into the restarted gatherer.

## Production impact

Alcove/PsiLink uses TURN credentials with a one-hour lifetime.

They measured that werift binds the TURN server/credential when the ICE transport is created and an ICE restart re-gathers with that frozen credential. Their workaround is to mint a fresh credential every 30 minutes and rebuild the entire RTCPeerConnection.

That rebuild requires extra signaling IDs and an overlap window solely because the existing PeerConnection cannot rotate TURN credentials for the next ICE generation.

Downstream PR:
https://github.com/georgetown-mdi/alcove/pull/1678

## Expected behavior

At least this sequence should use the fresh TURN server/credential:

```ts
pc.setConfiguration({ iceServers: freshServers });
pc.restartIce();
const offer = await pc.createOffer();
await pc.setLocalDescription(offer);
```

Also, per JSEP, calling `setConfiguration({ iceServers })` after gathering has started/completed should make the next offer perform an ICE restart even if the application does not separately call `restartIce()`.

Existing active transport/protocols should remain usable until the restart begins; only the next generation should use the updated server configuration.

## Suggested implementation direction

- when `iceServers` changes after gathering has started/completed, set PeerConnection's restart-needed bit;
- when a transport is actually restarted, re-apply `resolveIceServerOptions()` from the current PeerConfig to the now-`new` gatherer before gathering begins;
- ensure old TURN protocols/candidates are not re-advertised as if they belonged to the fresh credential generation;
- preserve current WHIP behavior where `setConfiguration()` before first gathering updates the existing gatherer without forcing an unnecessary restart.

## Tests

Suggested public-API regression tests:

1. gather with TURN credential A;
2. call `setConfiguration()` with TURN credential B after gathering completes;
3. verify restart-needed is set;
4. call `createOffer()` (with or without an explicit prior `restartIce()`);
5. set local description and gather;
6. assert the new TURN allocation authenticates with credential B, not A;
7. assert old relay candidates/protocols are not re-advertised into the new generation;
8. verify STUN-only and TURN-removal replacements too.

Reference:
RFC 9429 §4.1.18 (setConfiguration).