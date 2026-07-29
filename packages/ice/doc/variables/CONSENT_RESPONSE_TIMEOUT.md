[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / CONSENT\_RESPONSE\_TIMEOUT

# Variable: CONSENT\_RESPONSE\_TIMEOUT

> `const` **CONSENT\_RESPONSE\_TIMEOUT**: `1000` = `1000`

Default single-shot response wait for consent requests (ms) when RTT is unknown.
Independent of retransmission count. Downstream ICE-lite peers typically
answer in 150–300ms; 1s is a conservative default used by interop patches.
