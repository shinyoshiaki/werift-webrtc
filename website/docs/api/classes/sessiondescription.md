---
id: "sessiondescription"
title: "Class: SessionDescription"
sidebar_label: "SessionDescription"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new SessionDescription**()

## Properties

### dtlsFingerprints

• **dtlsFingerprints**: [RTCDtlsFingerprint](rtcdtlsfingerprint.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L45)

___

### dtlsRole

• **dtlsRole**: [DtlsRole](../modules.md#dtlsrole)

#### Defined in

[packages/webrtc/src/sdp.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L40)

___

### group

• **group**: [GroupDescription](groupdescription.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L36)

___

### host

• `Optional` **host**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L35)

___

### iceLite

• **iceLite**: `boolean`

#### Defined in

[packages/webrtc/src/sdp.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L42)

___

### iceOptions

• **iceOptions**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L41)

___

### icePassword

• **icePassword**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L43)

___

### iceUsernameFragment

• **iceUsernameFragment**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L44)

___

### media

• **media**: [MediaDescription](mediadescription.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L38)

___

### msidSemantic

• **msidSemantic**: [GroupDescription](groupdescription.md)[] = []

#### Defined in

[packages/webrtc/src/sdp.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L37)

___

### name

• **name**: `string` = "-"

#### Defined in

[packages/webrtc/src/sdp.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L33)

___

### origin

• `Optional` **origin**: `string`

#### Defined in

[packages/webrtc/src/sdp.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L32)

___

### time

• **time**: `string` = "0 0"

#### Defined in

[packages/webrtc/src/sdp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L34)

___

### type

• **type**: ``"offer"`` \| ``"answer"``

#### Defined in

[packages/webrtc/src/sdp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L39)

___

### version

• **version**: `number` = 0

#### Defined in

[packages/webrtc/src/sdp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L31)

## Accessors

### string

• `get` **string**(): `string`

#### Returns

`string`

#### Defined in

[packages/webrtc/src/sdp.ts:303](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L303)

## Methods

### toJSON

▸ **toJSON**(): [RTCSessionDescription](rtcsessiondescription.md)

#### Returns

[RTCSessionDescription](rtcsessiondescription.md)

#### Defined in

[packages/webrtc/src/sdp.ts:318](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L318)

___

### webrtcTrackId

▸ **webrtcTrackId**(`media`): `undefined` \| `string`

#### Parameters

| Name | Type |
| :------ | :------ |
| `media` | [MediaDescription](mediadescription.md) |

#### Returns

`undefined` \| `string`

#### Defined in

[packages/webrtc/src/sdp.ts:288](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L288)

___

### parse

▸ `Static` **parse**(`sdp`): [SessionDescription](sessiondescription.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sdp` | `string` |

#### Returns

[SessionDescription](sessiondescription.md)

#### Defined in

[packages/webrtc/src/sdp.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/sdp.ts#L47)
