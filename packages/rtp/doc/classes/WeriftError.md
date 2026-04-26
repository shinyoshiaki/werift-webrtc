[**werift-rtp**](../README.md) • **Docs**

***

[werift-rtp](../globals.md) / WeriftError

# Class: WeriftError

## Extends

- `Error`

## Constructors

### new WeriftError()

> **new WeriftError**(`props`): [`WeriftError`](WeriftError.md)

#### Parameters

• **props**: `Pick`\<[`WeriftError`](WeriftError.md), `"message"` \| `"payload"` \| `"path"`\>

#### Returns

[`WeriftError`](WeriftError.md)

#### Overrides

`Error.constructor`

## Properties

### cause?

> `optional` **cause**: `unknown`

#### Inherited from

`Error.cause`

***

### message

> **message**: `string`

#### Overrides

`Error.message`

***

### name

> **name**: `string`

#### Inherited from

`Error.name`

***

### path?

> `optional` **path**: `string`

***

### payload?

> `optional` **payload**: `object`

***

### stack?

> `optional` **stack**: `string`

#### Inherited from

`Error.stack`

***

### prepareStackTrace()?

> `static` `optional` **prepareStackTrace**: (`err`, `stackTraces`) => `any`

Optional override for formatting stack traces

#### Parameters

• **err**: `Error`

• **stackTraces**: `CallSite`[]

#### Returns

`any`

#### See

https://v8.dev/docs/stack-trace-api#customizing-stack-traces

#### Inherited from

`Error.prepareStackTrace`

***

### stackTraceLimit

> `static` **stackTraceLimit**: `number`

#### Inherited from

`Error.stackTraceLimit`

## Methods

### toJSON()

> **toJSON**(): `object`

#### Returns

`object`

##### message

> **message**: `string`

##### path

> **path**: `undefined` \| `string`

##### payload

> **payload**: `any`

***

### captureStackTrace()

> `static` **captureStackTrace**(`targetObject`, `constructorOpt`?): `void`

Create .stack property on a target object

#### Parameters

• **targetObject**: `object`

• **constructorOpt?**: `Function`

#### Returns

`void`

#### Inherited from

`Error.captureStackTrace`
