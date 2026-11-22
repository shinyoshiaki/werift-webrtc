[**werift**](../README.md)

***

[werift](../globals.md) / isServerAnswer

# Function: isServerAnswer()

> **isServerAnswer**(`error`): error is TransactionFailed \| TransactionIntegrityViolation \| TurnRedirectError \| MissingMappedAddressError

Whether `error` means a response from the server arrived, whatever its
content: an error response (with or without a valid ERROR-CODE, a
challenge, a redirect that was not followed), a response that failed
MESSAGE-INTEGRITY, or a success response without XOR-MAPPED-ADDRESS. A
server that answered was reached, so it is never reported as 701.

## Parameters

### error

`unknown`

## Returns

error is TransactionFailed \| TransactionIntegrityViolation \| TurnRedirectError \| MissingMappedAddressError
