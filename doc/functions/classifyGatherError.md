[**werift**](../README.md)

***

[werift](../globals.md) / classifyGatherError

# Function: classifyGatherError()

> **classifyGatherError**(`error`, `context`): \{ `errorCode`: `number`; `errorText`: `string`; \} \| `undefined`

The `errorCode` / `errorText` an application is told for a failed STUN
query or TURN allocation, or undefined when the failure is not reported:
a transaction cancelled by close, or an answer that carries no STUN error
code (an error response without a valid ERROR-CODE, a response that
failed MESSAGE-INTEGRITY, a success response without
XOR-MAPPED-ADDRESS). Such a server was reached (isServerAnswer), so 701
does not apply (W3C: 701 only when no host candidate reaches the server),
and there is no STUN error code to report.

- an error response: its ERROR-CODE and the server's reason phrase with
  credential material masked (gatherErrorReasonText; a 300 whose redirect
  was not followed: 300 and why it was not followed);
- no answer (timeout, DNS, address family, TCP / TLS connect, socket
  error): 701 and a fixed phrase naming the cause;
- an answer without a STUN error code: not reported (undefined).

The text never includes the username, password, realm or nonce werift
knows of (they are masked).

## Parameters

### error

`unknown`

### context

[`GatherErrorContext`](../type-aliases/GatherErrorContext.md)

## Returns

\{ `errorCode`: `number`; `errorText`: `string`; \} \| `undefined`
