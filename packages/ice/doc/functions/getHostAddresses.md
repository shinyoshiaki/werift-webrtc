[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / getHostAddresses

# Function: getHostAddresses()

> **getHostAddresses**(`useIpv4`, `useIpv6`, `options?`): `string`[]

[nodeIpAddress](nodeIpAddress.md) of IPv4 then IPv6, as enabled.

## Parameters

### useIpv4

`boolean`

### useIpv6

`boolean`

### options?

#### useLinkLocalAddress?

`boolean`

such as google cloud run

## Returns

`string`[]

## Throws

the `SystemError` of `os.networkInterfaces()` when the interfaces
cannot be enumerated, like [nodeIpAddress](nodeIpAddress.md).
