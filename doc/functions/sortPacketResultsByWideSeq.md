[**werift**](../README.md)

***

[werift](../globals.md) / sortPacketResultsByWideSeq

# Function: sortPacketResultsByWideSeq()

> **sortPacketResultsByWideSeq**\<`T`\>(`results`): `T`[]

Sort TWCC packet results into send-order with wrap-around safety.

Chooses the origin that minimises the covered span (largest gap between
consecutive sequences, including wrap), so a window like
`{0, 1, 65534, 65535}` sorts as `65534, 65535, 0, 1` rather than numeric order.

## Type Parameters

• **T** *extends* `object`

## Parameters

### results

`T`[]

## Returns

`T`[]
