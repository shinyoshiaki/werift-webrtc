[**werift**](../README.md)

***

[werift](../globals.md) / BandwidthLimitedCause

# Type Alias: BandwidthLimitedCause

> **BandwidthLimitedCause**: `"loss_limited_bwe_increasing"` \| `"loss_limited_bwe"` \| `"delay_based_limited"` \| `"delay_based_limited_delay_increased"` \| `"rtt_based_back_off_high_rtt"`

libwebrtc `BandwidthLimitedCause` (probe_controller.h) — reason the BWE
estimate is limited. ProbeController::InitiateProbing uses this to decide
whether new probes are forbidden or allowed with a scale cap.
