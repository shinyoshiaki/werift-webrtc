[**werift**](../README.md)

***

[werift](../globals.md) / normalizePem

# Function: normalizePem()

> **normalizePem**(`pem`): `string`

Trims indentation and blank lines from each PEM line.
`node:crypto` rejects indented PEM (e.g. written in an indented template literal),
which the previous `@fidm/x509` parser accepted.

## Parameters

### pem

`string`

## Returns

`string`
