[**werift**](../README.md)

***

[werift](../globals.md) / IceGatheringErrorInfo

# Type Alias: IceGatheringErrorInfo

> **IceGatheringErrorInfo** = `object`

A gathering error of one generation (`Connection.onGatheringError`).

## Properties

### cause?

> `optional` **cause?**: `unknown`

The original exception (e.g. the SystemError of os.networkInterfaces()), when there is one.

***

### errorText

> **errorText**: `string`

Human-readable description, for logs. Not a stable identifier.

***

### generation

> **generation**: `number`

The generation whose gathering reported it.

***

### reason

> **reason**: [`IceGatheringErrorReason`](../enumerations/IceGatheringErrorReason.md)
