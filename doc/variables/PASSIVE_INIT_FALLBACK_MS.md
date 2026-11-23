[**werift**](../README.md)

***

[werift](../globals.md) / PASSIVE\_INIT\_FALLBACK\_MS

# Variable: PASSIVE\_INIT\_FALLBACK\_MS

> `const` **PASSIVE\_INIT\_FALLBACK\_MS**: `1000` = `1000`

How long the DTLS client (passive SCTP side) waits for the peer's INIT
after DTLS authentication before sending INIT itself. A peer that picks
the SCTP initiator by the ICE role (older werift) may wait as well; well
below the SCTP initial RTO (3 s), so a lost INIT also recovers sooner.
