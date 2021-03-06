---
id: "srtcpsession"
title: "Class: SrtcpSession"
sidebar_label: "SrtcpSession"
custom_edit_url: null
hide_title: true
---

# Class: SrtcpSession

## Hierarchy

* *Session*<SrtcpContext\>

  ↳ **SrtcpSession**

## Constructors

### constructor

\+ **new SrtcpSession**(`config`: Config): [*SrtcpSession*](srtcpsession.md)

#### Parameters:

Name | Type |
:------ | :------ |
`config` | Config |

**Returns:** [*SrtcpSession*](srtcpsession.md)

Defined in: [rtp/src/srtp/srtcp.ts:4](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/srtp/srtcp.ts#L4)

## Properties

### config

• **config**: Config

___

### localContext

• **localContext**: *SrtcpContext*

Defined in: [rtp/src/srtp/session.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/srtp/session.ts#L16)

___

### onData

• `Optional` **onData**: *undefined* \| (`buf`: *Buffer*) => *void*

Defined in: [rtp/src/srtp/session.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/srtp/session.ts#L18)

___

### remoteContext

• **remoteContext**: *SrtcpContext*

Defined in: [rtp/src/srtp/session.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/srtp/session.ts#L17)

## Methods

### decrypt

▸ **decrypt**(`buf`: *Buffer*): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`buf` | *Buffer* |

**Returns:** *Buffer*

Defined in: [rtp/src/srtp/srtcp.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/srtp/srtcp.ts#L17)

___

### encrypt

▸ **encrypt**(`rawRtcp`: *Buffer*): *Buffer*

#### Parameters:

Name | Type |
:------ | :------ |
`rawRtcp` | *Buffer* |

**Returns:** *Buffer*

Defined in: [rtp/src/srtp/srtcp.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/srtp/srtcp.ts#L22)

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

Defined in: [rtp/src/srtp/session.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/4277d59/packages/rtp/src/srtp/session.ts#L22)
