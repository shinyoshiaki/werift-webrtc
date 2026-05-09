# werift-ice-server

RFC 8489 STUN server for TypeScript.

This package ships:

- a **Sans-IO** STUN protocol handler for Binding over UDP
- a **Node.js UDP reference server** built on `node:dgram`

The protocol layer is transport-agnostic, so applications can plug it
into their own networking stack while reusing the STUN codec and server
behavior.
