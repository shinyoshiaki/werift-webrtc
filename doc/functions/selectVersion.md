[**werift**](../README.md)

***

[werift](../globals.md) / selectVersion

# Function: selectVersion()

> **selectVersion**(`localPreference`, `peerSupported`): [`DtlsVersion`](../enumerations/DtlsVersion.md)

Association-layer version selection (both roles).
Walks `localPreference` in order and returns the first version also in
`peerSupported`. Empty intersection → ProtocolVersionError.

## Parameters

### localPreference

readonly [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

### peerSupported

readonly [`DtlsVersion`](../enumerations/DtlsVersion.md)[]

## Returns

[`DtlsVersion`](../enumerations/DtlsVersion.md)
