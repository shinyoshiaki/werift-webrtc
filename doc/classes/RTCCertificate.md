[**werift**](../README.md)

***

[werift](../globals.md) / RTCCertificate

# Class: RTCCertificate

## Constructors

### Constructor

> **new RTCCertificate**(`privateKeyPem`, `certPem`, `signatureHash`): `RTCCertificate`

#### Parameters

##### privateKeyPem

`string`

##### certPem

`string`

##### signatureHash

[`SignatureHash`](../type-aliases/SignatureHash.md)

#### Returns

`RTCCertificate`

## Properties

### certPem

> **certPem**: `string`

***

### privateKey

> **privateKey**: `string`

***

### publicKey

> **publicKey**: `string`

***

### signatureHash

> **signatureHash**: [`SignatureHash`](../type-aliases/SignatureHash.md)

## Methods

### getFingerprints()

> **getFingerprints**(): [`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[]

#### Returns

[`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[]
