[**werift**](../../../../README.md)

***

[werift](../../../../globals.md) / [binaryData](../README.md) / Decoded

# Type Alias: Decoded\<S\>

> **Decoded**\<`S`\> = `S` *extends* [`DataType`](../interfaces/DataType.md)\<infer T\> ? `T` : `S` *extends* [`Schema`](../interfaces/Schema.md) ? `{ -readonly [K in keyof S]: Decoded<S[K]> }` : `never`

Infer the decoded value from a type or schema.

## Type Parameters

### S

`S`
