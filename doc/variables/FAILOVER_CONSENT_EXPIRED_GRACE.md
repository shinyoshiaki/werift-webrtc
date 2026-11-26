[**werift**](../README.md)

***

[werift](../globals.md) / FAILOVER\_CONSENT\_EXPIRED\_GRACE

# Variable: FAILOVER\_CONSENT\_EXPIRED\_GRACE

> `const` **FAILOVER\_CONSENT\_EXPIRED\_GRACE**: `10000` = `10_000`

After the selected pair's consent expired (RFC 7675: no more application
data on it), how long (ms) the agent stays `disconnected` waiting for the
selection to move to a writable backup (its own failover nomination, or
the peer's when controlled) before it fails. A peer that fails over does
so 5–10 s after the path broke, long before the 30 s expiry; the grace
covers a nomination still in flight. werift's own value.
