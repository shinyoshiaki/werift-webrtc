[**werift**](../README.md)

***

[werift](../globals.md) / RoundTripTimeConsumer

# Interface: RoundTripTimeConsumer

Optional RTCP / network RTT consumer (pin OnRoundTripTimeUpdate).

Not part of the common [BandwidthEstimator](BandwidthEstimator.md) contract. Pin discards
**smoothed** RTT updates and feeds **raw** RTT into AIMD — callers must pass
the per-report raw sample, not a stats-smoothed value.

## Methods

### setRoundTripTime()

> **setRoundTripTime**(`rttMs`): `void`

Raw round-trip time in **milliseconds** (not TWCC propagation RTT).
Pin GoogCc ignores smoothed RTT and only applies unsmoothed updates.

#### Parameters

##### rttMs

`number`

#### Returns

`void`
