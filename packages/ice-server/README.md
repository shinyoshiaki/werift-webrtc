# werift-ice-server

RFC 8489 STUN / RFC 8656 TURN server for TypeScript.

This package ships:

- a **Sans-IO** STUN protocol handler for Binding
- a **Sans-IO** TURN protocol handler for Allocate / Refresh / CreatePermission / ChannelBind / Send / Data / ChannelData
- shared STUN / TURN wire helpers, including long-term credential auth and TURN-over-TCP framing helpers
- `Message` / `parseMessage`, also used by `werift-ice`: `MESSAGE-INTEGRITY` and `MESSAGE-INTEGRITY-SHA256` (RFC 8489 §14.5 / §14.6) generation and verification with a given key. TURN long-term credentials stay `MESSAGE-INTEGRITY` only.
- a **Node.js reference server** built on `node:dgram`, `node:net`, and `node:tls` for UDP/TCP/TLS control transports with UDP relays

The protocol layer stays transport-agnostic, so applications can plug it
into their own networking stack while reusing the STUN/TURN codec,
authentication, allocation state machine, and relay actions.

## Validation

Run the package unit suite with:

```sh
npm test && npm run type
```

Run the Chrome interop harness with:

```sh
npm run chrome-e2e
```
