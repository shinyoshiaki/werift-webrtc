[**werift**](../README.md)

***

[werift](../globals.md) / IceGatheringErrorInfo

# Type Alias: IceGatheringErrorInfo

> **IceGatheringErrorInfo** = `object`

A gathering error of one generation (`Connection.onGatheringError`).

## See

packages/ice/tests/ice/interface-enumeration.test.ts「without servers or explicit addresses: ends with interface-enumeration-failed then no-candidates」

## Properties

### cause?

> `optional` **cause?**: `unknown`

The original exception, when there is one.

***

### errorText

> **errorText**: `string`

Human-readable description, for logs. Not a stable identifier.

***

### generation

> **generation**: `number`

#### See

packages/ice/tests/ice/interface-enumeration.test.ts「nothing is reported for a generation an ICE restart replaced」

***

### reason

> **reason**: [`IceGatheringErrorReason`](../enumerations/IceGatheringErrorReason.md)
