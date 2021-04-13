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

Overrides: Session&lt;SrtpContext&gt;.constructor

Defined in: [rtp/src/srtp/srtp.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/srtp.ts#L5)

## Properties

### config

• **config**: Config

___

### localContext

• **localContext**: *SrtpContext*

Inherited from: Session.localContext

Defined in: [rtp/src/srtp/session.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/session.ts#L16)

___

### onData

• `Optional` **onData**: (`buf`: *Buffer*) => *void*

#### Type declaration:

▸ (`buf`: *Buffer*): *void*

#### Parameters:

Name | Type |
:------ | :------ |
`buf` | *Buffer* |

**Returns:** *void*

Defined in: [rtp/src/srtp/session.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/session.ts#L18)

Inherited from: Session.onData

Defined in: [rtp/src/srtp/session.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/session.ts#L18)

___

### remoteContext

• **remoteContext**: *SrtpContext*

Inherited from: Session.remoteContext

Defined in: [rtp/src/srtp/session.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/session.ts#L17)

## Methods

### decrypt

▸ **decrypt**(`buf`: *Buffer*): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`buf` | *Buffer* |

**Returns:** *Buffer*

Defined in: [rtp/src/srtp/srtp.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/srtp.ts#L17)

___

### encrypt

▸ **encrypt**(`payload`: *Buffer*, `header`: [*RtpHeader*](rtpheader.md)): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`payload` | *Buffer* |
`header` | [*RtpHeader*](rtpheader.md) |

**Returns:** *Buffer*

Defined in: [rtp/src/srtp/srtp.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/srtp.ts#L22)

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

Inherited from: Session.start

Defined in: [rtp/src/srtp/session.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/ad4c7a5/packages/rtp/src/srtp/session.ts#L22)
