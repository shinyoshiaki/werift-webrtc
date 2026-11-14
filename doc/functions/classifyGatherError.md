[**werift**](../README.md)

***

[werift](../globals.md) / classifyGatherError

# Function: classifyGatherError()

> **classifyGatherError**(`error`, `context`): \{ `errorCode`: `number`; `errorText`: `string`; \} \| `undefined`

The `errorCode` / `errorText` an application is told for a failed STUN
query or TURN allocation, or undefined when the failure is not reported
(a transaction cancelled by close).

- an error response: its ERROR-CODE and reason phrase (a 300 whose
  redirect was not followed: 300 and the reason);
- no answer (timeout, DNS, address family, TCP / TLS connect, socket
  error): 701 and a fixed phrase naming the cause.

The text never includes a username, password, realm or nonce.

## Parameters

### error

`unknown`

### context

[`GatherErrorContext`](../type-aliases/GatherErrorContext.md)

## Returns

\{ `errorCode`: `number`; `errorText`: `string`; \} \| `undefined`
