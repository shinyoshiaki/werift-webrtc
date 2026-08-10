**werift-ice**

***

# werift-ice

ICE/STUN-client/TURN-client Implementation for TypeScript  
based on aioice

The TURN client is exercised against the local `werift-ice-server`
reference TURN server over UDP, TCP, and TLS (`turns:`) control transports.

## pion TURN interop (opt-in)

Default `npm test` skips third-party TURN tests. To exercise werift ICE against
[pion/turn](https://github.com/pion/turn) in Docker (dynamic free UDP port):

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
Compose: `packages/ice/docker/pion-turn/` (`network_mode: host`, free `UDP_PORT`)
