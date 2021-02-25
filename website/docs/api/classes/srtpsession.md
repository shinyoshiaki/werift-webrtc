---
id: "srtpsession"
title: "Class: SrtpSession"
sidebar_label: "SrtpSession"
custom_edit_url: null
hide_title: true
---

# Class: SrtpSession

## Hierarchy

* *Session*<SrtpContext\>

  ↳ **SrtpSession**

## Constructors

### constructor

\+ **new SrtpSession**(`config`: Config): [*SrtpSession*](srtpsession.md)

#### Parameters:

Name | Type |
:------ | :------ |
`config` | Config |

**Returns:** [*SrtpSession*](srtpsession.md)

Defined in: [rtp/src/srtp/srtp.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/srtp/srtp.ts#L5)

## Properties

### config

• **config**: Config

___

### localContext

• **localContext**: *SrtpContext*

Defined in: [rtp/src/srtp/session.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/srtp/session.ts#L16)

___

### onData

• `Optional` **onData**: *undefined* \| (`buf`: *Buffer*) => *void*

Defined in: [rtp/src/srtp/session.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/srtp/session.ts#L18)

___

### remoteContext

• **remoteContext**: *SrtpContext*

Defined in: [rtp/src/srtp/session.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/srtp/session.ts#L17)

## Methods

### decrypt

▸ **decrypt**(`buf`: *Buffer*): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`buf` | *Buffer* |

**Returns:** *Buffer*

Defined in: [rtp/src/srtp/srtp.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/srtp/srtp.ts#L17)

___

### encrypt

▸ **encrypt**(`payload`: *Buffer*, `header`: [*RtpHeader*](rtpheader.md)): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`payload` | *Buffer* |
`header` | [*RtpHeader*](rtpheader.md) |

**Returns:** *Buffer*

Defined in: [rtp/src/srtp/srtp.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/srtp/srtp.ts#L22)

___

### start

▸ **start**(`localMasterKey`: *Buffer*, `localMasterSalt`: *Buffer*, `remoteMasterKey`: *Buffer*, `remoteMasterSalt`: *Buffer*, `profile`: *number*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`localMasterKey` | *Buffer* |
`localMasterSalt` | *Buffer* |
`remoteMasterKey` | *Buffer* |
`remoteMasterSalt` | *Buffer* |
`profile` | *number* |

**Returns:** *void*

Defined in: [rtp/src/srtp/session.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/2cffe94/packages/rtp/src/srtp/session.ts#L22)
