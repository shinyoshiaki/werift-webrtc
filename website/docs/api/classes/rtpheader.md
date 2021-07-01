---
id: "rtpheader"
title: "Class: RtpHeader"
sidebar_label: "RtpHeader"
sidebar_position: 0
custom_edit_url: null
---

## Constructors

### constructor

• **new RtpHeader**(`props?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Partial`<[RtpHeader](rtpheader.md)\> |

#### Defined in

[packages/rtp/src/rtp/rtp.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L48)

## Properties

### csrc

• **csrc**: `number`[] = []

#### Defined in

[packages/rtp/src/rtp/rtp.ts:44](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L44)

___

### extension

• **extension**: `boolean` = false

#### Defined in

[packages/rtp/src/rtp/rtp.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L37)

___

### extensionLength

• `Optional` **extensionLength**: `number`

deserialize only

#### Defined in

[packages/rtp/src/rtp/rtp.ts:47](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L47)

___

### extensionProfile

• **extensionProfile**: `ExtensionProfile`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:45](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L45)

___

### extensions

• **extensions**: [Extension](../modules.md#extension)[] = []

#### Defined in

[packages/rtp/src/rtp/rtp.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L48)

___

### marker

• **marker**: `boolean` = false

#### Defined in

[packages/rtp/src/rtp/rtp.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L38)

___

### padding

• **padding**: `boolean` = false

#### Defined in

[packages/rtp/src/rtp/rtp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L35)

___

### paddingSize

• **paddingSize**: `number` = 0

#### Defined in

[packages/rtp/src/rtp/rtp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L36)

___

### payloadOffset

• **payloadOffset**: `number` = 0

#### Defined in

[packages/rtp/src/rtp/rtp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L39)

___

### payloadType

• **payloadType**: `number` = 0

#### Defined in

[packages/rtp/src/rtp/rtp.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L40)

___

### sequenceNumber

• **sequenceNumber**: `number` = 0

#### Defined in

[packages/rtp/src/rtp/rtp.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L41)

___

### ssrc

• **ssrc**: `number` = 0

#### Defined in

[packages/rtp/src/rtp/rtp.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L43)

___

### timestamp

• **timestamp**: `number` = 0

#### Defined in

[packages/rtp/src/rtp/rtp.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L42)

___

### version

• **version**: `number` = 2

#### Defined in

[packages/rtp/src/rtp/rtp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L34)

## Accessors

### serializeSize

• `get` **serializeSize**(): `number`

#### Returns

`number`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:162](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L162)

## Methods

### serialize

▸ **serialize**(`size`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `size` | `number` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/rtp/rtp.ts:189](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L189)

___

### deSerialize

▸ `Static` **deSerialize**(`rawPacket`): [RtpHeader](rtpheader.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawPacket` | `Buffer` |

#### Returns

[RtpHeader](rtpheader.md)

#### Defined in

[packages/rtp/src/rtp/rtp.ts:53](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/rtp/rtp.ts#L53)
