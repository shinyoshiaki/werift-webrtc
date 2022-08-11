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

#### Defined in

[packages/webrtc/src/sdp.ts:46](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L46)

___

### dtlsRole

• **dtlsRole**: [`DtlsRole`](../modules.md#dtlsrole)

#### Defined in

[packages/webrtc/src/sdp.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L41)

___

### extMapAllowMixed

• **extMapAllowMixed**: `boolean` = `true`

#### Defined in

[packages/webrtc/src/sdp.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L37)

___

### group

• **group**: [`GroupDescription`](GroupDescription.md)[] = `[]`

#### Defined in

[packages/webrtc/src/sdp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L36)

___

### host

• `Optional` **host**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L35)

___

### iceLite

• **iceLite**: `boolean`

#### Defined in

[packages/webrtc/src/sdp.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L43)

___

### iceOptions

• **iceOptions**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L42)

___

### icePassword

• **icePassword**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L44)

___

### iceUsernameFragment

• **iceUsernameFragment**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L45)

___

### media

• **media**: [`MediaDescription`](MediaDescription.md)[] = `[]`

#### Defined in

[packages/webrtc/src/sdp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L39)

___

### msidSemantic

• **msidSemantic**: [`GroupDescription`](GroupDescription.md)[] = `[]`

#### Defined in

[packages/webrtc/src/sdp.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L38)

___

### name

• **name**: `string` = `"-"`

#### Defined in

[packages/webrtc/src/sdp.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L33)

___

### origin

• `Optional` **origin**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L32)

___

### time

• **time**: `string` = `"0 0"`

#### Defined in

[packages/webrtc/src/sdp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L34)

___

### type

• **type**: ``"offer"`` \| ``"answer"``

#### Defined in

[packages/webrtc/src/sdp.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L40)

___

### version

• **version**: `number` = `0`

#### Defined in

[packages/webrtc/src/sdp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L31)

## Accessors

### string

• `get` **string**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/sdp.ts:314](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L314)

## Methods

### toJSON

▸ **toJSON**(): [`RTCSessionDescription`](RTCSessionDescription.md)

#### Returns

[`RTCSessionDescription`](RTCSessionDescription.md)

#### Defined in

[packages/webrtc/src/sdp.ts:332](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L332)

___

### webrtcTrackId

▸ **webrtcTrackId**(`media`): `undefined` \| `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `media` | [`MediaDescription`](MediaDescription.md) |

#### Returns

`undefined` \| `string`

#### Defined in

[packages/webrtc/src/sdp.ts:299](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L299)

___

### parse

▸ `Static` **parse**(`sdp`): [`SessionDescription`](SessionDescription.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sdp` | `string` |

#### Returns

[`SessionDescription`](SessionDescription.md)

#### Defined in

[packages/webrtc/src/sdp.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/webrtc/src/sdp.ts#L48)
