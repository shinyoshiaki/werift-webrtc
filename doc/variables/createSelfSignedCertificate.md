[**werift**](../README.md)

***

[werift](../globals.md) / createSelfSignedCertificate

# Variable: createSelfSignedCertificate

> `const` **createSelfSignedCertificate**: (`signatureHash`, `namedCurveAlgorithm?`) => `Promise`\<\{ `certPem`: `string`; `keyPem`: `string`; `signatureHash`: [`SignatureHash`](../type-aliases/SignatureHash.md); \}\> = `CipherContext.createSelfSignedCertificateWithKey`

## Parameters

### signatureHash

[`SignatureHash`](../type-aliases/SignatureHash.md)

### namedCurveAlgorithm?

[`NamedCurveAlgorithms`](../type-aliases/NamedCurveAlgorithms.md)

necessary when use ecdsa

## Returns

`Promise`\<\{ `certPem`: `string`; `keyPem`: `string`; `signatureHash`: [`SignatureHash`](../type-aliases/SignatureHash.md); \}\>

## Param

**signatureHash**

## Param

**namedCurveAlgorithm**

necessary when use ecdsa
