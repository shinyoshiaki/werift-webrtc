[**werift**](../README.md)

***

[werift](../globals.md) / flushTransportSend

# Function: flushTransportSend()

> **flushTransportSend**(`transport`, `data`, `addr`?): `Promise`\<`void`\>

Flush one datagram when the transport supports it; else [Transport.send](../interfaces/Transport.md#send).

## Parameters

### transport

[`Transport`](../interfaces/Transport.md)

### data

`Buffer`

### addr?

readonly \[`string`, `number`\]

## Returns

`Promise`\<`void`\>
