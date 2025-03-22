[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / RTCCertificate

# Class: RTCCertificate

## Constructors

### new RTCCertificate()

> **new RTCCertificate**(`privateKeyPem`, `certPem`, `signatureHash`): [`RTCCertificate`](RTCCertificate.md)

#### Parameters

• **privateKeyPem**: `string`

• **certPem**: `string`

• **signatureHash**: [`SignatureHash`](../type-aliases/SignatureHash.md)

#### Returns

[`RTCCertificate`](RTCCertificate.md)

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
