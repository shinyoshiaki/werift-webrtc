---
id: "mediastream"
title: "Class: MediaStream"
sidebar_label: "MediaStream"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new MediaStream**(`props`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[MediaStream](mediastream.md)\> & `Pick`<[MediaStream](mediastream.md), ``"id"``\> |

#### Defined in

[packages/webrtc/src/media/track.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/track.ts#L59)

## Properties

### id

• **id**: `string`

#### Defined in

[packages/webrtc/src/media/track.ts:58](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/track.ts#L58)

___

### tracks

• **tracks**: [MediaStreamTrack](mediastreamtrack.md)[] = []

#### Defined in

[packages/webrtc/src/media/track.ts:59](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/track.ts#L59)

## Methods

### addTrack

▸ **addTrack**(`track`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `track` | [MediaStreamTrack](mediastreamtrack.md) |

#### Returns

`void`

#### Defined in

[packages/webrtc/src/media/track.ts:65](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/track.ts#L65)

___

### getTracks

▸ **getTracks**(): [MediaStreamTrack](mediastreamtrack.md)[]

#### Returns

[MediaStreamTrack](mediastreamtrack.md)[]

#### Defined in

[packages/webrtc/src/media/track.ts:69](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/webrtc/src/media/track.ts#L69)
