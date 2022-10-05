[werift](../README.md) / [Exports](../modules.md) / IceOptions

# Interface: IceOptions

## Table of contents

### Properties

- [components](IceOptions.md#components)
- [filterStunResponse](IceOptions.md#filterstunresponse)
- [forceTurn](IceOptions.md#forceturn)
- [interfaceAddresses](IceOptions.md#interfaceaddresses)
- [portRange](IceOptions.md#portrange)
- [stunServer](IceOptions.md#stunserver)
- [turnPassword](IceOptions.md#turnpassword)
- [turnServer](IceOptions.md#turnserver)
- [turnSsl](IceOptions.md#turnssl)
- [turnTransport](IceOptions.md#turntransport)
- [turnUsername](IceOptions.md#turnusername)
- [useIpv4](IceOptions.md#useipv4)
- [useIpv6](IceOptions.md#useipv6)

## Properties

### components

• **components**: `number`

___

### filterStunResponse

• `Optional` **filterStunResponse**: (`message`: `Message`, `addr`: readonly [`string`, `number`], `protocol`: `Protocol`) => `boolean`

#### Type declaration

▸ (`message`, `addr`, `protocol`): `boolean`

##### Parameters

| Name | Type |
| :------ | :------ |
| `message` | `Message` |
| `addr` | readonly [`string`, `number`] |
| `protocol` | `Protocol` |

##### Returns

`boolean`

___

### forceTurn

• `Optional` **forceTurn**: `boolean`

___

### interfaceAddresses

• `Optional` **interfaceAddresses**: [`InterfaceAddresses`](../modules.md#interfaceaddresses)

___

### portRange

• `Optional` **portRange**: [`number`, `number`]

___

### stunServer

• `Optional` **stunServer**: readonly [`string`, `number`]

___

### turnPassword

• `Optional` **turnPassword**: `string`

___

### turnServer

• `Optional` **turnServer**: readonly [`string`, `number`]

___

### turnSsl

• `Optional` **turnSsl**: `boolean`

___

### turnTransport

• `Optional` **turnTransport**: `string`

___

### turnUsername

• `Optional` **turnUsername**: `string`

___

### useIpv4

• **useIpv4**: `boolean`

___

### useIpv6

• **useIpv6**: `boolean`
