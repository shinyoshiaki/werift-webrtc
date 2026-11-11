[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / findPort

# Function: findPort()

> **findPort**(`min`, `max`, `protocol?`, `interfaceAddresses?`, `bindAddress?`): `Promise`\<`number`\>

Finds a free port in `[min, max]`. The probe binds `bindAddress` when it is
given (the address the socket will be bound to), otherwise the address of
`interfaceAddresses` for `protocol` (wildcard when unset).

## Parameters

### min

`number`

### max

`number`

### protocol?

`SocketType` = `"udp4"`

### interfaceAddresses?

[`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

### bindAddress?

`string`

## Returns

`Promise`\<`number`\>
