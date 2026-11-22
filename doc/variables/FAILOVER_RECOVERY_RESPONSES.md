[**werift**](../README.md)

***

[werift](../globals.md) / FAILOVER\_RECOVERY\_RESPONSES

# Variable: FAILOVER\_RECOVERY\_RESPONSES

> `const` **FAILOVER\_RECOVERY\_RESPONSES**: `3` = `3`

Consecutive responses a pair the agent failed over from needs before the
selection may move back to it (or to another pair of its socket). Keeps
the selection from flapping. werift's own value (libwebrtc relies on
[MIN\_PINGS\_AT\_WEAK\_PING\_INTERVAL](MIN_PINGS_AT_WEAK_PING_INTERVAL.md) for the same purpose).
