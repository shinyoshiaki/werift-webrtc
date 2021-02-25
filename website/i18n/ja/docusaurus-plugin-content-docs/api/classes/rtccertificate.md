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

\+ **new RTCCertificate**(`privateKeyPem`: *string*, `certPem`: *string*): [*RTCCertificate*](rtccertificate.md)

#### Parameters:

Name | Type |
:------ | :------ |
`privateKeyPem` | *string* |
`certPem` | *string* |

**Returns:** [*RTCCertificate*](rtccertificate.md)

Defined in: [webrtc/src/transport/dtls.ts:191](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/transport/dtls.ts#L191)

## Properties

### cert

• **cert**: *string*

Defined in: [webrtc/src/transport/dtls.ts:191](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/transport/dtls.ts#L191)

___

### privateKey

• **privateKey**: *string*

Defined in: [webrtc/src/transport/dtls.ts:190](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/transport/dtls.ts#L190)

___

### publicKey

• **publicKey**: *string*

Defined in: [webrtc/src/transport/dtls.ts:189](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/transport/dtls.ts#L189)

## Methods

### getFingerprints

▸ **getFingerprints**(): *RTCDtlsFingerprint*[]

**Returns:** *RTCDtlsFingerprint*[]

Defined in: [webrtc/src/transport/dtls.ts:199](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/transport/dtls.ts#L199)

___

### unsafe\_useDefaultCertificate

▸ `Static`**unsafe_useDefaultCertificate**(): [*RTCCertificate*](rtccertificate.md)

**Returns:** [*RTCCertificate*](rtccertificate.md)

Defined in: [webrtc/src/transport/dtls.ts:208](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/webrtc/src/transport/dtls.ts#L208)
