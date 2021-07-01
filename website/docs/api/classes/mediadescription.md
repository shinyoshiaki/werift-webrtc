---
id: "mediadescription"
title: "Class: MediaDescription"
sidebar_label: "MediaDescription"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new MediaDescription**(`kind`, `port`, `profile`, `fmt`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `kind` | [Kind](../modules.md#kind) |
| `port` | `number` |
| `profile` | `string` |
| `fmt` | `number`[] \| `string`[] |

#### Defined in

[packages/webrtc/src/sdp.ts:356](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L356)

## Properties

### direction

• `Optional` **direction**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/sdp.ts:326](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L326)

___

### dtlsParams

• `Optional` **dtlsParams**: [RTCDtlsParameters](rtcdtlsparameters.md)

#### Defined in

[packages/webrtc/src/sdp.ts:347](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L347)

___

### fmt

• **fmt**: `number`[] \| `string`[]

___

### host

• `Optional` **host**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:325](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L325)

___

### iceCandidates

• **iceCandidates**: [IceCandidate](icecandidate.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:351](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L351)

___

### iceCandidatesComplete

• **iceCandidatesComplete**: `boolean` = false

#### Defined in

[packages/webrtc/src/sdp.ts:352](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L352)

___

### iceOptions

• `Optional` **iceOptions**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:353](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L353)

___

### iceParams

• `Optional` **iceParams**: [RTCIceParameters](rtciceparameters.md)

#### Defined in

[packages/webrtc/src/sdp.ts:350](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L350)

___

### kind

• **kind**: [Kind](../modules.md#kind)

___

### msid

• `Optional` **msid**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:327](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L327)

___

### port

• **port**: `number`

___

### profile

• **profile**: `string`

___

### rtcpHost

• `Optional` **rtcpHost**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:331](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L331)

___

### rtcpMux

• **rtcpMux**: `boolean` = false

#### Defined in

[packages/webrtc/src/sdp.ts:332](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L332)

___

### rtcpPort

• `Optional` **rtcpPort**: `number`

#### Defined in

[packages/webrtc/src/sdp.ts:330](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L330)

___

### rtp

• **rtp**: [RTCRtpParameters](../interfaces/rtcrtpparameters.md)

#### Defined in

[packages/webrtc/src/sdp.ts:339](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L339)

___

### sctpCapabilities

• `Optional` **sctpCapabilities**: [RTCSctpCapabilities](rtcsctpcapabilities.md)

#### Defined in

[packages/webrtc/src/sdp.ts:342](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L342)

___

### sctpMap

• **sctpMap**: `Object` = {}

#### Index signature

▪ [key: `number`]: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:343](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L343)

___

### sctpPort

• `Optional` **sctpPort**: `number`

#### Defined in

[packages/webrtc/src/sdp.ts:344](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L344)

___

### simulcastParameters

• **simulcastParameters**: [RTCRtpSimulcastParameters](rtcrtpsimulcastparameters.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:356](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L356)

___

### ssrc

• **ssrc**: [SsrcDescription](ssrcdescription.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:335](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L335)

___

### ssrcGroup

• **ssrcGroup**: [GroupDescription](groupdescription.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:336](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L336)

## Methods

### toString

▸ **toString**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/sdp.ts:365](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L365)
