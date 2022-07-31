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

#### Defined in

[packages/webrtc/src/transport/dtls.ts:280](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L280)

## Properties

### certPem

• **certPem**: `string`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:282](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L282)

___

### privateKey

• **privateKey**: `string`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:278](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L278)

___

### publicKey

• **publicKey**: `string`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:277](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L277)

___

### signatureHash

• **signatureHash**: [`SignatureHash`](../modules.md#signaturehash)

#### Defined in

[packages/webrtc/src/transport/dtls.ts:283](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L283)

## Methods

### getFingerprints

▸ **getFingerprints**(): [`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[]

#### Returns

[`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[]

#### Defined in

[packages/webrtc/src/transport/dtls.ts:290](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/transport/dtls.ts#L290)
