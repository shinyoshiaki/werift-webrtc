[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / RequireAtLeastOne

# Type Alias: RequireAtLeastOne\<T\>

> **RequireAtLeastOne**\<`T`\>: `{ [K in keyof T]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<keyof T, K>>> }`\[keyof `T`\]

## Type Parameters

• **T**
