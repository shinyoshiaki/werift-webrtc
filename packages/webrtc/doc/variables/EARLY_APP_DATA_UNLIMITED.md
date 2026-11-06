[**werift**](../README.md)

***

[werift](../globals.md) / EARLY\_APP\_DATA\_UNLIMITED

# Variable: EARLY\_APP\_DATA\_UNLIMITED

> `const` **EARLY\_APP\_DATA\_UNLIMITED**: `number` = `Number.POSITIVE_INFINITY`

Opt-in unbounded early-app-data buffer for trusted P2P paths.
Pass as `maxEarlyAppDataRecords` / `maxEarlyAppDataBytes`.
There is no hidden ceiling — the association will buffer until `onConnect`.
