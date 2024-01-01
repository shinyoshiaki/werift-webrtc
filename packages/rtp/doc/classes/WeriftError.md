[werift-rtp](../README.md) / [Exports](../modules.md) / WeriftError

# Class: WeriftError

## Hierarchy

- `Error`

  ↳ **`WeriftError`**

## Table of contents

### Constructors

- [constructor](WeriftError.md#constructor)

### Properties

- [cause](WeriftError.md#cause)
- [message](WeriftError.md#message)
- [name](WeriftError.md#name)
- [path](WeriftError.md#path)
- [payload](WeriftError.md#payload)
- [stack](WeriftError.md#stack)
- [prepareStackTrace](WeriftError.md#preparestacktrace)
- [stackTraceLimit](WeriftError.md#stacktracelimit)

### Methods

- [toJSON](WeriftError.md#tojson)
- [captureStackTrace](WeriftError.md#capturestacktrace)

## Constructors

### constructor

• **new WeriftError**(`props`): [`WeriftError`](WeriftError.md)

#### Parameters

| Name | Type |
| :------ | :------ |
| `props` | `Pick`\<[`WeriftError`](WeriftError.md), ``"message"`` \| ``"payload"`` \| ``"path"``\> |

#### Returns

[`WeriftError`](WeriftError.md)

#### Overrides

Error.constructor

## Properties

### cause

• `Optional` **cause**: `unknown`

#### Inherited from

Error.cause

___

### message

• **message**: `string`

#### Overrides

Error.message

___

### name

• **name**: `string`

#### Inherited from

Error.name

___

### path

• `Optional` **path**: `string`

___

### payload

• `Optional` **payload**: `object`

___

### stack

• `Optional` **stack**: `string`

#### Inherited from

Error.stack

___

### prepareStackTrace

▪ `Static` `Optional` **prepareStackTrace**: (`err`: `Error`, `stackTraces`: `CallSite`[]) => `any`

Optional override for formatting stack traces

**`See`**

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Type declaration

▸ (`err`, `stackTraces`): `any`

Optional override for formatting stack traces

##### Parameters

| Name | Type |
| :------ | :------ |
| `err` | `Error` |
| `stackTraces` | `CallSite`[] |

##### Returns

`any`

**`See`**

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Inherited from

Error.prepareStackTrace

___

### stackTraceLimit

▪ `Static` **stackTraceLimit**: `number`

#### Inherited from

Error.stackTraceLimit

## Methods

### toJSON

▸ **toJSON**(): `Object`

#### Returns

`Object`

| Name | Type |
| :------ | :------ |
| `message` | `string` |
| `path` | `undefined` \| `string` |
| `payload` | `any` |

___

### captureStackTrace

▸ **captureStackTrace**(`targetObject`, `constructorOpt?`): `void`

Create .stack property on a target object

#### Parameters

| Name | Type |
| :------ | :------ |
| `targetObject` | `object` |
| `constructorOpt?` | `Function` |

#### Returns

`void`

#### Inherited from

Error.captureStackTrace
