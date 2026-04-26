[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / MediaDescription

# Class: MediaDescription

## Constructors

### new MediaDescription()

> **new MediaDescription**(`kind`, `port`, `profile`, `fmt`): [`MediaDescription`](MediaDescription.md)

#### Parameters

• **kind**: [`Kind`](../type-aliases/Kind.md)

• **port**: `number`

• **profile**: `string`

• **fmt**: `number`[] \| `string`[]

#### Returns

[`MediaDescription`](MediaDescription.md)

## Properties

### direction?

> `optional` **direction**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### dtlsParams?

> `optional` **dtlsParams**: [`RTCDtlsParameters`](RTCDtlsParameters.md)

***

### fmt

> **fmt**: `number`[] \| `string`[]

***

### host?

> `optional` **host**: `string`

***

### iceCandidates

> **iceCandidates**: [`IceCandidate`](IceCandidate.md)[] = `[]`

***

### iceCandidatesComplete

> **iceCandidatesComplete**: `boolean` = `false`

***

### iceOptions?

> `optional` **iceOptions**: `string`

***

### iceParams?

> `optional` **iceParams**: [`RTCIceParameters`](RTCIceParameters.md)

***

### kind

> **kind**: [`Kind`](../type-aliases/Kind.md)

***

### msid?

> `optional` **msid**: `string`

***

### port

> **port**: `number`

***

### profile

> **profile**: `string`

***

### rtcpHost?

> `optional` **rtcpHost**: `string`

***

### rtcpMux

> **rtcpMux**: `boolean` = `false`

***

### rtcpPort?

> `optional` **rtcpPort**: `number`

***

### rtp

> **rtp**: [`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

***

### sctpCapabilities?

> `optional` **sctpCapabilities**: [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

***

### sctpMap

> **sctpMap**: `object` = `{}`

#### Index Signature

 \[`key`: `number`\]: `string`

***

### sctpPort?

> `optional` **sctpPort**: `number`

***

### simulcastParameters

> **simulcastParameters**: [`RTCRtpSimulcastParameters`](RTCRtpSimulcastParameters.md)[] = `[]`

***

### ssrc

> **ssrc**: [`SsrcDescription`](SsrcDescription.md)[] = `[]`

***

### ssrcGroup

> **ssrcGroup**: [`GroupDescription`](GroupDescription.md)[] = `[]`

## Methods

### toString()

> **toString**(): `string`

#### Returns

`string`
