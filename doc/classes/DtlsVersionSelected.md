[**werift**](../README.md)

***

[werift](../globals.md) / DtlsVersionSelected

# Class: DtlsVersionSelected

Intentional dual-stack version selection result (not a handshake failure).
Association layer switches engines; must not be treated as public onError.

## Extends

- `Error`

## Constructors

### new DtlsVersionSelected()

> **new DtlsVersionSelected**(`version`, `message`?): [`DtlsVersionSelected`](DtlsVersionSelected.md)

#### Parameters

##### version

[`DtlsVersion`](../enumerations/DtlsVersion.md)

##### message?

`string`

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
