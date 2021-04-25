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

Defined in: [webrtc/src/transport/dtls.ts:221](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L221)

## Properties

### certPem

• **certPem**: *string*

___

### privateKey

• **privateKey**: *string*

Defined in: [webrtc/src/transport/dtls.ts:221](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L221)

___

### publicKey

• **publicKey**: *string*

Defined in: [webrtc/src/transport/dtls.ts:220](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L220)

___

### signatureHash

• **signatureHash**: SignatureHash

## Methods

### getFingerprints

▸ **getFingerprints**(): *RTCDtlsFingerprint*[]

**Returns:** *RTCDtlsFingerprint*[]

Defined in: [webrtc/src/transport/dtls.ts:233](https://github.com/shinyoshiaki/werift-webrtc/blob/915ed10/packages/webrtc/src/transport/dtls.ts#L233)
