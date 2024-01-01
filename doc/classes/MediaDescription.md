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

• **new MediaDescription**(`kind`, `port`, `profile`, `fmt`): [`MediaDescription`](MediaDescription.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `kind` | [`Kind`](../modules.md#kind) |
| `port` | `number` |
| `profile` | `string` |
| `fmt` | `number`[] \| `string`[] |

#### Returns

[`MediaDescription`](MediaDescription.md)

## Properties

### direction

• `Optional` **direction**: ``"inactive"`` \| ``"sendonly"`` \| ``"recvonly"`` \| ``"sendrecv"``

___

### dtlsParams

• `Optional` **dtlsParams**: [`RTCDtlsParameters`](RTCDtlsParameters.md)

___

### fmt

• **fmt**: `number`[] \| `string`[]

___

### host

• `Optional` **host**: `string`

___

### iceCandidates

• **iceCandidates**: [`IceCandidate`](IceCandidate.md)[] = `[]`

___

### iceCandidatesComplete

• **iceCandidatesComplete**: `boolean` = `false`

___

### iceOptions

• `Optional` **iceOptions**: `string`

___

### iceParams

• `Optional` **iceParams**: [`RTCIceParameters`](RTCIceParameters.md)

___

### kind

• **kind**: [`Kind`](../modules.md#kind)

___

### msid

• `Optional` **msid**: `string`

___

### port

• **port**: `number`

___

### profile

• **profile**: `string`

___

### rtcpHost

• `Optional` **rtcpHost**: `string`

___

### rtcpMux

• **rtcpMux**: `boolean` = `false`

___

### rtcpPort

• `Optional` **rtcpPort**: `number`

___

### rtp

• **rtp**: [`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

___

### sctpCapabilities

• `Optional` **sctpCapabilities**: [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

___

### sctpMap

• **sctpMap**: `Object` = `{}`

#### Index signature

▪ [key: `number`]: `string`

___

### sctpPort

• `Optional` **sctpPort**: `number`

___

### simulcastParameters

• **simulcastParameters**: [`RTCRtpSimulcastParameters`](RTCRtpSimulcastParameters.md)[] = `[]`

___

### ssrc

• **ssrc**: [`SsrcDescription`](SsrcDescription.md)[] = `[]`

___

### ssrcGroup

• **ssrcGroup**: [`GroupDescription`](GroupDescription.md)[] = `[]`

## Methods

### toString

▸ **toString**(): `string`

#### Returns

`string`
