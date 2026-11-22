[**werift**](../README.md)

***

[werift](../globals.md) / IceServerReachedInfo

# Type Alias: IceServerReachedInfo

> **IceServerReachedInfo** = `object`

A STUN or TURN server a gathering used answered (`Connection
.onIceServerReached`): a STUN query or TURN allocation gave a candidate,
or the server answered with an error response (300-699). A server that
answered is reachable, so `icecandidateerror` reports no 701 for it.
Only for the generation gathering and never after close; a STUN server
may be reported once per local socket that reached it.

## Properties

### generation

> **generation**: `number`

Gathering generation the answer belongs to.

***

### server

> **server**: [`IceServerRef`](IceServerRef.md)
