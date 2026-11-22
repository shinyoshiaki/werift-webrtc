[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / nodeIpAddress

# Function: nodeIpAddress()

> **nodeIpAddress**(`family`, `__namedParameters?`): `string`[]

The candidate host addresses of the local interfaces of `family` (4 or 6),
as werift gathers them (loopback, tunnel and, unless
`useLinkLocalAddress`, link-local addresses excluded).

## Parameters

### family

`number`

### \_\_namedParameters?

#### useLinkLocalAddress?

`boolean`

such as google cloud run

## Returns

`string`[]

## Throws

the `SystemError` of `os.networkInterfaces()` when the interfaces
cannot be enumerated (e.g. `AF_NETLINK` denied by systemd's
`RestrictAddressFamilies=`): the caller decides how to go on. ICE
gathering itself does not use this function and never throws for it (see
`Connection.onGatheringError`).
