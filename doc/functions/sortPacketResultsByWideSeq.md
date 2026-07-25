[**werift**](../README.md)

***

[werift](../globals.md) / sortPacketResultsByWideSeq

# Function: sortPacketResultsByWideSeq()

> **sortPacketResultsByWideSeq**\<`T`\>(`results`): `T`[]

Sort TWCC packet results into send-order with wrap-around safety.
Uses the first sequence as an origin so a window that crosses 0xFFFF sorts
as e.g. 65534, 65535, 0, 1 rather than 0, 1, 65534, 65535.

## Type Parameters

• **T** *extends* `object`

## Parameters

### results

`T`[]

## Returns

`T`[]
