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

• **new Candidate**(`foundation`, `component`, `transport`, `priority`, `host`, `port`, `type`, `relatedAddress?`, `relatedPort?`, `tcptype?`, `generation?`): [`Candidate`](Candidate.md)

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

#### Returns

[`Candidate`](Candidate.md)

## Properties

### component

• **component**: `number`

___

### foundation

• **foundation**: `string`

___

### generation

• `Optional` **generation**: `number`

___

### host

• **host**: `string`

___

### port

• **port**: `number`

___

### priority

• **priority**: `number`

___

### relatedAddress

• `Optional` **relatedAddress**: `string`

___

### relatedPort

• `Optional` **relatedPort**: `number`

___

### tcptype

• `Optional` **tcptype**: `string`

___

### transport

• **transport**: `string`

___

### type

• **type**: `string`

## Methods

### canPairWith

▸ **canPairWith**(`other`): `boolean`

#### Parameters

| Name | Type |
| :------ | :------ |
| `other` | [`Candidate`](Candidate.md) |

#### Returns

`boolean`

___

### toSdp

▸ **toSdp**(): `string`

#### Returns

`string`

___

### fromSdp

▸ **fromSdp**(`sdp`): [`Candidate`](Candidate.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `sdp` | `string` |

#### Returns

[`Candidate`](Candidate.md)
