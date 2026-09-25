[**werift**](../README.md)

***

[werift](../globals.md) / CipherContext

# Class: CipherContext

## Constructors

### new CipherContext()

> **new CipherContext**(`sessionType`, `certPem`?, `keyPem`?, `signatureHashAlgorithm`?): [`CipherContext`](CipherContext.md)

#### Parameters

##### sessionType

`SessionTypes`

##### certPem?

`string`

##### keyPem?

`string`

##### signatureHashAlgorithm?

[`SignatureHash`](../type-aliases/SignatureHash.md)

#### Returns

[`CipherContext`](CipherContext.md)

## Properties

### certPem?

> `optional` **certPem**: `string`

***

### cipher

> **cipher**: `AEADCipher`

***

### cipherSuite

> **cipherSuite**: [`CipherSuites`](../type-aliases/CipherSuites.md)

***

### keyPem?

> `optional` **keyPem**: `string`

***

### localCert

> **localCert**: `Buffer`

***

### localKeyPair

> **localKeyPair**: `NamedCurveKeyPair`

***

### localPrivateKey

> **localPrivateKey**: `PrivateKey`

***

### localRandom

> **localRandom**: `DtlsRandom`

***

### masterSecret

> **masterSecret**: `Buffer`

***

### namedCurve

> **namedCurve**: [`NamedCurveAlgorithms`](../type-aliases/NamedCurveAlgorithms.md)

***

### remoteCertificate?

> `optional` **remoteCertificate**: `Buffer`\<`ArrayBufferLike`\>

***

### remoteKeyPair

> **remoteKeyPair**: `Partial`\<`NamedCurveKeyPair`\>

***

### remoteRandom

> **remoteRandom**: `DtlsRandom`

***

### sessionType

> **sessionType**: `SessionTypes`

***

### signatureHashAlgorithm?

> `optional` **signatureHashAlgorithm**: [`SignatureHash`](../type-aliases/SignatureHash.md)

## Methods

### decryptPacket()

> **decryptPacket**(`pkt`): `Buffer`\<`ArrayBufferLike`\>

#### Parameters

##### pkt

`DtlsPlaintext`

#### Returns

`Buffer`\<`ArrayBufferLike`\>

***

### encryptPacket()

> **encryptPacket**(`pkt`): `DtlsPlaintext`

#### Parameters

##### pkt

`DtlsPlaintext`

#### Returns

`DtlsPlaintext`

***

### generateKeySignature()

> **generateKeySignature**(`hashAlgorithm`): `Buffer`\<`ArrayBufferLike`\>

#### Parameters

##### hashAlgorithm

`string`

#### Returns

`Buffer`\<`ArrayBufferLike`\>

***

### parseX509()

> **parseX509**(`certPem`, `keyPem`, `signatureHash`): `void`

#### Parameters

##### certPem

`string`

##### keyPem

`string`

##### signatureHash

[`SignatureHash`](../type-aliases/SignatureHash.md)

#### Returns

`void`

***

### signatureData()

> **signatureData**(`data`, `hash`): `Buffer`\<`ArrayBufferLike`\>

#### Parameters

##### data

`Buffer`

##### hash

`string`

#### Returns

`Buffer`\<`ArrayBufferLike`\>

***

### verifyData()

> **verifyData**(`buf`): `Buffer`\<`ArrayBuffer`\>

#### Parameters

##### buf

`Buffer`

#### Returns

`Buffer`\<`ArrayBuffer`\>

***

### createSelfSignedCertificateWithKey()

> `static` **createSelfSignedCertificateWithKey**(`signatureHash`, `namedCurveAlgorithm`?): `Promise`\<\{ `certPem`: `string`; `keyPem`: `string`; `signatureHash`: [`SignatureHash`](../type-aliases/SignatureHash.md); \}\>

#### Parameters

##### signatureHash

[`SignatureHash`](../type-aliases/SignatureHash.md)

##### namedCurveAlgorithm?

[`NamedCurveAlgorithms`](../type-aliases/NamedCurveAlgorithms.md)

necessary when use ecdsa

#### Returns

`Promise`\<\{ `certPem`: `string`; `keyPem`: `string`; `signatureHash`: [`SignatureHash`](../type-aliases/SignatureHash.md); \}\>
