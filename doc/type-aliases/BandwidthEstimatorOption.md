[**werift**](../README.md)

***

[werift](../globals.md) / BandwidthEstimatorOption

# Type Alias: BandwidthEstimatorOption

> **BandwidthEstimatorOption**: [`BandwidthEstimatorPreset`](BandwidthEstimatorPreset.md) \| `false` \| () => [`BandwidthEstimator`](../interfaces/BandwidthEstimator.md)

How a new [RTCRtpSender](../classes/RTCRtpSender.md) obtains its [BandwidthEstimator](../interfaces/BandwidthEstimator.md).

- `"legacy"` (default): [SenderBandwidthEstimator](../classes/LegacyCumulativeBandwidthEstimator.md)
- `"gcc"`: [GccBandwidthEstimator](../classes/GccBandwidthEstimator.md)
- `false` / `"none"`: [DisabledBandwidthEstimator](../classes/DisabledBandwidthEstimator.md)
- factory: called **once per sender** (do not share one instance)
