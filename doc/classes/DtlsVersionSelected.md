[**werift**](../README.md)

***

[werift](../globals.md) / DtlsVersionSelected

# Class: DtlsVersionSelected

Dual-stack association signal: peer used DTLS 1.2 HelloVerifyRequest cookie path.
Not a final version selection — association continues dual negotiation on the
1.2 cookie path while still advertising supported_versions including 1.3.
Must not be treated as public onError.

## Extends

- `Error`

## Constructors

### new DtlsVersionSelected()

> **new DtlsVersionSelected**(`version`, `message`?, `helloVerifyCookie`?): [`DtlsVersionSelected`](DtlsVersionSelected.md)

#### Parameters

##### version

[`DtlsVersion`](../enumerations/DtlsVersion.md)

##### message?

`string`

##### helloVerifyCookie?

`Buffer`\<`ArrayBufferLike`\>

Cookie from HelloVerifyRequest to continue dual CH on 1.2 path.

#### Returns

[`DtlsVersionSelected`](DtlsVersionSelected.md)

#### Overrides

`Error.constructor`

## Properties

### cause?

> `optional` **cause**: `unknown`

#### Inherited from

`Error.cause`

***

### code

> `readonly` **code**: `"version_selected"` = `"version_selected"`

***

### helloVerifyCookie?

> `readonly` `optional` **helloVerifyCookie**: `Buffer`\<`ArrayBufferLike`\>

Cookie from HelloVerifyRequest to continue dual CH on 1.2 path.

***

### message

> **message**: `string`

#### Inherited from

`Error.message`

***

### name

> **name**: `string`

#### Inherited from

`Error.name`

***

### stack?

> `optional` **stack**: `string`

#### Inherited from

`Error.stack`

***

### version

> `readonly` **version**: [`DtlsVersion`](../enumerations/DtlsVersion.md)

***

### prepareStackTrace()?

> `static` `optional` **prepareStackTrace**: (`err`, `stackTraces`) => `any`

Optional override for formatting stack traces

#### Parameters

##### err

`Error`

##### stackTraces

`CallSite`[]

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

### captureStackTrace()

> `static` **captureStackTrace**(`targetObject`, `constructorOpt`?): `void`

Create .stack property on a target object

#### Parameters

##### targetObject

`object`

##### constructorOpt?

`Function`

#### Returns

`void`

#### Inherited from

`Error.captureStackTrace`
