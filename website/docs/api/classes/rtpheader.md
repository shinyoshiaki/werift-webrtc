---
id: "rtpheader"
title: "Class: RtpHeader"
sidebar_label: "RtpHeader"
custom_edit_url: null
hide_title: true
---

# Class: RtpHeader

## Constructors

### constructor

\+ **new RtpHeader**(`props?`: *Partial*<[*RtpHeader*](rtpheader.md)\>): [*RtpHeader*](rtpheader.md)

#### Parameters:

Name | Type |
:------ | :------ |
`props` | *Partial*<[*RtpHeader*](rtpheader.md)\> |

**Returns:** [*RtpHeader*](rtpheader.md)

Defined in: [rtp/src/rtp/rtp.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L43)

## Properties

### csrc

• **csrc**: *number*[]

Defined in: [rtp/src/rtp/rtp.ts:40](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L40)

___

### extension

• **extension**: *boolean*= false

Defined in: [rtp/src/rtp/rtp.ts:33](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L33)

___

### extensionLength

• `Optional` **extensionLength**: *undefined* \| *number*

Defined in: [rtp/src/rtp/rtp.ts:42](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L42)

___

### extensionProfile

• **extensionProfile**: *number*

Defined in: [rtp/src/rtp/rtp.ts:41](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L41)

___

### extensions

• **extensions**: [*Extension*](../modules.md#extension)[]

Defined in: [rtp/src/rtp/rtp.ts:43](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L43)

___

### marker

• **marker**: *boolean*= false

Defined in: [rtp/src/rtp/rtp.ts:34](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L34)

___

### padding

• **padding**: *boolean*= false

Defined in: [rtp/src/rtp/rtp.ts:31](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L31)

___

### paddingSize

• **paddingSize**: *number*= 0

Defined in: [rtp/src/rtp/rtp.ts:32](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L32)

___

### payloadOffset

• **payloadOffset**: *number*= 0

Defined in: [rtp/src/rtp/rtp.ts:35](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L35)

___

### payloadType

• **payloadType**: *number*= 0

Defined in: [rtp/src/rtp/rtp.ts:36](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L36)

___

### sequenceNumber

• **sequenceNumber**: *number*= 0

Defined in: [rtp/src/rtp/rtp.ts:37](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L37)

___

### ssrc

• **ssrc**: *number*= 0

Defined in: [rtp/src/rtp/rtp.ts:39](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L39)

___

### timestamp

• **timestamp**: *number*= 0

Defined in: [rtp/src/rtp/rtp.ts:38](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L38)

___

### version

• **version**: *number*= 2

Defined in: [rtp/src/rtp/rtp.ts:30](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L30)

## Accessors

### serializeSize

• get **serializeSize**(): *number*

**Returns:** *number*

Defined in: [rtp/src/rtp/rtp.ts:155](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L155)

## Methods

### serialize

▸ **serialize**(`size`: *number*): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`size` | *number* |

**Returns:** *Buffer*

Defined in: [rtp/src/rtp/rtp.ts:180](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L180)

___

### deSerialize

▸ `Static`**deSerialize**(`rawPacket`: *Buffer*): [*RtpHeader*](rtpheader.md)

#### Parameters:

Name | Type |
:------ | :------ |
`rawPacket` | *Buffer* |

**Returns:** [*RtpHeader*](rtpheader.md)

Defined in: [rtp/src/rtp/rtp.ts:48](https://github.com/shinyoshiaki/werift-webrtc/blob/b7c7a6e/packages/rtp/src/rtp/rtp.ts#L48)
