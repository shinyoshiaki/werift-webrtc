**werift-ice**

***

# werift-ice

ICE/STUN-client/TURN-client Implementation for TypeScript  
based on aioice

The TURN client is exercised against the local `werift-ice-server`
reference TURN server over UDP, TCP, and TLS (`turns:`) control transports.

## TURN server endpoint selection

- One allocation keeps one concrete server endpoint for its lifetime. Allocate
  retries, Refresh, CreatePermission, ChannelBind, Send indications and
  ChannelData never look the hostname up again.
- UDP: the socket family comes from an IP literal server address. For a
  hostname it comes from `udpFamily` (`IceOptions.turnUdpFamily`,
  `PeerConfig.turnUdpFamily` in `werift`), default `4`, and the hostname is
  resolved in that family. `udpFamily` is ignored for an IP literal.
- TCP/TLS: the endpoint is the peer the stream connected to
  (`Transport.remoteAddress`); the hostname is not resolved again. TLS still
  verifies the certificate against the configured hostname. SNI is sent only
  when `tlsOptions.servername` is set.
- `TurnProtocol.configuredServer` always holds the configured address.
  `TurnProtocol.server` is the server the allocation lives on (the configured
  one unless the Allocate was redirected, see below); the resolved endpoint
  is `TurnProtocol.serverEndpoint`.

## TURN 300 (Try Alternate)

An Allocate answered with `300 (Try Alternate)` is retried against its
`ALTERNATE-SERVER` (RFC 8656 §7.4, RFC 8489 §10):

- Same transport protocol and the same username/password. The alternate
  starts with an unauthenticated Allocate and its own 401 realm/nonce; the
  previous server's realm/nonce are not reused.
- After the redirect, the allocation and every later Refresh,
  CreatePermission, ChannelBind and data packet are pinned to the alternate.
- UDP keeps the same socket. An alternate of the other IP family fails with
  `AddressFamilyMismatch`.
- TCP/TLS (via `createTurnClient`) close the stream and connect to the
  alternate. TLS validates the alternate's certificate against
  `ALTERNATE-DOMAIN` when present, otherwise against the name the original
  server is validated with (`tlsOptions.servername`, else the configured
  host). `new TurnProtocol(...)` over a stream needs the `reconnect` option to
  follow a redirect.
- Only Allocate is redirected. A redirect fails with `TurnRedirectError`
  (`reason`: `missing-alternate`, `loop` for a server already tried by this
  Allocate, `too-many-redirects` beyond `maxAllocateRedirects` (default 3),
  or `unsupported-transport`).

## pion TURN interop (opt-in)

Default `npm test` skips third-party TURN tests. To exercise werift ICE against
[pion/turn](https://github.com/pion/turn) in Docker (dynamic free UDP port, plus a TCP-control-connection server on a free TCP port exported as `PION_TURN_TCP_PORT`):

```bash
# Recommended: start → run tests → always docker compose down (trap)
npm run test:pion-turn --workspace packages/ice

# Or manually:
eval "$(./packages/ice/scripts/run-pion-turn.sh --print-env)"
# exports: PION_TURN_HOST, PION_TURN_PORT, PION_TURN_USERNAME, PION_TURN_PASSWORD, ...
PION_TURN_HOST="$PION_TURN_HOST" PION_TURN_PORT="$PION_TURN_PORT" \
  PION_TURN_USERNAME="$PION_TURN_USERNAME" PION_TURN_PASSWORD="$PION_TURN_PASSWORD" \
  npm test --workspace packages/ice -- pion-turn
./packages/ice/scripts/run-pion-turn.sh --down
```

| Env | Required | Default |
|-----|----------|---------|
| `PION_TURN_HOST` | yes (opt-in gate) | set by script (`127.0.0.1`) |
| `PION_TURN_PORT` | no | script dynamic port / `3478` |
| `PION_TURN_USERNAME` | no | `username` |
| `PION_TURN_PASSWORD` | no | `password` |
| `PION_TURN_PUBLIC_IP` | no | `127.0.0.1` |

Scripts: `packages/ice/scripts/run-pion-turn.sh`  
Compose: `packages/ice/docker/pion-turn/` (`network_mode: host`, free `UDP_PORT`), `packages/ice/docker/pion-turn-tcp/` (free `TCP_PORT`)
