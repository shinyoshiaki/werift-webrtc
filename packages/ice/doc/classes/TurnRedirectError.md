[**werift-ice**](../README.md)

***

[werift-ice](../globals.md) / TurnRedirectError

# Class: TurnRedirectError

A TURN Allocate was answered with 300 (Try Alternate) and the redirect
could not be followed (RFC 8656 §7.4, RFC 8489 §10). The 300 response is
kept as `cause`.

## Extends

- `Error`

## Constructors

### new TurnRedirectError()

> **new TurnRedirectError**(`reason`, `server`, `alternate`, `cause`): [`TurnRedirectError`](TurnRedirectError.md)

#### Parameters

##### reason

[`TurnRedirectFailureReason`](../type-aliases/TurnRedirectFailureReason.md)

##### server

readonly \[`string`, `number`\]

Server that answered 300.

##### alternate

ALTERNATE-SERVER of the 300 response, when present.

`undefined` | readonly \[`string`, `number`\]

##### cause

`TransactionFailed`

#### Returns

[`TurnRedirectError`](TurnRedirectError.md)

#### Overrides

`Error.constructor`

## Properties

### alternate

> **alternate**: `undefined` \| readonly \[`string`, `number`\]

ALTERNATE-SERVER of the 300 response, when present.

***

### cause?

> `optional` **cause**: `unknown`

#### Inherited from

`Error.cause`

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

### reason

> **reason**: [`TurnRedirectFailureReason`](../type-aliases/TurnRedirectFailureReason.md)

***

### server

> **server**: readonly \[`string`, `number`\]

Server that answered 300.

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
