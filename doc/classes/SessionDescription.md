[**werift**](../README.md) • **Docs**

***

[werift](../globals.md) / SessionDescription

# Class: SessionDescription

## Constructors

### new SessionDescription()

> **new SessionDescription**(): [`SessionDescription`](SessionDescription.md)

#### Returns

[`SessionDescription`](SessionDescription.md)

## Properties

### dtlsFingerprints

> **dtlsFingerprints**: [`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[] = `[]`

***

### dtlsRole

> **dtlsRole**: [`DtlsRole`](../type-aliases/DtlsRole.md)

***

### extMapAllowMixed

> **extMapAllowMixed**: `boolean` = `true`

***

### group

> **group**: [`GroupDescription`](GroupDescription.md)[] = `[]`

***

### host?

> `optional` **host**: `string`

***

### iceLite

> **iceLite**: `boolean`

***

### iceOptions

> **iceOptions**: `string`

***

### icePassword

> **icePassword**: `string`

***

### iceUsernameFragment

> **iceUsernameFragment**: `string`

***

### media

> **media**: [`MediaDescription`](MediaDescription.md)[] = `[]`

***

### msidSemantic

> **msidSemantic**: [`GroupDescription`](GroupDescription.md)[] = `[]`

***

### name

> **name**: `string` = `"-"`

***

### origin?

> `optional` **origin**: `string`

***

### time

> **time**: `string` = `"0 0"`

***

### type

> **type**: `"offer"` \| `"answer"`

***

### version

> **version**: `number` = `0`

## Accessors

### string

> `get` **string**(): `string`

#### Returns

`string`

## Methods

### toJSON()

> **toJSON**(): [`RTCSessionDescription`](RTCSessionDescription.md)

#### Returns

[`RTCSessionDescription`](RTCSessionDescription.md)

***

### webrtcTrackId()

> **webrtcTrackId**(`media`): `undefined` \| `string`

#### Parameters

• **media**: [`MediaDescription`](MediaDescription.md)

#### Returns

`undefined` \| `string`

***

### parse()

> `static` **parse**(`sdp`): [`SessionDescription`](SessionDescription.md)

#### Parameters

• **sdp**: `string`

#### Returns

[`SessionDescription`](SessionDescription.md)
