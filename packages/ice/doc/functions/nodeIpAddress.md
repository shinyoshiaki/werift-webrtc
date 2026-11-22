[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / nodeIpAddress

# Function: nodeIpAddress()

> **nodeIpAddress**(`family`, `__namedParameters?`): `string`[]

The candidate host addresses of the local interfaces of `family` (4 or 6).

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
cannot be enumerated.

## See

packages/ice/tests/ice/interface-enumeration.test.ts「the public nodeIpAddress / getHostAddresses keep throwing (documented @throws)」
