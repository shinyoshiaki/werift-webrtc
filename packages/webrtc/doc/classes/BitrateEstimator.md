[**werift**](../README.md)

***

[werift](../globals.md) / BitrateEstimator

# Class: BitrateEstimator

Bayesian bitrate estimator (libwebrtc BitrateEstimator).
Used when robust throughput is disabled; kept for parity / unit tests.

## Constructors

### Constructor

> **new BitrateEstimator**(): `BitrateEstimator`

#### Returns

`BitrateEstimator`

## Methods

### bitrate()

> **bitrate**(): `number`

#### Returns

`number`

***

### expectFastRateChange()

> **expectFastRateChange**(): `void`

#### Returns

`void`

***

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### update()

> **update**(`atTimeMs`, `bytes`): `void`

#### Parameters

##### atTimeMs

`number`

##### bytes

`number`

#### Returns

`void`
