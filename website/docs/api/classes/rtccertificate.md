---
id: "rtccertificate"
title: "Class: RTCCertificate"
sidebar_label: "RTCCertificate"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RTCCertificate**(`privateKeyPem`, `certPem`, `signatureHash`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `privateKeyPem` | `string` |
| `certPem` | `string` |
| `signatureHash` | `SignatureHash` |

#### Defined in

[packages/webrtc/src/transport/dtls.ts:217](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/dtls.ts#L217)

## Properties

### certPem

• **certPem**: `string`

___

### privateKey

• **privateKey**: `string`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:217](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/dtls.ts#L217)

___

### publicKey

• **publicKey**: `string`

#### Defined in

[packages/webrtc/src/transport/dtls.ts:216](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/dtls.ts#L216)

___

### signatureHash

• **signatureHash**: `SignatureHash`

## Methods

### getFingerprints

▸ **getFingerprints**(): [RTCDtlsFingerprint](rtcdtlsfingerprint.md)[]

#### Returns

[RTCDtlsFingerprint](rtcdtlsfingerprint.md)[]

#### Defined in

[packages/webrtc/src/transport/dtls.ts:229](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/transport/dtls.ts#L229)
