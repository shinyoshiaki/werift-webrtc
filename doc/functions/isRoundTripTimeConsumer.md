[**werift**](../README.md)

***

[werift](../globals.md) / isRoundTripTimeConsumer

# Function: isRoundTripTimeConsumer()

> **isRoundTripTimeConsumer**(`e`): `e is BandwidthEstimator & RoundTripTimeConsumer`

True when the estimator consumes RTCP RTT for AIMD (non-zero process interval).
Legacy / disabled `setRoundTripTime` is a no-op.

## Parameters

### e

[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

## Returns

`e is BandwidthEstimator & RoundTripTimeConsumer`
