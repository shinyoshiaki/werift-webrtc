[**werift**](../README.md)

***

[werift](../globals.md) / createSelfSignedCertificate

# Function: createSelfSignedCertificate()

> **createSelfSignedCertificate**(`signatureHash`, `namedCurveAlgorithm`?): `Promise`\<\{ `certPem`: `string`; `keyPem`: `string`; `signatureHash`: [`SignatureHash`](../type-aliases/SignatureHash.md); \}\>

## Parameters

### signatureHash

[`SignatureHash`](../type-aliases/SignatureHash.md)

### namedCurveAlgorithm?

[`NamedCurveAlgorithms`](../type-aliases/NamedCurveAlgorithms.md)

kept for compatibility. ECDSA certificates always use P-256 (X25519 cannot sign).

## Returns

`Promise`\<\{ `certPem`: `string`; `keyPem`: `string`; `signatureHash`: [`SignatureHash`](../type-aliases/SignatureHash.md); \}\>

## Param

## Param

necessary when use ecdsa
