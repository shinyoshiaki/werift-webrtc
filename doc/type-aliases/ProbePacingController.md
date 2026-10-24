[**werift**](../README.md)

***

[werift](../globals.md) / ProbePacingController

# Type Alias: ProbePacingController

> **ProbePacingController**: `Pick`\<[`BandwidthEstimator`](../interfaces/BandwidthEstimator.md), `"shouldTagProbePacket"` \| `"getPacingBitrateBps"` \| `"reserveOutgoingProbe"` \| `"pendingProbePaddingPackets"` \| `"getPaddingBitrateBps"` \| `"pendingLossPaddingPackets"`\>

GCC-oriented probe / pacing subset of [BandwidthEstimator](../interfaces/BandwidthEstimator.md).
Legacy implements these as no-ops; use [isProbePacingController](../functions/isProbePacingController.md) to
detect an estimator that actually injects probe padding.
