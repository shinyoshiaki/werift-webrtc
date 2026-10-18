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
- `TurnProtocol.server` always holds the configured address; the resolved
  endpoint is `TurnProtocol.serverEndpoint`.

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
