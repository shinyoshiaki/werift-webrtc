[**werift**](../README.md)

***

[werift](../globals.md) / pickReportedGatherError

# Function: pickReportedGatherError()

> **pickReportedGatherError**(`failures`): `object`

Of the failures of the attempts at one TURN server (UDP, then the TCP
fallback), the one to report: a STUN error code the server answered with
wins over 701 (not reached); otherwise the last attempt's.

## Parameters

### failures

(\{ `errorCode`: `number`; `errorText`: `string`; \} \| `undefined`)[]

## Returns

`object`

### errorCode

> **errorCode**: `number`

### errorText

> **errorText**: `string`
