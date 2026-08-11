# Apply ICE server updates to a gatherer that has not gathered yet

An ICE gatherer takes its STUN/TURN servers when it is constructed, and that happens on the first
`createOffer()` / `addTrack()`. A later `setConfiguration()` only writes to `PeerConfig`, so
servers set after that point never reach the gatherer and the gather pass produces no relay
candidate. The only way around it today is to build a new `RTCPeerConnection`, which throws away
the offer and its ICE credentials.

This comes up with WHIP. The endpoint returns its STUN/TURN servers in `Link` headers on the
response to the POST that carries the offer
([RFC 9725 §4.6](https://www.rfc-editor.org/rfc/rfc9725.html#section-4.6)), so the client cannot
know them until the offer already exists:

```
POST /whip/live
201 Created
Link: <stun:stun.example.net>; rel="ice-server"
Link: <turn:turn.example.net?transport=tcp>; rel="ice-server";
      username="user"; credential="myPassword"
```

On a network where UDP is blocked, the relay candidate from that header is the only one that can
connect, and right now it cannot be gathered at all. The same section says a client "may need to
call the setConfiguration method before calling the setLocalDescription method [...] in order to
avoid having to perform an ICE restart", and notes that some implementations do not support
updating the servers after the local offer has been created. werift is one of them.

## Changes

* `setIceServers(options)` on `IceConnection`, re-resolving `stunServer` / `turnServer` the way
  the constructor does.
* Pass-throughs on `RTCIceGatherer` and `RTCIceTransport`.
* `SecureTransportManager.updateIceServers()`. The ICE server parsing that `createTransport()`
  already did moved into `resolveIceServerOptions()`, so both paths use the same code.
* `setConfiguration()` calls it when `iceServers` was passed and the transport is still in
  gathering state `new`.

That last condition follows JSEP
([RFC 8829 §4.1.18](https://www.rfc-editor.org/rfc/rfc8829.html#section-4.1.18)): changes to the
STUN/TURN servers affect the next gathering phase. Once gathering has started or finished,
nothing is applied, so a running or completed gather cannot be disturbed. `setIceServers` is
additive on all three types.

## Usage

```ts
const pc = new RTCPeerConnection({ iceTransportPolicy: "relay" });
const offer = await pc.createOffer();

const res = await fetch(whipEndpoint, {
  method: "POST",
  headers: { "content-type": "application/sdp" },
  body: offer.sdp,
});

pc.setConfiguration({ iceServers: parseLinkHeaders(res.headers) });

await pc.setLocalDescription(offer);
```

## Testing

Ran against an OvenMediaEngine WHIP endpoint from a network with UDP egress blocked. Before the
change the gather produced host candidates only and the session never connected. After it, the
relay candidate from the `Link` header is gathered and media flows over TURN/TCP. Existing test
suites pass.