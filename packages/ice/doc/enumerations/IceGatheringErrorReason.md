[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / IceGatheringErrorReason

# Enumeration: IceGatheringErrorReason

Why a gathering reported an error (`Connection.onGatheringError`).
New reasons may be added in a minor release: handle unknown values.

## Enumeration Members

### gatheringFailed

> **gatheringFailed**: `"gathering-failed"`

gatherCandidates() failed with an unexpected exception.

***

### interfaceEnumerationFailed

> **interfaceEnumerationFailed**: `"interface-enumeration-failed"`

os.networkInterfaces() threw: no host address was enumerated.

***

### noCandidates

> **noCandidates**: `"no-candidates"`

The generation's gathering ended without any local candidate.
