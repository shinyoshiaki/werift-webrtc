[**werift**](../README.md)

***

[werift](../globals.md) / MediaDescription

# Class: MediaDescription

## Constructors

### Constructor

> **new MediaDescription**(`kind`, `port`, `profile`, `fmt`): `MediaDescription`

#### Parameters

##### kind

[`Kind`](../type-aliases/Kind.md)

##### port

`number`

##### profile

`string`

##### fmt

`number`[] \| `string`[]

#### Returns

`MediaDescription`

## Properties

### direction?

> `optional` **direction?**: `"inactive"` \| `"sendonly"` \| `"recvonly"` \| `"sendrecv"`

***

### dtlsParams?

> `optional` **dtlsParams?**: [`RTCDtlsParameters`](RTCDtlsParameters.md)

***

### fmt

> **fmt**: `number`[] \| `string`[]

***

### host?

> `optional` **host?**: `string`

***

### iceCandidates

> **iceCandidates**: [`IceCandidate`](IceCandidate.md)[] = `[]`

***

### iceCandidatesComplete

> **iceCandidatesComplete**: `boolean` = `false`

***

### iceOptions?

> `optional` **iceOptions?**: `string`

***

### iceParams?

> `optional` **iceParams?**: [`RTCIceParameters`](RTCIceParameters.md)

***

### kind

> **kind**: [`Kind`](../type-aliases/Kind.md)

***

### msids

> **msids**: `string`[] = `[]`

***

### port

> **port**: `number`

***

### profile

> **profile**: `string`

***

### rtcpHost?

> `optional` **rtcpHost?**: `string`

`a=rtcp` の connection-address (RFC 3605)。
`a=rtcp:<port>` のようにアドレスが省略された場合は `undefined` のまま保持し、
有効な RTCP アドレスは media-level の `c=` (`host`)、それもなければ
session-level の `c=` を継承する (`rtcpHost ?? media.host ?? session.host`)。

***

### rtcpMux

> **rtcpMux**: `boolean` = `false`

`a=rtcp-mux` (RFC 5761)。`a=rtcp` の有無とは独立して入出力する。

***

### rtcpPort?

> `optional` **rtcpPort?**: `number`

`a=rtcp` の RTCP port (RFC 3605)。`undefined` のときは `a=rtcp` を出力しない。

***

### rtp

> **rtp**: [`RTCRtpParameters`](../interfaces/RTCRtpParameters.md)

***

### sctpCapabilities?

> `optional` **sctpCapabilities?**: [`RTCSctpCapabilities`](RTCSctpCapabilities.md)

***

### sctpMap

> **sctpMap**: `object` = `{}`

#### Index Signature

\[`key`: `number`\]: `string`

***

### sctpPort?

> `optional` **sctpPort?**: `number`

***

### simulcastParameters

> **simulcastParameters**: [`RTCRtpSimulcastParameters`](RTCRtpSimulcastParameters.md)[] = `[]`

***

### ssrc

> **ssrc**: [`SsrcDescription`](SsrcDescription.md)[] = `[]`

***

### ssrcGroup

> **ssrcGroup**: [`GroupDescription`](GroupDescription.md)[] = `[]`

## Accessors

### msid

#### Get Signature

> **get** **msid**(): `string` \| `undefined`

##### Returns

`string` \| `undefined`

#### Set Signature

> **set** **msid**(`value`): `void`

##### Parameters

###### value

`string` \| `undefined`

##### Returns

`void`

## Methods

### toString()

> **toString**(): `string`

#### Returns

`string`
