[**werift**](../README.md)

***

[werift](../globals.md) / createBandwidthEstimator

# Function: createBandwidthEstimator()

> **createBandwidthEstimator**(`option?`): [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

Construct a send-side estimator from a [BandwidthEstimatorOption](../type-aliases/BandwidthEstimatorOption.md).
Each [RTCRtpSender](../classes/RTCRtpSender.md) must get its own instance.

## Parameters

### option?

[`BandwidthEstimatorOption`](../type-aliases/BandwidthEstimatorOption.md) \| `undefined` = `"legacy"`

## Returns

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)
