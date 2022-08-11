[werift](../README.md) / [Exports](../modules.md) / Candidate

# Class: Candidate

## Table of contents

### Constructors

- [constructor](Candidate.md#constructor)

### Properties

- [component](Candidate.md#component)
- [foundation](Candidate.md#foundation)
- [generation](Candidate.md#generation)
- [host](Candidate.md#host)
- [port](Candidate.md#port)
- [priority](Candidate.md#priority)
- [relatedAddress](Candidate.md#relatedaddress)
- [relatedPort](Candidate.md#relatedport)
- [tcptype](Candidate.md#tcptype)
- [transport](Candidate.md#transport)
- [type](Candidate.md#type)

### Methods

- [canPairWith](Candidate.md#canpairwith)
- [toSdp](Candidate.md#tosdp)
- [fromSdp](Candidate.md#fromsdp)

## Constructors

### constructor

• **new Candidate**(`foundation`, `component`, `transport`, `priority`, `host`, `port`, `type`, `relatedAddress?`, `relatedPort?`, `tcptype?`, `generation?`)

#### Parameters

| Name | Type |
| :------ | :------ |
| `foundation` | `string` |
| `component` | `number` |
| `transport` | `string` |
| `priority` | `number` |
| `host` | `string` |
| `port` | `number` |
| `type` | `string` |
| `relatedAddress?` | `string` |
| `relatedPort?` | `number` |
| `tcptype?` | `string` |
| `generation?` | `number` |

#### Defined in

[packages/ice/src/candidate.ts:8](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L8)

## Properties

### component

• **component**: `number`

#### Defined in

[packages/ice/src/candidate.ts:10](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L10)

___

### foundation

• **foundation**: `string`

#### Defined in

[packages/ice/src/candidate.ts:9](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L9)

___

### generation

• `Optional` **generation**: `number`

#### Defined in

[packages/ice/src/candidate.ts:19](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L19)

___

### host

• **host**: `string`

#### Defined in

[packages/ice/src/candidate.ts:13](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L13)

___

### port

• **port**: `number`

#### Defined in

[packages/ice/src/candidate.ts:14](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L14)

___

### priority

• **priority**: `number`

#### Defined in

[packages/ice/src/candidate.ts:12](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L12)

___

### relatedAddress

• `Optional` **relatedAddress**: `string`

#### Defined in

[packages/ice/src/candidate.ts:16](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L16)

___

### relatedPort

• `Optional` **relatedPort**: `number`

#### Defined in

[packages/ice/src/candidate.ts:17](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L17)

___

### tcptype

• `Optional` **tcptype**: `string`

#### Defined in

[packages/ice/src/candidate.ts:18](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L18)

___

### transport

• **transport**: `string`

#### Defined in

[packages/ice/src/candidate.ts:11](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L11)

___

### type

• **type**: `string`

#### Defined in

[packages/ice/src/candidate.ts:15](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L15)

## Methods

### canPairWith

▸ **canPairWith**(`other`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `other` | [`Candidate`](Candidate.md) |

#### Returns

`boolean`

#### Defined in

[packages/ice/src/candidate.ts:70](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L70)

___

### toSdp

▸ **toSdp**(): `string`

#### Returns

`string`

#### Defined in

[packages/ice/src/candidate.ts:85](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L85)

___

### fromSdp

▸ `Static` **fromSdp**(`sdp`): [`Candidate`](Candidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sdp` | `string` |

#### Returns

[`Candidate`](Candidate.md)

#### Defined in

[packages/ice/src/candidate.ts:22](https://github.com/shinyoshiaki/werift-webrtc/blob/f609bd5a/packages/ice/src/candidate.ts#L22)
