---
id: "rtccertificate"
title: "Class: RTCCertificate"
sidebar_label: "RTCCertificate"
custom_edit_url: null
hide_title: true
---

# Class: RTCCertificate

## Constructors

### constructor

\+ **new RTCCertificate**(`privateKeyPem`: *string*, `certPem`: *string*, `signatureHash`: SignatureHash): [*RTCCertificate*](rtccertificate.md)

#### Parameters:

Name | Type |
:------ | :------ |
`privateKeyPem` | *string* |
`certPem` | *string* |
`signatureHash` | SignatureHash |

**Returns:** [*RTCCertificate*](rtccertificate.md)

Defined in: [webrtc/src/transport/dtls.ts:216](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/dtls.ts#L216)

## Properties

### certPem

• **certPem**: *string*

___

### privateKey

• **privateKey**: *string*

Defined in: [webrtc/src/transport/dtls.ts:216](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/dtls.ts#L216)

___

### publicKey

• **publicKey**: *string*

Defined in: [webrtc/src/transport/dtls.ts:215](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/dtls.ts#L215)

___

### signatureHash

• **signatureHash**: SignatureHash

## Methods

### getFingerprints

▸ **getFingerprints**(): *RTCDtlsFingerprint*[]

**Returns:** *RTCDtlsFingerprint*[]

Defined in: [webrtc/src/transport/dtls.ts:228](https://github.com/shinyoshiaki/werift-webrtc/blob/71f8ead/packages/webrtc/src/transport/dtls.ts#L228)
