[**werift**](../README.md)

***

[werift](../globals.md) / TrendlineEstimator

# Class: TrendlineEstimator

libwebrtc TrendlineEstimator port
(`modules/congestion_controller/goog_cc/trendline_estimator.cc`).

- Exponentially smoothed accumulated delay
- Linear regression slope only when the history window is **full**
- `modified_trend = min(num_deltas, 60) * trend * 4.0`
- Adaptive threshold with k_up=0.0087 / k_down=0.039
- Overuse / underuse / normal hypothesis (same role as OveruseDetector)

## Constructors

### new TrendlineEstimator()

> **new TrendlineEstimator**(): [`TrendlineEstimator`](TrendlineEstimator.md)

#### Returns

[`TrendlineEstimator`](TrendlineEstimator.md)

## Accessors

### adaptiveThreshold

#### Get Signature

> **get** **adaptiveThreshold**(): `number`

##### Returns

`number`

***

### modifiedTrend

#### Get Signature

> **get** **modifiedTrend**(): `number`

##### Returns

`number`

***

### numDeltas

#### Get Signature

> **get** **numDeltas**(): `number`

##### Returns

`number`

***

### sampleCount

#### Get Signature

> **get** **sampleCount**(): `number`

##### Returns

`number`

***

### state

#### Get Signature

> **get** **state**(): [`BandwidthUsage`](../type-aliases/BandwidthUsage.md)

##### Returns

[`BandwidthUsage`](../type-aliases/BandwidthUsage.md)

***

### trend

#### Get Signature

> **get** **trend**(): `number`

##### Returns

`number`

## Methods

### reset()

> **reset**(): `void`

#### Returns

`void`

***

### update()

> **update**(`recvDeltaMs`, `sendDeltaMs`, `arrivalTimeMs`): `number`

#### Parameters

##### recvDeltaMs

`number`

inter-arrival (ms)

##### sendDeltaMs

`number`

inter-departure (ms) — also drives overuse timer

##### arrivalTimeMs

`number`

absolute arrival time

#### Returns

`number`

modified trend (for tests / logging)
