# werift-ice-server

RFC 8489 STUN / RFC 8656 TURN server for TypeScript.

This package ships:

- a **Sans-IO** STUN protocol handler for Binding
- a **Sans-IO** TURN protocol handler for Allocate / Refresh / CreatePermission / ChannelBind / Send / Data / ChannelData
- shared STUN / TURN wire helpers, including long-term credential auth and TURN-over-TCP framing helpers
- a **Node.js reference server** built on `node:dgram` and `node:net` for UDP/TCP control transports with UDP relays

The protocol layer stays transport-agnostic, so applications can plug it
into their own networking stack while reusing the STUN/TURN codec,
authentication, allocation state machine, and relay actions.
