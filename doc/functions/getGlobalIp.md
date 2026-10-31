[**werift**](../README.md)

***

[werift](../globals.md) / getGlobalIp

# Function: getGlobalIp()

> **getGlobalIp**(`stunServer?`, `interfaceAddresses?`): `Promise`\<`string`\>

Query the public (server-reflexive) IP of this host with a STUN Binding
request.
When `stunServer` is omitted, `stun.l.google.com:19302` is used.

## Parameters

### stunServer?

readonly \[`string`, `number`\]

### interfaceAddresses?

[`InterfaceAddresses`](../type-aliases/InterfaceAddresses.md)

## Returns

`Promise`\<`string`\>
