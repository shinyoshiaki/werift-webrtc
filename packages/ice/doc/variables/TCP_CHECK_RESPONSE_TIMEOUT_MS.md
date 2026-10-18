[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / TCP\_CHECK\_RESPONSE\_TIMEOUT\_MS

# Variable: TCP\_CHECK\_RESPONSE\_TIMEOUT\_MS

> `const` **TCP\_CHECK\_RESPONSE\_TIMEOUT\_MS**: `3000` = `3000`

Response deadline for ICE connectivity checks over TCP (RFC 6544).
Reliable transports send each STUN request once (RFC 5389 §7.2.2), so this
single wait has to cover the TCP connect of an active candidate as well as
the request/response round trip on a loaded host.
