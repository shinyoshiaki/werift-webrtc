[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / IceCandidate

# Class: IceCandidate

## Constructors

### new IceCandidate()

> **new IceCandidate**(`component`, `foundation`, `ip`, `port`, `priority`, `protocol`, `type`, `generation`?, `ufrag`?): [`IceCandidate`](IceCandidate.md)

#### Parameters

• **component**: `number`

• **foundation**: `string`

• **ip**: `string`

• **port**: `number`

• **priority**: `number`

• **protocol**: `string`

• **type**: `string`

• **generation?**: `number`

• **ufrag?**: `string`

#### Returns

[`IceCandidate`](IceCandidate.md)

## Properties

### component

> **component**: `number`

***

### foundation

> **foundation**: `string`

***

### generation?

> `optional` **generation**: `number`

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

> `optional` **relatedAddress**: `string`

***

### relatedPort?

> `optional` **relatedPort**: `number`

***

### sdpMLineIndex?

> `optional` **sdpMLineIndex**: `number`

***

### sdpMid?

> `optional` **sdpMid**: `string`

***

### tcpType?

> `optional` **tcpType**: `string`

***

### type

> **type**: `string`

***

### ufrag?

> `optional` **ufrag**: `string`

## Methods

### toJSON()

> **toJSON**(): [`RTCIceCandidate`](RTCIceCandidate.md)

#### Returns

[`RTCIceCandidate`](RTCIceCandidate.md)

***

### fromJSON()

> `static` **fromJSON**(`data`): `undefined` \| [`IceCandidate`](IceCandidate.md)

#### Parameters

• **data**: [`RTCIceCandidate`](RTCIceCandidate.md)

#### Returns

`undefined` \| [`IceCandidate`](IceCandidate.md)
