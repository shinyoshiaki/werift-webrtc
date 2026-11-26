[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / FAILOVER\_BACKUP\_ATTEMPTS

# Variable: FAILOVER\_BACKUP\_ATTEMPTS

> `const` **FAILOVER\_BACKUP\_ATTEMPTS**: `3` = `3`

Pairs of one local socket (or TURN allocation) tried as its backup before
the socket waits for a retry (1, 2, 4, 8, 16 s, then every 16 s) and starts
again from its highest-priority pair. werift's own limit.
