[**werift**](../README.md)

***

[werift](../globals.md) / IceCandidate

# Class: IceCandidate

## Constructors

### Constructor

> **new IceCandidate**(`component`, `foundation`, `ip`, `port`, `priority`, `protocol`, `type`, `generation?`, `ufrag?`): `IceCandidate`

#### Parameters

##### component

`number`

##### foundation

`string`

##### ip

`string`

##### port

`number`

##### priority

`number`

##### protocol

`string`

##### type

`string`

##### generation?

`number`

##### ufrag?

`string`

#### Returns

`IceCandidate`

## Properties

### component

> **component**: `number`

***

### foundation

> **foundation**: `string`

***

### generation?

> `optional` **generation?**: `number`

***

### ip

> **ip**: `string`

***

### port

> **port**: `number`

***

### priority

> **priority**: `number`

***

### protocol

> **protocol**: `string`

***

### relatedAddress?

> `optional` **relatedAddress?**: `string`

***

### relatedPort?

> `optional` **relatedPort?**: `number`

***

### sdpMid?

> `optional` **sdpMid?**: `string`

***

### sdpMLineIndex?

> `optional` **sdpMLineIndex?**: `number`

***

### tcpType?

> `optional` **tcpType?**: `string`

***

### type

> **type**: `string`

***

### ufrag?

> `optional` **ufrag?**: `string`

## Methods

### toJSON()

> **toJSON**(): [`RTCIceCandidate`](RTCIceCandidate.md)

The parsed fields are validated from these typed values, not by reparsing.

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)

***

### fromJSON()

> `static` **fromJSON**(`data`): `IceCandidate` \| `undefined`

Returns `undefined` when `data.candidate` is empty or violates the grammar
documented on [RTCIceCandidateFields](../interfaces/RTCIceCandidateFields.md).

#### Parameters

##### data

[`RTCIceCandidate`](RTCIceCandidate.md) \| [`RTCIceCandidateInit`](../interfaces/RTCIceCandidateInit.md)

#### Returns

`IceCandidate` \| `undefined`
