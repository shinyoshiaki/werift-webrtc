[**werift**](../README.md)

***

[werift](../globals.md) / IceGatheringErrorDetails

# Type Alias: IceGatheringErrorDetails

> **IceGatheringErrorDetails** = `object`

A gathering error of an ICE transport (werift extension, not W3C): the
`IceGatheringErrorInfo` of the ICE agent without its generation
(only the current generation's errors are given).

## Properties

### cause?

> `optional` **cause?**: `unknown`

The original exception, when there is one.

***

### errorText

> **errorText**: `string`

Human-readable description, for logs. Not a stable identifier.

***

### reason

> **reason**: [`IceGatheringErrorReason`](../enumerations/IceGatheringErrorReason.md)

Why (new reasons may be added: handle unknown values).
