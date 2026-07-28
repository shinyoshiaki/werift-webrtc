[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / CONSENT\_RESPONSE\_TIMEOUT

# Variable: CONSENT\_RESPONSE\_TIMEOUT

> `const` **CONSENT\_RESPONSE\_TIMEOUT**: `1000` = `1000`

Conservative single-shot response wait for consent requests (milliseconds).
Independent of retransmission count. Consent requests use `retransmissions: 0`
with this timeout so delayed responses (e.g. 150–300ms) are not dropped by the
default STUN RTO of 50ms.
