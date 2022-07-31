[werift](../README.md) / [Exports](../modules.md) / MediaDescription

# Class: MediaDescription

## Table of contents

### Constructors

- [constructor](MediaDescription.md#constructor)

### Properties

- [direction](MediaDescription.md#direction)
- [dtlsParams](MediaDescription.md#dtlsparams)
- [fmt](MediaDescription.md#fmt)
- [host](MediaDescription.md#host)
- [iceCandidates](MediaDescription.md#icecandidates)
- [iceCandidatesComplete](MediaDescription.md#icecandidatescomplete)
- [iceOptions](MediaDescription.md#iceoptions)
- [iceParams](MediaDescription.md#iceparams)
- [kind](MediaDescription.md#kind)
- [msid](MediaDescription.md#msid)
- [port](MediaDescription.md#port)
- [profile](MediaDescription.md#profile)
- [rtcpHost](MediaDescription.md#rtcphost)
- [rtcpMux](MediaDescription.md#rtcpmux)
- [rtcpPort](MediaDescription.md#rtcpport)
- [rtp](MediaDescription.md#rtp)
- [sctpCapabilities](MediaDescription.md#sctpcapabilities)
- [sctpMap](MediaDescription.md#sctpmap)
- [sctpPort](MediaDescription.md#sctpport)
- [simulcastParameters](MediaDescription.md#simulcastparameters)
- [ssrc](MediaDescription.md#ssrc)
- [ssrcGroup](MediaDescription.md#ssrcgroup)

### Methods

- [toString](MediaDescription.md#tostring)

## Constructors

### constructor

• **new MediaDescription**(`kind`, `port`, `profile`, `fmt`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `kind` | [`Kind`](../modules.md#kind) |
| `port` | `number` |
| `profile` | `string` |
| `fmt` | `number`[] \| `string`[] |

#### Defined in

[packages/webrtc/src/sdp.ts:372](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L372)

## Properties

### direction

• `Optional` **direction**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

#### Defined in

[packages/webrtc/src/sdp.ts:340](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L340)

___

### dtlsParams

• `Optional` **dtlsParams**: [`RTCDtlsParameters`](RTCDtlsParameters.md)

#### Defined in

[packages/webrtc/src/sdp.ts:361](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L361)

___

### fmt

• **fmt**: `number`[] \| `string`[]

#### Defined in

[packages/webrtc/src/sdp.ts:376](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L376)

___

### host

• `Optional` **host**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:339](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L339)

___

### iceCandidates

• **iceCandidates**: [`IceCandidate`](IceCandidate.md)[] = `[]`

#### Defined in

[packages/webrtc/src/sdp.ts:365](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L365)

___

### iceCandidatesComplete

• **iceCandidatesComplete**: `boolean` = `false`

#### Defined in

[packages/webrtc/src/sdp.ts:366](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L366)

___

### iceOptions

• `Optional` **iceOptions**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:367](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L367)

___

### iceParams

• `Optional` **iceParams**: [`RTCIceParameters`](RTCIceParameters.md)

#### Defined in

[packages/webrtc/src/sdp.ts:364](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L364)

___

### kind

• **kind**: [`Kind`](../modules.md#kind)

#### Defined in

[packages/webrtc/src/sdp.ts:373](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L373)

___

### msid

• `Optional` **msid**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:341](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L341)

___

### port

• **port**: `number`

#### Defined in

[packages/webrtc/src/sdp.ts:374](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L374)

___

### profile

• **profile**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:375](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L375)

___

### rtcpHost

• `Optional` **rtcpHost**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:345](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L345)

___

### rtcpMux

• **rtcpMux**: `boolean` = `false`

#### Defined in

[packages/webrtc/src/sdp.ts:346](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L346)

___

### rtcpPort

• `Optional` **rtcpPort**: `number`

#### Defined in

[packages/webrtc/src/sdp.ts:344](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L344)

___

### rtp

• **rtp**: [`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

#### Defined in

[packages/webrtc/src/sdp.ts:353](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L353)

___

### sctpCapabilities

• `Optional` **sctpCapabilities**: [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

#### Defined in

[packages/webrtc/src/sdp.ts:356](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L356)

___

### sctpMap

• **sctpMap**: `Object` = `{}`

#### Index signature

▪ [key: `number`]: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:357](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L357)

___

### sctpPort

• `Optional` **sctpPort**: `number`

#### Defined in

[packages/webrtc/src/sdp.ts:358](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L358)

___

### simulcastParameters

• **simulcastParameters**: [`RTCRtpSimulcastParameters`](RTCRtpSimulcastParameters.md)[] = `[]`

#### Defined in

[packages/webrtc/src/sdp.ts:370](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L370)

___

### ssrc

• **ssrc**: [`SsrcDescription`](SsrcDescription.md)[] = `[]`

#### Defined in

[packages/webrtc/src/sdp.ts:349](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L349)

___

### ssrcGroup

• **ssrcGroup**: [`GroupDescription`](GroupDescription.md)[] = `[]`

#### Defined in

[packages/webrtc/src/sdp.ts:350](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L350)

## Methods

### toString

▸ **toString**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/sdp.ts:379](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L379)
