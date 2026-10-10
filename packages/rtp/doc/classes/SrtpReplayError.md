[**werift-rtp**](../README.md)

***

[werift-rtp](../globals.md) / SrtpReplayError

# Class: SrtpReplayError

A packet whose SRTP/SRTCP index was already received, or is older than the
replay window (RFC 3711 §3.3.2). Subclasses SrtpAuthenticationError so
receivers that drop unauthenticated packets drop replays the same way.

## Extends

- [`SrtpAuthenticationError`](SrtpAuthenticationError.md)

## Constructors

### new SrtpReplayError()

> **new SrtpReplayError**(`message`): [`SrtpReplayError`](SrtpReplayError.md)

#### Parameters

##### message

`string`

#### Returns

[`SrtpReplayError`](SrtpReplayError.md)

#### Overrides

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`constructor`](SrtpAuthenticationError.md#constructors)

## Properties

### cause?

> `optional` **cause**: `unknown`

#### Inherited from

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`cause`](SrtpAuthenticationError.md#cause)

***

### message

> **message**: `string`

#### Inherited from

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`message`](SrtpAuthenticationError.md#message-1)

***

### name

> **name**: `string`

#### Inherited from

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`name`](SrtpAuthenticationError.md#name)

***

### stack?

> `optional` **stack**: `string`

#### Inherited from

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`stack`](SrtpAuthenticationError.md#stack)

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

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`prepareStackTrace`](SrtpAuthenticationError.md#preparestacktrace)

***

### stackTraceLimit

> `static` **stackTraceLimit**: `number`

#### Inherited from

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`stackTraceLimit`](SrtpAuthenticationError.md#stacktracelimit)

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

[`SrtpAuthenticationError`](SrtpAuthenticationError.md).[`captureStackTrace`](SrtpAuthenticationError.md#capturestacktrace)
