---
id: "srtcpsession"
title: "Class: SrtcpSession"
sidebar_label: "SrtcpSession"
sidebar_position: 0
custom_edit_url: null
---

## Hierarchy

- `Session`<SrtcpContext\>

  ↳ **SrtcpSession**

## Constructors

### constructor

• **new SrtcpSession**(`config`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | `Config` |

#### Overrides

Session&lt;SrtcpContext\&gt;.constructor

#### Defined in

[packages/rtp/src/srtp/srtcp.ts:4](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/srtp/srtcp.ts#L4)

## Properties

### config

• **config**: `Config`

___

### localContext

• **localContext**: `SrtcpContext`

#### Inherited from

Session.localContext

#### Defined in

[packages/rtp/src/srtp/session.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/srtp/session.ts#L16)

___

### onData

• `Optional` **onData**: (`buf`: `Buffer`) => `void`

#### Type declaration

▸ (`buf`): `void`

##### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

##### Returns

`void`

#### Inherited from

Session.onData

#### Defined in

[packages/rtp/src/srtp/session.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/srtp/session.ts#L18)

___

### remoteContext

• **remoteContext**: `SrtcpContext`

#### Inherited from

Session.remoteContext

#### Defined in

[packages/rtp/src/srtp/session.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/srtp/session.ts#L17)

## Methods

### decrypt

▸ **decrypt**(`buf`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `buf` | `Buffer` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/srtp/srtcp.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/srtp/srtcp.ts#L17)

___

### encrypt

▸ **encrypt**(`rawRtcp`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `rawRtcp` | `Buffer` |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/srtp/srtcp.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/srtp/srtcp.ts#L22)

___

### start

▸ **start**(`localMasterKey`, `localMasterSalt`, `remoteMasterKey`, `remoteMasterSalt`, `profile`): `void`

#### Parameters

| Name | Type |
| :------ | :------ |
| `localMasterKey` | `Buffer` |
| `localMasterSalt` | `Buffer` |
| `remoteMasterKey` | `Buffer` |
| `remoteMasterSalt` | `Buffer` |
| `profile` | `number` |

#### Returns

`void`

#### Inherited from

Session.start

#### Defined in

[packages/rtp/src/srtp/session.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/32ca930/packages/rtp/src/srtp/session.ts#L22)
