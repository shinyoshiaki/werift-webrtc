[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / IceState

# Type Alias: IceState

> **IceState**: `"disconnected"` \| `"closed"` \| `"completed"` \| `"new"` \| `"connected"` \| `"failed"`

`failed` is used when RFC 7675 consent expires (last valid response older than
{@link CONSENT_TIMEOUT}). Explicit `Connection.close()` uses `closed`. Consent
failure keeps transport resources available for ICE restart with new credentials.
