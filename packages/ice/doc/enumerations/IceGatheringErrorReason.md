[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / IceGatheringErrorReason

# Enumeration: IceGatheringErrorReason

Why a gathering reported an error (`Connection.onGatheringError`).
New reasons may be added in a minor release: handle unknown values.

## Enumeration Members

### gatheringFailed

> **gatheringFailed**: `"gathering-failed"`

gatherCandidates() threw unexpectedly.

#### See

packages/ice/tests/ice/interface-enumeration.test.ts「an unexpected exception reports gathering-failed, ends the generation and rejects」

***

### interfaceEnumerationFailed

> **interfaceEnumerationFailed**: `"interface-enumeration-failed"`

os.networkInterfaces() threw.

#### See

packages/ice/tests/ice/interface-enumeration.test.ts「without servers or explicit addresses: ends with interface-enumeration-failed then no-candidates」

***

### noCandidates

> **noCandidates**: `"no-candidates"`

The gathering ended without any local candidate.

#### See

packages/ice/tests/ice/interface-enumeration.test.ts「without servers or explicit addresses: ends with interface-enumeration-failed then no-candidates」
