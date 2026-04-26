[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RequireAtLeastOne

# Type Alias: RequireAtLeastOne\<T\>

> **RequireAtLeastOne**\<`T`\>: `{ [K in keyof T]-?: Required<Pick<T, K>> & Partial<Pick<T, Exclude<keyof T, K>>> }`\[keyof `T`\]

## Type Parameters

• **T**
