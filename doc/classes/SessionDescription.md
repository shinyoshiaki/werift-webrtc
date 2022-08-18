[werift](../README.md) / [Exports](../modules.md) / SessionDescription

# Class: SessionDescription

## Table of contents

### Constructors

- [constructor](SessionDescription.md#constructor)

### Properties

- [dtlsFingerprints](SessionDescription.md#dtlsfingerprints)
- [dtlsRole](SessionDescription.md#dtlsrole)
- [extMapAllowMixed](SessionDescription.md#extmapallowmixed)
- [group](SessionDescription.md#group)
- [host](SessionDescription.md#host)
- [iceLite](SessionDescription.md#icelite)
- [iceOptions](SessionDescription.md#iceoptions)
- [icePassword](SessionDescription.md#icepassword)
- [iceUsernameFragment](SessionDescription.md#iceusernamefragment)
- [media](SessionDescription.md#media)
- [msidSemantic](SessionDescription.md#msidsemantic)
- [name](SessionDescription.md#name)
- [origin](SessionDescription.md#origin)
- [time](SessionDescription.md#time)
- [type](SessionDescription.md#type)
- [version](SessionDescription.md#version)

### Accessors

- [string](SessionDescription.md#string)

### Methods

- [toJSON](SessionDescription.md#tojson)
- [webrtcTrackId](SessionDescription.md#webrtctrackid)
- [parse](SessionDescription.md#parse)

## Constructors

### constructor

• **new SessionDescription**()

## Properties

### dtlsFingerprints

• **dtlsFingerprints**: [`RTCDtlsFingerprint`](RTCDtlsFingerprint.md)[] = `[]`

___

### dtlsRole

• **dtlsRole**: [`DtlsRole`](../modules.md#dtlsrole)

___

### extMapAllowMixed

• **extMapAllowMixed**: `boolean` = `true`

___

### group

• **group**: [`GroupDescription`](GroupDescription.md)[] = `[]`

___

### host

• `Optional` **host**: `string`

___

### iceLite

• **iceLite**: `boolean`

___

### iceOptions

• **iceOptions**: `string`

___

### icePassword

• **icePassword**: `string`

___

### iceUsernameFragment

• **iceUsernameFragment**: `string`

___

### media

• **media**: [`MediaDescription`](MediaDescription.md)[] = `[]`

___

### msidSemantic

• **msidSemantic**: [`GroupDescription`](GroupDescription.md)[] = `[]`

___

### name

• **name**: `string` = `"-"`

___

### origin

• `Optional` **origin**: `string`

___

### time

• **time**: `string` = `"0 0"`

___

### type

• **type**: ``"offer"`` \| ``"answer"``

___

### version

• **version**: `number` = `0`

## Accessors

### string

• `get` **string**(): `string`

#### Returns

`string`

## Methods

### toJSON

▸ **toJSON**(): [`RTCSessionDescription`](RTCSessionDescription.md)

#### Returns

[`RTCSessionDescription`](RTCSessionDescription.md)

___

### webrtcTrackId

▸ **webrtcTrackId**(`media`): `undefined` \| `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `media` | [`MediaDescription`](MediaDescription.md) |

#### Returns

`undefined` \| `string`

___

### parse

▸ `Static` **parse**(`sdp`): [`SessionDescription`](SessionDescription.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sdp` | `string` |

#### Returns

[`SessionDescription`](SessionDescription.md)
