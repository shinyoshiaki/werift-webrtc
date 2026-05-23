# front-proxy TURN/TLS example

This example demonstrates a minimal WebRTC-only front proxy that serves HTTPS and TURN/TLS from one public TLS address. Users only need to allow that single address, and browser peers can use `iceTransportPolicy: "relay"` with the returned `turns:` URL.

```text
Browser WebRTC Client
  |
  | TLS
  v
LB
  |
  | decrypted stream
  v
Relay
  |
  | { clientTransportKey, payload }
  v
Backend TURN
  |
  v
Peer
```

## Responsibilities

| Component | Does | Does not do |
| --- | --- | --- |
| LB | Listens on one TLS address, terminates TLS, randomly selects a relay per new connection, passes the original client source address to the relay | HTTP/TURN detection, STUN/TURN parsing, backend selection, KV lookup |
| Relay | Builds `clientTransportKey`, detects HTTP vs TURN, splits TURN/TCP frames, reads `USERNAME` only for routing, uses shared KV, forwards `{ clientTransportKey, payload }` to Backend TURN | Own TURN allocations or peer relay sockets |
| shared KV | Stores only `username -> backend TURN` and `clientTransportKey -> backend TURN` | Stores TURN allocation state |
| Backend TURN | Owns the TURN state machine, creates virtual transports per `clientTransportKey`, keeps allocations, relays peer traffic, writes client data back through the current relay | Terminates TLS or decides HTTP vs TURN |

`clientTransportKey` is the internal virtual 5-tuple:

```text
originalClientIp:originalClientPort|publicTurnIp:publicTurnPort|tcp
```

Example:

```text
203.0.113.10:53124|34.120.1.10:443|tcp
```

Because the key is derived from the LB-provided original source address and the public TURN address, a different relay can re-attach to the same backend virtual transport when the same client transport is presented again.

## Routing

1. `POST /credentials`: Relay selects a Backend TURN, issues `<backend-id>.<random>.<mac>`, and stores `username -> backend TURN`.
2. `Allocate`: Relay reads `USERNAME` when present, routes to the username backend, and stores `clientTransportKey -> backend TURN`. The initial unauthenticated Allocate has no `USERNAME`, so the sample pins that `clientTransportKey` to the backend that issued the nonce.
3. `Refresh`, `CreatePermission`, `ChannelBind`: Relay reads `USERNAME` and routes by `username -> backend TURN`.
4. `Send indication`, `ChannelData`: Relay does not require `USERNAME`; it routes by `clientTransportKey -> backend TURN`.

## Run

```sh
cd examples/front-proxy-turn
npm install
npm run server
```

Open `https://127.0.0.1:8443/`, accept the local test certificate, then click **Start relay-only DataChannel**. The page fetches credentials from the same HTTPS origin and connects two browser `RTCPeerConnection`s with:

```js
{
  iceServers: [{ urls, username, credential }],
  iceTransportPolicy: "relay",
}
```

The same `turns:127.0.0.1:8443?transport=tcp` address is used for TURN/TLS.

## Environment

| Variable | Default |
| --- | --- |
| `FRONT_PROXY_TURN_HOST` | `0.0.0.0` |
| `FRONT_PROXY_TURN_PORT` | `8443` |
| `FRONT_PROXY_TURN_PUBLIC_HOST` | `127.0.0.1` |
| `FRONT_PROXY_TURN_PUBLIC_PORT` | `8443` |
| `FRONT_PROXY_TURN_RELAY_COUNT` | `2` |
| `FRONT_PROXY_TURN_BACKEND_COUNT` | `1` |
| `FRONT_PROXY_TURN_REALM` | `front-proxy-turn.local` |
| `FRONT_PROXY_TURN_CREDENTIAL_SECRET` | random per process |
| `FRONT_PROXY_TURN_CERT_FILE` | `packages/dtls/assets/cert.pem` |
| `FRONT_PROXY_TURN_KEY_FILE` | `packages/dtls/assets/key.pem` |

## Validation

```sh
npm run type --workspace examples/front-proxy-turn
npm test --workspace examples/front-proxy-turn
```

The tests cover routing decisions, TURN/TCP frame splitting through Relay, Backend TURN virtual transport re-attach, HTTPS credential issuance, and TURN/TLS Allocate through the single TLS listener.

## Constraints and non-goals

This is a WebRTC-only sample. It is not a general-purpose TURN proxy compatibility layer.

Non-goals:

- restoring lost bytes or frames after relay failure
- seamless continuation of an already-broken TCP/TLS stream
- preserving an allocation after the client-LB connection itself is gone
- routing by ICE `ufrag`
- moving strict proxy behavior into `packages/ice-server`

For multi-backend deployments, unauthenticated Allocate challenge affinity must remain consistent with the later authenticated retry. This sample keeps the runnable browser demo to one backend by default and still exposes the two required KV mappings and backend-id username routing for understanding the front-proxy design.
