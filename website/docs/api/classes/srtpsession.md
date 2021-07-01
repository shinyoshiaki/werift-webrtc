---
id: "srtpsession"
title: "Class: SrtpSession"
sidebar_label: "SrtpSession"
sidebar_position: 0
custom_edit_url: null
---

## Hierarchy

- `Session`<SrtpContext\>

  ↳ **SrtpSession**

## Constructors

### constructor

• **new SrtpSession**(`config`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `config` | `Config` |

#### Overrides

Session&lt;SrtpContext\&gt;.constructor

#### Defined in

[packages/rtp/src/srtp/srtp.ts:5](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/srtp/srtp.ts#L5)

## Properties

### config

• **config**: `Config`

___

### localContext

• **localContext**: `SrtpContext`

#### Inherited from

Session.localContext

#### Defined in

[packages/rtp/src/srtp/session.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/srtp/session.ts#L16)

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

[packages/rtp/src/srtp/session.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/srtp/session.ts#L18)

___

### remoteContext

• **remoteContext**: `SrtpContext`

#### Inherited from

Session.remoteContext

#### Defined in

[packages/rtp/src/srtp/session.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/srtp/session.ts#L17)

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

[packages/rtp/src/srtp/srtp.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/srtp/srtp.ts#L17)

___

### encrypt

▸ **encrypt**(`payload`, `header`): `Buffer`

#### Parameters

| Name | Type |
| :------ | :------ |
| `payload` | `Buffer` |
| `header` | [RtpHeader](rtpheader.md) |

#### Returns

`Buffer`

#### Defined in

[packages/rtp/src/srtp/srtp.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/srtp/srtp.ts#L22)

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

[packages/rtp/src/srtp/session.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/8a77e73/packages/rtp/src/srtp/session.ts#L22)
