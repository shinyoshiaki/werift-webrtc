[werift](../README.md) / [Exports](../modules.md) / RTCCertificate

# Class: RTCCertificate

## Table of contents

### Constructors

- [constructor](RTCCertificate.md#constructor)

### Properties

- [certPem](RTCCertificate.md#certpem)
- [privateKey](RTCCertificate.md#privatekey)
- [publicKey](RTCCertificate.md#publickey)
- [signatureHash](RTCCertificate.md#signaturehash)

### Methods

- [getFingerprints](RTCCertificate.md#getfingerprints)

## Constructors

### constructor

• **new RTCCertificate**(`privateKeyPem`, `certPem`, `signatureHash`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `privateKeyPem` | `string` |
| `certPem` | `string` |
| `signatureHash` | [`SignatureHash`](../modules.md#signaturehash) |

## Properties

### certPem

• **certPem**: `string`

___

### privateKey

• **privateKey**: `string`

___

### publicKey

• **publicKey**: `string`

___

### signatureHash

• **signatureHash**: [`SignatureHash`](../modules.md#signaturehash)

## Methods

### getFingerprints

▸ **getFingerprints**(): [`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[]

#### Returns

[`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[]
