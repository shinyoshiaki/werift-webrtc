[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / DEAD\_CONNECTION\_RECEIVE\_TIMEOUT

# Variable: DEAD\_CONNECTION\_RECEIVE\_TIMEOUT

> `const` **DEAD\_CONNECTION\_RECEIVE\_TIMEOUT**: `number`

A backup pair that received nothing for this long (ms) is dropped (its
state becomes Failed) and the next pair of its socket is monitored. The
same value as [CONSENT\_TIMEOUT](CONSENT_TIMEOUT.md). libwebrtc:
`DEAD_CONNECTION_RECEIVE_TIMEOUT`.
