[**werift**](../README.md)

***

[werift](../globals.md) / EARLY\_APP\_DATA\_UNLIMITED

# Variable: EARLY\_APP\_DATA\_UNLIMITED

> `const` **EARLY\_APP\_DATA\_UNLIMITED**: `number` = `Number.POSITIVE_INFINITY`

Opt-in unbounded early-app-data buffer for trusted P2P paths.
Pass as `maxEarlyAppDataRecords` / `maxEarlyAppDataBytes`.
This removes only the record / byte caps. The EARLY\_APP\_DATA\_RETENTION\_MS
(2 s) retention still applies: if `onConnect` does not happen within it,
the whole buffered queue is dropped (counted in the early-data stats).
